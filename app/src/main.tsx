import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadServerAddress, server, setExplorer, type Config } from './lib';
import { AccountApp } from './Account';
import { SellerBankPage } from './Banks';
import './styles.css';

// A seller opening the bank link a buyer forwarded: ?seller-bank=<id>&t=<token> (no sign-in).
const q = new URLSearchParams(location.search);
const sellerBank = q.get('seller-bank') && q.get('t') ? { id: q.get('seller-bank')!, t: q.get('t')! } : null;

function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadServerAddress().then(() => server.config()).then((c) => {
      if (!('naira' in c)) throw new Error('This server runs the old demo. Start it with `npm run serve` instead.');
      setExplorer(c.explorerTx); setCfg(c);
    }).catch((e) => setError(`Cannot reach the StockRun server: ${e.message}`));
  }, []);

  return (
    <div className="shell">
      <nav className="top"><span className="brand"><span className="mark" aria-hidden="true" />StockRun</span></nav>
      <main>
        {error && <p className="alert">{error}</p>}
        {!cfg && !error && <p className="muted">Connecting… (the free server can take a minute to wake up)</p>}
        {cfg && (sellerBank ? <SellerBankPage sellerId={sellerBank.id} token={sellerBank.t} /> : <AccountApp cfg={cfg} />)}
      </main>
      {cfg && (
        <footer className={`demo-bar${cfg.network === 'xlayer' ? ' live' : ''}`}>
          {cfg.network === 'xlayer' ? 'Circuits on X Layer mainnet' : 'Local test chain'} · naira {cfg.naira.paystack ? (cfg.naira.test ? 'via Paystack test mode' : 'via Paystack') : 'deposits off'}{cfg.naira.testCredit ? ' · demo naira on' : ''} · real sellers from OpenStreetMap, not checked by StockRun
        </footer>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
