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

/** Approve the vault to take exactly `dollars`, then deposit them. Two wallet signatures. */
export async function depositCoins(cfg: Config, owner: Address, vault: Address, dollars: number, step: (s: string) => void) {
  const amount = toUnits(dollars);
  step('1 of 2: approve in your wallet…');
  await walletSend(cfg.coins!.chainId, owner, cfg.coins!.token, 'approve', [vault, amount]);
  step('2 of 2: deposit in your wallet…');
  return walletSend(cfg.coins!.chainId, owner, vault, 'deposit', [amount]);
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
  const maxAdd = Math.min(walletUsd, v.room);
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
          const tx = await depositCoins(cfg, wallet, v.vault, addN, setBusy);
          setAdd(''); setNote({ text: `${usd(addN)} added to your vault.`, tx });
        })}><Icon.plus size={18} /> Add</button>
      </div>
      {addN > maxAdd && <p className="fine warn-text">{addN > walletUsd ? `Your wallet holds ${usd(walletUsd)}.` : `The vault can take ${usd(v.room)} more (cap ${usd(v.cap)}).`}</p>}
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
