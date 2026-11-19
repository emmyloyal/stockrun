// The phone's signing key. It is made here, in the browser, and never sent to the server in readable form.
// - Kept on this phone in localStorage, one per account.
// - Backed up to the server encrypted with a PIN the server never sees: PBKDF2-SHA256 (600,000 rounds) turns the PIN
//   into an AES-256-GCM key. The server stores only ciphertext, salt and IV, and returns them after an SMS sign-in, so a
//   new phone can restore the key with the PIN. Without the key the owner cannot withdraw from their vault, so the
//   backup is required before a shop is set up.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import type { Backup } from './lib';

const KDF = 'pbkdf2-sha256-600000-aesgcm256';
const ROUNDS = 600_000;
const slot = (userId: number) => `stockrun.key.${userId}`;

export function localKey(userId: number): Hex | null {
  try { const k = localStorage.getItem(slot(userId)); return k && /^0x[0-9a-f]{64}$/i.test(k) ? (k as Hex) : null; } catch { return null; }
}
export function storeKey(userId: number, key: Hex): void {
  try { localStorage.setItem(slot(userId), key); }
  catch { throw new Error('This browser will not store the key (private mode?). Use a normal browser window.'); }
  if (localKey(userId) !== key) throw new Error('This browser did not keep the key. Use a normal browser window.');
}
export const newKey = (): Hex => generatePrivateKey();
export const addressOf = (key: Hex): Address => privateKeyToAccount(key).address;
export const signLink = (key: Hex, message: string) => privateKeyToAccount(key).signMessage({ message });

/** PINs: 6 digits, not all the same digit and not a straight run. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) return 'Use exactly 6 digits.';
  if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'That PIN is too easy to guess.';
  return null;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptKey(key: Hex, pin: string): Promise<Backup> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(pin, salt), new TextEncoder().encode(key)));
  return { ciphertext: b64(ct), salt: b64(salt), iv: b64(iv), kdf: KDF };
}

/** Decrypt a backup; checks that it really is the key for `expected`. */
export async function decryptKey(b: Backup, pin: string, expected: Address): Promise<Hex> {
  if (b.kdf !== KDF) throw new Error('This backup was made by a different app version.');
  let key: string;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) as BufferSource }, await aesKey(pin, unb64(b.salt)), unb64(b.ciphertext) as BufferSource);
    key = new TextDecoder().decode(pt);
  } catch { throw new Error('Wrong PIN.'); }
  if (!/^0x[0-9a-f]{64}$/i.test(key) || addressOf(key as Hex).toLowerCase() !== expected.toLowerCase()) throw new Error('This backup does not match your account.');
  return key as Hex;
}
