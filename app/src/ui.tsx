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
  const title = r.outcome === 'paid' ? `PickupCheck: seller paid for all ${r.qty}`
    : r.outcome === 'paid_part' ? `PickupCheck: seller paid for ${r.qty}; the rest of your money came back`
    : r.outcome === 'short' ? `DeliveryCheck: ${r.qty} short, delivery fee given back to you`
    : r.outcome === 'rider_paid' ? 'DeliveryCheck: logistics company paid'
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
export function CircuitTrail({ evidence, network }: { evidence: Evidence[]; network: string }) {
  if (!evidence.length) return null;
  return (
    <details className="trail">
      <summary className="fine">Decided by TapeOut circuits{network === 'xlayer' ? ' on X Layer' : ' (local test chain)'}</summary>
      <ul>
        {evidence.map((e, i) => (
          <li key={i} className="fine">{CIRCUIT[e.circuit]} at block {Number(e.block).toLocaleString()}: input <code>{e.input}</code> → output <code>{e.output}</code></li>
        ))}
      </ul>
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
