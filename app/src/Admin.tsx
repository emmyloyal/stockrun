// The admin page: every naira order, the money StockRun holds, and the seller payouts to send.
// The admin never decides a payment: PickupCheck approved each payout and its amount. The admin sends the bank
// transfer from StockRun's account, then records the reference here (or holds the payout for review).
import { useCallback, useEffect, useState } from 'react';
import { naira, server, whatsappLink, type AdminOrder, type AdminOverview, type Contact, type Payout } from './lib';
import { BankFields, useBanks } from './Banks';
import { STORE_KINDS } from './Store';
import type { Business } from './lib';

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
          <div><dt>StockRun fees earned</dt><dd>{naira(t.feesNaira ?? 0)}</dd></div>
          <div><dt>Store listings earned</dt><dd>{naira(t.listingsNaira ?? 0)}</dd></div>
          <div><dt>Owed to sellers</dt><dd>{naira(t.owedSellersNaira)}</dd></div>
          <div><dt>Paid out to sellers</dt><dd>{naira(t.paidOutNaira)}</dd></div>
          <div><dt>Owed to logistics</dt><dd>{naira(t.owedLogisticsNaira)}</dd></div>
          <div><dt>Buyers' spendable balances</dt><dd>{naira(t.buyersAvailableNaira)}</dd></div>
        </dl>
        <p className="fine">Naira is held in StockRun's ledger, not on-chain. "Owed to sellers" is what PickupCheck approved and nobody has sent yet.</p>
      </div>

      <Stores />

      <div className="panel stack">
        <h2>Seller payouts</h2>
        <p className="fine">{ov.paystackPayouts
          ? `Paystack pays approved bank accounts automatically after PickupCheck approves${ov.paystackTest ? ' (test mode: no real money moves)' : ''}. Anything here under "To pay" needs you: a bank account to add or approve, or a transfer that did not go through.`
          : 'Send each transfer from StockRun\'s bank, then record its reference.'}</p>
        <nav className="tabs" role="tablist">
          {(['owed', 'held', 'paid'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={show === s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>
              {s === 'owed' ? 'To pay' : s === 'held' ? 'On hold' : 'Paid'} ({count(s)})
            </button>
          ))}
        </nav>
        {list.length === 0 ? <p className="muted">Nothing here.</p> : (
          <ul className="cards">{list.map((p) => <PayoutCard key={p.orderId} p={p} onChange={refresh} paystack={!!ov.paystackPayouts} />)}</ul>
        )}
      </div>

      <div className="panel stack">
        <h2>Latest orders</h2>
        {orders.length === 0 ? <p className="muted">No orders yet.</p> : (
          <ul className="cards">
            {orders.map((o) => (
              <li key={o.orderId} className="card stack tight">
                <span className="row between"><strong>#{o.orderId} · {o.seller}</strong><span className="pill">{o.status}</span></span>
                <span className="fine">{o.ordered} × {naira(o.unitPriceNaira)} = {naira(o.totalNaira)}{o.serviceFeeNaira ? ` + ${naira(o.serviceFeeNaira)} fee` : ''}{o.self ? ' · buyer collects' : ' · delivery paid to the courier directly'}{o.picked ? ` · ${o.picked} picked up` : ''} · {when(o.createdAt)}</span>
                <span className="fine">Buyer {o.buyer}{o.sellerPhone ? <> · seller WhatsApp <a href={whatsappLink(o.sellerPhone, '')} target="_blank" rel="noreferrer">{o.sellerPhone}</a></> : ''}</span>
                <span className="fine">Circuits that decided: {o.circuits.join(' → ') || 'none yet'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel stack">
        <h2>Sellers buyers contacted</h2>
        <p className="fine">Every time a buyer got an AI message for a seller, opened the WhatsApp chat, or recorded a deal. Sellers were found on public maps and are not checked by StockRun.</p>
        <SellerContacts contacts={ov.contacts} />
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

/** Stores businesses registered: approve or reject new ones (with a reason), suspend live ones. */
function Stores() {
  const [list, setList] = useState<Business[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const load = useCallback(() => server.adminBusinesses().then(setList).catch((e) => setMsg(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (f: () => Promise<unknown>) => { setMsg(''); try { await f(); await load(); } catch (e) { setMsg((e as Error).message); } };
  if (!list) return null;
  const order = { pending: 0, approved: 1, rejected: 2 } as const;
  return (
    <div className="panel stack">
      <h2>Stores ({list.filter((b) => b.review === 'pending').length} waiting)</h2>
      {list.length === 0 ? <p className="muted">No business has registered a store yet.</p> : (
        <ul className="cards">{[...list].sort((a, b) => order[a.review] - order[b.review]).map((b) => (
          <li key={b.sellerId} className="card stack tight">
            <span className="row between"><strong>{b.name}</strong><span className="pill">{b.suspended ? 'suspended' : b.review === 'approved' ? (b.live ? 'live' : 'approved, not paid') : b.review}</span></span>
            <span className="fine">{STORE_KINDS.find(([k]) => k === b.kind)?.[1] ?? b.kind} · {b.address} · WhatsApp <a href={whatsappLink(b.phone, '')} target="_blank" rel="noreferrer">{b.phone}</a> · owner {b.owner?.label}</span>
            <span className="fine">{b.products.map((p) => `${p.item} ${naira(p.priceNaira)}/${p.unit}`).join(' · ')}</span>
            {b.bank && <span className="fine">Bank: {b.bank.bankName} {b.bank.accountNumber} · name at the bank: <strong>{b.bank.accountName}</strong>{b.bank.approved ? '' : ' (approved with the store)'}</span>}
            {b.reviewNote && <span className="fine">Reason given: {b.reviewNote}</span>}
            <div className="row wrap">
              <input placeholder="Reason (for reject or suspend)" value={notes[b.sellerId] ?? ''} maxLength={300} onChange={(e) => setNotes({ ...notes, [b.sellerId]: e.target.value })} />
              {b.review !== 'approved' && <button className="btn primary small" onClick={() => act(() => server.adminReviewBusiness(b.sellerId, true, ''))}>Approve</button>}
              {b.review !== 'rejected' && !b.live && <button className="btn ghost small" disabled={(notes[b.sellerId] ?? '').trim().length < 3} onClick={() => act(() => server.adminReviewBusiness(b.sellerId, false, notes[b.sellerId] ?? ''))}>Reject</button>}
              {b.review === 'approved' && (b.suspended
                ? <button className="btn ghost small" onClick={() => act(() => server.adminSuspendBusiness(b.sellerId, false, ''))}>Lift suspension</button>
                : <button className="btn ghost small" disabled={(notes[b.sellerId] ?? '').trim().length < 3} onClick={() => act(() => server.adminSuspendBusiness(b.sellerId, true, notes[b.sellerId] ?? ''))}>Suspend</button>)}
            </div>
          </li>
        ))}</ul>
      )}
      <p className="fine">Before approving, check the store is real (call or WhatsApp the number) and that the name at the bank matches the business or its owner: approving also lets payouts go to that account.</p>
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}

const ACTION: Record<Contact['action'], string> = {
  opened_chat: 'opened a StockRun chat with',
  drafted_message: 'got an AI message for', opened_whatsapp: 'opened WhatsApp with', recorded_deal: 'recorded a deal with', deal_refused: 'tried to record a deal with',
};
/** Grouped by seller (most recent first), each with its contact details and what buyers did. */
function SellerContacts({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return <p className="muted">No buyer has contacted a seller yet.</p>;
  const bySeller = new Map<string, Contact[]>();
  for (const c of contacts) bySeller.set(c.seller.id, [...(bySeller.get(c.seller.id) ?? []), c]);
  return (
    <ul className="cards">
      {[...bySeller.values()].map((list) => {
        const s = list[0].seller, buyers = new Set(list.map((c) => c.buyer.id)).size;
        return (
          <li key={s.id} className="card stack tight">
            <span className="row between"><strong>{s.name}</strong><span className="fine">{buyers} buyer{buyers === 1 ? '' : 's'} · {list.length} action{list.length === 1 ? '' : 's'}</span></span>
            <span className="fine">
              {s.kind ? `${s.kind.replace(/_/g, ' ')} · ` : ''}{s.address ?? 'address unknown'}
              {s.phone && <> · WhatsApp <a href={whatsappLink(s.phone, '')} target="_blank" rel="noreferrer">{s.phone}</a></>}
              {s.sourceUrl && <> · <a href={s.sourceUrl} target="_blank" rel="noreferrer">found on {s.source === 'osm' ? 'OpenStreetMap' : s.source === 'maps' ? 'Google Maps' : 'the web'}</a></>}
            </span>
            <details>
              <summary className="fine">What buyers did</summary>
              <ul className="plain">
                {list.map((c, i) => <li key={i} className="fine">{when(c.at)} · {c.buyer.label} {ACTION[c.action]} {s.name}{c.detail ? `: ${c.detail}` : ''}</li>)}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function PayoutCard({ p, onChange, paystack }: { p: Payout; onChange: () => void; paystack: boolean }) {
  const banks = useBanks(paystack);
  const [pick, setPick] = useState({ bankCode: p.bank?.bankCode ?? '', accountNumber: p.bank?.accountNumber ?? '' });
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
        {p.note && <p className="warn">{p.note}</p>}
        {editBank && paystack ? (
          <div className="stack tight">
            <span className="fine">Seller's bank account (the name comes from the bank)</span>
            <BankFields banks={banks} bankCode={pick.bankCode} accountNumber={pick.accountNumber} onChange={setPick} />
            <button className="btn ghost small" disabled={busy || !pick.bankCode || pick.accountNumber.length !== 10} onClick={() => act(async () => { await server.adminBank(p.orderId, { bankName: '', accountName: '', ...pick }); setEditBank(false); })}>Check and save bank account</button>
          </div>
        ) : editBank ? (
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
          <p className="fine">Pay to: <strong>{p.bank?.bankName} {p.bank?.accountNumber}</strong> ({p.bank?.accountName}){p.bank?.source === 'seller' ? ' · added by the seller' : ''} · <button className="link" onClick={() => setEditBank(true)}>change</button></p>
        )}
        {p.bank && !p.bank.approved && !editBank && (
          <div className="stack tight">
            <p className="warn">The seller added this account. Check that "{p.bank.accountName}" is {p.seller.name} or its owner before approving: payouts go there automatically after that.</p>
            <button className="btn primary small" disabled={busy} onClick={() => act(() => server.adminApproveBank(p.orderId))}>Approve this account</button>
          </div>
        )}
        {paystack && p.status === 'owed' && p.bank?.approved && p.bank.bankCode && !editBank && (
          <button className="btn primary small" disabled={busy} onClick={() => act(() => server.adminPayNow(p.orderId))}>Pay {naira(p.amountNaira)} now via Paystack</button>
        )}
        {p.status === 'owed' && p.bank && !editBank && (
          <div className="stack tight">
            <span className="fine">{paystack ? 'Or pay by hand: ' : ''}1. Send {naira(p.amountNaira)} from StockRun's bank account to the account above. 2. Type the transfer reference from your bank's receipt.</span>
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
