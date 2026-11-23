// Coins: the buyer's own vault on X Layer, owned by their wallet. StockRun sets it up and pays that gas; every step
// that moves coins (deposit, withdraw, approving a seller, the count at pickup) is signed in the buyer's own wallet.
// The vault is new and unaudited, so it holds at most the cap the server sets.
import { useState } from 'react';
import type { Address } from 'viem';
import { addressUrl, naira, server, short, walletSend, type Coins, type Config, type Me } from './lib';
import { Icon } from './icons';
import { Tx } from './ui';

const toUnits = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** StockRun's fee on a coin deposit, exactly as the vault works it out (rounded down), in dollars. */
export const coinFee = (dollars: number, feeBps: number) => Number((toUnits(dollars) * BigInt(feeBps)) / 10_000n) / 1_000_000;
/** The most a wallet holding `walletUsd` can deposit when the fee is paid on top. */
export const maxDepositFor = (walletUsd: number, feeBps: number) => Math.floor((walletUsd * 10_000 / (10_000 + feeBps)) * 100) / 100;

/** Approve the vault to take `dollars` plus StockRun's fee, then deposit `dollars`. Two wallet signatures. */
export async function depositCoins(cfg: Config, owner: Address, vault: Address, dollars: number, feeBps: number, step: (s: string) => void) {
  const amount = toUnits(dollars), fee = (amount * BigInt(feeBps)) / 10_000n;
  step('1 of 2: approve in your wallet…');
  await walletSend(cfg.coins!.chainId, owner, cfg.coins!.token, 'approve', [vault, amount + fee]);
  step('2 of 2: deposit in your wallet…');
  return walletSend(cfg.coins!.chainId, owner, vault, 'deposit', [amount]);
}

/** Move free coins from the buyer's vault back to their own wallet (their wallet signs; locked coins stay put). */
export function CoinWithdraw({ cfg, wallet, vault, onDone }: { cfg: Config; wallet: Address; vault: NonNullable<Coins['vault']>; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ text: string; tx: string } | null>(null);
  const n = Number(amount);
  return (
    <div className="stack">
      <p className="fine">From your vault {short(vault.vault)} to your wallet {short(wallet)} on X Layer. Only free coins can leave; coins locked in an order stay until PickupCheck settles it.</p>
      <dl className="money-grid">
        <div><dt>Free to withdraw</dt><dd>{usd(vault.free)} <span className="fine">≈ {naira(vault.naira.free)}</span></dd></div>
        <div><dt>Locked in orders</dt><dd>{usd(vault.locked)}</dd></div>
      </dl>
      <label className="field"><span>Amount ({vault.symbol})</span>
        <span className="input-icon"><span className="prefix">$</span><input inputMode="decimal" placeholder={vault.free.toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></span>
      </label>
      <div className="row wrap">
        <button className="btn ghost" disabled={vault.free <= 0} onClick={() => setAmount(vault.free.toFixed(6).replace(/\.?0+$/, ''))}>Use all {usd(vault.free)}</button>
        <button className="btn primary grow" disabled={!!busy || !(n >= 0.000001) || n > vault.free} onClick={async () => {
          setBusy('Confirm the withdrawal in your wallet…'); setError(''); setDone(null);
          try {
            const tx = await walletSend(cfg.coins!.chainId, wallet, vault.vault, 'withdraw', [toUnits(n)]);
            setDone({ text: `${usd(n)} is back in your wallet.`, tx }); setAmount(''); onDone();
          } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
        }}>Withdraw to my wallet</button>
      </div>
      {n > vault.free && <p className="fine warn-text">Only {usd(vault.free)} is free.</p>}
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {done && <p className="ok-box">{done.text} <Tx hash={done.tx} /></p>}
    </div>
  );
}

export function CoinsPanel({ cfg, me, coins, onChange }: { cfg: Config; me: Me; coins: Coins | null; onChange: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState<{ text: string; tx?: string } | null>(null);
  const [add, setAdd] = useState('');
  const [out, setOut] = useState('');
  const wallet = me.user?.wallet ?? null, v = coins?.vault ?? null, c = cfg.coins;
  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setError(''); setNote(null);
    try { await f(); onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const walletUsd = Number(coins?.token?.amount ?? 0);

  if (!wallet) return <p className="muted">Connect a wallet in <strong>Me</strong> to pay with coins.</p>;
  if (!coins?.wallet) return <p className="muted">Reading your wallet…</p>;
  const walletLine = (
    <dl className="money-grid">
      <div><dt>In your wallet</dt><dd>{coins.token?.amount} {coins.token?.symbol}</dd></div>
      <div><dt>OKB (gas)</dt><dd>{Number(coins.okb).toFixed(5)}</dd></div>
    </dl>
  );
  if (!c) return (<>
    <p className="fine">Wallet {short(coins.wallet)} on {coins.network === 'xlayer' ? 'X Layer' : 'the local test chain'}, read from the chain.</p>
    {walletLine}
    <p className="fine">Paying with coins isn't switched on on this server. Orders are paid from your naira balance.</p>
  </>);

  if (!v) return (
    <div className="stack">
      <p>Pay for orders with {c.symbol} on X Layer, from your own vault: a contract your wallet owns. RestockGuard and PickupCheck move the coins inside it; StockRun can't.</p>
      {walletLine}
      <p className="fine">StockRun creates the vault and pays that gas. It holds at most {usd(c.cap)} for now, because the vault is new and not yet audited.</p>
      <button className="btn primary" disabled={!!busy} onClick={() => act('Creating your vault on X Layer…', async () => {
        const r = await server.coinVault();
        setNote({ text: r.created ? 'Your vault is ready. Add coins to it next.' : 'Your vault was already set up.' });
      })}><Icon.lock size={18} /> Set up my coin vault</button>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
    </div>
  );

  const addN = Number(add), outN = Number(out);
  const maxAdd = Math.min(maxDepositFor(walletUsd, v.depositFeeBps), v.room), addFee = coinFee(addN || 0, v.depositFeeBps);
  const vaultLink = addressUrl(v.vault);
  return (
    <div className="stack">
      <p className="fine">Your vault {vaultLink ? <a href={vaultLink} target="_blank" rel="noreferrer">{short(v.vault)}</a> : short(v.vault)} on X Layer, owned by your wallet {short(v.owner)}. Read from the chain.</p>
      <dl className="money-grid">
        <div><dt>In your vault</dt><dd>{usd(v.balance)} <span className="fine">≈ {naira(v.naira.balance)}</span></dd></div>
        <div><dt>Free to spend</dt><dd>{usd(v.free)}</dd></div>
        <div><dt>Locked in orders</dt><dd>{usd(v.locked)}</dd></div>
        <div><dt>Room to the {usd(v.cap)} cap</dt><dd>{usd(v.room)}</dd></div>
      </dl>
      {walletLine}

      <div className="row wrap">
        <label className="field grow"><span>Add {v.symbol} from your wallet</span>
          <span className="input-icon"><span className="prefix">$</span><input inputMode="decimal" placeholder="10.00" value={add} onChange={(e) => setAdd(e.target.value.replace(/[^\d.]/g, ''))} /></span>
        </label>
        <button className="btn primary" disabled={!!busy || !(addN >= 0.01) || addN > maxAdd} onClick={() => act('Waiting for your wallet…', async () => {
          const tx = await depositCoins(cfg, wallet, v.vault, addN, v.depositFeeBps, setBusy);
          setAdd(''); setNote({ text: `${usd(addN)} added to your vault.`, tx });
        })}><Icon.plus size={18} /> Add</button>
      </div>
      {v.depositFeeBps > 0 && addN > 0 && <p className="fine">Your vault gets {usd(addN)}. StockRun's fee ({v.depositFeeBps / 100}%) is {usd(addFee)}, paid on top: {usd(addN + addFee)} leaves your wallet.</p>}
      {addN > maxAdd && <p className="fine warn-text">{addN + addFee > walletUsd ? `Your wallet holds ${usd(walletUsd)}${v.depositFeeBps ? `, enough to add ${usd(maxDepositFor(walletUsd, v.depositFeeBps))} with the fee` : ''}.` : `The vault can take ${usd(v.room)} more (cap ${usd(v.cap)}).`}</p>}
      {Number(coins.okb) === 0 && <p className="fine warn-text">Your wallet has no OKB for gas. Add a little OKB on X Layer to sign.</p>}

      <div className="row wrap">
        <label className="field grow"><span>Withdraw free coins to your wallet</span>
          <span className="input-icon"><span className="prefix">$</span><input inputMode="decimal" placeholder={v.free.toFixed(2)} value={out} onChange={(e) => setOut(e.target.value.replace(/[^\d.]/g, ''))} /></span>
        </label>
        <button className="btn ghost" disabled={!!busy || !(outN >= 0.01) || outN > v.free} onClick={() => act('Withdraw in your wallet…', async () => {
          const tx = await walletSend(c.chainId, wallet, v.vault, 'withdraw', [toUnits(outN)]);
          setOut(''); setNote({ text: `${usd(outN)} is back in your wallet.`, tx });
        })}><Icon.arrowUp size={18} /> Withdraw</button>
      </div>
      <p className="fine"><Icon.shield size={14} /> Coins locked in an order stay in the vault until PickupCheck pays the seller for what you counted; the rest comes back to "free".</p>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {note && <p className="ok-box">{note.text} {note.tx && <Tx hash={note.tx} />}</p>}
    </div>
  );
}
