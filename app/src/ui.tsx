import { short, type CheckResult, type Order } from './lib';

const STATUS: Record<Order['status'], [string, string]> = {
  None: ['Unknown', 'muted'],
  AwaitingOwner: ['Needs owner OK', 'ask'],
  Locked: ['In escrow · pickup next', 'info'],
  PickedUp: ['Picked up · on the way', 'info'],
  Delivered: ['Delivered', 'ok'],
  Refunded: ['Refunded', 'muted'],
};

export function StatusPill({ o }: { o: Order }) {
  const [label, tone] = STATUS[o.status];
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** Circuit decisions in plain words, with the transactions that carry them (local chain in the demo). */
export function Outcome({ r }: { r: CheckResult }) {
  const tone = r.status === 'retake' || r.status === 'error' ? 'no'
    : r.outcome === 'paid' || r.outcome === 'rider_paid' ? 'ok'
    : r.outcome === 'held' || r.status === 'waiting_rider' ? 'ask' : 'ask';
  const title = r.status === 'mismatch' ? `Photo shows ${r.aiCount} of ${r.expected}`
    : r.status === 'retake' ? 'Take the photo again'
    : r.status === 'error' ? 'Not done'
    : r.status === 'waiting_rider' ? `Photo counted ${r.aiCount}. Waiting for the rider's count`
    : r.outcome === 'paid' ? `PickupCheck: supplier paid for all ${r.qty}`
    : r.outcome === 'paid_part' ? `PickupCheck: supplier paid for ${r.qty} (short supply)`
    : r.outcome === 'compensated' ? `DeliveryCheck: owner paid back for ${r.qty} from the rider's bond`
    : r.outcome === 'rider_paid' ? 'DeliveryCheck: rider paid'
    : 'Circuit says: hold';
  return (
    <div className={`outcome ${tone}`} role="status">
      <strong>{title}</strong>
      <p>{r.message}</p>
      {r.aiCount !== undefined && r.status === 'settled' && <p className="fine">Photo count: {r.aiCount}{r.damage ? ' · damage seen' : ''}</p>}
      {(r.attestTx || r.settleTx) && (
        <p className="fine">{r.attestTx && <>Photo check <Tx hash={r.attestTx} /> </>}{r.settleTx && <>· circuit <Tx hash={r.settleTx} /></>}</p>
      )}
    </div>
  );
}

/** Transaction hash. The demo runs on a local chain, so there is no explorer link to give. */
export function Tx({ hash }: { hash: string }) {
  return <code className="tx" title={`${hash} (local demo chain)`}>{short(hash)}</code>;
}
