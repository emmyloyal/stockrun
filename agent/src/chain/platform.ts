// Everything chain-specific the multi-shop server needs, in one place, so the same server runs on the local test chain
// and on X Layer mainnet against the taped-out circuits.
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createTestClient, createWalletClient, getAddress, http, isAddress, parseAbi, parseEther,
  type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil, xLayer } from 'viem/chains';
import type { LocalChain } from '../sim/localChain.ts';
import { fixedRate, usdRate, type Money } from './money.ts';

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface Platform {
  name: 'local' | 'xlayer';
  chain: Chain;
  rpcUrl: string;
  pub: PublicClient;
  deployer: Wallet;          // deploys a vault for each new shop (pays that gas)
  agent: Wallet;             // proposes orders on every shop's vault (proposeOrder only)
  checker: Wallet;           // attests photo counts on every shop's vault (attest* only)
  token: Address;            // stablecoin held by the vaults
  tokenSymbol: string;
  circuits: Address;         // TapeOut processor (MockCircuits on the local chain)
  circuitIds: { restock: bigint; pickup: bigint; delivery: bigint };
  unit: bigint;              // token amount per circuit money unit (₦5,000)
  money: Money;              // naira <-> token
  supplierPayout: Address;   // where supplier payments go before the naira transfer (pilot: StockRun's off-ramp account)
  /** Local chain only: give a new account test money and gas. Absent on mainnet. */
  faucet?: (to: Address) => Promise<void>;
  /** Local chain only: move chain time forward (supplier approvals wait 24 h). Absent on mainnet. */
  advanceTime?: (seconds: number) => Promise<void>;
}

const OUT = new URL('../../../contracts/out/', import.meta.url);
export const artifact = (name: string) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };

export const tokenAbi = parseAbi([
  'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
]);

/** Deploy a vault owned by `owner` (the shop owner's phone key). Budget and limit are whole naira. */
export async function deployVault(p: Platform, owner: Address, weeklyBudgetNaira: number, limitNaira: number): Promise<Address> {
  const units = (naira: number) => BigInt(Math.floor(naira / 5000)) * p.unit;
  const a = artifact('StockRunVault');
  const hash = await p.deployer.deployContract({
    abi: a.abi, bytecode: a.bytecode.object,
    args: [p.token, p.circuits, p.circuitIds.restock, p.circuitIds.pickup, p.circuitIds.delivery, p.unit, owner,
      p.agent.account.address, p.checker.account.address, units(weeklyBudgetNaira), units(limitNaira)],
  });
  const r = await p.pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error('vault deployment failed');
  return r.contractAddress;
}

// Anvil's well-known PUBLIC test keys (index 5-7), separate from the ones the single-shop demo uses.
const LOCAL_KEYS = {
  deployer: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  agent: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  checker: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
} as const;

/** Platform on a local anvil chain started by startLocalChain(): MockToken + MockCircuits, faucet and time travel. */
export function localPlatform(chain: LocalChain): Platform {
  const transport = http(chain.url);
  const pub = createPublicClient({ chain: anvil, transport }) as PublicClient;
  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain: anvil, transport });
  const test = createTestClient({ chain: anvil, mode: 'anvil', transport });
  const deployer = wallet(LOCAL_KEYS.deployer);
  const tokenPerNaira = 1_000_000n, money = fixedRate(tokenPerNaira);
  return {
    name: 'local', chain: anvil, rpcUrl: chain.url, pub, deployer, agent: wallet(LOCAL_KEYS.agent), checker: wallet(LOCAL_KEYS.checker),
    token: chain.token, tokenSymbol: 'TEST', circuits: chain.circuits, circuitIds: { restock: 1n, pickup: 2n, delivery: 3n },
    unit: money.toToken(5000), money,
    supplierPayout: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').address,
    faucet: async (to) => {
      // ₦2,000,000 of test token and 1 test ETH for gas. Test money only: local chain.
      const h = await deployer.writeContract({ address: chain.token, abi: tokenAbi, functionName: 'mint', args: [to, money.toToken(2_000_000)] });
      await pub.waitForTransactionReceipt({ hash: h });
      await test.setBalance({ address: to, value: parseEther('1') });
    },
    advanceTime: async (seconds) => { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// X Layer mainnet

/** USDT0 on X Layer (from the tapeout.net config; decimals and symbol are checked on chain at start-up). */
export const XLAYER_USDT0: Address = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const TAPEOUT_FACTORY: Address = '0x1f09DAeFA827f02CBb40967cc91b259763760761';

const processorAbi = parseAbi([
  'function circuitInfo(uint256) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function netlist(uint256) view returns (bytes)',
]);
const factoryAbi = parseAbi(['function isCPU(address) view returns (bool)']);

/** A value from the environment with any inline `# comment` and surrounding spaces removed. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const v = raw.replace(/\s+#.*$/, '').trim();
  return v === '' ? undefined : v;
}

function envKey(env: NodeJS.ProcessEnv, name: string): Hex {
  const v = envValue(env, name);
  if (!v) throw new Error(`${name} is not set in .env`);
  const k = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not a 32-byte hex private key`);
  return k;
}

export interface XLayerDeployment {
  processor: Address;
  circuitIds: { restock: number; pickup: number; delivery: number };
  circuits: Record<'RestockGuard' | 'PickupCheck' | 'DeliveryCheck', { id: number; nIn: number; nOut: number; gates: number }>;
}

export const readDeployment = (): XLayerDeployment =>
  JSON.parse(readFileSync(new URL('../../../deployments/xlayer.json', import.meta.url), 'utf8')) as XLayerDeployment;

/**
 * Platform on X Layer mainnet. Needs in .env: DEPLOYER_PRIVATE_KEY, AGENT_PRIVATE_KEY, CHECK_SERVICE_PRIVATE_KEY (three
 * different keys), SUPPLIER_PAYOUT_ADDRESS, NGN_PER_USD. Checks the chain, the processor, every circuit's shape and
 * gate count, and the stablecoin before returning, and throws on any mismatch rather than starting half-configured.
 */
export async function xlayerPlatform(env: NodeJS.ProcessEnv = process.env): Promise<Platform> {
  const rpcUrl = envValue(env, 'XLAYER_RPC') ?? 'https://rpc.xlayer.tech';
  const transport = http(rpcUrl, { timeout: 20_000, retryCount: 2 });
  const pub = createPublicClient({ chain: xLayer, transport }) as PublicClient;
  const id = await pub.getChainId();
  if (id !== 196) throw new Error(`XLAYER_RPC points at chain ${id}, not X Layer (196)`);

  const accounts = {
    deployer: privateKeyToAccount(envKey(env, 'DEPLOYER_PRIVATE_KEY')),
    agent: privateKeyToAccount(envKey(env, 'AGENT_PRIVATE_KEY')),
    checker: privateKeyToAccount(envKey(env, 'CHECK_SERVICE_PRIVATE_KEY')),
  };
  if (new Set(Object.values(accounts).map((a) => a.address)).size !== 3) throw new Error('deployer, agent and check-service keys must all be different');
  const wallet = (a: Account) => createWalletClient({ account: a, chain: xLayer, transport });

  const payout = envValue(env, 'SUPPLIER_PAYOUT_ADDRESS');
  if (!payout || !isAddress(payout)) throw new Error('SUPPLIER_PAYOUT_ADDRESS is not a valid address');
  if (Object.values(accounts).some((a) => a.address === getAddress(payout))) throw new Error('SUPPLIER_PAYOUT_ADDRESS must not be the deployer, agent or check-service wallet');

  const rate = Number(envValue(env, 'NGN_PER_USD'));
  const money = usdRate(rate, 6);

  const d = readDeployment();
  if (!(await pub.readContract({ address: TAPEOUT_FACTORY, abi: factoryAbi, functionName: 'isCPU', args: [d.processor] }))) throw new Error('processor is not a TapeOut CPU');
  for (const [name, c] of Object.entries(d.circuits)) {
    const [nIn, nOut, , gates] = await pub.readContract({ address: d.processor, abi: processorAbi, functionName: 'circuitInfo', args: [BigInt(c.id)] });
    if (nIn !== c.nIn || nOut !== c.nOut || gates !== c.gates) throw new Error(`${name} (#${c.id}) on chain does not match deployments/xlayer.json`);
  }
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: XLAYER_USDT0, abi: tokenAbi, functionName: 'decimals' }),
    pub.readContract({ address: XLAYER_USDT0, abi: tokenAbi, functionName: 'symbol' }),
  ]);
  if (decimals !== 6) throw new Error(`USDT0 has ${decimals} decimals, expected 6`);

  return {
    name: 'xlayer', chain: xLayer, rpcUrl, pub,
    deployer: wallet(accounts.deployer), agent: wallet(accounts.agent), checker: wallet(accounts.checker),
    token: XLAYER_USDT0, tokenSymbol: symbol, circuits: d.processor,
    circuitIds: { restock: BigInt(d.circuitIds.restock), pickup: BigInt(d.circuitIds.pickup), delivery: BigInt(d.circuitIds.delivery) },
    unit: money.toToken(5000), money, supplierPayout: getAddress(payout),
  };
}
