// The real-account app (multi-shop server): sign in with a phone number, make or restore this phone's key, set up the
// shop (which deploys the owner's own vault), deposit the money to spend, then tell the agent what to buy.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatEther, type Hex } from 'viem';
import { currentPosition, naira, server, signer, type Me, type ServerConfig, type Shop, type ShopMoney, type User } from './lib';
import { addressOf, decryptKey, encryptKey, localKey, newKey, pinProblem, signLink, storeKey } from './keys';
import { Owner } from './Owner';
import { Tx } from './ui';

export function AccountApp({ cfg }: { cfg: ServerConfig }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => server.me().then(setMe).catch((e) => setError(e.message)), []);
  useEffect(() => { reload(); }, [reload]);

  if (error) return <p className="alert">{error}</p>;
  if (!me) return <p className="muted">Loading…</p>;
  if (!me.user) return <SignIn onDone={reload} />;
  const u = me.user;
  const key = localKey(u.id);
  const signOut = <button className="link" onClick={() => server.logout().then(reload)}>Sign out ({u.phone})</button>;

  if (!u.address || !key || addressOf(key).toLowerCase() !== u.address.toLowerCase()) {
    return <section className="stack"><KeySetup user={u} hasBackup={!!me.hasBackup} onDone={reload} />{signOut}</section>;
  }
  if (u.role !== 'owner') {
    // StockRun is for shop owners only: goods are collected by the owner or a verified logistics company.
    return (
      <section className="stack">
        <header className="screen-head"><p className="eyebrow">StockRun</p><h1>For shop owners</h1></header>
        <p>StockRun no longer has rider accounts. Deliveries are done by verified logistics companies, or shop owners collect their goods themselves.</p>
        {signOut}
      </section>
    );
  }
  if (!me.shop) return <section className="stack"><ShopSetup onDone={reload} />{signOut}</section>;
  return <section className="stack"><OwnerHome cfg={cfg} shop={me.shop} keyHex={key} />{signOut}</section>;
}

const gasName = (cfg: ServerConfig) => (cfg.network === 'xlayer' ? 'OKB' : 'test ETH');
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---------------------------------------------------------------- 1. phone + SMS code
function SignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (f: () => Promise<void>) => { setBusy(true); setError(''); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  return (
    <section className="stack">
      <header className="screen-head"><p className="eyebrow">Welcome</p><h1>Sign in</h1></header>
      <div className="panel stack">
        <label className="field"><span>Phone number</span>
          <input inputMode="tel" autoComplete="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sent} />
        </label>
        {!sent ? (
          <button className="btn primary" disabled={busy || phone.replace(/\D/g, '').length < 10} onClick={() => run(async () => { await server.requestCode(phone); setSent(true); })}>Send me a code</button>
        ) : (
          <>
            <label className="field"><span>6-digit code from the SMS</span>
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            <button className="btn primary" disabled={busy || code.length !== 6} onClick={() => run(async () => { await server.verify(phone, code, 'owner'); onDone(); })}>Sign in</button>
            <button className="link" disabled={busy} onClick={() => { setSent(false); setCode(''); }}>Use a different number</button>
          </>
        )}
        {error && <p className="alert">{error}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 2. this phone's key: make + back up, or restore
function KeySetup({ user, hasBackup, onDone }: { user: User; hasBackup: boolean; onDone: () => void }) {
  const restoring = !!user.address;
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (label: string, f: () => Promise<void>) => { setBusy(label); setError(''); try { await f(); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };

  const create = () => run('Making your key and backing it up…', async () => {
    const problem = pinProblem(pin); if (problem) throw new Error(problem);
    if (pin !== pin2) throw new Error('The two PINs are different.');
    const key = newKey(), address = addressOf(key);
    const backup = await encryptKey(key, pin);
    storeKey(user.id, key);                                   // keep it on this phone first: nothing is lost if a call fails
    const { message } = await server.linkMessage(address);
    await server.linkKey(address, await signLink(key, message));
    await server.saveBackup(backup);
  });
  const restore = () => run('Unlocking your backup…', async () => {
    const { backup } = await server.backup();
    if (!backup) throw new Error('There is no backup for this account. Use the phone you signed up on.');
    storeKey(user.id, await decryptKey(backup, pin, user.address!));
  });

  if (restoring) return (
    <>
      <header className="screen-head"><p className="eyebrow">This phone</p><h1>Restore your key</h1></header>
      <div className="panel stack">
        <p>Your account's key ({short(user.address!)}) is not on this phone yet. {hasBackup ? 'Enter the PIN you chose when you signed up.' : 'No backup was saved for this account, so it can only be used on the phone you signed up on.'}</p>
        {hasBackup && <>
          <label className="field"><span>Your 6-digit PIN</span><input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          <button className="btn primary" disabled={!!busy || pin.length !== 6} onClick={restore}>Restore</button>
        </>}
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>
    </>
  );
  return (
    <>
      <header className="screen-head"><p className="eyebrow">This phone</p><h1>Make your key</h1></header>
      <div className="panel stack">
        <p>Your phone makes a signing key. It controls your money: only this key can deposit, approve orders or take money out of your shop's vault. StockRun never holds it.</p>
        <p>Choose a 6-digit PIN. It locks a backup of the key that StockRun keeps for you, so you can get back in on a new phone. <strong>StockRun cannot see or reset this PIN.</strong> If you forget it and lose this phone, your key is gone.</p>
        <label className="field"><span>Choose a PIN</span><input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field"><span>Type it again</span><input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="btn primary" disabled={!!busy || pin.length !== 6 || pin2.length !== 6} onClick={create}>Make my key</button>
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 3. the shop: name, pin, limits -> vault
const LAGOS: [number, number] = [6.55, 3.37];

function ShopSetup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [budget, setBudget] = useState(300_000);
  const [limit, setLimit] = useState(100_000);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView(LAGOS, 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => setPos({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    const m = map.current; if (!m || !pos) return;
    pin.current?.remove();
    pin.current = L.circleMarker([pos.lat, pos.lng], { radius: 9, color: '#141B2E', weight: 2, fillColor: '#F4C20D', fillOpacity: 1 }).addTo(m);
  }, [pos]);

  const here = async () => {
    setError('');
    try { const p = await currentPosition(); setPos(p); map.current?.setView([p.lat, p.lng], 16); } catch (e) { setError((e as Error).message); }
  };
  const create = async () => {
    setBusy('Setting up your shop and its vault on the chain. This takes up to a minute…'); setError('');
    try { await server.createShop({ name, lat: pos!.lat, lng: pos!.lng, weeklyBudgetNaira: budget, limitNaira: limit }); onDone(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  return (
    <>
      <header className="screen-head"><p className="eyebrow">Shop owner</p><h1>Set up your shop</h1></header>
      <div className="panel stack">
        <label className="field"><span>Shop name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada's Provisions" maxLength={80} /></label>
        <div className="stack">
          <span className="field"><span>Where is the shop? Tap the map.</span></span>
          <div ref={el} className="map pick" />
          <div className="row wrap">
            <button className="btn ghost" onClick={here}>Use where I am now</button>
            <span className="fine">{pos ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}` : 'No pin yet'}</span>
          </div>
        </div>
        <label className="field"><span>Most the agent may spend in a week (₦)</span>
          <input className="money" inputMode="numeric" value={budget} onChange={(e) => setBudget(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </label>
        <label className="field"><span>Orders up to this go ahead without asking you (₦)</span>
          <input className="money" inputMode="numeric" value={limit} onChange={(e) => setLimit(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </label>
        <p className="fine">The agent can only spend what you deposit next. These limits are checked by the RestockGuard circuit on every order, and bigger orders wait for your OK. Weekly budget: ₦5,000 to ₦1,275,000.</p>
        <button className="btn primary" disabled={!!busy || name.trim().length < 2 || !pos} onClick={create}>Create my shop</button>
        {busy && <p className="busy">{busy}</p>}
        {error && <p className="alert">{error}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- 4 + 5. deposit, then order
function OwnerHome({ cfg, shop, keyHex }: { cfg: ServerConfig; shop: Shop; keyHex: Hex }) {
  const me = useMemo(() => signer(keyHex, { chainId: cfg.chainId, vault: shop.vault }), [keyHex, cfg.chainId, shop.vault]);
  const [money, setMoney] = useState<ShopMoney | null>(null);
  const refresh = useCallback(() => server.money().then(setMoney).catch(() => {}), []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  const block = !money ? 'Loading your balance…'
    : money.availableNaira <= 0 ? 'Deposit money into your shop first. The agent can only buy with what you deposit.' : '';
  return (
    <>
      <p className="eyebrow">{shop.name}</p>
      <Deposit cfg={cfg} me={me} money={money} onChange={refresh} />
      <Owner me={me} orderBlock={block} approveSuppliers />
    </>
  );
}

function Deposit({ cfg, me, money, onChange }: { cfg: ServerConfig; me: ReturnType<typeof signer>; money: ShopMoney | null; onChange: () => void }) {
  const [amount, setAmount] = useState('');
  const [gas, setGas] = useState<bigint | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ approveTx: Hex | null; depositTx: Hex } | null>(null);
  const loadGas = useCallback(() => me.gasBalance().then(setGas).catch(() => {}), [me]);
  useEffect(() => { loadGas(); }, [loadGas]);
  const n = Number(amount.replace(/\D/g, '')) || 0;
  const run = async (label: string, f: () => Promise<void>) => { setBusy(label); setError(''); try { await f(); onChange(); loadGas(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } };

  const deposit = () => run('Signing your deposit on this phone…', async () => {
    const q = await server.toToken(n);
    setDone(await me.deposit(cfg.token, BigInt(q.amount)));
    setAmount('');
  });
  const getGas = () => run('Asking StockRun for gas…', async () => {
    const r = await server.gas();
    if (r.already) throw new Error('StockRun already sent this phone its gas once. Ask StockRun if you need more.');
  });
  const copy = () => navigator.clipboard?.writeText(me.address).catch(() => {});

  return (
    <div className="panel stack">
      <h2>Your money</h2>
      {money ? (
        <dl className="money-grid">
          <div><dt>Ready to spend</dt><dd>{naira(money.availableNaira)}</dd></div>
          <div><dt>In escrow for orders</dt><dd>{naira(money.lockedNaira)}</dd></div>
          <div><dt>On this phone</dt><dd>{naira(money.walletNaira)}</dd></div>
          <div><dt>Spent this week</dt><dd>{naira(money.spentThisWeekNaira)} of {naira(money.weeklyBudgetNaira)}</dd></div>
        </dl>
      ) : <p className="muted">Loading…</p>}

      <label className="field"><span>How much do you want the agent to spend? (₦)</span>
        <input className="money" inputMode="numeric" placeholder="150,000" value={amount ? Number(amount).toLocaleString('en-NG') : ''} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      </label>
      {money && n > money.walletNaira && <p className="warn">This phone holds {naira(money.walletNaira)} of {cfg.tokenSymbol}. Add more before depositing {naira(n)}.</p>}
      <button className="btn primary" disabled={!!busy || n < 1 || !money || n > money.walletNaira || gas === 0n} onClick={deposit}>Deposit {n ? naira(n) : ''}</button>
      <p className="fine">The deposit goes into your shop's own vault. Only your phone's key can take it back out; StockRun and the agent cannot.</p>

      {money && money.walletNaira === 0 && (
        <div className="stack note">
          <p><strong>This phone has no {cfg.tokenSymbol} yet.</strong> {cfg.testMoney ? 'On this test network you can get free test money.' : `Send ${cfg.tokenSymbol} on X Layer to this phone's address:`}</p>
          {!cfg.testMoney && <p className="row wrap"><code className="addr">{me.address}</code><button className="btn ghost" onClick={copy}>Copy</button></p>}
          {cfg.testMoney && <button className="btn ghost" disabled={!!busy} onClick={() => run('Getting test money…', async () => { await server.testMoney(); })}>Get test money</button>}
        </div>
      )}
      {gas === 0n && (
        <div className="stack note">
          <p>This phone has no gas ({gasName(cfg)}) to sign with.</p>
          <button className="btn ghost" disabled={!!busy} onClick={getGas}>Get gas</button>
        </div>
      )}
      {gas !== null && gas > 0n && <p className="fine">Gas on this phone: {formatEther(gas)} {gasName(cfg)}</p>}
      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {done && <p className="ok">Deposited. {done.approveTx && <>Approval <Tx hash={done.approveTx} /> · </>}deposit <Tx hash={done.depositTx} /></p>}
    </div>
  );
}
