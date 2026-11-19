import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Accounts, ConsoleSms, openDb, normalisePhone, linkMessage, CODE_TTL_MS, AuthError } from '../src/accounts/accounts.ts';

const SECRET = 'test-secret-that-is-long-enough-1234567890';
function setup() {
  let t = 1_800_000_000_000;
  const sms = new ConsoleSms();
  const acc = new Accounts(openDb(), sms, SECRET, () => t);
  const lastCode = () => sms.sent.at(-1)!.text.match(/(\d{6})/)![1];
  return { acc, sms, lastCode, tick: (ms: number) => { t += ms; } };
}
const quiet = <T>(f: () => T) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };

describe('phone numbers', () => {
  it('normalises Nigerian numbers and rejects junk', () => {
    expect(normalisePhone('0803 123 4567')).toBe('+2348031234567');
    expect(normalisePhone('+234 (803) 123-4567')).toBe('+2348031234567');
    expect(normalisePhone('2348031234567')).toBe('+2348031234567');
    expect(normalisePhone('+447700900123')).toBe('+447700900123');
    expect(() => normalisePhone('12345')).toThrow(AuthError);
    expect(() => normalisePhone('0603 123 4567')).toThrow(AuthError);
  });
});

describe('sign-in with an SMS code', () => {
  it('creates the account on the first correct code and starts a session', async () => {
    const { acc, sms, lastCode } = setup();
    await quiet(() => acc.requestCode('0803 123 4567'));
    expect(sms.sent[0].phone).toBe('+2348031234567');
    expect(sms.sent[0].text).toMatch(/Never share it/);
    const { user, token } = acc.verifyCode('08031234567', lastCode(), 'owner');
    expect(user).toMatchObject({ phone: '+2348031234567', role: 'owner', address: null });
    expect(acc.session(token)?.id).toBe(user.id);
    acc.signOut(token);
    expect(acc.session(token)).toBeNull();
  });

  it('rejects wrong, reused, expired and brute-forced codes', async () => {
    const { acc, lastCode, tick } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const code = lastCode();
    expect(() => acc.verifyCode('08031234567', code === '000000' ? '111111' : '000000')).toThrow(/Wrong code/);
    acc.verifyCode('08031234567', code);
    expect(() => acc.verifyCode('08031234567', code)).toThrow(/expired/); // used codes do not work twice

    tick(61_000); await quiet(() => acc.requestCode('08031234567'));
    tick(CODE_TTL_MS + 1);
    expect(() => acc.verifyCode('08031234567', lastCode())).toThrow(/expired/);

    tick(61_000); await quiet(() => acc.requestCode('08031234567'));
    const right = lastCode(), wrong = right === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) expect(() => acc.verifyCode('08031234567', wrong)).toThrow(/Wrong code/);
    expect(() => acc.verifyCode('08031234567', right)).toThrow(/Too many wrong codes/); // locked even with the right code
  });

  it('limits how often codes are sent, and only the newest code works', async () => {
    const { acc, lastCode, tick } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const first = lastCode();
    await expect(acc.requestCode('08031234567')).rejects.toThrow(/Wait a minute/);
    tick(61_000); await quiet(() => acc.requestCode('08031234567'));
    expect(() => acc.verifyCode('08031234567', first)).toThrow();
    for (let i = 0; i < 3; i++) { tick(61_000); await quiet(() => acc.requestCode('08031234567')); }
    tick(61_000);
    await expect(acc.requestCode('08031234567')).rejects.toThrow(/Too many codes/);
  });

  it('never stores codes or session tokens in plain text', async () => {
    const db = openDb(); const sms = new ConsoleSms();
    const acc = new Accounts(db, sms, SECRET);
    await quiet(() => acc.requestCode('08031234567'));
    const code = sms.sent[0].text.match(/(\d{6})/)![1];
    const { token } = acc.verifyCode('08031234567', code);
    const dump = JSON.stringify([db.prepare('SELECT * FROM codes').all(), db.prepare('SELECT * FROM sessions').all()]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(token);
  });
});

describe('the phone key', () => {
  it('links once, only with a matching signature, and backs up ciphertext only', async () => {
    const { acc, lastCode } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const { user } = acc.verifyCode('08031234567', lastCode());
    const phoneKey = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());

    const forged = await other.signMessage({ message: linkMessage(user.id, phoneKey.address) });
    await expect(acc.linkAddress(user, phoneKey.address, forged)).rejects.toThrow(/does not match/);
    expect(() => acc.saveBackup(user, { ciphertext: 'x', salt: 'y', iv: 'z', kdf: 'pbkdf2' })).toThrow(/Link your key/);

    const sig = await phoneKey.signMessage({ message: linkMessage(user.id, phoneKey.address) });
    const linked = await acc.linkAddress(user, phoneKey.address, sig);
    expect(linked.address).toBe(phoneKey.address);
    const sig2 = await other.signMessage({ message: linkMessage(user.id, other.address) });
    await expect(acc.linkAddress(linked, other.address, sig2)).rejects.toThrow(/already has a key/);

    acc.saveBackup(linked, { ciphertext: 'c1', salt: 's', iv: 'i', kdf: 'pbkdf2-sha256-600000' });
    acc.saveBackup(linked, { ciphertext: 'c2', salt: 's', iv: 'i', kdf: 'pbkdf2-sha256-600000' });
    expect(acc.backup(linked)).toEqual({ ciphertext: 'c2', salt: 's', iv: 'i', kdf: 'pbkdf2-sha256-600000' });
  });
});
