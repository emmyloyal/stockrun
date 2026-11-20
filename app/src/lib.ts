// API, chain and device helpers for the app.
import { createPublicClient, createWalletClient, http, parseAbi, BaseError, ContractFunctionRevertedError, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

// ---------------------------------------------------------------- API types (mirror agent/src/server/api.ts)
export interface Place { name: string; lat: number; lng: number }
export interface CheckResult {
  status: 'retake' | 'waiting_rider' | 'settled' | 'mismatch' | 'error';
  message: string;
  outcome?: 'paid' | 'paid_part' | 'held' | 'rider_paid' | 'short';
  qty?: number; reason?: number; aiCount?: number; expected?: number; damage?: boolean; attestTx?: Hex; settleTx?: Hex;
}
export interface Order {
  orderId: string; item: string; unit: string; quantity: number; rider: Address; supplier: Place; shop: Place; createdAt: number;
  status: 'None' | 'AwaitingOwner' | 'Locked' | 'PickedUp' | 'Delivered' | 'Refunded';
  ordered: number; unitPriceNaira: number; riderFeeNaira: number;
  pickup: { atSupplier: boolean; riderCounted: boolean; riderCount: number; aiCounted: boolean; aiCount: number; damage: boolean; picked: number };
  delivery: { atShop: boolean; arrivedAt: number; aiCounted: boolean; delivered: number; damage: boolean; ownerOk: boolean; ownerIssue: boolean };
  lastCheck: CheckResult | null;
  /** Set when a logistics company delivers (real-account server). */
  logistics?: {
    carrier: string; carrierName: string; test: boolean; bookingId?: string;
    state?: 'booked' | 'searching' | 'assigned' | 'picked_up' | 'at_dropoff' | 'delivered' | 'failed' | 'cancelled';
    handoverCode?: string | null; trackingUrl?: string | null; riderName?: string | null; ownerCount?: number; error?: string; pickupSigned?: boolean;
  };
}
export interface MapData {
  shop: Place;
  /** Multi-shop server only: StockRun's payout account that supplier approvals point at. */
  supplierPayout?: Address;
  suppliers: { id: string; key?: Hex; name: string; market: string; lat: number; lng: number; simulated: boolean; status: number; km: number;
    pending?: { status: number; effectiveAt: number } | null;
    prices: { item: string; priceNaira: number; source: 'deal' | 'quote' | 'price_list' | 'catalogue'; age: string | null }[] }[];
}
export interface Config { chainId: number; vault: Address; photoCheck: boolean; demoKeys: { owner: Hex; rider: Hex } | null }

// ---------------------------------------------------------------- multi-shop server (mirror agent/src/server/app.ts)
export interface ServerConfig {
  chainId: number; network: 'local' | 'xlayer'; token: Address; tokenSymbol: string; explorerTx: string | null;
  photoCheck: boolean; testMoney: boolean; devTime: boolean;
}
export type AnyConfig = Config | ServerConfig;
export const isServer = (c: AnyConfig): c is ServerConfig => 'network' in c;
export interface User { id: number; phone: string; role: 'owner' | 'rider'; address: Address | null; createdAt: number }
export interface Shop { id: number; name: string; lat: number; lng: number; vault: Address; weeklyBudgetNaira: number; limitNaira: number }
export interface Me { user: User | null; shop?: Shop | null; hasBackup?: boolean }
export interface Backup { ciphertext: string; salt: string; iv: string; kdf: string }
export interface ShopMoney {
  vault: Address; vaultNaira: number; lockedNaira: number; availableNaira: number; walletNaira: number;
  weeklyBudgetNaira: number; spentThisWeekNaira: number; limitNaira: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw new Error(json.error ?? `Server error ${r.status}`);
  return json as T;
}
export const api = {
  config: () => call<Config>('/api/config'),
  orders: () => call<Order[]>('/api/orders'),
  map: () => call<MapData>('/api/map'),
  riderJobs: (rider: Address) => call<Order[]>(`/api/riders/${rider}/jobs`),
  placeOrder: (text: string, delivery: 'self' | 'logistics' = 'logistics') => call<{ message: string; problems: string[] }>('/api/orders', { text, delivery }),
  photo: (id: string, stage: 'pickup' | 'delivery', photo: { mediaType: string; data: string }) => call<CheckResult>(`/api/orders/${id}/photo`, { stage, ...photo }),
  settle: (id: string, stage: 'pickup' | 'delivery') => call<CheckResult>(`/api/orders/${id}/settle`, { stage }),
  confirmCount: (id: string, stage: 'pickup' | 'delivery') => call<CheckResult>(`/api/orders/${id}/confirm-count`, { stage }),
  /** Owner's count at the door for a logistics delivery. */
  received: (id: string, count: number) => call<{ attestTx: Hex }>(`/api/orders/${id}/received`, { count }),
};
export const server = {
  config: () => call<ServerConfig>('/api/config'),
  me: () => call<Me>('/api/me'),
  requestCode: (phone: string) => call<{ sent: true }>('/api/auth/code', { phone }),
  verify: (phone: string, code: string, role: 'owner' | 'rider') => call<{ user: User }>('/api/auth/verify', { phone, code, role }),
  logout: () => call<{ ok: true }>('/api/auth/logout', {}),
  linkMessage: (address: Address) => call<{ message: string }>(`/api/me/link-message?address=${address}`),
  linkKey: (address: Address, signature: Hex) => call<{ user: User }>('/api/me/key', { address, signature }),
  backup: () => call<{ backup: Backup | null }>('/api/me/backup'),
  saveBackup: (b: Backup) => call<{ ok: true }>('/api/me/backup', b),
  gas: () => call<{ tx: Hex | null; already: boolean }>('/api/me/gas', {}),
  testMoney: () => call<{ ok: true }>('/api/me/test-money', {}),
  createShop: (s: { name: string; lat: number; lng: number; weeklyBudgetNaira: number; limitNaira: number }) => call<{ shop: Shop }>('/api/shop', s),
  money: () => call<ShopMoney>('/api/shop/money'),
  toToken: (naira: number) => call<{ naira: number; amount: string; symbol: string }>(`/api/money/to-token?naira=${naira}`),
};

// ---------------------------------------------------------------- chain: each person signs their own steps
const vaultAbi = parseAbi([
  'function deposit(uint256 amount)',
  'function queueSupplier(bytes32 id, uint8 status, address payout)',
  'function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)',
  'function riderArrive(uint256 id, bool atShop)',
  'function ownerConfirm(uint256 id, bool ok, bool issue)',
  'function approveOrder(uint256 id)',
  'error NotAuthorized()', 'error BadStatus()', 'error CircuitFailed()', 'error Rejected(uint8 reason)', 'error OrderTooLarge()',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const transport = () => http(new URL('/rpc', location.origin).href, { timeout: 60_000 });

// X Layer fee rule, the same as the server's (agent/src/chain/platform.ts): tip 0.001 gwei, at most 1.25 x base fee + tip,
// set as viem's last step so no node suggestion overrides it, and nothing is sent if the base fee is above 0.5 gwei.
const TIP = 1_000_000n, MAX_BASE = 500_000_000n;
const xLayer: Chain = {
  id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.xlayer.tech'] } },
  prepareTransactionRequest: [
    async (request, { client }) => {
      const block = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as { baseFeePerGas?: Hex } | null;
      if (!block?.baseFeePerGas) throw new Error('X Layer block has no base fee; not sending.');
      const base = BigInt(block.baseFeePerGas);
      if (base > MAX_BASE) throw new Error('X Layer gas is unusually expensive right now. Nothing was sent; try again later.');
      const { gasPrice: _legacy, ...rest } = request as typeof request & { gasPrice?: bigint };
      return { ...rest, type: 'eip1559', maxPriorityFeePerGas: TIP, maxFeePerGas: (base * 125n) / 100n + TIP } as typeof request;
    },
    { runAt: ['afterFillParameters'] },
  ],
};
const chainFor = (id: number): Chain => (id === 196 ? xLayer : { ...anvil, id });

// Transaction links: set once from the server's config (null on a local chain).
let explorerTx: string | null = null;
export const setExplorer = (base: string | null) => { explorerTx = base; };
export const txUrl = (hash: string) => (explorerTx ? `${explorerTx}${hash}` : null);

/** The phone's key, signing steps on one vault: the demo Config, or { chainId, vault } of the signed-in owner's shop. */
export function signer(key: Hex, cfg: { chainId: number; vault: Address }) {
  const account = privateKeyToAccount(key);
  const chain = chainFor(cfg.chainId);
  const wallet = createWalletClient({ account, chain, transport: transport() });
  const pub = createPublicClient({ chain, transport: transport() });
  const confirmed = async (hash: Hex) => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction failed.');
    return hash;
  };
  /**
   * Move `amount` (token base units) from this phone's wallet into the shop's vault. The vault is approved for the
   * token once, for any amount, so later deposits are one transaction instead of two. The approval only lets the
   * owner's own vault pull tokens, and the vault only pulls when this key calls deposit.
   */
  const deposit = async (token: Address, amount: bigint): Promise<{ approveTx: Hex | null; depositTx: Hex }> => {
    try {
      let approveTx: Hex | null = null;
      if ((await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, cfg.vault] })) < amount) {
        approveTx = await confirmed(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [cfg.vault, 2n ** 255n] }));
      }
      const { request } = await pub.simulateContract({ address: cfg.vault, abi: vaultAbi, functionName: 'deposit', args: [amount], account });
      return { approveTx, depositTx: await confirmed(await wallet.writeContract(request)) };
    } catch (e) { throw new Error(explain(e)); }
  };
  const gasBalance = () => pub.getBalance({ address: account.address });
  const send = async (functionName: 'riderPickup' | 'riderArrive' | 'ownerConfirm' | 'approveOrder' | 'queueSupplier', args: readonly unknown[]): Promise<Hex> => {
    try {
      const { request } = await pub.simulateContract({ address: cfg.vault, abi: vaultAbi, functionName, args: args as never, account });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction failed.');
      return hash;
    } catch (e) { throw new Error(explain(e)); }
  };
  return { address: account.address, send, deposit, gasBalance };
}

function explain(e: unknown): string {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  const name = r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
  const words: Record<string, string> = {
    NotAuthorized: 'This key is not allowed to do that for this order.',
    BadStatus: 'The order is not at that step any more. Refresh.',
    Rejected: 'RestockGuard rejected the order.',
    CircuitFailed: 'The circuit check failed, so the order holds. Nothing was paid.',
  };
  const text = e instanceof Error ? e.message : String(e);
  if (/insufficient funds|exceeds the balance of the account/i.test(text)) return 'This phone has no gas (OKB) left to sign with. Tap "Get gas" or ask StockRun.';
  if (/transfer amount exceeds balance|ERC20InsufficientBalance/i.test(text)) return 'Your phone wallet does not hold that much USDT0.';
  return name ? words[name] ?? name : e instanceof Error ? e.message.split('\n')[0] : String(e);
}

// ---------------------------------------------------------------- device helpers
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const GEOFENCE_M = 150;

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

/** Shrink a phone photo to at most 1600 px and JPEG, so uploads stay small on mobile data. */
export async function preparePhoto(file: File): Promise<{ mediaType: string; data: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read the photo.'))), 'image/jpeg', 0.85));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mediaType: 'image/jpeg', data: btoa(bin), previewUrl: URL.createObjectURL(blob) };
}

export const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;
export const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

export function load<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } }
export function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
