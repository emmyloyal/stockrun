// Everything chain-specific the multi-shop server needs, in one place, so the same server runs on the local test chain
// today and on X Layer mainnet once the circuits are taped out.
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther,
  type Abi, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import type { LocalChain } from '../sim/localChain.ts';

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
  circuits: Address;         // TapeOut processor (MockCircuits on the local chain)
  circuitIds: { restock: bigint; pickup: bigint; delivery: bigint };
  unit: bigint;              // token amount per circuit money unit (₦5,000)
  tokenPerNaira: bigint;
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
  const unit = 5_000_000_000n, tokenPerNaira = 1_000_000n;
  return {
    name: 'local', chain: anvil, rpcUrl: chain.url, pub, deployer, agent: wallet(LOCAL_KEYS.agent), checker: wallet(LOCAL_KEYS.checker),
    token: chain.token, circuits: chain.circuits, circuitIds: { restock: 1n, pickup: 2n, delivery: 3n }, unit, tokenPerNaira,
    supplierPayout: privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').address,
    faucet: async (to) => {
      // ₦2,000,000 of test token and 1 test ETH for gas. Test money only: local chain.
      const h = await deployer.writeContract({ address: chain.token, abi: tokenAbi, functionName: 'mint', args: [to, 2_000_000n * tokenPerNaira] });
      await pub.waitForTransactionReceipt({ hash: h });
      await test.setBalance({ address: to, value: parseEther('1') });
    },
    advanceTime: async (seconds) => { await test.increaseTime({ seconds }); await test.mine({ blocks: 1 }); },
  };
}
