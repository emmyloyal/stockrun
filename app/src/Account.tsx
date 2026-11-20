// StockRun for everyone: sign in with a phone number or a wallet, keep a profile, deposit naira, and ask the agent
// for what you want with a budget and a delivery pin. The agent finds sellers on the map, negotiates on WhatsApp and
// pays the seller only once the logistics company (or you, collecting) has the goods.
import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  avatarUrl, currentPosition, hasWallet, load, naira, preparePhoto, save, server, short, signWithWallet,
  type Coins, type Config, type Me, type Movement, type Order, type Place, type RequestRecord, type Seller, type User,
} from './lib';
import { CircuitTrail, Outcome, StatusPill } from './ui';

type Tab = 'ask' | 'orders' | 'money' | 'me';
const LAGOS: [number, number] = [6.55, 3.37];
const run = async (setBusy: (s: string) => void, setError: (s: string) => void, label: string, f: () => Promise<void>) => {
  setBusy(label); setError('');
  try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
};

export function AccountApp({ cfg }: { cfg: Config }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('reference') ? 'money' : load<Tab>('stockrun.tab', 'ask')));
  const [bust, setBust] = useState(0);
  const reload = useCallback(() => server.me().then(setMe).catch((e) => setError(e.message)), []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { save('stockrun.tab', tab); }, [tab]);

  if (error) return <p className="alert">{error}</p>;
  if (!me) return <p className="muted">Loading…</p>;
  if (!me.user) return <SignIn onDone={reload} />;
  const u = me.user;
  const name = u.username ? `@${u.username}` : u.phone ?? (u.wallet ? short(u.wallet) : 'You');

  return (
    <section className="stack">
      <header className="row between">
        <span className="row">
          {u.hasAvatar ? <img className="avatar" src={avatarUrl(u.id, bust)} alt="" /> : <span className="avatar empty" aria-hidden="true">{(u.displayName ?? u.username ?? '?').slice(0, 1).toUpperCase()}</span>}
          <span className="stack tight"><strong>{u.displayName ?? name}</strong>{u.displayName && <span className="fine">{name}</span>}</span>
        </span>
        <span className="balance" title="Naira held by StockRun for you (not on-chain)">{naira(me.naira?.availableNaira ?? 0)}</span>
      </header>
      {!u.username && <p className="note">Choose a username in <button className="link" onClick={() => setTab('me')}>Me</button>.</p>}
      <nav className="tabs" role="tablist">
        {([['ask', 'Ask'], ['orders', 'Orders'], ['money', 'Money'], ['me', 'Me']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      {tab === 'ask' && <Ask user={u} me={me} onAsked={() => { reload(); setTab('orders'); }} goMoney={() => setTab('money')} />}
      {tab === 'orders' && <Orders cfg={cfg} onChange={reload} />}
      {tab === 'money' && <Money cfg={cfg} me={me} onChange={reload} />}
      {tab === 'me' && <Profile user={u} onChange={() => { setBust(Date.now()); reload(); }} />}
    </section>
  );
}

// ---------------------------------------------------------------- sign in: phone or wallet
function SignIn({ onDone }: { onDone: () => void }) {
  const [way, setWay] = useState<'phone' | 'wallet'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const go = (label: string, f: () => Promise<void>) => run(setBusy, setError, label, f);

  return (
    <section className="stack">
      <header className="screen-head">
        <p className="eyebrow">StockRun</p>
        <h1>Tell the AI what you need. It finds it on the map.</h1>
        <p className="muted">It finds sellers near you, haggles on WhatsApp, and pays them only after the goods are picked up.</p>
      </header>
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={way === 'phone'} className={way === 'phone' ? 'on' : ''} onClick={() => setWay('phone')}>Phone number</button>
        <button role="tab" aria-selected={way === 'wallet'} className={way === 'wallet' ? 'on' : ''} onClick={() => setWay('wallet')}>Wallet</button>
      </nav>
      <div className="panel stack">
        {way === 'phone' ? (<>
          <label className="field"><span>Phone number</span>
            <input inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sent} />
          </label>
          {!sent ? (
            <button className="btn primary" disabled={!!busy || phone.replace(/\D/g, '').length < 10} onClick={() => go('Sending…', async () => { await server.requestCode(phone); setSent(true); })}>Send me a code</button>
          ) : (<>
            <label className="field"><span>6-digit code</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            <button className="btn primary" disabled={!!busy || code.length !== 6} onClick={() => go('Signing in…', async () => { await server.verify(phone, code); onDone(); })}>Sign in</button>
            <button className="link" disabled={!!busy} onClick={() => { setSent(false); setCode(''); }}>Use a different number</button>
          </>)}
        </>) : (<>
          <p>Sign in with OKX Wallet or MetaMask. You sign a short message: it costs nothing and moves no money.</p>
          {!hasWallet() && <p className="warn">No wallet found in this browser. Open StockRun inside the OKX Wallet or MetaMask app, or install their extension.</p>}
          <button className="btn primary" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
            const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
            await server.walletSignIn(s.message, s.signature); onDone();
          })}>Connect wallet</button>
        </>)}
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- ask: what, budget, where; sellers on the map
function Ask({ user, me, onAsked, goMoney }: { user: User; me: Me; onAsked: () => void; goMoney: () => void }) {
  const [text, setText] = useState('');
  const [budget, setBudget] = useState('');
  const [place, setPlace] = useState<Place>(() => load<Place>('stockrun.place', { lat: NaN, lng: NaN, address: '' }));
  const [delivery, setDelivery] = useState<'logistics' | 'self'>('logistics');
  const [contact, setContact] = useState('');
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const el = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), layer = useRef<L.LayerGroup | null>(null);
  const pinned = Number.isFinite(place.lat) && Number.isFinite(place.lng);
  const available = me.naira?.availableNaira ?? 0;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView(pinned ? [place.lat, place.lng] : LAGOS, pinned ? 13 : 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => setPlace((p) => ({ ...p, lat: e.latlng.lat, lng: e.latlng.lng })));
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { save('stockrun.place', place); }, [place]);
  useEffect(() => {
    if (!pinned) return;
    server.map(place.lat, place.lng, 25).then((r) => setSellers(r.sellers)).catch(() => setSellers([]));
  }, [place.lat, place.lng, pinned]);
  useEffect(() => {
    const g = layer.current; if (!g) return;
    g.clearLayers();
    for (const s of sellers) {
      const rows = s.prices.slice(0, 6).map((p) => `<tr><td>${esc(p.item)}</td><td class="num">${naira(p.priceNaira)}</td></tr>`).join('');
      L.circleMarker([s.lat, s.lng], { radius: 8, color: s.verified ? '#18794A' : '#7A8194', weight: 3, fillOpacity: 0.8, fillColor: s.verified ? '#18794A' : '#7A8194' })
        .bindPopup(`<div class="pop"><strong>${esc(s.name)}</strong><span>${esc(s.market)} · ${s.km} km${s.simulated ? ' · demo seller' : ''}</span><table>${rows}</table></div>`).addTo(g);
    }
    if (pinned) L.circleMarker([place.lat, place.lng], { radius: 10, color: '#141B2E', weight: 3, fillColor: '#F4C20D', fillOpacity: 1 }).bindTooltip('Deliver here').addTo(g);
  }, [sellers, place.lat, place.lng, pinned]);

  const here = () => run(setBusy, setError, 'Finding you…', async () => {
    const p = await currentPosition();
    setPlace((x) => ({ ...x, lat: p.lat, lng: p.lng }));
    map.current?.setView([p.lat, p.lng], 15);
  });
  const ask = () => run(setBusy, setError, 'The agent is finding sellers and haggling…', async () => {
    const r = await server.ask({ text, budgetNaira: Number(budget.replace(/\D/g, '')), place, delivery, contactPhone: contact || undefined });
    setReply([r.message, ...r.problems].filter(Boolean).join('\n'));
    if (/locked|OK/.test(r.message)) onAsked();
  });
  const b = Number(budget.replace(/\D/g, '')) || 0;

  return (
    <div className="stack">
      <div className="panel stack">
        <label className="field"><span>What do you want?</span>
          <textarea rows={3} placeholder="20 cartons of Indomie, or 2 bags of rice" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="field"><span>Your budget (₦)</span>
          <input className="money" inputMode="numeric" placeholder="150,000" value={b ? b.toLocaleString('en-NG') : ''} onChange={(e) => setBudget(e.target.value)} />
        </label>
        {b > available && <p className="warn">Your balance is {naira(available)}. <button className="link" onClick={goMoney}>Deposit naira</button> first.</p>}
        <label className="field"><span>Deliver to (address)</span>
          <input placeholder="12 Ikorodu Road, Ketu, Lagos" value={place.address} onChange={(e) => setPlace((p) => ({ ...p, address: e.target.value }))} />
        </label>
        <div ref={el} className="map pick" />
        <div className="row wrap">
          <button className="btn ghost" onClick={here}>Use where I am</button>
          <span className="fine">{pinned ? `Pin: ${place.lat.toFixed(4)}, ${place.lng.toFixed(4)} · ${sellers.length} seller(s) within 25 km` : 'Tap the map to drop the delivery pin.'}</span>
        </div>
        <fieldset className="stack choice-group">
          <legend className="fine">How should it reach you?</legend>
          <label className="row"><input type="radio" checked={delivery === 'logistics'} onChange={() => setDelivery('logistics')} /> A verified logistics company delivers it</label>
          <label className="row"><input type="radio" checked={delivery === 'self'} onChange={() => setDelivery('self')} /> I'll collect it from the seller (no delivery fee)</label>
        </fieldset>
        {delivery === 'logistics' && !user.phone && (
          <label className="field"><span>Phone number for the rider</span><input inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="0803 123 4567" /></label>
        )}
        <button className="btn primary" disabled={!!busy || text.trim().length < 3 || b < 1000 || !pinned || place.address.trim().length < 3} onClick={ask}>Ask the agent</button>
        <p className="fine">The agent only spends within your budget. A circuit on X Layer approves every payment, and the seller is paid only once the goods are picked up.</p>
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
        {reply && <pre className="reply">{reply}</pre>}
      </div>
    </div>
  );
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------------------------------------------------------- orders
function Orders({ cfg, onChange }: { cfg: Config; onChange: () => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(() => Promise.all([server.orders().then(setOrders), server.requests().then(setRequests)]).catch((e) => setError(e.message)), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [refresh]);
  const act = (label: string, f: () => Promise<unknown>) => run(setBusy, setError, label, async () => { await f(); await refresh(); onChange(); });
  const count = (key: string, max: number) => {
    const n = Number(counts[key] ?? max);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Enter a number from 0 to ${max}.`);
    return n;
  };

  if (!orders) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {orders.length === 0 ? <div className="empty"><p>No orders yet.</p><p className="muted">Ask the agent for something.</p></div> : (
        <ul className="cards">
          {orders.map((o) => (
            <li key={o.orderId} className="card stack">
              <span className="row between"><strong>{o.ordered} × {o.item}</strong><StatusPill o={o} /></span>
              <span className="muted">{o.supplier.name} · {naira(o.unitPriceNaira)} each{o.self ? ' · you collect it' : ` · delivery ${naira(o.riderFeeNaira)}`} · paid in naira</span>
              {o.lastCheck && <Outcome r={o.lastCheck} />}
              {o.status === 'AwaitingOwner' && (
                <div className="stack"><p className="warn">This needs your OK. Approving never overrides a "no" from the circuit.</p>
                  <button className="btn primary" disabled={!!busy} onClick={() => act('Approving…', () => server.approve(o.orderId))}>Approve</button></div>
              )}
              {o.self && o.status === 'Locked' && (
                <div className="stack">
                  <p className="warn">Go to {o.supplier.name}. Count the good {o.unit}s you take: the seller is paid for that number, straight away.</p>
                  <div className="row wrap">
                    <label className="field"><span>{o.unit}s taken</span><input type="number" min={0} max={o.ordered} value={counts[`p${o.orderId}`] ?? String(o.ordered)} onChange={(e) => setCounts((c) => ({ ...c, [`p${o.orderId}`]: e.target.value }))} /></label>
                    <button className="btn primary" disabled={!!busy} onClick={() => act('Paying the seller…', () => server.collect(o.orderId, count(`p${o.orderId}`, o.ordered)))}>Confirm and pay seller</button>
                  </div>
                </div>
              )}
              {o.logistics && <Logistics o={o} />}
              {o.logistics && o.status === 'PickedUp' && o.logistics.ownerCount === undefined && (
                <div className="stack">
                  <p className="warn">When the rider arrives, count the good {o.unit}s before you give the delivery code. Fewer than {o.pickup.picked} means the delivery fee comes back to you.</p>
                  <div className="row wrap">
                    <label className="field"><span>{o.unit}s that arrived</span><input type="number" min={0} max={o.pickup.picked} value={counts[`d${o.orderId}`] ?? String(o.pickup.picked)} onChange={(e) => setCounts((c) => ({ ...c, [`d${o.orderId}`]: e.target.value }))} /></label>
                    <button className="btn primary" disabled={!!busy} onClick={() => act('Recording…', () => server.received(o.orderId, count(`d${o.orderId}`, o.pickup.picked)))}>Confirm what arrived</button>
                  </div>
                </div>
              )}
              <CircuitTrail evidence={o.evidence} network={cfg.network} />
            </li>
          ))}
        </ul>
      )}
      {requests.length > 0 && (
        <details className="supplier-list"><summary>Your requests ({requests.length})</summary>
          <ul className="cards">{requests.map((r) => (
            <li key={r.id} className="card stack"><strong>{r.text}</strong><span className="fine">Budget {naira(r.budgetNaira)} · {r.place.address} · {r.delivery === 'self' ? 'collect' : 'delivery'}</span><pre className="reply">{r.message}</pre></li>
          ))}</ul>
        </details>
      )}
    </div>
  );
}

const STATE: Record<string, string> = {
  booked: 'Booked', searching: 'Finding a rider', assigned: 'Rider on the way to the seller', picked_up: 'Picked up, on the way to you',
  at_dropoff: 'Rider at your address', delivered: 'Delivered', failed: 'Delivery failed', cancelled: 'Cancelled',
};
function Logistics({ o }: { o: Order }) {
  const l = o.logistics!;
  return (
    <div className="stack note">
      <p><strong>{l.carrierName}</strong>{l.test ? ' · test mode, simulated rider' : ''} · {l.state ? STATE[l.state] ?? l.state : 'Booking…'}{l.riderName ? ` · rider ${l.riderName}` : ''}</p>
      {l.pickupSigned && <p className="fine">Pickup confirmed by {l.carrierName}: their rider checked the goods against your order.</p>}
      {l.trackingUrl && <p><a href={l.trackingUrl} target="_blank" rel="noreferrer">Track the rider</a></p>}
      {l.handoverCode && o.status === 'PickedUp' && <p>Delivery code for the rider: <strong className="addr">{l.handoverCode}</strong>. Give it only after you have counted.</p>}
      {l.ownerCount !== undefined && <p className="fine">You counted {l.ownerCount} of {o.pickup.picked}.</p>}
      {l.error && <p className="alert">{l.error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- money: naira (Paystack) and coins (wallet)
function Money({ cfg, me, onChange }: { cfg: Config; me: Me; onChange: () => void }) {
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState(() => load<string>('stockrun.email', ''));
  const [moves, setMoves] = useState<Movement[]>([]);
  const [coins, setCoins] = useState<Coins | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const refresh = useCallback(() => { server.history().then(setMoves).catch(() => {}); if (me.user?.wallet) server.coins().then(setCoins).catch(() => {}); }, [me.user?.wallet]);
  useEffect(() => { refresh(); }, [refresh]);
  // Back from Paystack: confirm the payment (the server checks it with Paystack before crediting).
  useEffect(() => {
    const q = new URLSearchParams(location.search), ref = q.get('reference') ?? q.get('trxref');
    if (!ref) return;
    window.history.replaceState(null, '', location.pathname);
    run(setBusy, setError, 'Checking your payment with Paystack…', async () => {
      const r = await server.confirmDeposit(ref);
      setNote(r.status === 'credited' || r.status === 'already' ? `${naira(r.amountNaira)} added to your balance.` : r.status === 'pending' ? 'Paystack has not confirmed the payment yet. Check again in a minute.' : 'That payment did not go through. Nothing was charged.');
      onChange(); refresh();
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const n = Number(amount.replace(/\D/g, '')) || 0;

  return (
    <div className="stack">
      <div className="panel stack">
        <h2>Naira</h2>
        <dl className="money-grid">
          <div><dt>Ready to spend</dt><dd>{naira(me.naira?.availableNaira ?? 0)}</dd></div>
          <div><dt>Locked in orders</dt><dd>{naira(me.naira?.heldNaira ?? 0)}</dd></div>
        </dl>
        <p className="fine">Naira you deposit is held by StockRun and is not on-chain. Every payment from it is still decided by a TapeOut circuit on X Layer.</p>
        <label className="field"><span>Deposit (₦)</span><input className="money" inputMode="numeric" placeholder="50,000" value={n ? n.toLocaleString('en-NG') : ''} onChange={(e) => setAmount(e.target.value)} /></label>
        {cfg.naira.paystack ? (<>
          <label className="field"><span>Email (Paystack sends your receipt)</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          <button className="btn primary" disabled={!!busy || n < 100 || !email.includes('@')} onClick={() => run(setBusy, setError, 'Opening Paystack…', async () => {
            save('stockrun.email', email);
            const r = await server.deposit(n, email);
            location.href = r.checkoutUrl;
          })}>Pay {n ? naira(n) : ''} with Paystack</button>
          {cfg.naira.test && <p className="fine">Paystack is in test mode: use their test card, no real money moves.</p>}
        </>) : cfg.naira.testCredit ? (
          <button className="btn primary" disabled={!!busy || n < 100} onClick={() => run(setBusy, setError, 'Adding test naira…', async () => { await server.testNaira(n); onChange(); refresh(); })}>Add {n ? naira(n) : ''} test naira</button>
        ) : <p className="warn">Naira deposits are not switched on yet on this server.</p>}
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
        {note && <p className="ok">{note}</p>}
        {moves.length > 0 && (
          <details className="supplier-list"><summary>History</summary>
            <ul className="cards">{moves.map((m) => (
              <li key={m.key} className="card row between"><span>{m.type === 'deposit' ? 'Deposit' : m.type === 'hold' ? 'Locked for an order' : m.type === 'release' ? 'Came back to you' : m.type}</span><span className={m.amountNaira > 0 ? 'ok' : ''}>{m.amountNaira > 0 ? '+' : ''}{naira(m.amountNaira)}</span></li>
            ))}</ul>
          </details>
        )}
      </div>
      <div className="panel stack">
        <h2>Coins</h2>
        {me.user?.wallet ? (coins?.wallet ? (<>
          <p className="fine">Wallet {short(coins.wallet)} on {coins.network === 'xlayer' ? 'X Layer' : 'the local test chain'} (read from the chain; StockRun never holds it).</p>
          <dl className="money-grid">
            <div><dt>{coins.token?.symbol}</dt><dd>{coins.token?.amount} (≈ {naira(coins.token?.naira ?? 0)})</dd></div>
            <div><dt>OKB (gas)</dt><dd>{Number(coins.okb).toFixed(5)}</dd></div>
          </dl>
          <p className="warn">Paying for orders with coins from your wallet is the next step being built. For now, orders are paid from your naira balance.</p>
        </>) : <p className="muted">Reading your wallet…</p>) : <p className="muted">Connect a wallet in <strong>Me</strong> to see your coins.</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- profile
function Profile({ user, onChange }: { user: User; onChange: () => void }) {
  const [username, setUsername] = useState(user.username ?? '');
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [pic, setPic] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const go = (label: string, f: () => Promise<void>) => { setSaved(''); return run(setBusy, setError, label, f); };

  return (
    <div className="stack">
      <div className="panel stack">
        <h2>Profile</h2>
        <div className="row wrap">
          {user.hasAvatar ? <img className="avatar big" src={avatarUrl(user.id, pic)} alt="Your picture" /> : <span className="avatar big empty" aria-hidden="true">?</span>}
          <label className="btn ghost file">Change picture
            <input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) go('Uploading…', async () => { const p = await preparePhoto(f, 256, 0.8); await server.avatar(p.mediaType, p.data); setPic(Date.now()); onChange(); setSaved('Picture saved.'); }); }} />
          </label>
        </div>
        <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ada_lagos" maxLength={20} /></label>
        <label className="field"><span>Name</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Obi" maxLength={40} /></label>
        <button className="btn primary" disabled={!!busy} onClick={() => go('Saving…', async () => { await server.profile({ username: username.trim() || undefined, displayName }); onChange(); setSaved('Saved.'); })}>Save</button>
        <p className="fine">Your username, name and picture are public. Your phone number and wallet are never shown to others.</p>
      </div>
      <div className="panel stack">
        <h2>Sign-in methods</h2>
        <p>Phone: {user.phone ?? 'not added'} · Wallet: {user.wallet ? short(user.wallet) : 'not connected'}</p>
        {!user.wallet && <button className="btn ghost" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
          const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
          await server.addWallet(s.message, s.signature); onChange(); setSaved('Wallet connected.');
        })}>{hasWallet() ? 'Connect a wallet' : 'No wallet in this browser'}</button>}
        {!user.phone && (<>
          <label className="field"><span>Add a phone number</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 123 4567" disabled={sent} /></label>
          {!sent ? <button className="btn ghost" disabled={!!busy || phone.replace(/\D/g, '').length < 10} onClick={() => go('Sending…', async () => { await server.requestCode(phone); setSent(true); })}>Send code</button> : (<>
            <label className="field"><span>Code</span><input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
            <button className="btn ghost" disabled={!!busy || code.length !== 6} onClick={() => go('Adding…', async () => { await server.addPhone(phone, code); onChange(); setSaved('Phone added.'); })}>Add phone</button>
          </>)}
        </>)}
        <button className="link" onClick={() => server.logout().then(() => location.reload())}>Sign out</button>
      </div>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
    </div>
  );
}
