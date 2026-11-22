import { useEffect, type ReactNode } from 'react';
import { short, txUrl, type CheckResult, type Evidence, type Order } from './lib';

const STATUS: Record<Order['status'], [string, string]> = {
  None: ['Unknown', 'muted'],
  AwaitingOwner: ['Needs your OK', 'ask'],
  Locked: ['Money locked · pickup next', 'info'],
  PickedUp: ['Picked up · on the way', 'info'],
  Delivered: ['Done', 'ok'],
  Refunded: ['Refunded', 'muted'],
};

export function StatusPill({ o }: { o: Order }) {
  const [label, tone] = STATUS[o.status];
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** A circuit's decision in plain words. */
export function Outcome({ r }: { r: CheckResult }) {
  const tone = r.outcome === 'paid' || r.outcome === 'rider_paid' ? 'ok' : r.status === 'error' ? 'no' : 'ask';
  const title = r.outcome === 'paid' ? `PickupCheck: seller's payment approved for all ${r.qty}`
    : r.outcome === 'paid_part' ? `PickupCheck: seller's payment approved for ${r.qty}; the rest of your money came back`
    : r.outcome === 'short' ? `DeliveryCheck: ${r.qty} short, delivery fee given back to you`
    : r.outcome === 'rider_paid' ? "DeliveryCheck: logistics company's fee approved"
    : r.status === 'error' ? 'Not done' : 'The circuit says: hold';
  return (
    <div className={`outcome ${tone}`} role="status">
      <strong>{title}</strong>
      {r.message && <p>{r.message}</p>}
    </div>
  );
}

const CIRCUIT: Record<Evidence['circuit'], string> = { restock: 'RestockGuard #1', pickup: 'PickupCheck #2', delivery: 'DeliveryCheck #3' };

/** Which circuit decided what, on which X Layer block: anyone can re-run the same input with eval. */
export function CircuitTrail({ evidence, network, orderId }: { evidence: Evidence[]; network: string; orderId?: string | number }) {
  if (!evidence.length) return null;
  return (
    <details className="trail">
      <summary className="fine">Decided by TapeOut circuits{network === 'xlayer' ? ' on X Layer' : ' (local test chain)'}</summary>
      <ul>
        {evidence.map((e, i) => (
          <li key={i} className="fine">{CIRCUIT[e.circuit]} at block {Number(e.block).toLocaleString()}: input <code>{e.input}</code> → output <code>{e.output}</code></li>
        ))}
      </ul>
      {network === 'xlayer' && orderId !== undefined && (
        <p className="fine">Check it yourself: from the StockRun repo, run <code>node scripts/verify-order.mjs {String(orderId)}</code>. It calls each circuit on X Layer and compares the answer with what was saved here.</p>
      )}
    </details>
  );
}

/** Transaction hash: a link to the explorer on X Layer; plain text otherwise. */
export function Tx({ hash }: { hash: string }) {
  const url = txUrl(hash);
  return url
    ? <a className="tx" href={url} target="_blank" rel="noreferrer" title={hash}>{short(hash)}</a>
    : <code className="tx" title={hash}>{short(hash)}</code>;
}

/** Bottom sheet (a centred dialog on wide screens). Escape or tapping outside closes it. */
export function Sheet({ title, onClose, onBack, children }: { title: string; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          {onBack && <button className="sheet-x" aria-label="Back" onClick={onBack}>‹</button>}
          <h2>{title}</h2>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
