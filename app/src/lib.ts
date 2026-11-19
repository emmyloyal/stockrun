// API, chain and device helpers for the app.
import { createPublicClient, createWalletClient, http, parseAbi, BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

// ---------------------------------------------------------------- API types (mirror agent/src/server/api.ts)
export interface Place { name: string; lat: number; lng: number }
export interface CheckResult {
  status: 'retake' | 'waiting_rider' | 'settled' | 'mismatch' | 'error';
  message: string;
  outcome?: 'paid' | 'paid_part' | 'held' | 'rider_paid' | 'compensated';
  qty?: number; reason?: number; aiCount?: number; expected?: number; damage?: boolean; attestTx?: Hex; settleTx?: Hex;
}
export interface Order {
  orderId: string; item: string; unit: string; quantity: number; rider: Address; supplier: Place; shop: Place; createdAt: number;
  status: 'None' | 'AwaitingOwner' | 'Locked' | 'PickedUp' | 'Delivered' | 'Refunded';
  ordered: number; unitPriceNaira: number; riderFeeNaira: number;
  pickup: { atSupplier: boolean; riderCounted: boolean; riderCount: number; aiCounted: boolean; aiCount: number; damage: boolean; picked: number };
  delivery: { atShop: boolean; arrivedAt: number; aiCounted: boolean; delivered: number; damage: boolean; ownerOk: boolean; ownerIssue: boolean };
  lastCheck: CheckResult | null;
}
export interface Config { chainId: number; vault: Address; photoCheck: boolean; demoKeys: { owner: Hex; rider: Hex } | null }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok) throw new Error(json.error ?? `Server error ${r.status}`);
  return json as T;
}
export const api = {
  config: () => call<Config>('/api/config'),
  orders: () => call<Order[]>('/api/orders'),
  riderJobs: (rider: Address) => call<Order[]>(`/api/riders/${rider}/jobs`),
  placeOrder: (text: string) => call<{ message: string; problems: string[] }>('/api/orders', { text }),
  photo: (id: string, stage: 'pickup' | 'delivery', photo: { mediaType: string; data: string }) => call<CheckResult>(`/api/orders/${id}/photo`, { stage, ...photo }),
  settle: (id: string, stage: 'pickup' | 'delivery') => call<CheckResult>(`/api/orders/${id}/settle`, { stage }),
  confirmCount: (id: string, stage: 'pickup' | 'delivery') => call<CheckResult>(`/api/orders/${id}/confirm-count`, { stage }),
};

// ---------------------------------------------------------------- chain: each person signs their own steps
const vaultAbi = parseAbi([
  'function riderPickup(uint256 id, bool atSupplier, uint8 riderCount)',
  'function riderArrive(uint256 id, bool atShop)',
  'function ownerConfirm(uint256 id, bool ok, bool issue)',
  'function approveOrder(uint256 id)',
  'error NotAuthorized()', 'error BadStatus()', 'error CircuitFailed()', 'error Rejected(uint8 reason)', 'error OrderTooLarge()',
]);
const transport = () => http(new URL('/rpc', location.origin).href);
const chainFor = (id: number) => ({ ...anvil, id });

export function signer(key: Hex, cfg: Config) {
  const account = privateKeyToAccount(key);
  const chain = chainFor(cfg.chainId);
  const wallet = createWalletClient({ account, chain, transport: transport() });
  const pub = createPublicClient({ chain, transport: transport() });
  const send = async (functionName: 'riderPickup' | 'riderArrive' | 'ownerConfirm' | 'approveOrder', args: readonly unknown[]): Promise<Hex> => {
    try {
      const { request } = await pub.simulateContract({ address: cfg.vault, abi: vaultAbi, functionName, args: args as never, account });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction failed.');
      return hash;
    } catch (e) { throw new Error(explain(e)); }
  };
  return { address: account.address, send };
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
