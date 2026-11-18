// A complete local StockRun deployment on anvil, for the demo and the end-to-end test:
// MockToken (6-decimal "naira" token), MockCircuits (the reference rules), StockRunVault, an owner who
// has funded the vault and approved three demo suppliers, and a bonded demo rider.
// Uses anvil's well-known PUBLIC test keys; nothing here touches a real network.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createTestClient, createWalletClient, http, parseAbi,
  type Abi, type Address, type Hex, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { supplierKey } from '../tools/suppliers.ts';
import { VaultClient } from '../tools/vault.ts';
import type { Rider } from '../types.ts';

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
];
export const accounts = (() => { const [owner, agent, checker, rider, payout] = KEYS.map((k) => privateKeyToAccount(k)); return { owner, agent, checker, rider, payout }; })();

export const ANVIL = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
const OUT = new URL('../../../contracts/out/', import.meta.url);
export const localChainAvailable = () => existsSync(ANVIL) && existsSync(new URL('StockRunVault.sol/StockRunVault.json', OUT));
const art = (name: string) => JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };

export const UNIT = 5_000_000_000n;      // circuit money unit: ₦5,000 in a 6-decimal token where 1 token = ₦1
export const TOKEN_PER_NAIRA = 1_000_000n;
export const DEMO_SHOP = { name: 'Demo shop, Ojota', lat: 6.587, lng: 3.381 };
export const DEMO_SUPPLIERS = [['sim-mile12-adeyemi', 1], ['sim-ketu-chukwu', 2], ['sim-ikotun-nkechi', 1]] as const;

export const tokenAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const vaultAdminAbi = parseAbi(['function deposit(uint256)', 'function queueSupplier(bytes32,uint8,address)', 'function applySupplier(bytes32)', 'function postBond(uint256)', 'function locked() view returns (uint256)']);

export interface LocalChain { pub: PublicClient; token: Address; vault: Address; vaultClient: VaultClient; riders: Rider[]; stop: () => void }

export async function startLocalChain(port = 18545 + Math.floor(Math.random() * 1000)): Promise<LocalChain> {
  if (!localChainAvailable()) throw new Error('anvil or contract artifacts missing: install Foundry and run `forge build` in contracts/');
  const proc: ChildProcess = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: anvil, transport: http(url) });
  for (let i = 0; ; i++) { try { await pub.getChainId(); break; } catch (e) { if (i > 100) { proc.kill(); throw e; } await new Promise((r) => setTimeout(r, 100)); } }
  const test = createTestClient({ chain: anvil, mode: 'anvil', transport: http(url) });
  const w = (acct: typeof accounts.owner) => createWalletClient({ account: acct, chain: anvil, transport: http(url) });
  const send = async (p: Promise<Hex>) => pub.waitForTransactionReceipt({ hash: await p });
  const { owner, agent, checker, rider, payout } = accounts;
  const o = w(owner);
  const deploy = async (name: string, args: unknown[] = []) => {
    const a = art(name);
    return (await send(o.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress!;
  };

  const token = await deploy('MockToken');
  const circuits = await deploy('MockCircuits');
  // Weekly budget 200 units (₦1,000,000); auto-approve limit 40 units (₦200,000).
  const vault = await deploy('StockRunVault', [token, circuits, 1n, 2n, 3n, UNIT, owner.address, agent.address, checker.address, 200n * UNIT, 40n * UNIT]);

  await send(o.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [owner.address, 1000n * UNIT] }));
  await send(o.writeContract({ address: token, abi: tokenAbi, functionName: 'approve', args: [vault, 1000n * UNIT] }));
  await send(o.writeContract({ address: vault, abi: vaultAdminAbi, functionName: 'deposit', args: [500n * UNIT] }));
  for (const [id, status] of DEMO_SUPPLIERS)
    await send(o.writeContract({ address: vault, abi: vaultAdminAbi, functionName: 'queueSupplier', args: [supplierKey(id), status, payout.address] }));
  await test.increaseTime({ seconds: 86_400 }); await test.mine({ blocks: 1 }); // supplier approvals wait 24 h
  for (const [id] of DEMO_SUPPLIERS)
    await send(o.writeContract({ address: vault, abi: vaultAdminAbi, functionName: 'applySupplier', args: [supplierKey(id)] }));

  const r = w(rider);
  await send(o.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [rider.address, 300n * UNIT] }));
  await send(r.writeContract({ address: token, abi: tokenAbi, functionName: 'approve', args: [vault, 300n * UNIT] }));
  await send(r.writeContract({ address: vault, abi: vaultAdminAbi, functionName: 'postBond', args: [300n * UNIT] }));

  return {
    pub, token, vault,
    vaultClient: new VaultClient(vault, pub, w(agent)),
    riders: [{ id: 'r1', name: 'Tunde (demo rider)', address: rider.address, lat: 6.6, lng: 3.39 }],
    stop: () => { proc.kill(); },
  };
}
