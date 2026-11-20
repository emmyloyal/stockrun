// API, wallet and device helpers for the StockRun app.
import type { Address, Hex } from 'viem';

// ---------------------------------------------------------------- types (mirror agent/src/server/app.ts)
export interface Config {
  chainId: number; network: 'local' | 'xlayer'; token: Address; tokenSymbol: string; explorerTx: string | null;
  naira: { paystack: boolean; test: boolean; testCredit: boolean };
  logistics: { id: string; name: string; api: boolean }[];
  emailSignIn: boolean;
}
export interface User { id: number; phone: string | null; email: string | null; wallet: Address | null; username: string | null; displayName: string | null; hasAvatar: boolean; createdAt: number }
export interface NairaBalance { availableNaira: number; heldNaira: number }
export interface Me { user: User | null; naira?: NairaBalance }
export interface Place { lat: number; lng: number; address: string }
export interface CheckResult {
  status: 'retake' | 'waiting_rider' | 'settled' | 'mismatch' | 'error';
  message: string;
  outcome?: 'paid' | 'paid_part' | 'held' | 'rider_paid' | 'short';
  qty?: number; reason?: number;
}
export interface Evidence { circuit: 'restock' | 'pickup' | 'delivery'; circuitId: string; block: string; input: string; output: string; at: number }
export interface Order {
  orderId: string; item: string; unit: string; quantity: number; createdAt: number;
  supplier: { name: string; lat: number; lng: number }; shop: { name: string; lat: number; lng: number };
  money: 'naira' | 'coins'; self: boolean;
  status: 'None' | 'AwaitingOwner' | 'Locked' | 'PickedUp' | 'Delivered' | 'Refunded';
  ordered: number; unitPriceNaira: number; riderFeeNaira: number;
  pickup: { picked: number; riderCount: number };
  delivery: { delivered: number; aiCounted: boolean; ownerOk: boolean };
  evidence: Evidence[];
  lastCheck: CheckResult | null;
  logistics?: {
    carrier: string; carrierName: string; test: boolean; bookingId?: string;
    state?: 'booked' | 'searching' | 'assigned' | 'picked_up' | 'at_dropoff' | 'delivered' | 'failed' | 'cancelled';
    handoverCode?: string | null; trackingUrl?: string | null; riderName?: string | null; ownerCount?: number; error?: string; pickupSigned?: boolean;
  };
}
export interface RequestRecord { id: number; text: string; budgetNaira: number; place: Place; delivery: 'self' | 'logistics'; message: string; createdAt: number }
export interface Seller {
  id: string; name: string; market: string; lat: number; lng: number; simulated: boolean; verified: boolean; km: number;
  prices: { item: string; priceNaira: number; source: string; age: string | null }[];
}
export interface Movement { key: string; type: string; amountNaira: number; memo: string | null; at: number }
export interface Coins { wallet: Address | null; network?: string; okb?: string; token?: { symbol: string; amount: string; naira: number } }

// ---------------------------------------------------------------- where the server is
// Served by the StockRun server itself: same origin, session cookie. Hosted elsewhere (DeWEB): `stockrun-config.json`
// next to index.html names the server, and the session travels as a bearer token kept on this phone.
let API = '';
const TOKEN_KEY = 'stockrun.session';
const sessionToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setSessionToken = (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };
const authHeaders = (): Record<string, string> => { const t = API ? sessionToken() : null; return t ? { Authorization: `Bearer ${t}` } : {}; };
export const apiBase = () => API;

/** Read `stockrun-config.json` if this copy of the app has one (DeWEB). Call once before anything else. */
export async function loadServerAddress(): Promise<void> {
  try {
    const r = await fetch('stockrun-config.json', { cache: 'no-store' });
    if (!r.ok || !String(r.headers.get('content-type')).includes('json')) return;
    const c = await r.json() as { api?: unknown };
    if (typeof c.api === 'string' && /^https:\/\/[^/]+$/.test(c.api)) API = c.api;
  } catch { /* no config: same origin */ }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, body === undefined
    ? { credentials: API ? 'omit' : 'same-origin', headers: authHeaders() }
    : { method: 'POST', credentials: API ? 'omit' : 'same-origin', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw new Error(json.error ?? `Server error ${r.status}`);
  return json as T;
}
const signedIn = async (p: Promise<{ user: User; token?: string }>) => { const r = await p; if (r.token) setSessionToken(r.token); return r; };

export const server = {
  config: () => call<Config>('/api/config'),
  me: () => call<Me>('/api/me'),
  emailCode: (email: string) => call<{ sent: true }>('/api/auth/email-code', { email }),
  emailVerify: (email: string, code: string) => signedIn(call('/api/auth/email-verify', { email, code })),
  walletMessage: (address: Address) => call<{ message: string }>(`/api/auth/wallet-message?address=${address}`),
  walletSignIn: (message: string, signature: Hex) => signedIn(call('/api/auth/wallet', { message, signature })),
  logout: async () => { try { return await call<{ ok: true }>('/api/auth/logout', {}); } finally { setSessionToken(null); } },
  profile: (p: { username?: string; displayName?: string }) => call<{ user: User }>('/api/me/profile', p),
  avatar: (mediaType: string, data: string) => call<{ user: User }>('/api/me/avatar', { mediaType, data }),
  addWallet: (message: string, signature: Hex) => call<{ user: User }>('/api/me/wallet', { message, signature }),
  coins: () => call<Coins>('/api/me/coins'),
  deposit: (amountNaira: number, email: string) => call<{ reference: string; checkoutUrl: string }>('/api/naira/deposit', { amountNaira, email }),
  confirmDeposit: (reference: string) => call<{ status: string; amountNaira: number; naira: NairaBalance }>('/api/naira/confirm', { reference }),
  testNaira: (amountNaira: number) => call<{ naira: NairaBalance }>('/api/dev/naira', { amountNaira }),
  history: () => call<Movement[]>('/api/naira/history'),
  ask: (r: { text: string; budgetNaira: number; place: Place; delivery: 'self' | 'logistics'; contactPhone?: string }) => call<{ id: number; message: string; problems: string[] }>('/api/requests', r),
  requests: () => call<RequestRecord[]>('/api/requests'),
  orders: () => call<Order[]>('/api/orders'),
  approve: (id: string) => call<{ result: string; reason: string }>(`/api/orders/${id}/approve`, {}),
  collect: (id: string, count: number) => call<CheckResult>(`/api/orders/${id}/collect`, { count }),
  received: (id: string, count: number) => call<{ attestTx: string }>(`/api/orders/${id}/received`, { count }),
  map: (lat: number, lng: number, radiusKm = 25) => call<{ sellers: Seller[] }>(`/api/map?lat=${lat}&lng=${lng}&radius=${radiusKm}`),
};
export const avatarUrl = (userId: number, bust = 0) => `${API}/api/users/${userId}/avatar${bust ? `?v=${bust}` : ''}`;

// ---------------------------------------------------------------- browser wallet (OKX Wallet, MetaMask)
interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
const injected = (): Eip1193 | null => {
  const w = window as unknown as { okxwallet?: Eip1193; ethereum?: Eip1193 };
  return w.okxwallet ?? w.ethereum ?? null;
};
export const hasWallet = () => !!injected();

/** Ask the browser wallet for an address and a signature on StockRun's one-time message. Signing moves no money. */
export async function signWithWallet(getMessage: (a: Address) => Promise<string>): Promise<{ message: string; signature: Hex; address: Address }> {
  const w = injected();
  if (!w) throw new Error('No wallet found. Open StockRun inside the OKX Wallet or MetaMask app, or install their browser extension.');
  const [address] = await w.request({ method: 'eth_requestAccounts' }) as Address[];
  if (!address) throw new Error('The wallet did not share an address.');
  const message = await getMessage(address);
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const signature = await w.request({ method: 'personal_sign', params: [hex, address] }) as Hex;
  return { message, signature, address };
}

// ---------------------------------------------------------------- explorer links
let explorerTx: string | null = null;
export const setExplorer = (base: string | null) => { explorerTx = base; };
export const txUrl = (hash: string) => (explorerTx && /^0x[0-9a-f]{64}$/i.test(hash) ? `${explorerTx}${hash}` : null);

// ---------------------------------------------------------------- device helpers
export function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location permission was refused.' : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });
}

/** Shrink a photo to a square-ish JPEG of at most `max` px, for uploads on mobile data. */
export async function preparePhoto(file: File, max = 1600, quality = 0.85): Promise<{ mediaType: string; data: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the photo.'))), 'image/jpeg', quality));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', data: btoa(bin), previewUrl: URL.createObjectURL(blob) };
}

export const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
export function load<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } }
export function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
