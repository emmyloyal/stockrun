// Accounts for real shop owners and riders: sign in with a phone number and a one-time SMS code.
//
// Keys: each person's signing key is created ON THEIR PHONE. The server only learns the address, after the phone proves
// it holds the key by signing a message. For recovery the phone uploads its key encrypted with a PIN the server never
// sees; the server stores only that ciphertext and hands it back after a fresh SMS sign-in.
//
// Codes are 6 digits, stored as an HMAC (never in plain text), valid for 10 minutes, 5 guesses each, and limited to
// 1 per minute and 5 per hour per phone. Session tokens are random and stored only as a SHA-256 hash.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DB } from 'node:sqlite';
// Loaded through require: the test bundler does not know the newer `node:sqlite` built-in. Types still come from Node.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DB;
import { getAddress, verifyMessage, type Address, type Hex } from 'viem';

export type Role = 'owner' | 'rider';
export interface User { id: number; phone: string; role: Role; address: Address | null; createdAt: number }
export interface SmsSender { send(phone: string, text: string): Promise<void> }

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_GUESSES = 5;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const RESEND_GAP_MS = 60_000, HOURLY_LIMIT = 5;

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

export const linkMessage = (userId: number, address: Address) =>
  `StockRun: link this phone's key ${address.toLowerCase()} to account ${userId}.`;

export function openDb(file = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner','rider')),
      address TEXT UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY, phone TEXT NOT NULL, code_mac TEXT NOT NULL, expires_at INTEGER NOT NULL,
      guesses INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS codes_phone ON codes(phone, created_at);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS key_backups (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), ciphertext TEXT NOT NULL, salt TEXT NOT NULL, iv TEXT NOT NULL,
      kdf TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  return db;
}

interface UserRow { id: number; phone: string; role: Role; address: string | null; created_at: number }
const toUser = (r: UserRow): User => ({ id: r.id, phone: r.phone, role: r.role, address: r.address ? getAddress(r.address) : null, createdAt: r.created_at });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class Accounts {
  private db: DatabaseSync;
  private sms: SmsSender;
  private secret: Buffer;
  private now: () => number;
  constructor(db: DatabaseSync, sms: SmsSender, secret: string, now: () => number = Date.now) {
    if (secret.length < 32) throw new Error('SERVER_SECRET must be at least 32 characters');
    this.db = db; this.sms = sms; this.secret = Buffer.from(secret); this.now = now;
  }

  private mac(phone: string, code: string) { return createHmac('sha256', this.secret).update(`${phone}:${code}`).digest('hex'); }

  /** Send a sign-in code. Says nothing about whether the number has an account. */
  async requestCode(phoneInput: string): Promise<{ phone: string }> {
    const phone = normalisePhone(phoneInput), t = this.now();
    const recent = this.db.prepare('SELECT created_at FROM codes WHERE phone = ? AND created_at > ? ORDER BY created_at DESC').all(phone, t - 3600_000) as unknown as { created_at: number }[];
    if (recent.length && t - recent[0].created_at < RESEND_GAP_MS) throw new AuthError(429, 'A code was just sent. Wait a minute before asking for another.');
    if (recent.length >= HOURLY_LIMIT) throw new AuthError(429, 'Too many codes for this number. Try again in an hour.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.db.prepare('UPDATE codes SET used = 1 WHERE phone = ? AND used = 0').run(phone);   // only the newest code works
    this.db.prepare('INSERT INTO codes (phone, code_mac, expires_at, created_at) VALUES (?, ?, ?, ?)').run(phone, this.mac(phone, code), t + CODE_TTL_MS, t);
    await this.sms.send(phone, `Your StockRun code is ${code}. It expires in 10 minutes. Never share it with anyone, including StockRun staff.`);
    return { phone };
  }

  /** Check a code; on success create the account if needed (with the chosen role) and start a session. */
  verifyCode(phoneInput: string, code: string, role: Role = 'owner'): { user: User; token: string } {
    const phone = normalisePhone(phoneInput), t = this.now();
    const row = this.db.prepare('SELECT id, code_mac, expires_at, guesses FROM codes WHERE phone = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(phone) as unknown as
      { id: number; code_mac: string; expires_at: number; guesses: number } | undefined;
    if (!row || row.expires_at < t) throw new AuthError(400, 'That code has expired. Ask for a new one.');
    if (row.guesses >= MAX_GUESSES) throw new AuthError(429, 'Too many wrong codes. Ask for a new one.');
    this.db.prepare('UPDATE codes SET guesses = guesses + 1 WHERE id = ?').run(row.id);
    const given = Buffer.from(this.mac(phone, String(code).trim()), 'hex'), want = Buffer.from(row.code_mac, 'hex');
    if (!timingSafeEqual(given, want)) throw new AuthError(400, 'Wrong code. Check the SMS and try again.');
    this.db.prepare('UPDATE codes SET used = 1 WHERE id = ?').run(row.id);

    let u = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as unknown as UserRow | undefined;
    if (!u) {
      if (role !== 'owner' && role !== 'rider') throw new AuthError(400, 'role must be owner or rider');
      this.db.prepare('INSERT INTO users (phone, role, created_at) VALUES (?, ?, ?)').run(phone, role, t);
      u = this.db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as unknown as UserRow;
    }
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), u.id, t + SESSION_TTL_MS);
    return { user: toUser(u), token };
  }

  /** The signed-in user for a session token, or null. */
  session(token: string | undefined): User | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha256(token), this.now()) as unknown as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  signOut(token: string): void { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }

  /** Link the phone's key to the account, once. The phone must prove it holds the key. */
  async linkAddress(user: User, address: Address, signature: Hex): Promise<User> {
    if (user.address) {
      if (user.address.toLowerCase() === address.toLowerCase()) return user;
      throw new AuthError(409, 'This account already has a key. Restore it from your backup instead of making a new one.');
    }
    const ok = await verifyMessage({ address, message: linkMessage(user.id, address), signature }).catch(() => false);
    if (!ok) throw new AuthError(400, 'The signature does not match this key.');
    try { this.db.prepare('UPDATE users SET address = ? WHERE id = ?').run(address.toLowerCase(), user.id); }
    catch { throw new AuthError(409, 'This key is already linked to another account.'); }
    return { ...user, address: getAddress(address) };
  }

  /** Store the phone's PIN-encrypted key backup (the server cannot decrypt it). */
  saveBackup(user: User, b: { ciphertext: string; salt: string; iv: string; kdf: string }): void {
    if (!user.address) throw new AuthError(409, 'Link your key before backing it up.');
    for (const [k, v] of Object.entries(b)) if (typeof v !== 'string' || v.length > 4096) throw new AuthError(400, `bad backup field ${k}`);
    this.db.prepare(`INSERT INTO key_backups (user_id, ciphertext, salt, iv, kdf, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, salt = excluded.salt, iv = excluded.iv, kdf = excluded.kdf, updated_at = excluded.updated_at`)
      .run(user.id, b.ciphertext, b.salt, b.iv, b.kdf, this.now());
  }

  backup(user: User): { ciphertext: string; salt: string; iv: string; kdf: string } | null {
    return (this.db.prepare('SELECT ciphertext, salt, iv, kdf FROM key_backups WHERE user_id = ?').get(user.id) as unknown as { ciphertext: string; salt: string; iv: string; kdf: string } | undefined) ?? null;
  }
}

/** Development sender: prints codes to the server console instead of sending an SMS. Never use in production. */
export class ConsoleSms implements SmsSender {
  readonly sent: { phone: string; text: string }[] = [];
  async send(phone: string, text: string) { this.sent.push({ phone, text }); console.log(`[sms to ${phone}] ${text}`); }
}
