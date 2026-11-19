import { useCallback, useEffect, useState } from 'react';
import { api, naira, signer, type Order } from './lib';
import { Outcome, StatusPill, Tx } from './ui';
import { SupplierMap } from './SupplierMap';

type Signer = ReturnType<typeof signer>;

/** `orderBlock`: when set, ordering is off and this says why (real accounts: nothing deposited yet). */
export function Owner({ me, orderBlock = '', approveSuppliers = false }: { me: Signer; orderBlock?: string; approveSuppliers?: boolean }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [text, setText] = useState('5 cartons of Indomie, 10 bags of rice at 80k, within 5 km');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [txs, setTxs] = useState<Record<string, string>>({});
  const refresh = useCallback(() => api.orders().then(setOrders).catch((e) => setError(e.message)), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await f(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const place = () => run('StockRun is finding suppliers and haggling…', async () => {
    const r = await api.placeOrder(text);
    setReply([r.message, ...r.problems].filter(Boolean).join('\n'));
  });
  const approve = (o: Order) => run('Signing your approval…', async () => {
    setTxs((t) => ({ ...t, [o.orderId]: '' }));
    const h = await me.send('approveOrder', [BigInt(o.orderId)]);
    setTxs((t) => ({ ...t, [o.orderId]: h }));
  });
  const confirm = (o: Order, ok: boolean) => run(ok ? 'Confirming delivery…' : 'Reporting a problem…', async () => {
    const h = await me.send('ownerConfirm', [BigInt(o.orderId), ok, !ok]);
    setTxs((t) => ({ ...t, [o.orderId]: h }));
    await api.settle(o.orderId, 'delivery');
  });

  return (
    <section className="stack">
      <header className="screen-head">
        <p className="eyebrow">Shop owner</p>
        <h1>Restock</h1>
      </header>

      <div className="panel stack">
        <label className="field">
          <span>What do you need?</span>
          <textarea id="order-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button className="btn primary" disabled={!!busy || !text.trim() || !!orderBlock} onClick={place}>Send order</button>
        {orderBlock && <p className="warn">{orderBlock}</p>}
        {reply && <pre className="reply">{reply}</pre>}
      </div>

      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}

      <SupplierMap orders={orders ?? []} approve={approveSuppliers ? async (s, payout) => { await me.send('queueSupplier', [s.key, 1, payout]); } : undefined} />

      <h2>Orders</h2>
      {orders === null ? <p className="muted">Loading…</p> : orders.length === 0 ? (
        <div className="empty"><p>No orders yet.</p><p className="muted">Send an order above. Approved orders are paid into escrow and appear here.</p></div>
      ) : (
        <ul className="cards">
          {orders.map((o) => (
            <li key={o.orderId} className="card stack">
              <span className="row between"><strong>{o.ordered} × {o.item}</strong><StatusPill o={o} /></span>
              <span className="muted">{o.supplier.name} · {naira(o.unitPriceNaira)} each · delivery {naira(o.riderFeeNaira)}</span>
              <Progress o={o} />
              {o.lastCheck && <Outcome r={o.lastCheck} />}
              {o.status === 'AwaitingOwner' && (
                <div className="stack">
                  <p className="warn">This order needs your OK. Approving lets RestockGuard skip "ask owner" rules; it never overrides a reject.</p>
                  <button className="btn primary" disabled={!!busy} onClick={() => approve(o)}>Approve order</button>
                </div>
              )}
              {o.status === 'PickedUp' && o.delivery.aiCounted && !o.delivery.ownerOk && (
                <div className="row wrap">
                  <button className="btn primary" disabled={!!busy} onClick={() => confirm(o, true)}>I received {o.delivery.delivered} {o.unit}(s)</button>
                  <button className="btn ghost" disabled={!!busy} onClick={() => confirm(o, false)}>Report a problem</button>
                </div>
              )}
              {txs[o.orderId] && <p className="ok">Signed. <Tx hash={txs[o.orderId]} /></p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Progress({ o }: { o: Order }) {
  const steps = [
    { label: 'Escrow', done: o.status !== 'AwaitingOwner' },
    { label: o.pickup.picked ? `Picked up ${o.pickup.picked}/${o.ordered}` : 'Pickup check', done: o.status === 'PickedUp' || o.status === 'Delivered' },
    { label: o.delivery.aiCounted ? `Delivered ${o.delivery.delivered}` : 'Delivery check', done: o.delivery.aiCounted },
    { label: 'Rider paid', done: o.status === 'Delivered' },
  ];
  return <ol className="progress">{steps.map((s) => <li key={s.label} className={s.done ? 'done' : ''}>{s.label}</li>)}</ol>;
}
