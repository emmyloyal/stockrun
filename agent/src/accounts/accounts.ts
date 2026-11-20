// Accounts: anyone signs in with a phone number (one-time SMS code), an email address (one-time emailed code) or a
// wallet (signs a one-time message).
// Each person has a profile: a unique username, a display name and a picture.
//
// Phone accounts spend naira held in StockRun's ledger; they need no key. Wallet accounts spend coins from their own
// vault on X Layer, signed by their wallet. A wallet account can add a phone number later (and the other way round),
// so one person is one account.
//
// Codes are 6 digits, stored as an HMAC (never in plain text), valid for 10 minutes, 5 guesses each, and limited to
// 1 per minute and 5 per hour per phone or email. Wallet messages carry a random nonce, are valid for 10 minutes and work once.
// Sign-in lasts a year on the device: the session is a pass signed with SERVER_SECRET naming the phone or wallet,
// so it survives a server restart even when the database was wiped (the account is then recreated from the pass).
// Signing out deletes the pass from the browser and records it as revoked on the server.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DB } from 'node:sqlite';
// Loaded through require: the test bundler does not know the newer `node:sqlite` built-in. Types still come from Node.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DB;
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';

export interface User {
  id: number;
  phone: string | null;
  email: string | null;
  wallet: Address | null;
  username: string | null;
  displayName: string | null;
  hasAvatar: boolean;
  createdAt: number;
}
export interface SmsSender { send(phone: string, text: string): Promise<void> }
export interface EmailSender { send(to: string, subject: string, text: string): Promise<void> }

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_GUESSES = 5;
export const SESSION_TTL_MS = 365 * 24 * 3600_000;
export const WALLET_MSG_TTL_MS = 10 * 60_000;
export const AVATAR_MAX_BYTES = 300_000;
const RESEND_GAP_MS = 60_000, HOURLY_LIMIT = 5;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'AuthError'; this.status = status; }
}

/** Nigerian numbers in any common form -> +234XXXXXXXXXX. Other countries: + and 8-15 digits. */
export function normalisePhone(input: string): string {
  const d = input.replace(/[\s\-().]/g, '');
  let m = d.match(/^(?:\+?234|0)([789][01]\d{8})$/);
  if (m) return `+234${m[1]}`;
  m = d.match(/^\+([1-9]\d{7,14})$/);
  if (m) return `+${m[1]}`;
  throw new AuthError(400, 'Enter a phone number like 0803 123 4567.');
}

/** Email addresses: trimmed, lower-case, one @, a dot in the domain, at most 254 characters. */
export function normaliseEmail(input: string): string {
  const e = String(input).trim().toLowerCase();
  if (e.length > 254 || !/^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) throw new AuthError(400, 'Enter an email address like ada@gmail.com.');
  return e;
}

/** The message a wallet signs to sign in. Plain words, so the person sees exactly what they sign. */
export const walletMessage = (address: Address, nonce: string, issuedAt: number) =>
  `Sign in to StockRun\n\nWallet: ${address}\nNonce: ${nonce}\nIssued: ${new Date(issuedAt).toISOString()}\n\n` +
  `This only signs you in. It costs nothing and moves no money.`;

export function openDb(file = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (${USERS_TABLE});
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY, phone TEXT NOT NULL, code_mac TEXT NOT NULL, expires_at INTEGER NOT NULL,
      guesses INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS codes_phone ON codes(phone, created_at);
    CREATE TABLE IF NOT EXISTS wallet_nonces (
      nonce TEXT PRIMARY KEY, address TEXT NOT NULL, issued_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS revoked_sessions (sid TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  // Databases made before email sign-in: rebuild the users table with the email column (SQLite cannot change a CHECK).
  const cols = db.prepare('PRAGMA table_info(users)').all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === 'email')) {
    db.exec(`BEGIN;
      ALTER TABLE users RENAME TO users_old;
      CREATE TABLE users (${USERS_TABLE});
      INSERT INTO users (id, phone, wallet, username, display_name, avatar, avatar_type, created_at)
        SELECT id, phone, wallet, username, display_name, avatar, avatar_type, created_at FROM users_old;
      DROP TABLE users_old;
      COMMIT;`);
  }
  return db;
}
const USERS_TABLE = `
      id INTEGER PRIMARY KEY, phone TEXT UNIQUE, email TEXT UNIQUE, wallet TEXT UNIQUE, username TEXT UNIQUE COLLATE NOCASE,
      display_name TEXT, avatar BLOB, avatar_type TEXT, created_at INTEGER NOT NULL,
      CHECK (phone IS NOT NULL OR email IS NOT NULL OR wallet IS NOT NULL)`;

interface UserRow { id: number; phone: string | null; email: string | null; wallet: string | null; username: string | null; display_name: string | null; has_avatar: number; created_at: number }
const USER_COLS = 'id, phone, email, wallet, username, display_name, (avatar IS NOT NULL) AS has_avatar, created_at';
const toUser = (r: UserRow): User => ({
  id: r.id, phone: r.phone, email: r.email, wallet: r.wallet ? getAddress(r.wallet) : null, username: r.username,
  displayName: r.display_name, hasAvatar: !!r.has_avatar, createdAt: r.created_at,
});

export class Accounts {
  private db: DatabaseSync;
  private sms: SmsSender;
  private secret: Buffer;
  private now: () => number;
  private otpHost: string | null;
  private mail: EmailSender | null;
  /** `otpHost`: the site's domain (e.g. stockrun.onrender.com). When set, each code SMS ends with the Web OTP line
   *  `@<domain> #<code>`, so Chrome on Android offers to fill the code in by itself (iPhones fill it from any SMS). */
  /** `mail`: sends emailed sign-in codes; null switches email sign-in off. */
  constructor(db: DatabaseSync, sms: SmsSender, secret: string, now: () => number = Date.now, otpHost: string | null = null, mail: EmailSender | null = null) {
    if (secret.length < 32) throw new Error('SERVER_SECRET must be at least 32 characters');
    this.db = db; this.sms = sms; this.secret = Buffer.from(secret); this.now = now;
    this.otpHost = otpHost && /^[a-z0-9.-]+$/i.test(otpHost) ? otpHost.toLowerCase() : null;
    this.mail = mail;
  }
  get emailSignIn(): boolean { return !!this.mail; }

  private mac(phone: string, code: string) { return createHmac('sha256', this.secret).update(`${phone}:${code}`).digest('hex'); }
  private byId(id: number): User { return toUser(this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as unknown as UserRow); }
  private find(col: 'phone' | 'email' | 'wallet', v: string): User | null {
    const r = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE ${col} = ?`).get(v) as unknown as UserRow | undefined;
    return r ? toUser(r) : null;
  }
  /** A signed pass: `v1.<payload>.<signature>`. The payload names who (phone or wallet), not a database id. */
  private startSession(user: User) {
    const who = user.phone ? `p:${user.phone}` : user.email ? `e:${user.email}` : `w:${user.wallet!.toLowerCase()}`;
    const t = this.now();
    const payload = Buffer.from(JSON.stringify({ who, sid: randomBytes(12).toString('base64url'), iat: t, exp: t + SESSION_TTL_MS })).toString('base64url');
    return { user, token: `v1.${payload}.${this.sign(payload)}` };
  }
  private sign(payload: string) { return createHmac('sha256', this.secret).update(`session:${payload}`).digest('base64url'); }
  private readPass(token: string): { who: string; sid: string; exp: number } | null {
    const m = /^v1\.([A-Za-z0-9_-]{20,600})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return null;
    const want = Buffer.from(this.sign(m[1])), got = Buffer.from(m[2]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { who?: unknown; sid?: unknown; exp?: unknown };
      if (typeof p.who !== 'string' || typeof p.sid !== 'string' || typeof p.exp !== 'number' || p.exp < this.now()) return null;
      return { who: p.who, sid: p.sid, exp: p.exp };
    } catch { return null; }
  }

  // ---------------------------------------------------------------- phone
  /** Send a sign-in code. Says nothing about whether the number has an account. */
  async requestCode(phoneInput: string): Promise<{ phone: string }> {
    const phone = normalisePhone(phoneInput), code = this.issueCode(phone, 'number');
    const text = `Your StockRun code is ${code}. It expires in 10 minutes. Never share it with anyone, including StockRun staff.`;
    await this.sms.send(phone, this.otpHost ? `${text}\n\n@${this.otpHost} #${code}` : text);
    return { phone };
  }

  /** A new 6-digit code for a phone or email (codes.phone holds either), within the resend limits. */
  private issueCode(target: string, what: string): string {
    const t = this.now();
    const recent = this.db.prepare('SELECT created_at FROM codes WHERE phone = ? AND created_at > ? ORDER BY created_at DESC').all(target, t - 3600_000) as unknown as { created_at: number }[];
    if (recent.length && t - recent[0].created_at < RESEND_GAP_MS) throw new AuthError(429, 'A code was just sent. Wait a minute before asking for another.');
    if (recent.length >= HOURLY_LIMIT) throw new AuthError(429, `Too many codes for this ${what}. Try again in an hour.`);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.db.prepare('UPDATE codes SET used = 1 WHERE phone = ? AND used = 0').run(target);   // only the newest code works
    this.db.prepare('INSERT INTO codes (phone, code_mac, expires_at, created_at) VALUES (?, ?, ?, ?)').run(target, this.mac(target, code), t + CODE_TTL_MS, t);
    return code;
  }

  /** Check a code (one guess) for a normalised phone or email. Returns it on success. */
  private checkCode(phone: string, code: string): string {
    const t = this.now();
    const row = this.db.prepare('SELECT id, code_mac, expires_at, guesses FROM codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone) as unknown as
      { id: number; code_mac: string; expires_at: number; guesses: number } | undefined;
    if (!row || row.expires_at < t) throw new AuthError(400, 'That code has expired. Ask for a new one.');
    if (row.guesses >= MAX_GUESSES) throw new AuthError(429, 'Too many wrong codes. Ask for a new one.');
    this.db.prepare('UPDATE codes SET guesses = guesses + 1 WHERE id = ?').run(row.id);
    const given = Buffer.from(this.mac(phone, String(code).trim()), 'hex'), want = Buffer.from(row.code_mac, 'hex');
    if (!timingSafeEqual(given, want)) throw new AuthError(400, 'Wrong code. Check the message and try again.');
    this.db.prepare('UPDATE codes SET used = 1 WHERE id = ?').run(row.id);
    return phone;
  }

  /** Sign in with a code; the account is created on first sign-in. */
  verifyCode(phoneInput: string, code: string): { user: User; token: string } {
    const phone = this.checkCode(normalisePhone(phoneInput), code);
    let u = this.find('phone', phone);
    if (!u) {
      const id = Number(this.db.prepare('INSERT INTO users (phone, created_at) VALUES (?, ?)').run(phone, this.now()).lastInsertRowid);
      u = this.byId(id);
    }
    return this.startSession(u);
  }

  /** A signed-in wallet account adds a phone number (proved with a code). */
  addPhone(user: User, phoneInput: string, code: string): User {
    if (user.phone) throw new AuthError(409, 'This account already has a phone number.');
    const phone = this.checkCode(normalisePhone(phoneInput), code);
    if (this.find('phone', phone)) throw new AuthError(409, 'That number already has its own StockRun account.');
    this.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, user.id);
    return this.byId(user.id);
  }

  // ---------------------------------------------------------------- email
  /** Email a sign-in code. Says nothing about whether the address has an account. */
  async requestEmailCode(emailInput: string): Promise<{ email: string }> {
    if (!this.mail) throw new AuthError(503, 'Email sign-in is not switched on yet on this server.');
    const email = normaliseEmail(emailInput), code = this.issueCode(email, 'email address');
    await this.mail.send(email, `${code} is your StockRun code`,
      `Your StockRun sign-in code is ${code}.\n\nIt expires in 10 minutes. Never share it with anyone, including StockRun staff.\n\n` +
      `If you did not ask for this code, you can ignore this email.`);
    return { email };
  }

  /** Sign in with an emailed code; the account is created on first sign-in. */
  verifyEmailCode(emailInput: string, code: string): { user: User; token: string } {
    const email = this.checkCode(normaliseEmail(emailInput), code);
    let u = this.find('email', email);
    if (!u) {
      const id = Number(this.db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run(email, this.now()).lastInsertRowid);
      u = this.byId(id);
    }
    return this.startSession(u);
  }

  // ---------------------------------------------------------------- wallet
  /** A fresh message for this wallet to sign. */
  walletChallenge(addressInput: string): { message: string } {
    if (!isAddress(addressInput)) throw new AuthError(400, 'That is not a wallet address.');
    const address = getAddress(addressInput), nonce = randomBytes(16).toString('hex'), t = this.now();
    this.db.prepare('INSERT INTO wallet_nonces (nonce, address, issued_at) VALUES (?, ?, ?)').run(nonce, address.toLowerCase(), t);
    return { message: walletMessage(address, nonce, t) };
  }

  /** Check a signed challenge: our nonce, this wallet, fresh, unused, and signed by the wallet. Returns the address. */
  private async checkWallet(message: string, signature: Hex): Promise<Address> {
    const m = /^Sign in to StockRun\n\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{32})\n/.exec(String(message));
    if (!m) throw new AuthError(400, 'That is not a StockRun sign-in message.');
    const address = getAddress(m[1]), t = this.now();
    const row = this.db.prepare('SELECT address, issued_at, used FROM wallet_nonces WHERE nonce = ?').get(m[2]) as unknown as { address: string; issued_at: number; used: number } | undefined;
    if (!row || row.used || row.address !== address.toLowerCase() || row.issued_at + WALLET_MSG_TTL_MS < t || message !== walletMessage(address, m[2], row.issued_at))
      throw new AuthError(400, 'That sign-in message has expired. Try again.');
    const ok = await verifyMessage({ address, message, signature }).catch(() => false);
    if (!ok) throw new AuthError(400, 'The signature does not match this wallet.');
    this.db.prepare('UPDATE wallet_nonces SET used = 1 WHERE nonce = ?').run(m[2]);
    return address;
  }

  /** Sign in with a wallet; the account is created on first sign-in. */
  async verifyWallet(message: string, signature: Hex): Promise<{ user: User; token: string }> {
    const address = await this.checkWallet(message, signature);
    let u = this.find('wallet', address.toLowerCase());
    if (!u) {
      const id = Number(this.db.prepare('INSERT INTO users (wallet, created_at) VALUES (?, ?)').run(address.toLowerCase(), this.now()).lastInsertRowid);
      u = this.byId(id);
    }
    return this.startSession(u);
  }

  /** A signed-in phone account connects a wallet (proved with a signature). */
  async addWallet(user: User, message: string, signature: Hex): Promise<User> {
    if (user.wallet) throw new AuthError(409, 'This account already has a wallet.');
    const address = await this.checkWallet(message, signature);
    if (this.find('wallet', address.toLowerCase())) throw new AuthError(409, 'That wallet already has its own StockRun account.');
    this.db.prepare('UPDATE users SET wallet = ? WHERE id = ?').run(address.toLowerCase(), user.id);
    return this.byId(user.id);
  }

  // ---------------------------------------------------------------- sessions
  /**
   * The signed-in user for a pass, or null. A valid pass whose account is missing (the database was wiped by a
   * restart) recreates the account from the phone or wallet it names: the person proved it when signing in.
   */
  session(token: string | undefined): User | null {
    const pass = token ? this.readPass(token) : null;
    if (!pass || this.db.prepare('SELECT 1 FROM revoked_sessions WHERE sid = ?').get(pass.sid)) return null;
    const [kind, v] = [pass.who.slice(0, 2), pass.who.slice(2)];
    if (kind !== 'p:' && kind !== 'e:' && kind !== 'w:') return null;
    const col = kind === 'p:' ? 'phone' : kind === 'e:' ? 'email' : 'wallet';
    const found = this.find(col, v);
    if (found) return found;
    const id = Number(this.db.prepare(`INSERT INTO users (${col}, created_at) VALUES (?, ?)`).run(v, this.now()).lastInsertRowid);
    return this.byId(id);
  }
  signOut(token: string): void {
    const pass = this.readPass(token);
    if (pass) this.db.prepare('INSERT OR IGNORE INTO revoked_sessions (sid, expires_at) VALUES (?, ?)').run(pass.sid, pass.exp);
  }

  // ---------------------------------------------------------------- profile
  /** Username: 3-20 letters, digits or _, unique (case-insensitive). Display name: up to 40 characters. */
  setProfile(user: User, input: { username?: unknown; displayName?: unknown }): User {
    if (input.username !== undefined) {
      const u = String(input.username).trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) throw new AuthError(400, 'Usernames are 3 to 20 letters, numbers or _.');
      const taken = this.db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(u, user.id);
      if (taken) throw new AuthError(409, 'That username is taken.');
      this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(u, user.id);
    }
    if (input.displayName !== undefined) {
      const n = String(input.displayName).trim().replace(/\s+/g, ' ');
      if (n.length > 40) throw new AuthError(400, 'Keep your name under 40 characters.');
      this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(n || null, user.id);
    }
    return this.byId(user.id);
  }

  /** Profile picture: JPEG, PNG or WebP, at most 300 KB (the app shrinks photos first). Checked by its first bytes. */
  setAvatar(user: User, data: Buffer, type: string): User {
    if (!AVATAR_TYPES.includes(type)) throw new AuthError(400, 'Use a JPEG, PNG or WebP picture.');
    if (data.length < 8 || data.length > AVATAR_MAX_BYTES) throw new AuthError(413, 'That picture is too big: keep it under 300 KB.');
    const magic = data.subarray(0, 12).toString('hex');
    const real = magic.startsWith('ffd8ff') ? 'image/jpeg' : magic.startsWith('89504e47') ? 'image/png'
      : magic.startsWith('52494646') && magic.slice(16, 24) === '57454250' ? 'image/webp' : null;
    if (real !== type) throw new AuthError(400, 'That file is not the picture it says it is.');
    this.db.prepare('UPDATE users SET avatar = ?, avatar_type = ? WHERE id = ?').run(data, type, user.id);
    return this.byId(user.id);
  }

  avatar(userId: number): { data: Buffer; type: string } | null {
    const r = this.db.prepare('SELECT avatar, avatar_type FROM users WHERE id = ? AND avatar IS NOT NULL').get(userId) as unknown as { avatar: Uint8Array; avatar_type: string } | undefined;
    return r ? { data: Buffer.from(r.avatar), type: r.avatar_type } : null;
  }

  /** Public view of a user (for showing a profile): never the phone number, email or session data. */
  publicProfile(userId: number): { id: number; username: string | null; displayName: string | null; hasAvatar: boolean } | null {
    const r = this.db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId) as unknown as UserRow | undefined;
    if (!r) return null;
    const u = toUser(r);
    return { id: u.id, username: u.username, displayName: u.displayName, hasAvatar: u.hasAvatar };
  }
}

/** Development sender: prints codes to the server console instead of sending an SMS. Never use in production. */
export class ConsoleSms implements SmsSender {
  readonly sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string) { this.sent.push({ phone, text }); console.log(`[sms to ${phone}] ${text}`); }
}
