import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts, AuthError, ConsoleSms, normaliseEmail, openDb } from '../src/accounts/accounts.ts';
import { ConsoleEmail, GmailSender, emailFromEnv, rawEmail } from '../src/accounts/email.ts';

const SECRET = 'test-secret-that-is-long-enough-1234567890';
const quiet = async <T>(f: () => Promise<T>) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const setup = () => {
  const mail = new ConsoleEmail();
  const acc = new Accounts(openDb(), new ConsoleSms(), SECRET, Date.now, null, mail);
  const lastCode = () => mail.sent.at(-1)!.text.match(/(\d{6})/)![1];
  return { acc, mail, lastCode };
};

describe('email addresses', () => {
  it('normalises and rejects junk', () => {
    expect(normaliseEmail('  Ada.Obi@Gmail.COM ')).toBe('ada.obi@gmail.com');
    for (const bad of ['ada', 'ada@gmail', '@gmail.com', 'a b@gmail.com', 'ada@gmail.com\r\nBcc: x@y.com']) expect(() => normaliseEmail(bad)).toThrow(AuthError);
  });
});

describe('sign-in with an emailed code', () => {
  it('emails a code, creates the account on the first correct code, and the session survives', async () => {
    const { acc, mail, lastCode } = setup();
    await quiet(() => acc.requestEmailCode('Ada@Gmail.com'));
    expect(mail.sent[0].to).toBe('ada@gmail.com');
    expect(mail.sent[0].subject).toBe(`${lastCode()} is your StockRun code`);
    expect(mail.sent[0].text).toMatch(/Never share it/);
    const { user, token } = acc.verifyEmailCode('ada@gmail.com', lastCode());
    expect(user).toMatchObject({ email: 'ada@gmail.com', phone: null, wallet: null });
    expect(acc.session(token)?.id).toBe(user.id);
    expect(acc.publicProfile(user.id)).not.toHaveProperty('email');
  });

  it('rejects a wrong code, an old code, and quick resends', async () => {
    const { acc, lastCode } = setup();
    await quiet(() => acc.requestEmailCode('ada@gmail.com'));
    const code = lastCode();
    expect(() => acc.verifyEmailCode('ada@gmail.com', code === '000000' ? '111111' : '000000')).toThrow(/Wrong code/);
    await expect(quiet(() => acc.requestEmailCode('ada@gmail.com'))).rejects.toThrow(/Wait a minute/);
    acc.verifyEmailCode('ada@gmail.com', code);
    expect(() => acc.verifyEmailCode('ada@gmail.com', code)).toThrow(/expired/);
  });

  it('a phone code cannot sign in an email address', async () => {
    const sms = new ConsoleSms();
    const acc = new Accounts(openDb(), sms, SECRET, Date.now, null, new ConsoleEmail());
    await quiet(() => acc.requestCode('0803 123 4567'));
    const code = sms.sent[0].text.match(/(\d{6})/)![1];
    expect(() => acc.verifyEmailCode('ada@gmail.com', code)).toThrow(/expired/);
  });

  it('is switched off without a mail sender', async () => {
    const acc = new Accounts(openDb(), new ConsoleSms(), SECRET);
    expect(acc.emailSignIn).toBe(false);
    await expect(acc.requestEmailCode('ada@gmail.com')).rejects.toThrow(/not switched on/);
  });

  it('upgrades a database made before email sign-in, keeping its users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-')), file = join(dir, 'old.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT UNIQUE, wallet TEXT UNIQUE, username TEXT UNIQUE COLLATE NOCASE,
      display_name TEXT, avatar BLOB, avatar_type TEXT, created_at INTEGER NOT NULL, CHECK (phone IS NOT NULL OR wallet IS NOT NULL));
      INSERT INTO users (phone, username, created_at) VALUES ('+2348031234567', 'ada', 1);`);
    old.close();
    const db = openDb(file);
    expect(db.prepare('SELECT phone, email, username FROM users').get()).toEqual({ phone: '+2348031234567', email: null, username: 'ada' });
    db.prepare("INSERT INTO users (email, created_at) VALUES ('b@x.com', 2)").run();
    db.close(); rmSync(dir, { recursive: true, force: true });
  });
});

describe('Gmail sender', () => {
  it('builds a plain-text message and refuses header injection', () => {
    const raw = Buffer.from(rawEmail('StockRun <s@gmail.com>', 'ada@gmail.com', '123456 is your StockRun code', 'Hello ₦'), 'base64url').toString('utf8');
    expect(raw).toMatch(/^From: StockRun <s@gmail.com>\r\nTo: ada@gmail.com\r\nSubject: 123456 is your StockRun code\r\n/);
    expect(Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString('utf8')).toBe('Hello ₦');
    expect(() => rawEmail('s@gmail.com', 'a@b.com\r\nBcc: x@y.com', 's', 't')).toThrow(/line breaks/);
  });

  it('swaps the refresh token for an access token once, then sends', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.includes('oauth2')) {
        expect(String(init.body)).toContain('grant_type=refresh_token');
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const g = new GmailSender({ clientId: 'c', clientSecret: 's', refreshToken: 'r', from: 'StockRun <s@gmail.com>', fetch: f });
    await g.send('ada@gmail.com', 'x', 'y');
    await g.send('ada@gmail.com', 'x', 'y');
    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('messages/send'))).toHaveLength(2);
  });

  it('says to run the setup again when Google revokes the refresh token', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })) as unknown as typeof fetch;
    await expect(new GmailSender({ clientId: 'c', clientSecret: 's', refreshToken: 'r', from: 'x', fetch: f }).send('a@b.com', 's', 't')).rejects.toThrow(/gmail:auth/);
  });

  it('is chosen only when all four GMAIL_* settings are present', () => {
    const all = { GMAIL_CLIENT_ID: 'c', GMAIL_CLIENT_SECRET: 's', GMAIL_REFRESH_TOKEN: 'r', GMAIL_FROM: 'stockrun@gmail.com' };
    expect(emailFromEnv(all, false).kind).toBe('Gmail from stockrun@gmail.com');
    expect(emailFromEnv({ ...all, GMAIL_REFRESH_TOKEN: '' }, false).mail).toBeNull();
    expect(emailFromEnv({}, true).kind).toMatch(/^console/);
  });
});
