// API, wallet and device helpers for the StockRun app.
import type { Address, Hex } from 'viem';

// ---------------------------------------------------------------- types (mirror agent/src/server/app.ts)
export interface Config {
  chainId: number; network: 'local' | 'xlayer'; token: Address; tokenSymbol: string; explorerTx: string | null;
  naira: { paystack: boolean; test: boolean; testCredit: boolean; fee?: { percent: number; minNaira: number; maxNaira: number } };
  logistics: { id: string; name: string; api: boolean }[];
  emailSignIn: boolean;
  chat?: boolean;
  business?: { feeNaira: number; periodDays: number } | null;
  withdrawals?: boolean;
  sellerBankLinks?: boolean;
  sellerHunt: boolean;
}
export interface User { id: number; phone: string | null; email: string | null; wallet: Address | null; username: string | null; displayName: string | null; hasAvatar: boolean; createdAt: number; role?: 'buyer' | 'shop' }
export interface NairaBalance { availableNaira: number; heldNaira: number }
export interface Me { user: User | null; naira?: NairaBalance; admin?: boolean }
export interface Bank { bankName: string; accountNumber: string; accountName: string; bankCode?: string | null; approved?: boolean; source?: 'admin' | 'seller' }
export interface Withdrawal { reference: string; amountKobo: number; bankName: string; accountNumber: string; accountName: string; status: 'sending' | 'sent' | 'failed'; note: string | null; at: number }
export interface Payout {
  orderId: number; amountNaira: number; approvedAt: number; status: 'owed' | 'held' | 'paid'; buyer: string;
  seller: { key: string; name: string; phone: string | null }; bank: Bank | null; reference: string | null; note: string | null; paidAt: number | null; paidBy: string | null;
}
export interface AdminOverview {
  totals: { listingsNaira?: number; feesNaira?: number; lockedNaira: number; buyersAvailableNaira: number; owedSellersNaira: number; owedLogisticsNaira: number; paidOutNaira: number; heldPayouts: number };
  payouts: Payout[]; log: { admin: string; action: string; orderId: number | null; detail: string; at: number }[];
  paystackPayouts?: boolean; paystackTest?: boolean;
  contacts: Contact[];
}
export interface Contact {
  at: number; action: 'drafted_message' | 'opened_whatsapp' | 'opened_chat' | 'recorded_deal' | 'deal_refused'; detail: string | null;
  buyer: { id: number; label: string };
  seller: { id: string; name: string; phone: string | null; address: string | null; kind: string | null; source: string | null; sourceUrl: string | null };
}
export interface AdminOrder { orderId: number; buyerId: number; buyer: string; sellerPhone: string | null; status: string; ordered: number; picked: number; unitPriceNaira: number; totalNaira: number; deliveryFeeNaira: number; serviceFeeNaira?: number; self: boolean; createdAt: number; circuits: string[]; seller: string }
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
  ordered: number; unitPriceNaira: number; riderFeeNaira: number; serviceFeeNaira?: number;
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
/** A seller the AI found on Google Maps or the web: real, but not confirmed by StockRun. */
export interface FoundSeller { id: string; name: string; kind?: string | null; address: string; lat: number; lng: number; phone: string; source: 'maps' | 'osm' | 'web' | 'listed'; sourceUrl: string | null; km: number; listed?: boolean; products?: { item: string; unit: string; priceNaira: number }[] }
export interface Business {
  sellerId: string; name: string; kind: string; address: string; lat: number; lng: number; phone: string; products: { item: string; unit: string; priceNaira: number }[];
  paidUntil: number; live: boolean; suspended: boolean; suspendedNote: string | null; createdAt: number; review: 'pending' | 'approved' | 'rejected'; reviewNote: string | null;
  owner?: { id: number; label: string }; bank?: { bankName: string; accountName: string; accountNumber: string; approved?: boolean } | null;
}
export interface ChatSummary { id: number; role: 'buyer' | 'shop'; store: { sellerId: string; name: string }; buyer: { id: number; label: string }; last: { text: string; from: 'buyer' | 'shop'; at: number } | null; unread: number; updatedAt: number }
export interface ChatMessage { id: number; from: 'buyer' | 'shop'; text: string; at: number }
export interface SellerHit { id: string; name: string; kind: string | null; address: string; lat: number; lng: number; phone: string | null; source: 'maps' | 'osm' | 'web' | 'demo'; sourceUrl: string | null; km: number; demo: boolean }
export interface PlaceHit { name: string; address: string; lat: number; lng: number; kind: string }
export interface MySeller { sellerId: string; status: 0 | 1 | 3; pendingStatus: 1 | null; effectiveAt: number | null; addedAt: number }
export type Category = 'staples' | 'drinks' | 'cooking' | 'toiletries' | 'snacks' | 'household' | 'restricted' | 'highValue';
export interface DealResult { status: 'locked' | 'ask_owner' | 'rejected' | 'too_large' | 'circuit_failed' | 'no_rider'; orderId?: string; reason?: number; message: string }
export interface HuntResult { place: Place & { matched: string }; searches: string[]; shopTypes: string[]; checked: number; dropped: number; sellers: FoundSeller[] }
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
  search: (q: string, near?: { lat: number; lng: number }) => call<{ sellers: SellerHit[]; places: PlaceHit[] }>(`/api/search?${new URLSearchParams({ q, ...(near ? { lat: String(near.lat), lng: String(near.lng) } : {}) })}`),
  messageDraft: (sellerId: string, text: string, place: Place, delivery: 'self' | 'logistics') =>
    call<{ seller: { id: string; name: string; phone: string }; message: string; ai: boolean; whatsappUrl: string }>(`/api/sellers/${sellerId}/message`, { text, place, delivery }),
  mySeller: (id: string) => call<MySeller>(`/api/my-sellers/${id}`),
  addSeller: (id: string) => call<MySeller>(`/api/my-sellers/${id}`, {}),
  blockSeller: (id: string) => call<MySeller>(`/api/my-sellers/${id}/block`, {}),
  recordDeal: (d: { sellerId: string; item: string; quantity: number; unit: string; unitPriceNaira: number; category: Category; delivery: 'self' | 'logistics'; place: Place; contactPhone?: string }) =>
    call<DealResult>('/api/deals', d),
  sellerOpened: (sellerId: string) => call<{ ok: true }>(`/api/sellers/${sellerId}/opened`, {}),
  adminOverview: () => call<AdminOverview>('/api/admin/overview'),
  adminOrders: () => call<AdminOrder[]>('/api/admin/orders'),
  banks: () => call<{ name: string; code: string }[]>('/api/banks'),
  sellerBankLink: (sellerId: string) => call<{ url: string; message: string; whatsappUrl: string | null }>(`/api/sellers/${sellerId}/bank-link`, {}),
  sellerBankInfo: (sellerId: string, t: string) => call<{ name: string; transfers: boolean; test: boolean }>(`/api/seller-bank/${sellerId}?t=${encodeURIComponent(t)}`),
  sellerBankSubmit: (sellerId: string, t: string, b: { bankCode: string; accountNumber: string }) => call<{ accountName: string; bankName: string }>(`/api/seller-bank/${sellerId}`, { t, ...b }),
  setRole: (role: 'buyer' | 'shop') => call<{ user: User }>('/api/me/role', { role }),
  myBusiness: () => call<{ business: Business | null; feeNaira: number; periodDays: number; bankLinked: { bankName: string; accountName: string; approved?: boolean } | null }>('/api/business'),
  saveBusiness: (b: { name: string; kind: string; address: string; phone: string; products: { item: string; unit: string; priceNaira: number }[] }) => call<Business>('/api/business', b),
  payBusiness: (key: string) => call<Business>('/api/business/pay', { key }),
  businessBank: (b: { bankCode: string; accountNumber: string }) => call<{ accountName: string; bankName: string }>('/api/business/bank', b),
  adminBusinesses: () => call<Business[]>('/api/admin/businesses'),
  adminReviewBusiness: (sellerId: string, approve: boolean, note: string) => call<Business>(`/api/admin/businesses/${sellerId}/review`, { approve, note }),
  adminSuspendBusiness: (sellerId: string, suspended: boolean, note: string) => call<Business>(`/api/admin/businesses/${sellerId}/suspend`, { suspended, note }),
  chats: () => call<{ chats: ChatSummary[]; unread: number }>('/api/chats'),
  openChat: (sellerId: string) => call<ChatSummary>('/api/chats', { sellerId }),
  chatMessages: (id: number, after: number) => call<ChatMessage[]>(`/api/chats/${id}/messages?after=${after}`),
  chatSend: (id: number, text: string) => call<ChatMessage>(`/api/chats/${id}/messages`, { text }),
  depositQuote: (amountNaira: number) => call<{ amountNaira: number; chargeNaira: number; totalNaira: number }>(`/api/naira/deposit-quote?amountNaira=${amountNaira}`),
  withdraw: (amountNaira: number, bankCode: string, accountNumber: string) => call<Withdrawal>('/api/naira/withdraw', { amountNaira, bankCode, accountNumber }),
  withdrawals: () => call<Withdrawal[]>('/api/naira/withdrawals'),
  adminApproveBank: (orderId: number) => call<Payout>(`/api/admin/payouts/${orderId}/approve-bank`, {}),
  adminPayNow: (orderId: number) => call<{ result: string; payout: Payout | null }>(`/api/admin/payouts/${orderId}/pay`, {}),
  adminBank: (orderId: number, b: Bank) => call<Payout>(`/api/admin/payouts/${orderId}/bank`, b),
  adminHold: (orderId: number, hold: boolean, note: string) => call<Payout>(`/api/admin/payouts/${orderId}/hold`, { hold, note }),
  adminPaid: (orderId: number, reference: string) => call<Payout>(`/api/admin/payouts/${orderId}/paid`, { reference }),
  hunt: (text: string, place: Place, budgetNaira: number) => call<HuntResult>('/api/hunt', { text, place, budgetNaira }),
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
  collect: (id: string, count: number, at?: { lat: number; lng: number; accuracy: number }) =>
    call<CheckResult & { location?: { atSupplier: boolean; metres: number | null } }>(`/api/orders/${id}/collect`, { count, ...at }),
  received: (id: string, count: number) => call<{ attestTx: string }>(`/api/orders/${id}/received`, { count }),
  map: (lat: number, lng: number, radiusKm = 25) => call<{ sellers: Seller[]; found: FoundSeller[] }>(`/api/map?lat=${lat}&lng=${lng}&radius=${radiusKm}`),
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

/** wa.me link: opens the person's own WhatsApp on a chat with this number, with the message typed in. */
export const whatsappLink = (phone: string, message: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
/** StockRun's service fee on goods worth `goodsNaira` (same rule as the server). */
export const serviceFee = (goodsNaira: number, f?: { percent: number; minNaira: number; maxNaira: number }) =>
  !f || f.percent <= 0 || goodsNaira <= 0 ? 0 : Math.min(f.maxNaira || Infinity, Math.max(f.minNaira, Math.floor(goodsNaira * f.percent) / 100));
export const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
export function load<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } }
export function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
