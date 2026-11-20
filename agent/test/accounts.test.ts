import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Accounts, ConsoleSms, openDb, normalisePhone, CODE_TTL_MS, WALLET_MSG_TTL_MS, AuthError } from '../src/accounts/accounts.ts';

const SECRET = 'test-secret-that-is-long-enough-1234567890';
function setup() {
  let t = 1_800_000_000_000;
  const sms = new ConsoleSms();
  const acc = new Accounts(openDb(), sms, SECRET, () => t);
  const lastCode = () => sms.sent.at(-1)!.text.match(/(\d{6})/)![1];
  return { acc, sms, lastCode, tick: (ms: number) => { t += ms; } };
}
const quiet = <T>(f: () => T) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100, 7)]);

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
    const { user, token } = acc.verifyCode('08031234567', lastCode());
    expect(user).toMatchObject({ phone: '+2348031234567', wallet: null, username: null, hasAvatar: false });
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

describe('sign-in with a wallet', () => {
  it('creates the account on the first valid signature; the same wallet signs into the same account', async () => {
    const { acc } = setup();
    const w = privateKeyToAccount(generatePrivateKey());
    const { message } = acc.walletChallenge(w.address);
    expect(message).toMatch(/costs nothing and moves no money/);
    const { user, token } = await acc.verifyWallet(message, await w.signMessage({ message }));
    expect(user).toMatchObject({ wallet: w.address, phone: null });
    expect(acc.session(token)?.id).toBe(user.id);
    const again = acc.walletChallenge(w.address.toLowerCase()).message;
    expect((await acc.verifyWallet(again, await w.signMessage({ message: again }))).user.id).toBe(user.id);
  });

  it('refuses another wallet\'s signature, a reused or expired message, and an edited message', async () => {
    const { acc, tick } = setup();
    const w = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
    const { message } = acc.walletChallenge(w.address);
    await expect(acc.verifyWallet(message, await other.signMessage({ message }))).rejects.toThrow(/does not match/);
    const sig = await w.signMessage({ message });
    await acc.verifyWallet(message, sig);
    await expect(acc.verifyWallet(message, sig)).rejects.toThrow(/expired/);                     // works once
    const late = acc.walletChallenge(w.address).message;
    tick(WALLET_MSG_TTL_MS + 1);
    await expect(acc.verifyWallet(late, await w.signMessage({ message: late }))).rejects.toThrow(/expired/);
    const m3 = acc.walletChallenge(w.address).message, edited = m3.replace('moves no money', 'moves money');
    await expect(acc.verifyWallet(edited, await w.signMessage({ message: edited }))).rejects.toThrow(/expired/);
    await expect(acc.verifyWallet('hello', '0x00')).rejects.toThrow(/not a StockRun sign-in message/);
  });

  it('one person, one account: a phone account adds a wallet and a wallet account adds a phone, never someone else\'s', async () => {
    const { acc, lastCode, tick } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const ada = acc.verifyCode('08031234567', lastCode()).user;
    const w = privateKeyToAccount(generatePrivateKey());
    const m = acc.walletChallenge(w.address).message;
    const withWallet = await acc.addWallet(ada, m, await w.signMessage({ message: m }));
    expect(withWallet).toMatchObject({ phone: '+2348031234567', wallet: w.address });
    const m2 = acc.walletChallenge(w.address).message;
    expect((await acc.verifyWallet(m2, await w.signMessage({ message: m2 }))).user.id).toBe(ada.id);   // wallet sign-in finds Ada

    const w2 = privateKeyToAccount(generatePrivateKey());
    const m3 = acc.walletChallenge(w2.address).message;
    const bisi = (await acc.verifyWallet(m3, await w2.signMessage({ message: m3 }))).user;
    tick(61_000); await quiet(() => acc.requestCode('08031234567'));
    expect(() => acc.addPhone(bisi, '08031234567', lastCode())).toThrow(/already has its own/);
    tick(61_000); await quiet(() => acc.requestCode('08059999999'));
    expect(acc.addPhone(bisi, '08059999999', lastCode())).toMatchObject({ phone: '+2348059999999', wallet: w2.address });
  });
});

describe('profiles', () => {
  it('usernames are unique (any case) and well-formed; names are trimmed', async () => {
    const { acc, lastCode, tick } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const a = acc.verifyCode('08031234567', lastCode()).user;
    tick(61_000); await quiet(() => acc.requestCode('08051234567'));
    const b = acc.verifyCode('08051234567', lastCode()).user;
    expect(acc.setProfile(a, { username: 'Ada_Lagos', displayName: '  Ada   Obi ' })).toMatchObject({ username: 'Ada_Lagos', displayName: 'Ada Obi' });
    expect(() => acc.setProfile(b, { username: 'ada_lagos' })).toThrow(/taken/);
    expect(() => acc.setProfile(b, { username: 'a b' })).toThrow(/3 to 20/);
    expect(() => acc.setProfile(b, { username: 'x'.repeat(21) })).toThrow(/3 to 20/);
    expect(acc.setProfile(a, { username: 'ada_lagos' }).username).toBe('ada_lagos');           // own name, new case
    expect(acc.publicProfile(a.id)).toEqual({ id: a.id, username: 'ada_lagos', displayName: 'Ada Obi', hasAvatar: false });
  });

  it('profile pictures: real JPEG/PNG/WebP only, under 300 KB', async () => {
    const { acc, lastCode } = setup();
    await quiet(() => acc.requestCode('08031234567'));
    const u = acc.verifyCode('08031234567', lastCode()).user;
    expect(acc.setAvatar(u, JPEG, 'image/jpeg').hasAvatar).toBe(true);
    expect(acc.avatar(u.id)).toEqual({ data: JPEG, type: 'image/jpeg' });
    acc.setAvatar(u, PNG, 'image/png');
    expect(acc.avatar(u.id)?.type).toBe('image/png');
    expect(() => acc.setAvatar(u, PNG, 'image/jpeg')).toThrow(/not the picture/);
    expect(() => acc.setAvatar(u, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).toThrow(/JPEG, PNG or WebP/);
    expect(() => acc.setAvatar(u, Buffer.concat([JPEG, Buffer.alloc(300_000)]), 'image/jpeg')).toThrow(/too big/);
  });
});
