// StockRun for everyone: sign in with an email address or a wallet, keep a profile, deposit naira, and ask the agent
// for what you want with a budget and a delivery pin. The agent finds sellers on the map, negotiates on WhatsApp and
// pays the seller only once the logistics company (or you, collecting) has the goods.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  avatarUrl, currentPosition, hasWallet, load, naira, preparePhoto, save, server, short, signWithWallet, whatsappLink,
  type Category, type Coins, type Config, type DealResult, type FoundSeller, type HuntResult, type Me, type MySeller, type PlaceHit, type SellerHit, type Movement, type Order, type Place, type RequestRecord, type Seller, type User,
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
  if (!me.user) return <SignIn cfg={cfg} onDone={reload} />;
  const u = me.user;
  const name = u.username ? `@${u.username}` : u.phone ?? u.email ?? (u.wallet ? short(u.wallet) : 'You');

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
      {tab === 'ask' && <Ask cfg={cfg} user={u} me={me} onAsked={() => { reload(); setTab('orders'); }} goMoney={() => setTab('money')} />}
      {tab === 'orders' && <Orders cfg={cfg} onChange={reload} />}
      {tab === 'money' && <Money cfg={cfg} me={me} onChange={reload} />}
      {tab === 'me' && <Profile user={u} onChange={() => { setBust(Date.now()); reload(); }} />}
    </section>
  );
}

// ---------------------------------------------------------------- sign in: email or wallet
function SignIn({ cfg, onDone }: { cfg: Config; onDone: () => void }) {
  const [way, setWay] = useState<'email' | 'wallet'>(cfg.emailSignIn ? 'email' : 'wallet');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const go = (label: string, f: () => Promise<void>) => run(setBusy, setError, label, f);
  const signIn = (c: string) => go('Signing in…', async () => { await server.emailVerify(email, c); save('stockrun.signin', 'email'); onDone(); });
  const pick = (w: typeof way) => { setWay(w); setSent(false); setCode(''); setError(''); };
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  return (
    <section className="stack">
      <header className="screen-head">
        <p className="eyebrow">StockRun</p>
        <h1>Tell the AI what you need. It finds it on the map.</h1>
        <p className="muted">It finds sellers near you, haggles on WhatsApp, and pays them only after the goods are picked up.</p>
      </header>
      <nav className="tabs" role="tablist">
        {cfg.emailSignIn && <button role="tab" aria-selected={way === 'email'} className={way === 'email' ? 'on' : ''} onClick={() => pick('email')}>Email</button>}
        <button role="tab" aria-selected={way === 'wallet'} className={way === 'wallet' ? 'on' : ''} onClick={() => pick('wallet')}>Wallet</button>
      </nav>
      <div className="panel stack">
        {way === 'email' ? (<>
          <label className="field"><span>Email address</span>
            <input type="email" inputMode="email" autoComplete="email" placeholder="ada@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} />
          </label>
          {!sent ? (
            <button className="btn primary" disabled={!!busy || !emailOk} onClick={() => go('Sending…', async () => { await server.emailCode(email.trim()); setSent(true); })}>Email me a code</button>
          ) : (<>
            <label className="field"><span>6-digit code</span>
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => {
                const c = e.target.value.replace(/\D/g, '');
                setCode(c);
                if (c.length === 6 && !busy) signIn(c);   // pasted or filled in: sign in straight away
              }} />
            </label>
            <p className="fine">We've emailed a code to {email.trim()}. Not there? Check Spam or Promotions.</p>
            <button className="btn primary" disabled={!!busy || code.length !== 6} onClick={() => signIn(code)}>Sign in</button>
            <button className="link" disabled={!!busy} onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </>)}
        </>) : (<>
          <p>Sign in with OKX Wallet or MetaMask. You sign a short message: it costs nothing and moves no money.</p>
          {!hasWallet() && <p className="warn">No wallet found in this browser. Open StockRun inside the OKX Wallet or MetaMask app, or install their extension.</p>}
          <button className="btn primary" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
            const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
            await server.walletSignIn(s.message, s.signature); save('stockrun.signin', 'wallet'); onDone();
          })}>Connect wallet</button>
        </>)}
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- ask: what, budget, where; sellers on the map
function Ask({ cfg, user, me, onAsked, goMoney }: { cfg: Config; user: User; me: Me; onAsked: () => void; goMoney: () => void }) {
  const [text, setText] = useState('');
  const [budget, setBudget] = useState('');
  const [place, setPlace] = useState<Place>(() => load<Place>('stockrun.place', { lat: NaN, lng: NaN, address: '' }));
  const [delivery, setDelivery] = useState<'logistics' | 'self'>('logistics');
  const [contact, setContact] = useState('');
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [hunt, setHunt] = useState<HuntResult | null>(null);
  const [found, setFound] = useState<FoundSeller[]>([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ sellers: SellerHit[]; places: PlaceHit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<SellerHit | null>(null);
  const markers = useRef(new Map<string, L.CircleMarker>());
  const [draft, setDraft] = useState<{ id: string; name: string; phone: string; message: string; ai: boolean } | null>(null);
  const contactPanel = useRef<HTMLDivElement>(null);
  const [deal, setDeal] = useState<{ id: string; name: string; seller: MySeller | null; item: string; quantity: string; unit: string; price: string; category: Category; result: DealResult | null; note: string } | null>(null);
  const dealPanel = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState('');
  const [showMap, setShowMap] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const el = useRef<HTMLDivElement>(null), map = useRef<L.Map | null>(null), layer = useRef<L.LayerGroup | null>(null);
  const pinned = Number.isFinite(place.lat) && Number.isFinite(place.lng);
  const available = me.naira?.availableNaira ?? 0;

  useEffect(() => {
    if (!showMap || !el.current || map.current) return;
    const m = L.map(el.current).setView(pinned ? [place.lat, place.lng] : LAGOS, pinned ? 13 : 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => setPlace((p) => ({ ...p, lat: e.latlng.lat, lng: e.latlng.lng })));
    map.current = m;
    if (hunt?.sellers.length) m.fitBounds(L.latLngBounds([[place.lat, place.lng], ...hunt.sellers.map((s): [number, number] => [s.lat, s.lng])]).pad(0.2));
    return () => { m.remove(); map.current = null; layer.current = null; };
  }, [showMap]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { save('stockrun.place', place); }, [place]);
  useEffect(() => {
    if (!pinned) return;
    server.map(place.lat, place.lng, 25).then((r) => { setSellers(r.sellers); setFound(r.found ?? []); }).catch(() => { setSellers([]); setFound([]); });
  }, [place.lat, place.lng, pinned]);
  useEffect(() => {
    const g = layer.current; if (!g) return;
    g.clearLayers(); markers.current.clear();
    for (const s of sellers) {
      const rows = s.prices.slice(0, 6).map((p) => `<tr><td>${esc(p.item)}</td><td class="num">${naira(p.priceNaira)}</td></tr>`).join('');
      markers.current.set(s.id, L.circleMarker([s.lat, s.lng], { radius: 8, color: s.verified ? '#18794A' : '#7A8194', weight: 3, fillOpacity: 0.8, fillColor: s.verified ? '#18794A' : '#7A8194' })
        .bindPopup(`<div class="pop"><strong>${esc(s.name)}</strong><span>${esc(s.market)} · ${s.km} km${s.simulated ? ' · demo seller' : ''}</span><table>${rows}</table></div>`).addTo(g));
    }
    const shown = new Map<string, FoundSeller>();
    for (const f of [...found, ...(hunt?.sellers ?? [])]) shown.set(f.id, f);
    if (picked && !picked.demo && picked.phone) shown.set(picked.id, { ...picked, phone: picked.phone, source: picked.source as FoundSeller['source'] });
    if (picked?.demo && !markers.current.has(picked.id)) {
      markers.current.set(picked.id, L.circleMarker([picked.lat, picked.lng], { radius: 8, color: '#7A8194', weight: 3, fillOpacity: 0.8, fillColor: '#7A8194' })
        .bindPopup(`<div class="pop"><strong>${esc(picked.name)}</strong><span>${esc(picked.address)} · demo seller</span></div>`).addTo(g));
    }
    for (const f of shown.values()) {
      markers.current.set(f.id, L.circleMarker([f.lat, f.lng], { radius: 9, color: '#C2410C', weight: 3, fillOpacity: 0.85, fillColor: '#F97316' })
        .bindPopup(`<div class="pop"><strong>${esc(f.name)}</strong><span>${f.kind ? `${esc(f.kind.replace(/_/g, ' '))} · ` : ''}${f.km} km · WhatsApp ${esc(f.phone)}</span><span>Found on ${SOURCE[f.source]} · not confirmed by StockRun</span>${f.sourceUrl ? `<a href="${esc(f.sourceUrl)}" target="_blank" rel="noreferrer">Where we found it</a>` : ''}${f.source === 'osm' ? '<span class="fine">© OpenStreetMap contributors</span>' : ''}<button type="button" class="wa-btn" data-seller="${esc(f.id)}">Message on WhatsApp</button><button type="button" class="deal-btn" data-deal="${esc(f.id)}" data-name="${esc(f.name)}">Record the deal</button></div>`).addTo(g));
    }
    if (pinned) L.circleMarker([place.lat, place.lng], { radius: 10, color: '#141B2E', weight: 3, fillColor: '#F4C20D', fillOpacity: 1 }).bindTooltip('Deliver here').addTo(g);
    if (picked) markers.current.get(picked.id)?.openPopup();
  }, [sellers, found, hunt, picked, place.lat, place.lng, pinned, showMap]);

  const search = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setSearching(true);
    try { setResults(await server.search(q.trim(), pinned ? place : undefined)); }
    catch (err) { setError((err as Error).message); }
    finally { setSearching(false); }
  };
  const goSeller = (s: SellerHit) => { setResults(null); setPicked(s); map.current?.setView([s.lat, s.lng], 16); };
  const goPlace = (p: PlaceHit) => {
    setResults(null); setPicked(null);
    setPlace((x) => ({ lat: p.lat, lng: p.lng, address: x.address.trim() ? x.address : [p.name, p.address].filter(Boolean).join(', ') }));
    map.current?.setView([p.lat, p.lng], 15);
  };
  /** The AI writes the buyer's message to this seller; the buyer checks it and sends it from their own WhatsApp. */
  const contactSeller = (id: string) => run(setBusy, setError, 'The AI is writing your message…', async () => {
    if (text.trim().length < 3) throw new Error('Type what you want to buy first, then tap Message on WhatsApp.');
    const r = await server.messageDraft(id, text.trim(), place, delivery);
    setDraft({ id, name: r.seller.name, phone: r.seller.phone, message: r.message, ai: r.ai });
    setTimeout(() => contactPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  });
  const contactRef = useRef(contactSeller);
  contactRef.current = contactSeller;
  /** Record a deal agreed on WhatsApp: it becomes an order that RestockGuard decides, paid to the seller at pickup. */
  const openDeal = (id: string, name: string) => run(setBusy, setError, 'Checking your sellers…', async () => {
    const seller = await server.mySeller(id);
    setDeal({ id, name, seller, item: '', quantity: '1', unit: 'carton', price: '', category: 'staples', result: null, note: '' });
    setTimeout(() => dealPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  });
  const dealRef = useRef(openDeal);
  dealRef.current = openDeal;
  /** What still stops this deal, in plain words; empty when it can be sent. */
  const dealProblem = (d: NonNullable<typeof deal>): string => {
    const price = Number(d.price.replace(/\D/g, '')), qty = Number(d.quantity);
    if (d.seller?.status === 3) return 'You blocked this seller.';
    if (d.seller?.status !== 1 && d.seller?.pendingStatus) return `${d.name} joins your sellers on ${lagosTime(d.seller.effectiveAt!)}. You can record the deal from then.`;
    if (d.item.trim().length < 2) return 'Say what you agreed to buy.';
    if (!Number.isInteger(qty) || qty < 1 || qty > 255) return 'Enter how many (1 to 255).';
    if (!(price >= 1)) return `Enter the agreed price per ${d.unit || 'unit'}.`;
    if (!pinned) return 'Type your delivery address and tap Find sellers first, so the distance can be checked.';
    if (delivery === 'logistics' && !user.phone && contact.replace(/\D/g, '').length < 10) return 'Add a phone number for the rider (under "How should it reach you?"), or choose to collect it yourself.';
    if (price * qty > available) return `This deal is ${naira(price * qty)} but your balance is ${naira(available)}. Deposit naira first.`;
    return '';
  };
  const submitDeal = async () => {
    if (!deal) return;
    const problem = dealProblem(deal);
    if (problem) { setDeal({ ...deal, note: problem, result: null }); return; }
    setBusy('RestockGuard is checking your deal…');
    try {
      const result = await server.recordDeal({ sellerId: deal.id, item: deal.item.trim(), quantity: Number(deal.quantity), unit: deal.unit.trim(), unitPriceNaira: Number(deal.price.replace(/\D/g, '')),
        category: deal.category, delivery, place, contactPhone: contact || undefined });
      setDeal({ ...deal, result, note: '' });
    } catch (e) { setDeal({ ...deal, note: (e as Error).message, result: null }); }
    finally { setBusy(''); }
  };
  const lagosTime = (t: number) => new Date(t).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  useEffect(() => {
    const box = el.current; if (!box) return;
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.wa-btn');
      if (b?.dataset.seller) { e.preventDefault(); map.current?.closePopup(); contactRef.current(b.dataset.seller); }
      const d = (e.target as HTMLElement).closest<HTMLElement>('.deal-btn');
      if (d?.dataset.deal) { e.preventDefault(); map.current?.closePopup(); dealRef.current(d.dataset.deal, d.dataset.name ?? 'this seller'); }
    };
    box.addEventListener('click', onClick);
    return () => box.removeEventListener('click', onClick);
  }, [showMap]);

  const here = () => run(setBusy, setError, 'Finding you…', async () => {
    const p = await currentPosition();
    setPlace((x) => ({ ...x, lat: p.lat, lng: p.lng }));
    map.current?.setView([p.lat, p.lng], 15);
  });
  /** The AI decides what kind of seller sells this (from the goods and the budget) and finds the closest to the address. */
  const findSellers = () => run(setBusy, setError, 'Finding your address and the right sellers near it…', async () => {
    const r = await server.hunt(text, place, Number(budget.replace(/\D/g, '')) || 0);
    setPlace((x) => ({ ...x, lat: r.place.lat, lng: r.place.lng }));
    setHunt(r);
    if (r.sellers.length && map.current) map.current.fitBounds(L.latLngBounds([[r.place.lat, r.place.lng], ...r.sellers.map((s): [number, number] => [s.lat, s.lng])]).pad(0.2));
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
        <label className="field"><span>Deliver to (your area is enough)</span>
          <input placeholder="Ikeja, or 12 Ikorodu Road, Ketu" autoComplete="street-address" value={place.address}
            onChange={(e) => setPlace({ lat: NaN, lng: NaN, address: e.target.value })} />
        </label>
        <button className="link" onClick={here}>Use where I am instead</button>
        <fieldset className="stack choice-group">
          <legend className="fine">How should it reach you?</legend>
          <label className="row"><input type="radio" checked={delivery === 'logistics'} onChange={() => setDelivery('logistics')} /> A verified logistics company delivers it</label>
          <label className="row"><input type="radio" checked={delivery === 'self'} onChange={() => setDelivery('self')} /> I'll collect it from the seller (no delivery fee)</label>
        </fieldset>
        {delivery === 'logistics' && !user.phone && (
          <label className="field"><span>Phone number for the rider</span><input inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="0803 123 4567" /></label>
        )}
        <button className="btn primary" disabled={!!busy || !cfg.sellerHunt || text.trim().length < 3 || (place.address.trim().length < 2 && !pinned)} onClick={findSellers}>Find sellers</button>
        <p className="fine">{cfg.sellerHunt
          ? 'The AI works out what kind of seller sells this, from your goods and budget, and finds the closest ones to your address that have a WhatsApp number. They are real businesses, not checked by StockRun.'
          : 'Seller search is not switched on yet on this server.'}</p>
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
        {hunt && (
          <div className="stack">
            <p className="fine">Near <strong>{hunt.place.matched || hunt.place.address}</strong> · looked for {hunt.shopTypes.map((t) => t.replace(/_/g, ' ')).join(', ')}</p>
            <FoundList hunt={hunt} onContact={(id) => contactSeller(id)} onDeal={openDeal} />
          </div>
        )}
        {draft && (
          <div ref={contactPanel} className="stack note contact">
            <p><strong>Message to {draft.name}</strong> <span className="fine">· WhatsApp {draft.phone}</span></p>
            <label className="field"><span>{draft.ai ? 'Written by the AI from your request. Change anything you like.' : 'Your message. Change anything you like.'}</span>
              <textarea rows={4} value={draft.message} maxLength={600} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
            </label>
            <a className="btn wa" href={whatsappLink(draft.phone, draft.message)} target="_blank" rel="noreferrer">Open WhatsApp chat</a>
            <button className="btn ghost" onClick={() => openDeal(draft.id, draft.name)}>Agreed a price? Record the deal</button>
            <p className="fine">WhatsApp opens on your phone with this message typed in; you send it and chat with the seller yourself. StockRun does not see the chat. This seller was found on a public map and is not checked by StockRun, so agree the price and see the goods before you pay.</p>
            <button className="link" onClick={() => setDraft(null)}>Close</button>
          </div>
        )}
        {deal && (
          <div ref={dealPanel} className="stack note deal">
            <p><strong>Record your deal with {deal.name}</strong></p>
            {deal.seller?.status === 3 ? <p className="alert">You blocked this seller.</p>
              : deal.seller?.status === 1 ? <p className="ok">✓ {deal.name} is on your sellers list.</p>
              : deal.seller?.pendingStatus ? <p className="warn">{deal.name} joins your sellers on {lagosTime(deal.seller.effectiveAt!)}.</p>
              : <p className="fine">Recording this deal adds {deal.name} to your sellers.</p>}
            <label className="field"><span>What you agreed to buy</span><input value={deal.item} maxLength={80} placeholder="Indomie noodles (40 x 70g)" onChange={(e) => setDeal({ ...deal, item: e.target.value })} /></label>
            <div className="row wrap">
              <label className="field"><span>How many</span><input type="number" min={1} max={255} value={deal.quantity} onChange={(e) => setDeal({ ...deal, quantity: e.target.value })} /></label>
              <label className="field"><span>Unit</span><input value={deal.unit} maxLength={20} placeholder="carton" onChange={(e) => setDeal({ ...deal, unit: e.target.value })} /></label>
              <label className="field"><span>Price per {deal.unit || 'unit'} (₦)</span><input className="money" inputMode="numeric" placeholder="14,000" value={Number(deal.price.replace(/\D/g, '')) ? Number(deal.price.replace(/\D/g, '')).toLocaleString('en-NG') : ''} onChange={(e) => setDeal({ ...deal, price: e.target.value })} /></label>
            </div>
            <label className="field"><span>Kind of goods</span>
              <select value={deal.category} onChange={(e) => setDeal({ ...deal, category: e.target.value as Category })}>
                {CATEGORY_LABELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {Number(deal.price.replace(/\D/g, '')) > 0 && Number(deal.quantity) > 0 && <p className="fine">Total {naira(Number(deal.price.replace(/\D/g, '')) * Number(deal.quantity))}{delivery === 'logistics' ? ' plus delivery' : ', you collect it'} · your balance {naira(available)}</p>}
            <button className="btn primary" disabled={!!busy} onClick={submitDeal}>{busy && busy.startsWith('RestockGuard') ? 'Checking…' : 'Record deal and lock the money'}</button>
            {deal.note && <p className="alert">{deal.note}</p>}
            <p className="fine">RestockGuard, a circuit on X Layer, decides whether the money locks. {deal.name} is paid from it only at pickup, for the number of good {deal.unit || 'unit'}s counted ({delivery === 'self' ? 'by you' : 'by the logistics company'}). Uses your pickup or delivery choice above.</p>
            {deal.result && <pre className="reply">{deal.result.message}</pre>}
            {deal.result && (deal.result.status === 'locked' || deal.result.status === 'ask_owner') && <button className="btn ghost" onClick={onAsked}>See it in Orders</button>}
            <button className="link" onClick={() => setDeal(null)}>Close</button>
          </div>
        )}
        <button className="link" onClick={() => setShowMap((v) => !v)}>{showMap ? 'Hide the map' : 'Show on map'}</button>
        {showMap && (<>
        <div className="map-wrap">
          <div ref={el} className="map pick" />
          <form className="map-search" role="search" onSubmit={search}>
            <input type="search" aria-label="Search sellers or places" placeholder="Search sellers or places (e.g. Shoprite, Mile 12)" value={q}
              onChange={(e) => { setQ(e.target.value); if (!e.target.value) setResults(null); }} />
            <button className="btn primary" type="submit" disabled={searching || q.trim().length < 2}>{searching ? '…' : 'Search'}</button>
          </form>
          {results && (
            <div className="map-results" role="listbox">
              {!results.sellers.length && !results.places.length && <p className="muted">Nothing found for &ldquo;{q}&rdquo;.</p>}
              {results.sellers.map((s) => (
                <button key={s.id} type="button" className="map-hit" onClick={() => goSeller(s)}>
                  <strong>{s.name}</strong><span className="fine">{s.demo ? 'demo seller' : `${(s.kind ?? 'seller').replace(/_/g, ' ')} · not confirmed`} · {s.km} km{s.address ? ` · ${s.address}` : ''}</span>
                </button>
              ))}
              {results.places.map((p, i) => (
                <button key={`p${i}`} type="button" className="map-hit place" onClick={() => goPlace(p)}>
                  <strong>📍 {p.name}</strong><span className="fine">{p.kind}{p.address ? ` · ${p.address}` : ''} · tap to deliver here</span>
                </button>
              ))}
              <button type="button" className="link" onClick={() => setResults(null)}>Close</button>
            </div>
          )}
        </div>
          <span className="fine">{pinned ? `${found.length} real and ${sellers.length} demo seller(s) within 25 km · tap the map to move your pin` : 'Tap the map to drop your delivery pin.'}</span>
        </>)}
        <details className="supplier-list">
          <summary>Try the demo agent (demo sellers, it haggles for you)</summary>
          <div className="stack">
            <p className="fine">Six demo sellers answered by bots. The agent haggles on your behalf within your budget, then RestockGuard locks the money. Needs your address found on the map first (Find sellers, or Show on map).</p>
            <button className="btn ghost" disabled={!!busy || text.trim().length < 3 || b < 1000 || !pinned || place.address.trim().length < 2} onClick={ask}>Ask the demo agent</button>
            {reply && <pre className="reply">{reply}</pre>}
          </div>
        </details>
      </div>
    </div>
  );
}
const SOURCE = { maps: 'Google Maps', osm: 'OpenStreetMap', web: 'the web' } as const;
const SOURCE_FROM = { maps: 'its Google Maps listing', osm: 'its OpenStreetMap entry', web: 'a web page' } as const;
const CATEGORY_LABELS: [Category, string][] = [
  ['staples', 'Food staples (rice, noodles, flour, garri)'], ['drinks', 'Drinks (water, soft drinks, malt)'], ['cooking', 'Cooking (oil, tomato paste, sugar)'],
  ['toiletries', 'Toiletries (soap, detergent)'], ['snacks', 'Snacks and biscuits'], ['household', 'Household (batteries, candles, bags)'],
  ['restricted', 'Alcohol or cigarettes (always needs your OK)'], ['highValue', 'Phones, electronics, anything else (always needs your OK)'],
];
function FoundList({ hunt, onContact, onDeal }: { hunt: HuntResult; onContact: (id: string) => void; onDeal: (id: string, name: string) => void }) {
  if (!hunt.sellers.length) return <p className="muted">No seller of this kind with a WhatsApp number turned up near your address. Try other words, or a nearby area.</p>;
  return (
    <ul className="cards">
      {hunt.sellers.map((f: FoundSeller) => (
        <li key={f.id} className="card stack tight">
          <span className="row between"><strong>{f.name}</strong><span className="pill found">found by AI</span></span>
          <span className="fine">{f.kind ? `${f.kind.replace(/_/g, ' ')} · ` : ''}{f.km} km · {f.address}</span>
          <span className="fine">WhatsApp {f.phone} · from {SOURCE_FROM[f.source]}{f.sourceUrl && <> · <a href={f.sourceUrl} target="_blank" rel="noreferrer">source</a></>}</span>
          <span className="row wrap"><button className="btn wa small" onClick={() => onContact(f.id)}>Message on WhatsApp</button><button className="btn ghost small" onClick={() => onDeal(f.id, f.name)}>Record the deal</button></span>
        </li>
      ))}
    </ul>
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
  const [email, setEmail] = useState(() => load<string>('stockrun.email', ''));
  const [moves, setMoves] = useState<Movement[]>([]);
  const [coins, setCoins] = useState<Coins | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [sheet, setSheet] = useState<null | 'amount' | 'pay'>(null);
  const [amount, setAmount] = useState(0);
  // Naira for people who signed in with email, dollars for people who signed in with a wallet.
  const how = load<'phone' | 'email' | 'wallet' | ''>('stockrun.signin', '');
  const currency: Currency = how === 'wallet' || (!how && !me.user?.phone && !me.user?.email && me.user?.wallet) ? 'usd' : 'ngn';
  const close = useCallback(() => { setSheet(null); setError(''); }, []);
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
  const walletDollars = Number(coins?.token?.amount ?? 0);
  const nairaOn = cfg.naira.paystack || cfg.naira.testCredit;
  const max = currency === 'usd' ? (Number.isFinite(walletDollars) ? walletDollars : 0) : cfg.naira.paystack ? 0 : 500_000;

  return (
    <div className="stack">
      <div className="panel stack">
        <h2>Naira</h2>
        <dl className="money-grid">
          <div><dt>Ready to spend</dt><dd>{naira(me.naira?.availableNaira ?? 0)}</dd></div>
          <div><dt>Locked in orders</dt><dd>{naira(me.naira?.heldNaira ?? 0)}</dd></div>
        </dl>
        <p className="fine">Naira you deposit is held by StockRun and is not on-chain. Every payment from it is still decided by a TapeOut circuit on X Layer.</p>
        <button className="btn primary" disabled={!!busy} onClick={() => { setNote(''); setError(''); setSheet('amount'); }}>Deposit</button>
        {currency === 'ngn' && !nairaOn && <p className="warn">Naira deposits are not switched on yet on this server.</p>}
        {busy && !sheet && <p className="busy">{busy}</p>}
        {error && !sheet && <p className="alert">{error}</p>}
        {note && <p className="ok">{note}</p>}
        {moves.length > 0 && (
          <details className="supplier-list"><summary>History</summary>
            <ul className="cards">{moves.map((m) => (
              <li key={m.key} className="card row between"><span>{m.type === 'deposit' ? 'Deposit (Paystack)' : m.type === 'demo' ? 'Demo naira (not real money)' : m.type === 'hold' ? 'Locked for an order' : m.type === 'release' ? 'Came back to you' : m.type}</span><span className={m.amountNaira > 0 ? 'ok' : ''}>{m.amountNaira > 0 ? '+' : ''}{naira(m.amountNaira)}</span></li>
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

      {sheet === 'amount' && (
        <AmountSheet title="Add money" currency={currency} max={max} onClose={close}
          onContinue={(a) => { setAmount(a); setSheet('pay'); }} />
      )}
      {sheet === 'pay' && (
        <Sheet title={`Add ${money(currency, amount)}`} onClose={close} onBack={() => setSheet('amount')}>
          {currency === 'usd' ? (
            <div className="stack">
              <p>Moving {coins?.token?.symbol ?? 'coins'} from your wallet into StockRun is the next step being built, so this deposit can't be made yet.</p>
              <p className="fine">Nothing has been taken from your wallet.</p>
              <button className="btn ghost" onClick={close}>Close</button>
            </div>
          ) : (
            <div className="stack">
              {cfg.naira.testCredit && (
                <div className="stack note">
                  <p><strong>Try it free:</strong> demo naira is play money for testing. It is not real money and buys nothing real.</p>
                  <button className="btn primary" disabled={!!busy || amount < 100 || amount > 500_000} onClick={() => run(setBusy, setError, 'Adding demo naira…', async () => { await server.testNaira(amount); onChange(); refresh(); setNote(`${naira(amount)} demo naira added (not real money).`); close(); })}>Add {naira(amount)} demo naira</button>
                  <p className="fine">Up to ₦500,000 at a time and ₦2,000,000 a day.</p>
                </div>
              )}
              {cfg.naira.paystack && (<>
                <label className="field"><span>Email (Paystack sends your receipt)</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
                <button className="btn primary" disabled={!!busy || amount < 100 || !email.includes('@')} onClick={() => run(setBusy, setError, 'Opening Paystack…', async () => {
                  save('stockrun.email', email);
                  const r = await server.deposit(amount, email);
                  location.href = r.checkoutUrl;
                })}>Pay {naira(amount)} with Paystack</button>
                {cfg.naira.test && <p className="fine">Paystack is in test mode: use their test card, no real money moves.</p>}
              </>)}
              {!nairaOn && <p className="warn">Naira deposits are not switched on yet on this server.</p>}
              {busy && <p className="busy">{busy}</p>}
              {error && <p className="alert">{error}</p>}
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- deposit sheet: big amount and a keypad
type Currency = 'ngn' | 'usd';
const money = (c: Currency, n: number) => c === 'ngn' ? naira(n) : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function Sheet({ title, onClose, onBack, children }: { title: string; onClose: () => void; onBack?: () => void; children: ReactNode }) {
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

/** max 0 = no limit known here (the server still checks). */
function AmountSheet({ title, currency, max, onClose, onContinue }: { title: string; currency: Currency; max: number; onClose: () => void; onContinue: (n: number) => void }) {
  const [text, setText] = useState('');
  const n = Number(text) || 0;
  const min = currency === 'ngn' ? 100 : 1;
  const press = (k: string) => setText((t) => {
    if (k === '<') return t.slice(0, -1);
    if (k === '.') return currency === 'usd' && !t.includes('.') ? (t || '0') + '.' : t;
    if (k === '00' && (t === '' || t === '0')) return t;
    const next = (t === '0' ? '' : t) + k;
    if (currency === 'usd' && /\.\d{3}$/.test(next)) return t;   // cents only
    if (next.replace('.', '').length > 10) return t;
    return next;
  });
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('<');
      else if (e.key === '.') press('.');
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const [whole, cents] = text.split('.');
  const sym = currency === 'ngn' ? '₦' : '$';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', currency === 'usd' ? '.' : '00', '0', '<'];
  const tooBig = max > 0 && n > max;

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="pad-amount" aria-live="polite">
        {sym}{Number(whole || 0).toLocaleString(currency === 'ngn' ? 'en-NG' : 'en-US')}{cents !== undefined && <small>.{cents}</small>}
      </div>
      <p className={`fine center${tooBig ? ' warn-text' : ''}`}>
        {tooBig ? `The most you can add here is ${money(currency, max)}.` : currency === 'ngn' ? 'Naira, held by StockRun for you (not on-chain).' : 'Dollars, from the coins in your wallet.'}
      </p>
      <div className="keypad">
        {keys.map((k) => (
          <button key={k} type="button" aria-label={k === '<' ? 'Delete' : k} onClick={() => press(k)}>{k === '<' ? '‹' : k}</button>
        ))}
      </div>
      <div className="sheet-actions">
        <button className="btn ghost pill" disabled={max <= 0} onClick={() => setText(String(max))}>Use max</button>
        <button className="btn primary pill" disabled={n < min || tooBig} onClick={() => onContinue(n)}>Continue</button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- profile
function Profile({ user, onChange }: { user: User; onChange: () => void }) {
  const [username, setUsername] = useState(user.username ?? '');
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
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
        <p className="fine">Your username, name and picture are public. Your email and wallet are never shown to others.</p>
      </div>
      <div className="panel stack">
        <h2>Sign-in methods</h2>
        <p>Email: {user.email ?? 'not added'} · Wallet: {user.wallet ? short(user.wallet) : 'not connected'}</p>
        {!user.wallet && <button className="btn ghost" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
          const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
          await server.addWallet(s.message, s.signature); onChange(); setSaved('Wallet connected.');
        })}>{hasWallet() ? 'Connect a wallet' : 'No wallet in this browser'}</button>}
      </div>
      <div className="panel stack">
        <h2>Log out</h2>
        <p className="fine">Logs you out on this device. Your balance, orders and profile stay safe; log back in with your email or wallet.</p>
        <button className="btn danger" disabled={!!busy} onClick={() => go('Logging out…', async () => {
          await server.logout();
          save('stockrun.signin', '');
          location.reload();
        })}>Log out</button>
      </div>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {saved && <p className="ok">{saved}</p>}
    </div>
  );
}
