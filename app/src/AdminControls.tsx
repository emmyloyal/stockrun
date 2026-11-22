// Admin controls: emergency pauses, the books against Paystack, deposits to check, buyer withdrawals, users
// (find, inspect, freeze, mute) and feed moderation. None of these decides a payment: pauses and freezes only stop
// money moving, a mismatched deposit is settled only as Paystack confirms it, and a rejected withdrawal goes back to
// the buyer's own balance.
import { useCallback, useEffect, useState } from 'react';
import { naira, server, type AdminDeposit, type AdminPost, type AdminUser, type AdminUserDetail, type AdminWithdrawal, type Books, type Switch, type SwitchState } from './lib';

const when = (t: number) => new Date(t).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Run an admin action, then reload; errors show in place. */
function useAct(load: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
  const act = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMsg('');
    try { await f(); await load(); if (done) setMsg(done); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, msg, act };
}

// ---------------------------------------------------------------- 1. emergency pauses
const SWITCH_TEXT: Record<Switch, [string, string]> = {
  deposits: ['Deposits', 'Nobody can start a new Paystack deposit. Payments already made are still credited.'],
  orders: ['New orders', 'Nobody can record a deal, ask the agent or approve an order. Pickups of existing orders still settle.'],
  withdrawals: ['Withdrawals', 'Buyers cannot withdraw, and you cannot approve withdrawals waiting for review.'],
  payouts: ['Seller payouts', 'Nothing is sent to sellers through Paystack. Recording a payment you made by hand still works.'],
};

export function PausePanel() {
  const [sw, setSw] = useState<Record<Switch, SwitchState> | null>(null);
  const [limits, setLimits] = useState<{ dailyNaira: number; reviewOverNaira: number } | null>(null);
  const [notes, setNotes] = useState<Partial<Record<Switch, string>>>({});
  const load = useCallback(() => server.adminControls().then((r) => { setSw(r.switches); setLimits(r.withdrawalLimits); }), []);
  const { busy, msg, act } = useAct(load);
  useEffect(() => { load().catch(() => {}); }, [load]);
  if (!sw) return null;
  const anyPaused = (Object.keys(sw) as Switch[]).some((k) => sw[k].paused);
  return (
    <div className="panel stack">
      <h2>Emergency pause {anyPaused && <span className="pill">something is paused</span>}</h2>
      <p className="fine">Stops money moving at once, without taking the site down. Money already in the ledger stays where it is.</p>
      <ul className="cards">{(Object.keys(SWITCH_TEXT) as Switch[]).map((k) => (
        <li key={k} className="card stack tight">
          <span className="row between"><strong>{SWITCH_TEXT[k][0]}</strong><span className="pill">{sw[k].paused ? 'PAUSED' : 'running'}</span></span>
          <span className="fine">{SWITCH_TEXT[k][1]}</span>
          {sw[k].paused && <p className="warn">Paused by {sw[k].by} {sw[k].at ? when(sw[k].at!) : ''}: {sw[k].note}</p>}
          {sw[k].paused
            ? <button className="btn primary small" disabled={busy} onClick={() => act(() => server.adminSetSwitch(k, false, ''))}>Resume {SWITCH_TEXT[k][0].toLowerCase()}</button>
            : <div className="row wrap">
                <input placeholder="Why pause it?" value={notes[k] ?? ''} maxLength={300} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} />
                <button className="btn ghost small" disabled={busy || (notes[k] ?? '').trim().length < 3} onClick={() => act(async () => { await server.adminSetSwitch(k, true, notes[k] ?? ''); setNotes({ ...notes, [k]: '' }); })}>Pause</button>
              </div>}
        </li>
      ))}</ul>
      {limits && <p className="fine">Withdrawal limits: {naira(limits.dailyNaira)} per person a day; over {naira(limits.reviewOverNaira)} waits for you to approve it (set WITHDRAW_DAILY_NAIRA and WITHDRAW_REVIEW_OVER_NAIRA on the server).</p>}
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 5. the books
export function BooksPanel() {
  const [b, setB] = useState<Books | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => server.adminBooks().then(setB).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!b) return error ? <div className="panel"><p className="alert">{error}</p></div> : null;
  const diff = b.differenceNaira;
  return (
    <div className="panel stack">
      <div className="row between"><h2>Books: Paystack against the ledger</h2><button className="link" onClick={load}>Refresh</button></div>
      <dl className="money-grid">
        <div><dt>Paystack balance{b.test ? ' (test mode)' : ''}</dt><dd>{b.paystackNaira === null ? '—' : naira(b.paystackNaira)}</dd></div>
        <div><dt>StockRun owes people</dt><dd>{naira(b.owed.totalNaira)}</dd></div>
        <div><dt>Difference</dt><dd>{diff === null ? '—' : `${diff < 0 ? '−' : ''}${naira(Math.abs(diff))}`}</dd></div>
        <div><dt>StockRun income (fees, listings)</dt><dd>{naira(b.incomeNaira)}</dd></div>
      </dl>
      {b.paystackError && <p className="warn">Could not read Paystack: {b.paystackError}</p>}
      {diff !== null && (diff < 0
        ? <p className="alert">Paystack holds {naira(-diff)} less than StockRun owes people. Check Paystack settlements (money Paystack moved to your bank), seller payouts you paid by hand from another account, and the deposits below. If you cannot explain it, pause withdrawals and payouts.</p>
        : <p className="ok">Paystack holds enough to cover everything StockRun owes people. The extra {naira(diff)} is StockRun's income plus the charges buyers paid on deposits.</p>)}
      <p className="fine">Owed: spendable {naira(b.owed.buyersAvailableNaira)} · locked in orders {naira(b.owed.lockedNaira)} · sellers {naira(b.owed.sellersNaira)} · logistics {naira(b.owed.logisticsNaira)} · withdrawals not yet sent {naira(b.owed.withdrawalsPendingNaira)}.
        {b.coinOwedNaira > 0 && ` Also owed to sellers for coin pickups: ${naira(b.coinOwedNaira)} (the buyer paid in USD₮0 to the payout wallet, not into Paystack).`}</p>
      <p className={b.ledger.ok ? 'fine' : 'alert'}>{b.ledger.ok ? 'Ledger check: every transaction balances and every balance equals its entries.' : `Ledger check FAILED: ${b.ledger.problems.join('; ')}. Pause everything and investigate.`}</p>
    </div>
  );
}

// ---------------------------------------------------------------- 2. deposits to check
export function DepositsPanel() {
  const [show, setShow] = useState<'mismatch' | 'started' | ''>('mismatch');
  const [rows, setRows] = useState<AdminDeposit[] | null>(null);
  const load = useCallback(() => server.adminDeposits(show).then(setRows), [show]);
  const { busy, msg, act } = useAct(load);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  return (
    <div className="panel stack">
      <h2>Deposits</h2>
      <p className="fine">"Does not match" means Paystack took a payment that differs from the deposit StockRun started (amount, currency or person). It was not credited. Settle it only as Paystack shows it: credit what Paystack received, or refund it to the payer.</p>
      <nav className="tabs" role="tablist">
        {([['mismatch', 'Does not match'], ['started', 'Started, not confirmed'], ['', 'All']] as const).map(([s, label]) => (
          <button key={s} role="tab" aria-selected={show === s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>{label}</button>
        ))}
      </nav>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing here.</p> : (
        <ul className="cards">{rows.map((d) => (
          <li key={d.reference} className="card stack tight">
            <span className="row between"><strong>{naira(d.amountNaira)} · {d.buyer}</strong><span className="pill">{d.status}</span></span>
            <span className="fine">{d.reference} · started {when(d.createdAt)}{d.chargeNaira ? ` · Paystack charge ${naira(d.chargeNaira)}` : ''}</span>
            <div className="row wrap">
              {d.status === 'mismatch' && <>
                <button className="btn primary small" disabled={busy} onClick={() => confirm(`Credit ${d.buyer} with what Paystack actually received (minus the charge)?`) && act(() => server.adminDepositResolve(d.reference, 'credit'), 'Credited.')}>Credit what Paystack received</button>
                <button className="btn ghost small" disabled={busy} onClick={() => confirm('Refund this payment to the payer through Paystack? Nothing is credited.') && act(() => server.adminDepositResolve(d.reference, 'refund'), 'Refund asked of Paystack.')}>Refund through Paystack</button>
              </>}
              {d.status === 'started' && <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { const r = await server.adminDepositRecheck(d.reference); if (r.status === 'pending') throw new Error('Paystack says it is not paid (yet).'); }, 'Checked with Paystack.')}>Check with Paystack</button>}
            </div>
          </li>
        ))}</ul>
      )}
      {msg && <p className={/^(Credited|Refund|Checked)/.test(msg) ? 'ok' : 'alert'}>{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 3. buyer withdrawals
export function WithdrawalsPanel() {
  const [show, setShow] = useState<'review' | 'sending' | 'failed' | 'sent'>('review');
  const [rows, setRows] = useState<AdminWithdrawal[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = useCallback(() => server.adminWithdrawals(show).then(setRows), [show]);
  const { busy, msg, act } = useAct(load);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  return (
    <div className="panel stack">
      <h2>Buyer withdrawals</h2>
      <p className="fine">Large withdrawals wait here. The money has already left the buyer's balance, so it cannot be spent meanwhile. Approve sends it through Paystack; stop returns it to the buyer's balance. Before approving, check the account name matches the buyer.</p>
      <nav className="tabs" role="tablist">
        {([['review', 'To check'], ['sending', 'Sending'], ['failed', 'Failed'], ['sent', 'Sent']] as const).map(([s, label]) => (
          <button key={s} role="tab" aria-selected={show === s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>{label}</button>
        ))}
      </nav>
      {show === 'sending' && <p className="fine">A withdrawal that stays "sending" means the server stopped while asking Paystack. Check it in the Paystack dashboard before doing anything.</p>}
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing here.</p> : (
        <ul className="cards">{rows.map((w) => (
          <li key={w.reference} className="card stack tight">
            <span className="row between"><strong>{naira(w.amountNaira)} · {w.buyer}</strong><span className="fine">{when(w.at)}</span></span>
            <span className="fine">To {w.accountName} · {w.bankName} {w.accountNumber} · {w.reference}</span>
            {w.note && <span className="fine">{w.note}</span>}
            {w.status === 'review' && <div className="row wrap">
              <button className="btn primary small" disabled={busy} onClick={() => confirm(`Send ${naira(w.amountNaira)} to ${w.accountName}?`) && act(() => server.adminWithdrawalApprove(w.reference))}>Approve and send</button>
              <input placeholder="Why stop it? (the buyer sees this)" value={reasons[w.reference] ?? ''} maxLength={200} onChange={(e) => setReasons({ ...reasons, [w.reference]: e.target.value })} />
              <button className="btn ghost small" disabled={busy || (reasons[w.reference] ?? '').trim().length < 3} onClick={() => act(() => server.adminWithdrawalReject(w.reference, reasons[w.reference] ?? ''))}>Stop, return the money</button>
            </div>}
          </li>
        ))}</ul>
      )}
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 4. users
export function UsersPanel() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<AdminUser[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const search = useCallback((s: string) => server.adminUsers(s).then(setList), []);
  useEffect(() => { search('').catch(() => setList([])); }, [search]);
  return (
    <div className="panel stack">
      <h2>Users</h2>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); search(q).catch(() => setList([])); }}>
        <input placeholder="Email, @username, name, wallet, phone or id" value={q} maxLength={80} onChange={(e) => setQ(e.target.value)} />
        <button className="btn ghost small">Search</button>
      </form>
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">Nobody found.</p> : (
        <ul className="cards">{list.map((u) => (
          <li key={u.id} className="card stack tight">
            <button className="link row between" onClick={() => setOpen(open === u.id ? null : u.id)}>
              <strong>#{u.id} · {u.label}</strong>
              <span className="fine">{naira(u.naira.availableNaira)} spendable{u.naira.heldNaira ? ` · ${naira(u.naira.heldNaira)} locked` : ''}{u.flags.frozen ? ' · FROZEN' : ''}{u.flags.muted ? ' · muted' : ''}</span>
            </button>
            {open === u.id && <UserDetail id={u.id} onChange={() => search(q)} />}
          </li>
        ))}</ul>
      )}
    </div>
  );
}

const MOVE: Record<string, string> = {
  deposit: 'Deposit', demo: 'Demo naira', hold: 'Locked for an order', release: 'Returned from an order', withdraw: 'Withdrawal',
  withdraw_failed: 'Withdrawal returned', listing_fee: 'Store listing fee',
};
function UserDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const [d, setD] = useState<AdminUserDetail | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => server.adminUser(id).then(setD), [id]);
  const { busy, msg, act } = useAct(async () => { await load(); onChange(); });
  useEffect(() => { load().catch(() => {}); }, [load]);
  if (!d) return <p className="muted">Loading…</p>;
  const u = d.user, f = d.flags;
  const flag = (change: { frozen?: boolean; muted?: boolean }) => act(async () => { await server.adminUserFlags(id, change, note); setNote(''); });
  return (
    <div className="stack tight">
      <span className="fine">{[u.email, u.username && `@${u.username}`, u.displayName, u.wallet, u.phone].filter(Boolean).join(' · ')} · {u.role} · joined {when(u.createdAt)}</span>
      {d.store && <span className="fine">Store: {d.store.name} ({d.store.live ? 'live' : d.store.review})</span>}
      {(f.frozen || f.muted) && <p className="warn">{f.frozen ? 'Frozen' : 'Muted'} by {f.by} {f.at ? when(f.at) : ''}: {f.note}</p>}
      <div className="row wrap">
        <input placeholder="Reason (needed to freeze or mute)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        {f.frozen
          ? <button className="btn primary small" disabled={busy} onClick={() => flag({ frozen: false })}>Unfreeze</button>
          : <button className="btn ghost small" disabled={busy || note.trim().length < 3} onClick={() => flag({ frozen: true })}>Freeze money</button>}
        {f.muted
          ? <button className="btn primary small" disabled={busy} onClick={() => flag({ muted: false })}>Unmute</button>
          : <button className="btn ghost small" disabled={busy || note.trim().length < 3} onClick={() => flag({ muted: true })}>Mute posts and chat</button>}
      </div>
      <span className="fine">Freezing stops deposits, orders, withdrawals and store fees; the balance stays as it is. Muting stops posts and chat messages.</span>
      <details><summary className="fine">Money history ({d.history.length})</summary>
        <ul className="plain">{d.history.map((m) => <li key={m.key} className="fine">{when(m.at)} · {MOVE[m.type] ?? m.type.replace(/_/g, ' ')} · {m.amountNaira > 0 ? '+' : '−'}{naira(Math.abs(m.amountNaira))}{m.memo ? ` · ${m.memo}` : ''}</li>)}</ul>
      </details>
      <details><summary className="fine">Deposits ({d.deposits.length}) · withdrawals ({d.withdrawals.length}) · orders ({d.orders.length})</summary>
        <ul className="plain">
          {d.deposits.map((x) => <li key={x.reference} className="fine">Deposit {naira(x.amountNaira)} · {x.status} · {when(x.createdAt)}</li>)}
          {d.withdrawals.map((x) => <li key={x.reference} className="fine">Withdrawal {naira(x.amountNaira)} to {x.accountName} ({x.bankName}) · {x.status} · {when(x.at)}</li>)}
          {d.orders.map((x) => <li key={x.orderId} className="fine">Order #{x.orderId} · {x.seller} · {naira(x.totalNaira)} · {x.status} · {when(x.createdAt)}</li>)}
        </ul>
      </details>
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 6. feed moderation
export function PostsPanel() {
  const [rows, setRows] = useState<AdminPost[] | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const load = useCallback(() => server.adminPosts().then(setRows), []);
  const { busy, msg, act } = useAct(load);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  if (!rows) return null;
  return (
    <div className="panel stack">
      <h2>Feed posts</h2>
      <p className="fine">Take down spam, scams or anything that breaks the rules. To stop someone posting or messaging, mute them under Users; to take a whole store off, suspend it under Stores.</p>
      {rows.length === 0 ? <p className="muted">No posts yet.</p> : (
        <ul className="cards">{rows.map((p) => (
          <li key={p.id} className="card stack tight">
            <span className="row between"><strong>{p.store.name}</strong><span className="fine">{when(p.at)}{p.live ? '' : ' · store not live'}</span></span>
            <span>{p.text}</span>
            <span className="fine">{p.priceNaira ? `${naira(p.priceNaira)}/${p.unit} · ` : ''}{p.hasPhoto ? 'with photo · ' : ''}owner {p.owner ?? 'unknown'}{p.ownerId ? ` (#${p.ownerId})` : ''}</span>
            <div className="row wrap">
              <input placeholder="Why remove it?" value={reasons[p.id] ?? ''} maxLength={200} onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} />
              <button className="btn ghost small" disabled={busy || (reasons[p.id] ?? '').trim().length < 3} onClick={() => act(() => server.adminRemovePost(p.id, reasons[p.id] ?? ''))}>Remove post</button>
            </div>
          </li>
        ))}</ul>
      )}
      {msg && <p className="alert">{msg}</p>}
    </div>
  );
}
