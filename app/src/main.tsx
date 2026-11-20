import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, isServer, loadServerAddress, setExplorer, signer, type AnyConfig, type Config } from './lib';
import { AccountApp } from './Account';
import { Owner } from './Owner';
import './styles.css';

function App() {
  const [any, setAny] = useState<AnyConfig | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadServerAddress().then(() => api.config() as Promise<AnyConfig>).then((c) => { setExplorer(isServer(c) ? c.explorerTx : null); setAny(c); })
      .catch((e) => setError(`Cannot reach the StockRun server: ${e.message}`));
  }, []);
  const cfg: Config | null = any && !isServer(any) ? any : null;
  // StockRun is for shop owners only; goods are collected by the owner or a verified logistics company.
  const me = useMemo(() => (cfg?.demoKeys ? signer(cfg.demoKeys.owner, cfg) : null), [cfg]);

  if (any && isServer(any)) return (
    <div className="shell">
      <nav className="top"><span className="brand"><span className="mark" aria-hidden="true" />StockRun</span></nav>
      <main><AccountApp cfg={any} /></main>
      <footer className={`demo-bar${any.network === 'xlayer' ? ' live' : ''}`}>
        {any.network === 'xlayer' ? 'X Layer mainnet · real USDT0 · suppliers are simulated bots for now' : 'Local test chain · test money · simulated suppliers'}
      </footer>
    </div>
  );

  return (
    <div className="shell">
      <nav className="top">
        <span className="brand"><span className="mark" aria-hidden="true" />StockRun</span>
      </nav>
      <main>
        {error && <p className="alert">{error}</p>}
        {!any && !error && <p className="muted">Connecting…</p>}
        {cfg && !cfg.demoKeys && <p className="alert">This server has no demo keys. Wallet sign-in is not built yet.</p>}
        {cfg && me && <Owner me={me} />}
      </main>
      <footer className="demo-bar">Demo · local test chain · simulated suppliers</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
