import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadServerAddress, server, setExplorer, type Config } from './lib';
import { AccountApp, Brand } from './Account';
import { SellerBankPage } from './Banks';
import './styles.css';
import './shell.css';

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

  if (!cfg) {
    return (
      <div className="shell">
        <header className="topbar"><Brand /></header>
        <main>{error ? <p className="alert">{error}</p> : <div className="loading"><span className="spinner" aria-hidden="true" /><span className="muted">Connecting…</span></div>}</main>
      </div>
    );
  }
  return (
    <div className="shell">
      {sellerBank
        ? (<><header className="topbar"><Brand /></header><main><SellerBankPage sellerId={sellerBank.id} token={sellerBank.t} /></main></>)
        : <AccountApp cfg={cfg} />}
      <footer className="about">
        {cfg.naira.test ? 'Test money only' : cfg.naira.paystack ? 'Naira through Paystack' : 'Deposits off'} · {cfg.network === 'xlayer' ? 'Payments decided on X Layer' : 'Local test chain'} · Sellers from OpenStreetMap, not checked by StockRun
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
