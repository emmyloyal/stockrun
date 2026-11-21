// Businesses: register a store (an admin approves it, then ₦1,000 a month keeps it live) and chat with buyers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { naira, server, type Business, type ChatMessage, type ChatSummary } from './lib';
import { BankFields, useBanks } from './Banks';

export const STORE_KINDS: [string, string][] = [
  ['wholesale', 'Wholesale / distributor'], ['supermarket', 'Supermarket'], ['convenience', 'Provisions / mini mart'], ['general', 'General store'],
  ['food', 'Food shop'], ['beverages', 'Drinks'], ['bakery', 'Bakery'], ['chemist', 'Chemist / toiletries'], ['cosmetics', 'Cosmetics'],
  ['hardware', 'Hardware'], ['building_materials', 'Building materials'], ['electronics', 'Electronics'], ['mobile_phone', 'Phones'],
  ['clothes', 'Clothes'], ['fabric', 'Fabric'], ['furniture', 'Furniture'], ['houseware', 'Household items'], ['stationery', 'Stationery'],
];
const when = (t: number) => new Date(t).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Me tab: register and run your store. */
export function MyStore({ fee, banksOn, balance, onChange }: { fee: { feeNaira: number; periodDays: number }; banksOn: boolean; balance: number; onChange: () => void }) {
  const [b, setB] = useState<Business | null | undefined>(undefined);
  const [bank, setBank] = useState<{ bankName: string; accountName: string; approved?: boolean } | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'wholesale', address: '', phone: '', products: [{ item: '', unit: 'carton', price: '' }] });
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState({ bankCode: '', accountNumber: '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const banks = useBanks(banksOn && !!b);
  const load = useCallback(() => server.myBusiness().then((r) => {
    setB(r.business); setBank(r.bankLinked);
    if (r.business) setForm({ name: r.business.name, kind: r.business.kind, address: r.business.address, phone: r.business.phone.replace(/^\+234/, '0'),
      products: r.business.products.map((p) => ({ item: p.item, unit: p.unit, price: String(p.priceNaira) })) });
  }).catch((e) => { setB(null); setMsg({ ok: false, text: e.message }); }), []);
  useEffect(() => { load(); }, [load]);
  const act = async (label: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(label); setMsg(null);
    try { await f(); await load(); onChange(); if (ok) setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(''); }
  };
  const setProduct = (i: number, k: 'item' | 'unit' | 'price', v: string) => setForm({ ...form, products: form.products.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });

  if (b === undefined) return null;
  const showForm = !b || editing;
  return (
    <div className="panel stack">
      <h2>My store</h2>
      {!b && <p className="fine">Sell on StockRun: buyers near you find your products first and can chat with you here. StockRun checks your store, then it is {naira(fee.feeNaira)} every {fee.periodDays} days, paid from your StockRun balance.</p>}
      {b && !editing && (
        <div className="stack tight">
          <p><strong>{b.name}</strong> · {STORE_KINDS.find(([k]) => k === b.kind)?.[1] ?? b.kind} · {b.address} · WhatsApp {b.phone}</p>
          <p className={b.live ? 'ok' : b.review === 'rejected' || b.suspended ? 'alert' : 'warn'}>
            {b.suspended ? `Suspended by StockRun${b.suspendedNote ? `: ${b.suspendedNote}` : ''}.`
              : b.review === 'pending' ? 'Waiting for StockRun to check your store. You can pay once it is approved.'
              : b.review === 'rejected' ? `Not approved${b.reviewNote ? `: ${b.reviewNote}` : ''}. Edit your store to send it again.`
              : b.live ? `Live until ${when(b.paidUntil)}. Buyers can find you and chat with you.`
              : b.paidUntil ? `Expired on ${when(b.paidUntil)}. Pay to show your store again.` : 'Approved. Pay to go live.'}
          </p>
          <ul className="plain">{b.products.map((p, i) => <li key={i} className="fine">{p.item}: {naira(p.priceNaira)} per {p.unit}</li>)}</ul>
          {b.review === 'approved' && !b.suspended && (
            <button className="btn primary" disabled={!!busy || balance < fee.feeNaira} onClick={() => act('Paying…', () => server.payBusiness(crypto.randomUUID()), 'Paid. Your store is live.')}>
              Pay {naira(fee.feeNaira)} for {b.live ? `${fee.periodDays} more days` : `${fee.periodDays} days`}
            </button>
          )}
          {b.review === 'approved' && balance < fee.feeNaira && <p className="fine">Your balance is {naira(balance)}. Deposit in Money first.</p>}
          <button className="link" onClick={() => setEditing(true)}>Edit store and products</button>
        </div>
      )}
      {showForm && (
        <div className="stack">
          <label className="field"><span>Store name</span><input value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mama Tolu Provisions" /></label>
          <label className="field"><span>Kind of store</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{STORE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <label className="field"><span>Where (your area is enough)</span><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Mile 12" /></label>
          <label className="field"><span>WhatsApp number</span><input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0803 123 4567" /></label>
          <span className="fine">Products and prices</span>
          {form.products.map((p, i) => (
            <div key={i} className="row wrap product-row">
              <input placeholder="Product (e.g. Indomie carton)" value={p.item} maxLength={80} onChange={(e) => setProduct(i, 'item', e.target.value)} />
              <input placeholder="unit" value={p.unit} maxLength={20} onChange={(e) => setProduct(i, 'unit', e.target.value)} />
              <input placeholder="₦ price" inputMode="numeric" value={p.price} onChange={(e) => setProduct(i, 'price', e.target.value.replace(/\D/g, ''))} />
              {form.products.length > 1 && <button className="link" onClick={() => setForm({ ...form, products: form.products.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          {form.products.length < 50 && <button className="link" onClick={() => setForm({ ...form, products: [...form.products, { item: '', unit: 'carton', price: '' }] })}>+ Add a product</button>}
          <div className="row wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => act('Saving…', async () => {
              await server.saveBusiness({ ...form, products: form.products.filter((p) => p.item.trim()).map((p) => ({ item: p.item, unit: p.unit, priceNaira: Number(p.price) })) });
              setEditing(false);
            }, b ? 'Saved.' : 'Sent. StockRun will check your store.')}>{b ? 'Save changes' : 'Register my store'}</button>
            {editing && <button className="link" onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        </div>
      )}
      {b && banksOn && (
        <div className="stack tight">
          <h3>Where StockRun pays you</h3>
          {bank ? <p className="fine">{bank.bankName} · {bank.accountName}{bank.approved ? '' : ' · StockRun approves it with your store'}</p> : (<>
            <p className="fine">When a buyer collects goods from you and confirms the count, StockRun sends your money here. The name is checked with your bank.</p>
            <BankFields banks={banks} bankCode={pick.bankCode} accountNumber={pick.accountNumber} onChange={setPick} />
            <button className="btn ghost" disabled={!!busy || !pick.bankCode || pick.accountNumber.length !== 10} onClick={() => act('Checking with your bank…', () => server.businessBank(pick), 'Bank account saved.')}>Save bank account</button>
          </>)}
        </div>
      )}
      {busy && <p className="busy">{busy}</p>}
      {msg && <p className={msg.ok ? 'ok' : 'alert'}>{msg.text}</p>}
    </div>
  );
}

/** Chats tab: the list, and one conversation (new messages every few seconds while open). */
export function ChatsTab({ openId, onOpened }: { openId: number | null; onOpened: () => void }) {
  const [list, setList] = useState<ChatSummary[] | null>(null);
  const [open, setOpen] = useState<number | null>(openId);
  const refresh = useCallback(() => server.chats().then((r) => setList(r.chats)).catch(() => setList([])), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => { if (openId) { setOpen(openId); onOpened(); } }, [openId, onOpened]);
  const current = list?.find((c) => c.id === open) ?? null;

  if (open && current) return <Thread chat={current} onBack={() => { setOpen(null); refresh(); }} />;
  if (!list) return <p className="muted">Loading…</p>;
  if (!list.length) return <div className="empty"><p>No chats yet.</p><p className="muted">Stores registered on StockRun have a "Chat in StockRun" button in your seller results.</p></div>;
  return (
    <ul className="cards">
      {list.map((c) => (
        <li key={c.id}>
          <button className="card chat-row" onClick={() => setOpen(c.id)}>
            <span className="row between"><strong>{c.role === 'buyer' ? c.store.name : `${c.buyer.label} · about your store`}</strong>{c.unread > 0 && <span className="pill found">{c.unread} new</span>}</span>
            <span className="fine">{c.last ? `${c.last.from === (c.role === 'buyer' ? 'buyer' : 'shop') ? 'You: ' : ''}${c.last.text}` : 'No messages yet'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Thread({ chat, onBack }: { chat: ChatSummary; onBack: () => void }) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const last = useRef(0), end = useRef<HTMLDivElement>(null);
  const pull = useCallback(async () => {
    const m = await server.chatMessages(chat.id, last.current).catch(() => []);
    if (m.length) { last.current = m[m.length - 1].id; setMsgs((x) => [...x, ...m]); }
  }, [chat.id]);
  useEffect(() => { last.current = 0; setMsgs([]); pull(); const t = setInterval(pull, 4000); return () => clearInterval(t); }, [pull]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);
  const me = chat.role === 'buyer' ? 'buyer' : 'shop';
  const send = async () => {
    const t = text.trim(); if (!t) return;
    setError('');
    try { await server.chatSend(chat.id, t); setText(''); await pull(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="stack chat">
      <div className="row between"><button className="link" onClick={onBack}>‹ All chats</button><strong>{chat.role === 'buyer' ? chat.store.name : chat.buyer.label}</strong></div>
      <div className="chat-log">
        {msgs.length === 0 && <p className="muted">Say hello. Ask about prices and stock; when you agree, record the deal in Ask so your money is protected.</p>}
        {msgs.map((m) => <div key={m.id} className={`bubble ${m.from === me ? 'mine' : 'theirs'}`}><span>{m.text}</span><small>{when(m.at)}</small></div>)}
        <div ref={end} />
      </div>
      <div className="row chat-input">
        <textarea rows={2} value={text} maxLength={1000} placeholder="Type a message" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn primary" disabled={!text.trim()} onClick={send}>Send</button>
      </div>
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
