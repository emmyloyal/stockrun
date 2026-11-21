// The admin page: every naira order, the money StockRun holds, and the seller payouts to send.
// The admin never decides a payment: PickupCheck approved each payout and its amount. The admin sends the bank
// transfer from StockRun's account, then records the reference here (or holds the payout for review).
import { useCallback, useEffect, useState } from 'react';
import { naira, server, type AdminOrder, type AdminOverview, type Payout } from './lib';

const when = (t: number) => new Date(t).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Admin() {
  const [ov, setOv] = useState<AdminOverview | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [show, setShow] = useState<'owed' | 'held' | 'paid'>('owed');
  const [error, setError] = useState('');
  const refresh = useCallback(() => Promise.all([server.adminOverview().then(setOv), server.adminOrders().then(setOrders)]).catch((e) => setError(e.message)), []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!ov) return error ? <p className="alert">{error}</p> : <p className="muted">Loading…</p>;
  const t = ov.totals, list = ov.payouts.filter((p) => p.status === show);
  const count = (s: Payout['status']) => ov.payouts.filter((p) => p.status === s).length;

  return (
    <div className="stack">
      <div className="panel stack">
        <h2>Money StockRun holds</h2>
        <dl className="money-grid">
          <div><dt>Locked in buyers' orders</dt><dd>{naira(t.lockedNaira)}</dd></div>
          <div><dt>Owed to sellers</dt><dd>{naira(t.owedSellersNaira)}</dd></div>
          <div><dt>Paid out to sellers</dt><dd>{naira(t.paidOutNaira)}</dd></div>
          <div><dt>Owed to logistics</dt><dd>{naira(t.owedLogisticsNaira)}</dd></div>
          <div><dt>Buyers' spendable balances</dt><dd>{naira(t.buyersAvailableNaira)}</dd></div>
        </dl>
        <p className="fine">Naira is held in StockRun's ledger, not on-chain. "Owed to sellers" is what PickupCheck approved and nobody has sent yet.</p>
      </div>

      <div className="panel stack">
        <h2>Seller payouts</h2>
        <nav className="tabs" role="tablist">
          {(['owed', 'held', 'paid'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={show === s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>
              {s === 'owed' ? 'To pay' : s === 'held' ? 'On hold' : 'Paid'} ({count(s)})
            </button>
          ))}
        </nav>
        {list.length === 0 ? <p className="muted">Nothing here.</p> : (
          <ul className="cards">{list.map((p) => <PayoutCard key={p.orderId} p={p} onChange={refresh} />)}</ul>
        )}
      </div>

      <div className="panel stack">
        <h2>Latest orders</h2>
        {orders.length === 0 ? <p className="muted">No orders yet.</p> : (
          <ul className="cards">
            {orders.map((o) => (
              <li key={o.orderId} className="card stack tight">
                <span className="row between"><strong>#{o.orderId} · {o.seller}</strong><span className="pill">{o.status}</span></span>
                <span className="fine">{o.ordered} × {naira(o.unitPriceNaira)} = {naira(o.totalNaira)}{o.self ? ' · buyer collects' : ` + ${naira(o.deliveryFeeNaira)} delivery`}{o.picked ? ` · ${o.picked} picked up` : ''} · {when(o.createdAt)}</span>
                <span className="fine">Circuits that decided: {o.circuits.join(' → ') || 'none yet'} · buyer #{o.buyerId}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ov.log.length > 0 && (
        <details className="supplier-list"><summary>What admins did ({ov.log.length})</summary>
          <ul className="cards">{ov.log.map((l, i) => (
            <li key={i} className="card"><span className="fine">{when(l.at)} · {l.admin} · {l.action.replace('_', ' ')}{l.orderId ? ` · order #${l.orderId}` : ''}</span><span>{l.detail}</span></li>
          ))}</ul>
        </details>
      )}
      {error && <p className="alert">{error}</p>}
    </div>
  );
}

function PayoutCard({ p, onChange }: { p: Payout; onChange: () => void }) {
  const [bank, setBank] = useState({ bankName: p.bank?.bankName ?? '', accountNumber: p.bank?.accountNumber ?? '', accountName: p.bank?.accountName ?? '' });
  const [editBank, setEditBank] = useState(!p.bank);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setMsg('');
    try { await f(); onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <li className="card stack">
      <span className="row between"><strong>{naira(p.amountNaira)} to {p.seller.name}</strong><span className="fine">order #{p.orderId}</span></span>
      <span className="fine">Approved by PickupCheck {when(p.approvedAt)} · buyer {p.buyer}{p.seller.phone ? ` · seller WhatsApp ${p.seller.phone}` : ''}</span>

      {p.status === 'paid' ? (
        <p className="ok">Paid {p.paidAt ? when(p.paidAt) : ''} by {p.paidBy} to {p.bank?.bankName} {p.bank?.accountNumber} ({p.bank?.accountName}) · reference <strong>{p.reference}</strong></p>
      ) : (<>
        {p.status === 'held' && <p className="warn">On hold: {p.note}</p>}
        {editBank ? (
          <div className="stack tight">
            <span className="fine">Seller's bank account (ask the seller on WhatsApp; check the name matches the business)</span>
            <div className="row wrap">
              <input placeholder="Bank (e.g. GTBank)" value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} />
              <input placeholder="Account number (10 digits)" inputMode="numeric" maxLength={10} value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value.replace(/\D/g, '') })} />
              <input placeholder="Account name" value={bank.accountName} onChange={(e) => setBank({ ...bank, accountName: e.target.value })} />
            </div>
            <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { await server.adminBank(p.orderId, bank); setEditBank(false); })}>Save bank account</button>
          </div>
        ) : (
          <p className="fine">Pay to: <strong>{p.bank?.bankName} {p.bank?.accountNumber}</strong> ({p.bank?.accountName}) · <button className="link" onClick={() => setEditBank(true)}>change</button></p>
        )}
        {p.status === 'owed' && p.bank && !editBank && (
          <div className="stack tight">
            <span className="fine">1. Send {naira(p.amountNaira)} from StockRun's bank account to the account above. 2. Type the transfer reference from your bank's receipt.</span>
            <div className="row wrap">
              <input placeholder="Transfer reference" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
              <button className="btn primary small" disabled={busy || reference.trim().length < 4} onClick={() => act(() => server.adminPaid(p.orderId, reference.trim()))}>Record as paid</button>
            </div>
          </div>
        )}
        <div className="row wrap">
          {p.status === 'owed' ? (<>
            <input placeholder="Why hold it?" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            <button className="btn ghost small" disabled={busy || note.trim().length < 3} onClick={() => act(() => server.adminHold(p.orderId, true, note.trim()))}>Hold for review</button>
          </>) : <button className="btn ghost small" disabled={busy} onClick={() => act(() => server.adminHold(p.orderId, false, ''))}>Release hold</button>}
        </div>
      </>)}
      {msg && <p className="alert">{msg}</p>}
    </li>
  );
}
