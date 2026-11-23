// StockRun for everyone: sign in with an email address or a wallet, keep a profile, deposit naira, and ask the agent
// for what you want with a budget and a delivery pin. The agent finds sellers on the map, negotiates on WhatsApp and
// pays the seller only once the logistics company (or you, collecting) has the goods.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  walletSend, type CoinVault,
  avatarUrl, currentPosition, hasWallet, load, naira, preparePhoto, save, server, serviceFee, short, signWithWallet, whatsappLink,
  type Category, type Coins, type Config, type DealResult, type DepositQuote, type FoundSeller, type HuntResult, type Me, type MySeller, type PlaceHit, type SellerHit, type Movement, type Order, type Place, type RequestRecord, type Seller, type User,
} from './lib';
import { CircuitTrail, Outcome, Sheet, StatusPill, Tx } from './ui';
import { Admin } from './Admin';
import { WithdrawPanel } from './Banks';
import { ChatsTab, MyStore } from './Store';
import { FeedTab } from './Feed';
import { Icon } from './icons';
import { CoinWithdraw, CoinsPanel, coinFee, depositCoins, maxDepositFor } from './Coins';

type Tab = 'feed' | 'ask' | 'orders' | 'chats' | 'money' | 'me' | 'admin';
/** The Route S mark: a solid dot at pickup, an open ring at the shop. Ink on light, danfo yellow on dark. */
export const Mark = ({ size = 24 }: { size?: number }) => (
  <svg className="mark" width={size} height={size} viewBox="190 416 410 410" aria-hidden="true">
    <g fill="none" stroke="currentColor">
      <path d="M522 475H360a73 73 0 0 0 0 146h80a73 73 0 0 1 0 146H318" strokeWidth="56" />
      <circle cx="270" cy="767" r="40.5" strokeWidth="27" />
    </g>
    <circle cx="522" cy="474" r="52" fill="currentColor" />
  </svg>
);
export const Brand = () => <span className="brand"><Mark />StockRun</span>;
const greeting = () => { const h = Number(new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false })); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const Avatar = ({ u, bust = 0, big = false }: { u: User; bust?: number; big?: boolean }) => u.hasAvatar
  ? <img className={`avatar${big ? ' big' : ''}`} src={avatarUrl(u.id, bust)} alt="" />
  : <span className={`avatar${big ? ' big' : ''}`} aria-hidden="true">{(u.displayName ?? u.username ?? u.email ?? '?').slice(0, 1).toUpperCase()}</span>;
const LAGOS: [number, number] = [6.55, 3.37];
const run = async (setBusy: (s: string) => void, setError: (s: string) => void, label: string, f: () => Promise<void>) => {
  setBusy(label); setError('');
  try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
};

export function AccountApp({ cfg }: { cfg: Config }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('reference') ? 'money' : load<Tab>('stockrun.tab', cfg.feed ? 'feed' : 'ask')));
  const [bust, setBust] = useState(0);
  const reload = useCallback(() => server.me().then(setMe).catch((e) => setError(e.message)), []);
  const [unread, setUnread] = useState(0);
  const [openChat, setOpenChat] = useState<number | null>(null);
  useEffect(() => {
    if (!cfg.chat || !me?.user) return;
    const f = () => server.chats().then((r) => setUnread(r.unread)).catch(() => {});
    f(); const t = setInterval(f, 15_000); return () => clearInterval(t);
  }, [cfg.chat, me?.user]);
  const startChat = (sellerId: string) => server.openChat(sellerId).then((c) => { setOpenChat(c.id); setTab('chats'); });
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { save('stockrun.tab', tab); }, [tab]);

  const testChip = cfg.naira.test || cfg.network !== 'xlayer' ? <span className="chip-test" title="No real money moves">Test money</span> : null;
  if (error) return <><header className="topbar"><Brand />{testChip}</header><main><p className="alert">{error}</p></main></>;
  if (!me) return <><header className="topbar"><Brand /></header><main><div className="loading"><span className="spinner" aria-hidden="true" /></div></main></>;
  if (!me.user) return <><header className="topbar"><Brand />{testChip}</header><main><SignIn cfg={cfg} onDone={reload} /></main></>;
  const u = me.user;
  const tabs: [Tab, string, ReactNode, number?][] = [
    ...(cfg.feed ? [['feed', 'Feed', <Icon.home />] as [Tab, string, ReactNode]] : []),
    ['ask', 'Ask', <Icon.search />], ['orders', 'Orders', <Icon.box />],
    ...(cfg.chat ? [['chats', 'Chats', <Icon.chat />, unread] as [Tab, string, ReactNode, number]] : []),
    ['money', 'Money', <Icon.wallet />], ['me', 'Me', <Icon.user />],
  ];
  const go = (t: Tab) => { setTab(t); window.scrollTo({ top: 0 }); };

  return (
    <>
      <header className="topbar">
        <Brand />
        <span className="row tight-gap">
          {testChip}
          <button className="balance" title="Naira held by StockRun for you (not on-chain)" onClick={() => go('money')}>{naira(me.naira?.availableNaira ?? 0)}</button>
          <button className="avatar-btn" aria-label="Your profile" onClick={() => go('me')}><Avatar u={u} bust={bust} /></button>
        </span>
      </header>
      <main>
        <section className="stack">
          {!u.username && tab !== 'me' && <button className="nudge" onClick={() => go('me')}><Icon.user size={18} /> Choose a username so sellers know who you are <Icon.chevron size={16} /></button>}
          {tab === 'chats' && cfg.chat && <ChatsTab openId={openChat} onOpened={() => setOpenChat(null)} />}
          {tab === 'ask' && <Ask onChat={startChat} cfg={cfg} user={u} me={me} onAsked={() => { reload(); go('orders'); }} goMoney={() => go('money')} />}
          {tab === 'orders' && <Orders cfg={cfg} wallet={u.wallet} onChange={reload} goAsk={() => go('ask')} />}
          {tab === 'money' && <Money cfg={cfg} me={me} onChange={reload} />}
          {tab === 'admin' && me.admin && <Admin />}
          {tab === 'me' && me.admin && <button className="nudge admin-link" onClick={() => go('admin')}><Icon.admin size={18} /> Admin: orders, payouts and stores <Icon.chevron size={16} /></button>}
          {tab === 'admin' && me.admin && <button className="link-btn" onClick={() => go('me')}>‹ Back to Me</button>}
          {tab === 'feed' && cfg.feed && <FeedTab user={u} onChat={startChat} goStore={() => go('me')} />}
          {tab === 'me' && <Profile user={u} bust={bust} supportEmail={cfg.supportEmail ?? null} onChange={() => { setBust(Date.now()); reload(); }} />}
          {tab === 'me' && cfg.business && u.role === 'shop' && <MyStore fee={cfg.business} banksOn={!!cfg.sellerBankLinks} balance={me.naira?.availableNaira ?? 0} onChange={reload} />}
        </section>
      </main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(([k, label, icon, badge]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => go(k)}>
            <span className="tab-icon">{icon}{badge ? <span className="badge">{badge > 9 ? '9+' : badge}</span> : null}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
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
  const [asShop, setAsShop] = useState(false);
  const go = (label: string, f: () => Promise<void>) => run(setBusy, setError, label, f);
  /** A new shop owner's account is marked as one right after signing in (existing shop owners stay shop owners). */
  const finish = async (u: { role?: string }) => { if (asShop && u.role !== 'shop') await server.setRole('shop'); onDone(); };
  const signIn = (c: string) => go('Signing in…', async () => { const r = await server.emailVerify(email, c); save('stockrun.signin', 'email'); await finish(r.user); });
  const pick = (w: typeof way) => { setWay(w); setSent(false); setCode(''); setError(''); };
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  return (
    <section className="welcome">
      <header className="hero">
        <h1>Buy stock without the market run.</h1>
        <p className="lead">Real sellers near you.<br />Pay only for what you collect.</p>
      </header>
      <div className="signin-card">
        <h2>{sent ? 'Check your email' : 'Sign in'}</h2>
        {!sent && (
          <div className="seg two" role="radiogroup" aria-label="I am">
            <button role="radio" aria-checked={!asShop} className={!asShop ? 'on' : ''} onClick={() => setAsShop(false)}>I'm buying</button>
            <button role="radio" aria-checked={asShop} className={asShop ? 'on' : ''} onClick={() => setAsShop(true)}>I own a shop</button>
          </div>
        )}
        {way === 'email' ? (<>
          <label className="field"><span>Email</span>
            <input type="email" inputMode="email" autoComplete="email" placeholder="ada@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} />
          </label>
          {!sent ? (
            <button className="btn primary" disabled={!!busy || !emailOk} onClick={() => go('Sending…', async () => { await server.emailCode(email.trim()); setSent(true); })}>Email me a code</button>
          ) : (<>
            <label className="field"><span>Code</span>
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => {
                const c = e.target.value.replace(/\D/g, '');
                setCode(c);
                if (c.length === 6 && !busy) signIn(c);   // pasted or filled in: sign in straight away
              }} />
            </label>
            <p className="fine">Sent to <strong>{email.trim()}</strong>. Check Spam if it isn't there.</p>
            <button className="btn primary" disabled={!!busy || code.length !== 6} onClick={() => signIn(code)}>Sign in</button>
            <button className="link center-link" disabled={!!busy} onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </>)}
        </>) : (<>
          <p className="fine">OKX Wallet or MetaMask. Signing is free and moves no money.</p>
          {!hasWallet() && <p className="warn">No wallet found. Open StockRun in your wallet app's browser.</p>}
          <button className="btn primary" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
            const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
            const r = await server.walletSignIn(s.message, s.signature); save('stockrun.signin', 'wallet'); await finish(r.user);
          })}>Connect wallet</button>
        </>)}
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
        {!sent && (cfg.emailSignIn
          ? (way === 'email'
            ? <><div className="or"><span>or</span></div><button className="btn ghost" onClick={() => pick('wallet')}><Icon.wallet size={18} /> Continue with a wallet</button></>
            : <button className="link center-link" onClick={() => pick('email')}>Use email instead</button>)
          : null)}
      </div>
      {cfg.supportEmail && <p className="fine support-line">Need help? <a href={supportMailto(cfg.supportEmail)}>{cfg.supportEmail}</a></p>}
    </section>
  );
}

// ---------------------------------------------------------------- ask: what, budget, where; sellers on the map
function Ask({ cfg, user, me, onAsked, goMoney, onChat }: { cfg: Config; user: User; me: Me; onAsked: () => void; goMoney: () => void; onChat: (sellerId: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [budget, setBudget] = useState('');
  const [place, setPlace] = useState<Place>(() => load<Place>('stockrun.place', { lat: NaN, lng: NaN, address: '' }));
  // Delivery is only offered when the server has a logistics company; otherwise the buyer collects (or sends someone).
  const canDeliver = cfg.logistics.length > 0;
  const [delivery, setDelivery] = useState<'logistics' | 'self'>(canDeliver ? 'logistics' : 'self');
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
  const [deal, setDeal] = useState<{ id: string; name: string; seller: MySeller | null; item: string; quantity: string; unit: string; price: string; category: Category; result: DealResult | null; note: string; pay: 'naira' | 'coins' } | null>(null);
  /** The buyer's coin vault, when coins are on and set up: lets a deal be paid from it. */
  const [coinVault, setCoinVault] = useState<CoinVault | null>(null);
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
    const v = cfg.coins && user.wallet ? (await server.coins().catch(() => null))?.vault ?? null : null;
    setCoinVault(v);
    setDeal({ id, name, seller, item: '', quantity: '1', unit: 'carton', price: '', category: 'staples', result: null, note: '', pay: 'naira' });
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
    if (d.pay === 'coins') {
      if (!coinVault) return 'Set up your coin vault in Money first.';
      if (delivery === 'logistics') return 'Coin orders are collect-it-yourself for now. Choose "I\'ll collect".';
      if (price * qty > coinVault.naira.free) return `This deal is ${naira(price * qty)}, but your vault has ${naira(coinVault.naira.free)} free. Add coins in Money first.`;
      return '';
    }
    if (delivery === 'logistics' && !user.phone && contact.replace(/\D/g, '').length < 10) return 'Add a phone number for the rider (under "How should it reach you?"), or choose to collect it yourself.';
    const total = price * qty + serviceFee(price * qty, cfg.naira.fee);
    if (total > available) return `This deal is ${naira(total)}, but your balance is ${naira(available)}. Deposit naira first.`;
    return '';
  };
  const submitDeal = async () => {
    if (!deal) return;
    const problem = dealProblem(deal);
    if (problem) { setDeal({ ...deal, note: problem, result: null }); return; }
    setBusy('RestockGuard is checking your deal…');
    try {
      if (deal.pay === 'coins') {
        const d = { sellerId: deal.id, item: deal.item.trim(), quantity: Number(deal.quantity), unit: deal.unit.trim(), unitPriceNaira: Number(deal.price.replace(/\D/g, '')), category: deal.category, place };
        let r = await server.coinDeal(d);
        if (r.status === 'needs_seller') {
          // The seller isn't in the vault yet: the buyer's wallet approves them (instant: paid through StockRun's payout wallet).
          setBusy(`Approve ${r.seller.name} in your wallet…`);
          await walletSend(cfg.coins!.chainId, user.wallet!, coinVault!.vault, 'queueSupplier', [r.seller.key, 1, r.payout]);
          setBusy('RestockGuard is checking your deal…');
          r = await server.coinDeal(d);
        }
        if (r.status === 'needs_seller') throw new Error(r.message);
        setDeal({ ...deal, result: { status: r.status, orderId: r.orderId, reason: r.reason, message: r.message } as DealResult, note: '' });
        return;
      }
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
  const firstName = (user.displayName ?? user.username ?? '').split(' ')[0];
  const SUGGEST = ['20 cartons of Indomie', '5 bags of rice (50kg)', '10 kegs of groundnut oil', '30 crates of malt'];

  return (
    <div className="stack">
      <header className="screen-head">
        <p className="eyebrow">{greeting()}{firstName ? `, ${firstName}` : ''}</p>
        <h1 className="h-page">What do you need today?</h1>
      </header>

      <div className="panel stack ask">
        <label className="field"><span className="sr-only">What do you want?</span>
          <textarea className="big-input" rows={3} placeholder="e.g. 20 cartons of Indomie" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {!text && (
          <div className="suggest" aria-label="Suggestions">
            {SUGGEST.map((s) => <button key={s} type="button" className="chip" onClick={() => setText(s)}>{s}</button>)}
          </div>
        )}
        <div className="two-col">
          <label className="field"><span>Budget</span>
            <span className="input-icon"><span className="prefix">₦</span><input inputMode="numeric" placeholder="150,000" value={b ? b.toLocaleString('en-NG') : ''} onChange={(e) => setBudget(e.target.value)} /></span>
          </label>
          <label className="field"><span>Your area</span>
            <span className="input-icon"><Icon.pin size={18} /><input placeholder="Ikeja, Ketu…" autoComplete="street-address" value={place.address}
              onChange={(e) => setPlace({ lat: NaN, lng: NaN, address: e.target.value })} /></span>
          </label>
        </div>
        <div className="row between small-row">
          <button className="link-btn" onClick={here}><Icon.locate size={16} /> Use my location</button>
          <span className={`fine${b > available ? ' warn' : ''}`}>Balance {naira(available)}{b > available && <> · <button className="link inline" onClick={goMoney}>Deposit</button></>}</span>
        </div>
        {canDeliver && (
          <div className="options" role="radiogroup" aria-label="How should it reach you?">
            <button role="radio" aria-checked={delivery === 'self'} className={`option${delivery === 'self' ? ' on' : ''}`} onClick={() => setDelivery('self')}>
              <Icon.walk /><span><strong>I'll collect</strong><span className="fine">You or someone you send · no delivery fee</span></span>
            </button>
            <button role="radio" aria-checked={delivery === 'logistics'} className={`option${delivery === 'logistics' ? ' on' : ''}`} onClick={() => setDelivery('logistics')}>
              <Icon.truck /><span><strong>Deliver it</strong><span className="fine">A verified logistics company · you pay their fee to them directly</span></span>
            </button>
          </div>
        )}
        {canDeliver && delivery === 'logistics' && !user.phone && (
          <label className="field"><span>Phone number for the rider</span><input inputMode="tel" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="0803 123 4567" /></label>
        )}
        <button className="btn primary big" disabled={!!busy || !cfg.sellerHunt || text.trim().length < 3 || (place.address.trim().length < 2 && !pinned)} onClick={findSellers}>
          {busy && busy.startsWith('Finding your address') ? <><span className="spinner small" aria-hidden="true" /> Finding sellers…</> : <><Icon.search size={20} /> Find sellers</>}
        </button>
        {!cfg.sellerHunt && <p className="warn">Seller search is not switched on yet on this server.</p>}
        {busy && !busy.startsWith('Finding your address') && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>

      {hunt && (
        <section className="stack">
          <div className="section-head">
            <h2>{hunt.sellers.length ? `${hunt.sellers.length} seller${hunt.sellers.length === 1 ? '' : 's'} near ${hunt.place.matched || hunt.place.address}` : 'No sellers found'}</h2>
            <p className="fine"><Icon.spark size={14} /> The AI looked for {hunt.shopTypes.map((t) => t.replace(/_/g, ' ')).join(', ')} with a WhatsApp number</p>
          </div>
          <FoundList hunt={hunt} onContact={(id) => contactSeller(id)} onDeal={openDeal} onChat={cfg.chat ? (id) => run(setBusy, setError, 'Opening the chat…', () => onChat(id)) : undefined} />
        </section>
      )}
      {!hunt && (
        <ul className="trust">
          <li><Icon.lock size={18} /><span>Your money is locked, not paid, when you record a deal</span></li>
          <li><Icon.shield size={18} /><span>The seller is paid only for the goods you count at collection</span></li>
          <li><Icon.whatsapp size={18} /><span>You chat with sellers on your own WhatsApp; StockRun sends nothing</span></li>
        </ul>
      )}

      <details className="more">
        <summary><Icon.map size={18} /> See sellers on the map</summary>
        <div className="stack">
          {!showMap && <button className="btn ghost" onClick={() => setShowMap(true)}>Open the map</button>}
          {showMap && (<>
            <div className="map-wrap">
              <div ref={el} className="map pick" />
              <form className="map-search" role="search" onSubmit={search}>
                <input type="search" aria-label="Search sellers or places" placeholder="Search sellers or places" value={q}
                  onChange={(e) => { setQ(e.target.value); if (!e.target.value) setResults(null); }} />
                <button className="btn primary" type="submit" disabled={searching || q.trim().length < 2}>{searching ? '…' : 'Go'}</button>
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
            <span className="fine">{pinned ? `${found.length} seller(s)${cfg.demoSellers ? ` and ${sellers.length} demo seller(s)` : ''} within 25 km · tap the map to move your pin` : 'Tap the map to drop your pin.'}</span>
          </>)}
        </div>
      </details>
      {cfg.demoSellers && <details className="more">
        <summary><Icon.spark size={18} /> Try the demo agent</summary>
        <div className="stack">
          <p className="fine">Six demo sellers answered by bots. The agent haggles within your budget, then RestockGuard locks the money. Needs your area found first (Find sellers).</p>
          <button className="btn ghost" disabled={!!busy || text.trim().length < 3 || b < 1000 || !pinned || place.address.trim().length < 2} onClick={ask}>Ask the demo agent</button>
          {reply && <pre className="reply">{reply}</pre>}
        </div>
      </details>}

      {draft && (
        <Sheet title={`Message ${draft.name}`} onClose={() => setDraft(null)}>
          <div ref={contactPanel} className="stack contact">
            <p className="fine">WhatsApp {draft.phone}</p>
            <label className="field"><span>{draft.ai ? 'Written by the AI from your request. Edit anything.' : 'Your message. Edit anything.'}</span>
              <textarea rows={5} value={draft.message} maxLength={600} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
            </label>
            <a className="btn wa big" href={whatsappLink(draft.phone, draft.message)} target="_blank" rel="noreferrer" onClick={() => { server.sellerOpened(draft.id).catch(() => {}); }}><Icon.whatsapp size={20} /> Open in WhatsApp</a>
            <button className="btn ghost" onClick={() => { const d = draft; setDraft(null); openDeal(d.id, d.name); }}><Icon.handshake size={18} /> Agreed a price? Record the deal</button>
            <p className="fine">You send it and chat yourself; StockRun doesn't see the chat. This seller comes from a public map and isn't checked by StockRun, so agree the price before you record the deal.</p>
          </div>
        </Sheet>
      )}
      {deal && (
        <Sheet title="Record the deal" onClose={() => setDeal(null)}>
          <div ref={dealPanel} className="stack deal">
            <div className="seller-line"><span className="seller-avatar">{deal.name.slice(0, 1).toUpperCase()}</span><span><strong>{deal.name}</strong>
              {deal.seller?.status === 3 ? <span className="fine warn-text">You blocked this seller</span>
                : deal.seller?.status === 1 ? <span className="fine ok">✓ On your sellers list</span>
                : deal.seller?.pendingStatus ? <span className="fine warn">Joins your sellers on {lagosTime(deal.seller.effectiveAt!)}</span>
                : <span className="fine">Recording this deal adds them to your sellers</span>}</span></div>
            <label className="field"><span>What you agreed to buy</span><input value={deal.item} maxLength={80} placeholder="Indomie noodles (40 x 70g)" onChange={(e) => setDeal({ ...deal, item: e.target.value })} /></label>
            <div className="three-col">
              <label className="field"><span>How many</span><input inputMode="numeric" value={deal.quantity} onChange={(e) => setDeal({ ...deal, quantity: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="field"><span>Unit</span><input value={deal.unit} maxLength={20} placeholder="carton" onChange={(e) => setDeal({ ...deal, unit: e.target.value })} /></label>
              <label className="field"><span>Price each</span><span className="input-icon"><span className="prefix">₦</span><input inputMode="numeric" placeholder="14,000" value={Number(deal.price.replace(/\D/g, '')) ? Number(deal.price.replace(/\D/g, '')).toLocaleString('en-NG') : ''} onChange={(e) => setDeal({ ...deal, price: e.target.value })} /></span></label>
            </div>
            <label className="field"><span>Kind of goods</span>
              <select value={deal.category} onChange={(e) => setDeal({ ...deal, category: e.target.value as Category })}>
                {CATEGORY_LABELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {cfg.coins && coinVault && !deal.result && (
              <div className="seg two" role="radiogroup" aria-label="Pay with">
                <button role="radio" aria-checked={deal.pay === 'naira'} className={deal.pay === 'naira' ? 'on' : ''} onClick={() => setDeal({ ...deal, pay: 'naira', note: '' })}>Naira balance</button>
                <button role="radio" aria-checked={deal.pay === 'coins'} className={deal.pay === 'coins' ? 'on' : ''} onClick={() => setDeal({ ...deal, pay: 'coins', note: '' })}>{cfg.coins.symbol} vault</button>
              </div>
            )}
            {Number(deal.price.replace(/\D/g, '')) > 0 && Number(deal.quantity) > 0 && deal.pay === 'coins' && coinVault && (() => {
              const goods = Number(deal.price.replace(/\D/g, '')) * Number(deal.quantity), dollars = goods * (cfg.coins!.cap / cfg.coins!.capNaira);
              return (
                <dl className="receipt">
                  <div><dt>Goods</dt><dd>{naira(goods)}</dd></div>
                  <div className="total"><dt>Locked in your vault</dt><dd>≈ ${dollars.toFixed(2)} {cfg.coins!.symbol}</dd></div>
                  <div className="fine-row"><dt>Free in your vault</dt><dd>${coinVault.free.toFixed(2)} ≈ {naira(coinVault.naira.free)}</dd></div>
                  <div className="fine-row"><dt>Collection</dt><dd>you collect · on-chain, signed in your wallet</dd></div>
                </dl>
              );
            })()}
            {Number(deal.price.replace(/\D/g, '')) > 0 && Number(deal.quantity) > 0 && deal.pay === 'naira' && (() => {
              const goods = Number(deal.price.replace(/\D/g, '')) * Number(deal.quantity), fee = serviceFee(goods, cfg.naira.fee);
              return (
                <dl className="receipt">
                  <div><dt>Goods</dt><dd>{naira(goods)}</dd></div>
                  {fee > 0 && <div><dt>StockRun fee ({cfg.naira.fee!.percent}%)</dt><dd>{naira(fee)}</dd></div>}
                  <div className="total"><dt>Locked now</dt><dd>{naira(goods + fee)}</dd></div>
                  {delivery === 'logistics' && <div className="fine-row"><dt>Delivery fee</dt><dd>quoted next · paid to the courier directly, not locked</dd></div>}
                  <div className="fine-row"><dt>Your balance</dt><dd>{naira(available)}</dd></div>
                </dl>
              );
            })()}
            {deal.note && <p className="alert">{deal.note}</p>}
            {!deal.result && <button className="btn primary big" disabled={!!busy} onClick={submitDeal}>{busy && busy.startsWith('RestockGuard') ? <><span className="spinner small" aria-hidden="true" /> RestockGuard is checking…</> : <><Icon.lock size={18} /> Lock the money</>}</button>}
            <p className="fine"><Icon.shield size={14} /> RestockGuard, a circuit on X Layer, decides whether the money locks. The seller gets the full agreed price, paid only at collection for the good {deal.unit || 'unit'}s counted.</p>
            {deal.result && <pre className="reply">{deal.result.message}</pre>}
            {deal.result && (deal.result.status === 'locked' || deal.result.status === 'ask_owner') && (
              <div className="stack">
                <button className="btn primary" onClick={onAsked}>See it in Orders</button>
                {cfg.sellerBankLinks && <button className="btn wa" disabled={!!busy} onClick={() => run(setBusy, setError, 'Making the link…', async () => {
                  const l = await server.sellerBankLink(deal.id);
                  if (l.whatsappUrl) window.open(l.whatsappUrl, '_blank', 'noopener'); else await navigator.clipboard?.writeText(l.message);
                })}><Icon.whatsapp size={18} /> Ask {deal.name} for their bank details</button>}
                {cfg.sellerBankLinks && <p className="fine">Sends the seller a link to add their bank account, so StockRun can pay them when you collect.</p>}
              </div>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
const SOURCE = { maps: 'Google Maps', osm: 'OpenStreetMap', web: 'the web', listed: 'StockRun (registered store)' } as const;
const SOURCE_FROM = { maps: 'its Google Maps listing', osm: 'its OpenStreetMap entry', web: 'a web page', listed: 'its StockRun store' } as const;
const CATEGORY_LABELS: [Category, string][] = [
  ['staples', 'Food staples (rice, noodles, flour, garri)'], ['drinks', 'Drinks (water, soft drinks, malt)'], ['cooking', 'Cooking (oil, tomato paste, sugar)'],
  ['toiletries', 'Toiletries (soap, detergent)'], ['snacks', 'Snacks and biscuits'], ['household', 'Household (batteries, candles, bags)'],
  ['restricted', 'Alcohol or cigarettes (always needs your OK)'], ['highValue', 'Phones, electronics, anything else (always needs your OK)'],
];
function FoundList({ hunt, onContact, onDeal, onChat }: { hunt: HuntResult; onContact: (id: string) => void; onDeal: (id: string, name: string) => void; onChat?: (id: string) => void }) {
  if (!hunt.sellers.length) return <div className="empty"><p><strong>No seller of this kind with a WhatsApp number turned up near you.</strong></p><p className="muted">Try other words, or a nearby area.</p></div>;
  return (
    <ul className="cards">
      {hunt.sellers.map((f: FoundSeller) => (
        <li key={f.id} className="card seller">
          <div className="seller-line">
            <span className={`seller-avatar${f.listed ? ' listed' : ''}`} aria-hidden="true">{f.name.slice(0, 1).toUpperCase()}</span>
            <span className="grow">
              <strong>{f.name}</strong>
              <span className="fine">{f.kind ? `${f.kind.replace(/_/g, ' ')} · ` : ''}{f.address}</span>
            </span>
            <span className="km">{f.km} km</span>
          </div>
          <div className="row wrap tags">
            {f.listed ? <span className="pill listed">✓ Registered on StockRun</span> : <span className="pill found">Found by AI · not checked</span>}
            <span className="fine">from {SOURCE_FROM[f.source]}{f.sourceUrl && <> · <a href={f.sourceUrl} target="_blank" rel="noreferrer">source</a></>}</span>
          </div>
          {f.listed && f.products?.length ? (
            <ul className="price-list">{f.products.slice(0, 4).map((p, i) => <li key={i}><span>{p.item}</span><span className="num">{naira(p.priceNaira)} / {p.unit}</span></li>)}</ul>
          ) : null}
          <div className="actions">
            {f.listed && onChat
              ? <button className="btn primary" onClick={() => onChat(f.id)}><Icon.chat size={18} /> Chat</button>
              : <button className="btn wa" onClick={() => onContact(f.id)}><Icon.whatsapp size={18} /> WhatsApp</button>}
            {f.listed && onChat && <button className="btn wa icon-only" aria-label={`Message ${f.name} on WhatsApp`} onClick={() => onContact(f.id)}><Icon.whatsapp size={18} /></button>}
            <button className="btn ghost" onClick={() => onDeal(f.id, f.name)}><Icon.handshake size={18} /> Record deal</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------------------------------------------------------- orders
function Orders({ cfg, wallet, onChange, goAsk }: { cfg: Config; wallet: User['wallet']; onChange: () => void; goAsk: () => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
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

  if (!orders) return <div className="loading"><span className="spinner" aria-hidden="true" /></div>;
  const active = orders.filter((o) => o.status === 'AwaitingOwner' || o.status === 'Locked' || o.status === 'PickedUp');
  const past = orders.filter((o) => !active.includes(o));
  const card = (o: Order) => {
    const total = o.ordered * o.unitPriceNaira + (o.serviceFeeNaira ?? 0);     // what StockRun locked: never the delivery fee
    const stage = o.status === 'AwaitingOwner' ? 0 : o.status === 'Locked' ? 1 : o.status === 'PickedUp' ? 2 : o.status === 'Delivered' ? 3 : -1;
    const steps = o.self ? ['Locked', 'Collected', 'Seller paid'] : ['Locked', 'Picked up', 'Delivered'];
    return (
      <li key={o.orderId} className="card order">
        <div className="stack tight">
          <span className="order-meta"><StatusPill o={o} /><span className="fine">#{o.orderId}</span></span>
          <strong className="order-title">{o.ordered} × {o.item}</strong>
          <span className="fine">{o.supplier.name}</span>
        </div>
        {stage >= 0 && (
          <ol className="tracker" aria-label="Progress">
            {steps.map((s, i) => {
              const done = stage > i;
              const now = !done && stage === i;
              return <li key={s} className={done ? 'done' : now ? 'now' : ''}><span className="dot">{done ? <Icon.check size={12} /> : null}</span>{s}</li>;
            })}
          </ol>
        )}
        {(() => {
          // After collection the seller is paid for what was counted; the fee is charged on that share only (as the server does).
          const settled = o.status === 'PickedUp' || o.status === 'Delivered';
          const qty = settled ? o.pickup.picked : o.ordered;
          const fee = !o.serviceFeeNaira ? 0 : qty === o.ordered ? o.serviceFeeNaira : Math.floor((o.serviceFeeNaira * 100 * qty) / o.ordered) / 100;
          const paid = qty * o.unitPriceNaira + fee;
          return (
            <dl className="receipt compact">
              <div><dt>{naira(o.unitPriceNaira)} × {qty}{settled && qty < o.ordered ? ` of ${o.ordered}` : ''}</dt><dd>{naira(qty * o.unitPriceNaira)}</dd></div>
              {fee ? <div><dt>StockRun fee</dt><dd>{naira(fee)}</dd></div> : null}
              {o.money === 'coins' && <div className="fine-row"><dt>Paid in</dt><dd>{o.tokenSymbol} from your vault · ${((o.unitPriceToken ?? 0) * qty).toFixed(2)}</dd></div>}
              <div className="total"><dt>{settled ? 'Paid' : o.status === 'Refunded' ? 'Refunded' : 'Locked'}</dt><dd>{naira(settled ? paid : total)}</dd></div>
              {settled && total - paid > 0 && <div className="fine-row"><dt>Came back to you</dt><dd>{naira(total - paid)}</dd></div>}
              {!o.self && <div className="fine-row"><dt>Delivery fee</dt><dd>{o.courierFeeNaira ? `${naira(o.courierFeeNaira)}, ` : ''}paid to {o.logistics?.carrierName ?? 'the courier'} directly</dd></div>}
            </dl>
          );
        })()}
        {o.lastCheck && <Outcome r={o.lastCheck} />}
        {o.status === 'AwaitingOwner' && (
          <div className="next">
            <p><strong>Needs your OK.</strong> <span className="fine">Approving never overrides a "no" from the circuit.</span></p>
            <button className="btn primary" disabled={!!busy} onClick={() => act(o.money === 'coins' ? 'Approve in your wallet…' : 'Approving…', () => o.money === 'coins'
              ? walletSend(cfg.coins!.chainId, wallet!, o.vault!, 'approveOrder', [BigInt(o.coinOrderId!)])
              : server.approve(o.orderId))}>{o.money === 'coins' ? 'Approve in your wallet' : 'Approve'}</button>
          </div>
        )}
        {o.self && o.status === 'Locked' && (
          <div className="next">
            <p><strong>Next: collect from {o.supplier.name}.</strong> <span className="fine">Go yourself or send someone. Count the good {o.unit}s, then confirm here: the seller's payment is approved for that number and the rest comes back to you.</span></p>
            {confirming !== o.orderId ? (
              <div className="row wrap">
                <label className="field stepper-field"><span>{o.unit}s collected</span>
                  <span className="stepper">
                    <button type="button" aria-label="One less" onClick={() => setCounts((c) => ({ ...c, [`p${o.orderId}`]: String(Math.max(0, Number(c[`p${o.orderId}`] ?? o.ordered) - 1)) }))}>−</button>
                    <input inputMode="numeric" value={counts[`p${o.orderId}`] ?? String(o.ordered)} onChange={(e) => setCounts((c) => ({ ...c, [`p${o.orderId}`]: e.target.value.replace(/\D/g, '') }))} />
                    <button type="button" aria-label="One more" onClick={() => setCounts((c) => ({ ...c, [`p${o.orderId}`]: String(Math.min(o.ordered, Number(c[`p${o.orderId}`] ?? o.ordered) + 1)) }))}>+</button>
                  </span>
                </label>
                <button className="btn primary grow" disabled={!!busy} onClick={() => { setError(''); setConfirming(o.orderId); }}><Icon.check size={18} /> Goods collected</button>
              </div>
            ) : (() => {
              const n = Number(counts[`p${o.orderId}`] ?? o.ordered);
              return (
                <div className="stack confirm">
                  <p><strong>Approve {naira(n * o.unitPriceNaira)} for {o.supplier.name}?</strong> <span className="fine">For {n} {o.unit}{n === 1 ? '' : 's'}. This can't be undone, so only confirm once the goods are collected.</span></p>
                  <div className="row wrap">
                    <button className="btn primary grow" disabled={!!busy} onClick={() => act('PickupCheck is deciding…', async () => {
                      const n = count(`p${o.orderId}`, o.ordered);
                      if (o.money === 'coins') {
                        // The count is the vault owner's: their wallet signs it, then PickupCheck pays through the vault.
                        setBusy('Sign your count in your wallet…');
                        await walletSend(cfg.coins!.chainId, wallet!, o.vault!, 'riderPickup', [BigInt(o.coinOrderId!), true, n]);
                        setBusy('PickupCheck is deciding…');
                        await server.coinSettlePickup(o.coinOrderId!);
                      } else await server.collect(o.orderId, n);
                      setConfirming(null);
                    })}>Yes, approve payment</button>
                    <button className="btn ghost" onClick={() => setConfirming(null)}>Not yet</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        {o.logistics && <Logistics o={o} />}
        {o.logistics && o.status === 'PickedUp' && o.logistics.ownerCount === undefined && (
          <div className="next">
            <p><strong>When the rider arrives, count before you give the code.</strong> <span className="fine">Fewer than {o.pickup.picked} is recorded by DeliveryCheck as a short delivery: your proof for a claim against {o.logistics.carrierName}.</span></p>
            <div className="row wrap">
              <label className="field"><span>{o.unit}s that arrived</span><input inputMode="numeric" value={counts[`d${o.orderId}`] ?? String(o.pickup.picked)} onChange={(e) => setCounts((c) => ({ ...c, [`d${o.orderId}`]: e.target.value.replace(/\D/g, '') }))} /></label>
              <button className="btn primary grow" disabled={!!busy} onClick={() => act('Recording…', () => server.received(o.orderId, count(`d${o.orderId}`, o.pickup.picked)))}>Confirm what arrived</button>
            </div>
          </div>
        )}
        {o.money === 'coins' ? (
          <div className="stack tight">
            <p className="fine"><Icon.shield size={14} /> Decided by TapeOut circuits inside your vault on X Layer:</p>
            {o.txs?.map((t) => <p key={t.hash} className="fine">{t.label}: <Tx hash={t.hash} /></p>)}
          </div>
        ) : <CircuitTrail evidence={o.evidence} network={cfg.network} orderId={o.orderId} />}
      </li>
    );
  };
  return (
    <div className="stack">
      <header className="screen-head"><h1 className="h-page">Orders</h1></header>
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {orders.length === 0 ? (
        <div className="empty big">
          <span className="empty-icon"><Icon.box size={28} /></span>
          <p><strong>No orders yet</strong></p>
          <p className="muted">Find a seller, agree a price on WhatsApp, then record the deal. It shows up here.</p>
          <button className="btn primary" onClick={goAsk}><Icon.search size={18} /> Find sellers</button>
        </div>
      ) : (<>
        {active.length > 0 && <><h2 className="section-label">In progress</h2><ul className="cards">{active.map(card)}</ul></>}
        {past.length > 0 && <><h2 className="section-label">Done</h2><ul className="cards">{past.map(card)}</ul></>}
      </>)}
      {requests.length > 0 && (
        <details className="more"><summary>Your requests to the demo agent ({requests.length})</summary>
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
  const [sheet, setSheet] = useState<null | 'amount' | 'pay' | 'withdraw'>(null);
  const [withdrawWhat, setWithdrawWhat] = useState<'naira' | 'coins'>('naira');
  const [showAll, setShowAll] = useState(false);
  const [amount, setAmount] = useState(0);
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  useEffect(() => { if (sheet === 'pay' && amount > 0) server.depositQuote(amount).then(setQuote).catch(() => setQuote(null)); else setQuote(null); }, [sheet, amount]);
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
  const vault = coins?.vault ?? null;
  const max = currency === 'usd' ? Math.max(0, Math.min(maxDepositFor(Number.isFinite(walletDollars) ? walletDollars : 0, vault?.depositFeeBps ?? 0), vault ? vault.room : Infinity)) : cfg.naira.paystack ? 0 : 500_000;

  const MOVE: Record<string, [string, 'in' | 'out' | 'lock']> = {
    deposit: ['Deposit', 'in'], demo: ['Demo naira (not real money)', 'in'], hold: ['Locked for an order', 'lock'], release: ['Came back to you', 'in'],
    withdraw: ['Withdrawn to your bank', 'out'], withdraw_failed: ['Withdrawal returned', 'in'],
  };

  return (
    <div className="stack">
      <header className="screen-head"><h1 className="h-page">Money</h1></header>
      <div className="balance-card">
        <span className="bc-label">Ready to spend</span>
        <span className="bc-amount">{naira(me.naira?.availableNaira ?? 0)}</span>
        <span className="bc-sub"><Icon.lock size={14} /> {naira(me.naira?.heldNaira ?? 0)} locked in orders</span>
        <div className="bc-actions">
          <button className="btn danfo" disabled={!!busy} onClick={() => { setNote(''); setError(''); setSheet('amount'); }}><Icon.plus size={18} /> Add money</button>
          {(cfg.withdrawals || (vault && me.user?.wallet)) && <button className="btn on-dark" onClick={() => {
            setNote(''); setError(''); setWithdrawWhat(cfg.withdrawals && currency === 'ngn' ? 'naira' : vault ? 'coins' : 'naira'); setSheet('withdraw');
          }}><Icon.arrowUp size={18} /> Withdraw</button>}
        </div>
      </div>
      <p className="fine"><Icon.info size={14} /> Naira you add is held by StockRun in a ledger, not on-chain. Every payment from it is decided by a TapeOut circuit on X Layer.</p>
      {currency === 'ngn' && !nairaOn && <p className="warn">Naira deposits are not switched on yet on this server.</p>}
      {busy && !sheet && <p className="busy">{busy}</p>}
      {error && !sheet && <p className="alert">{error}</p>}
      {note && <p className="ok-box">{note}</p>}

      <section className="stack">
        <h2 className="section-label">Activity</h2>
        {moves.length === 0 ? <div className="empty"><p className="muted">No activity yet. Add money to start buying.</p></div> : (
          <ul className="activity">{moves.slice(0, showAll ? undefined : 8).map((m) => {
            const [label, kind] = MOVE[m.type] ?? [m.type, m.amountNaira > 0 ? 'in' : 'out'];
            return (
              <li key={m.key}>
                <span className={`act-icon ${kind}`}>{kind === 'in' ? <Icon.arrowDown size={16} /> : kind === 'lock' ? <Icon.lock size={16} /> : <Icon.arrowUp size={16} />}</span>
                <span className="grow">{label}</span>
                <span className={`num${m.amountNaira > 0 ? ' ok' : ''}`}>{m.amountNaira > 0 ? '+' : '−'}{naira(Math.abs(m.amountNaira))}</span>
              </li>
            );
          })}</ul>
        )}
        {moves.length > 8 && <button className="link" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show less' : `Show all ${moves.length}`}</button>}
      </section>

      <section className="panel stack">
        <div className="row between"><h2>Coins</h2><span className="pill muted">{cfg.coins ? `${cfg.coins.symbol} · X Layer` : 'Wallet'}</span></div>
        <CoinsPanel cfg={cfg} me={me} coins={coins} onChange={refresh} />
      </section>

      {sheet === 'withdraw' && (
        <Sheet title={withdrawWhat === 'coins' ? 'Withdraw to your wallet' : 'Withdraw to your bank'} onClose={close}>
          <div className="stack">
            {cfg.withdrawals && vault && me.user?.wallet && (
              <div className="seg two" role="radiogroup" aria-label="Withdraw">
                <button role="radio" aria-checked={withdrawWhat === 'naira'} className={withdrawWhat === 'naira' ? 'on' : ''} onClick={() => setWithdrawWhat('naira')}>Naira → bank</button>
                <button role="radio" aria-checked={withdrawWhat === 'coins'} className={withdrawWhat === 'coins' ? 'on' : ''} onClick={() => setWithdrawWhat('coins')}>{vault.symbol} → wallet</button>
              </div>
            )}
            {withdrawWhat === 'coins' && vault && me.user?.wallet
              ? <CoinWithdraw cfg={cfg} wallet={me.user.wallet} vault={vault} onDone={refresh} />
              : <WithdrawPanel available={me.naira?.availableNaira ?? 0} onDone={() => { onChange(); refresh(); }} />}
          </div>
        </Sheet>
      )}

      {sheet === 'amount' && (
        <AmountSheet title="Add money" currency={currency} max={max} onClose={close}
          onContinue={(a) => { setAmount(a); setSheet('pay'); }} />
      )}
      {sheet === 'pay' && (
        <Sheet title={`Add ${money(currency, amount)}`} onClose={close} onBack={() => setSheet('amount')}>
          {currency === 'usd' ? (
            <div className="stack">
              {!cfg.coins ? (<>
                <p>Paying with coins isn't switched on on this server. Nothing has been taken from your wallet.</p>
                <button className="btn ghost" onClick={close}>Close</button>
              </>) : !vault || !me.user?.wallet ? (<>
                <p>Set up your coin vault first: it's under <strong>Coins</strong> on this page. StockRun creates it and pays that gas.</p>
                <button className="btn ghost" onClick={close}>Close</button>
              </>) : (<>
                <p>{money(currency, amount)} of {vault.symbol} goes from your wallet into your own vault on X Layer. Your wallet asks you twice: once to allow it, once to deposit.</p>
                {vault.depositFeeBps > 0 && <p className="fine">StockRun's fee ({vault.depositFeeBps / 100}%) is {money(currency, coinFee(amount, vault.depositFeeBps))}, paid on top: {money(currency, amount + coinFee(amount, vault.depositFeeBps))} leaves your wallet and your vault gets the full {money(currency, amount)}.</p>}
                <button className="btn primary" disabled={!!busy} onClick={() => run(setBusy, setError, 'Waiting for your wallet…', async () => {
                  await depositCoins(cfg, me.user!.wallet!, vault.vault, amount, vault.depositFeeBps, setBusy);
                  setNote(`${money(currency, amount)} added to your vault.`); refresh(); close();
                })}><Icon.lock size={18} /> Deposit {money(currency, amount)}</button>
                <p className="fine">Your vault holds at most {money(currency, vault.cap)} for now (it's new and not yet audited).</p>
                {busy && <p className="busy">{busy}</p>}
                {error && <p className="alert">{error}</p>}
              </>)}
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
                })}>Pay {naira(quote?.totalNaira ?? amount)} with Paystack</button>
                {quote && (quote.feeNaira > 0 || quote.chargeNaira > 0) && (
                  <dl className="receipt">
                    <div><dt>Goes to your balance</dt><dd>{naira(amount)}</dd></div>
                    {quote.feeNaira > 0 && <div><dt>StockRun fee ({quote.feePercent}%)</dt><dd>{naira(quote.feeNaira)}</dd></div>}
                    {quote.chargeNaira > 0 && <div><dt>Paystack charge</dt><dd>{naira(quote.chargeNaira)}</dd></div>}
                    <div className="total"><dt>You pay</dt><dd>{naira(quote.totalNaira)}</dd></div>
                  </dl>
                )}
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
/** A mail link to support with a subject line, so the message is easy to spot. */
const supportMailto = (email: string, orderHint = '') => `mailto:${email}?subject=${encodeURIComponent(`StockRun support${orderHint}`)}`;

function Profile({ user, bust, supportEmail, onChange }: { user: User; bust: number; supportEmail: string | null; onChange: () => void }) {
  const [username, setUsername] = useState(user.username ?? '');
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const go = (label: string, f: () => Promise<void>) => { setSaved(''); return run(setBusy, setError, label, f); };
  const handle = user.username ? `@${user.username}` : user.email ?? (user.wallet ? short(user.wallet) : '');

  return (
    <div className="stack">
      <div className="profile-card">
        <label className="avatar-edit" title="Change picture">
          <Avatar u={user} bust={bust} big />
          <span className="avatar-badge"><Icon.plus size={14} /></span>
          <input type="file" accept="image/*" aria-label="Change picture" onChange={(e) => { const f = e.target.files?.[0]; if (f) go('Uploading…', async () => { const p = await preparePhoto(f, 256, 0.8); await server.avatar(p.mediaType, p.data); onChange(); setSaved('Picture saved.'); }); }} />
        </label>
        <span className="stack tight">
          <strong className="profile-name">{user.displayName ?? user.username ?? 'Your profile'}</strong>
          <span className="fine">{handle}</span>
          <span className="pill muted">{user.role === 'shop' ? 'Shop owner' : 'Buyer'}</span>
        </span>
      </div>
      <div className="panel stack">
        <h2>Profile</h2>
        <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ada_lagos" maxLength={20} /></label>
        <label className="field"><span>Name</span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada Obi" maxLength={40} /></label>
        <button className="btn primary" disabled={!!busy} onClick={() => go('Saving…', async () => { await server.profile({ username: username.trim() || undefined, displayName }); onChange(); setSaved('Saved.'); })}>Save</button>
        <p className="fine">Your username, name and picture are public. Your email and wallet are never shown to others.</p>
      </div>
      <div className="panel stack">
        <h2>Account type</h2>
        <p>{user.role === 'shop' ? 'Shop owner: your store is under My store above.' : 'Buyer.'}</p>
        {user.role !== 'shop'
          ? <button className="link" disabled={!!busy} onClick={() => go('Switching…', async () => { await server.setRole('shop'); onChange(); setSaved('You are now a shop owner. Register your store under My store.'); })}>Own a shop? Sell on StockRun</button>
          : <button className="link" disabled={!!busy} onClick={() => go('Switching…', async () => { await server.setRole('buyer'); onChange(); setSaved('Switched to a buyer account.'); })}>Switch back to a buyer account</button>}
      </div>
      <div className="panel stack">
        <h2>Sign-in methods</h2>
        <p>Email: {user.email ?? 'not added'} · Wallet: {user.wallet ? short(user.wallet) : 'not connected'}</p>
        {!user.wallet && <button className="btn ghost" disabled={!!busy || !hasWallet()} onClick={() => go('Waiting for your wallet…', async () => {
          const s = await signWithWallet(async (a) => (await server.walletMessage(a)).message);
          await server.addWallet(s.message, s.signature); onChange(); setSaved('Wallet connected.');
        })}>{hasWallet() ? 'Connect a wallet' : 'No wallet in this browser'}</button>}
      </div>
      {supportEmail && (
        <div className="panel stack">
          <h2>Help & support</h2>
          <p className="fine">A question about an order, a payment or your store? Email us and include your order number (it's on each order, like #12).</p>
          <a className="btn ghost" href={supportMailto(supportEmail)}><Icon.mail size={18} /> {supportEmail}</a>
        </div>
      )}
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
