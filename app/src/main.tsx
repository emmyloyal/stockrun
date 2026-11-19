import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, load, save, signer, type Config } from './lib';
import { Owner } from './Owner';
import { Rider } from './Rider';
import './styles.css';

type Role = 'owner' | 'rider';

function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [role, setRole] = useState<Role | null>(() => load<Role | null>('stockrun.role', null));
  useEffect(() => { api.config().then(setCfg).catch((e) => setError(`Cannot reach the StockRun server: ${e.message}`)); }, []);
  useEffect(() => { save('stockrun.role', role); }, [role]);

  const me = useMemo(() => (cfg?.demoKeys && role ? signer(cfg.demoKeys[role], cfg) : null), [cfg, role]);

  return (
    <div className="shell">
      <nav className="top">
        <span className="brand"><span className="mark" aria-hidden="true" />StockRun</span>
        {role && <button className="link" onClick={() => setRole(null)}>Switch role</button>}
      </nav>
      <main>
        {error && <p className="alert">{error}</p>}
        {!cfg && !error && <p className="muted">Connecting…</p>}
        {cfg && !cfg.demoKeys && <p className="alert">This server has no demo keys. Wallet sign-in is not built yet.</p>}
        {cfg && cfg.demoKeys && !role && (
          <section className="stack">
            <header className="screen-head"><p className="eyebrow">Local demo</p><h1>Who are you?</h1></header>
            <button className="card choice" onClick={() => setRole('owner')}><strong>Shop owner</strong><span className="muted">Send an order, approve, confirm delivery</span></button>
            <button className="card choice" onClick={() => setRole('rider')}><strong>Rider</strong><span className="muted">Pick up, count, photograph, deliver</span></button>
            <p className="fine">Demo: suppliers are simulated bots and money moves on a local test chain with test keys. Nothing here is real money.</p>
          </section>
        )}
        {cfg && me && role === 'owner' && <Owner me={me} />}
        {cfg && me && role === 'rider' && <Rider cfg={cfg} me={me} />}
      </main>
      <footer className="demo-bar">Demo · local test chain · simulated suppliers</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
