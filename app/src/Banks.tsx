// Bank transfers through Paystack: a seller adds the account StockRun pays (from a link a buyer forwarded), and buyers
// withdraw spendable naira to their own bank. Account names always come from the bank, never from what was typed.
import { useEffect, useState } from 'react';
import { naira, server, type Withdrawal } from './lib';

/** The list of banks, loaded once. */
export function useBanks(enabled: boolean) {
  const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  useEffect(() => { if (enabled) server.banks().then(setBanks).catch(() => setBanks([])); }, [enabled]);
  return banks;
}

export function BankFields({ banks, bankCode, accountNumber, onChange }: { banks: { name: string; code: string }[]; bankCode: string; accountNumber: string; onChange: (v: { bankCode: string; accountNumber: string }) => void }) {
  return (
    <div className="row wrap">
      <label className="field"><span>Bank</span>
        <select value={bankCode} onChange={(e) => onChange({ bankCode: e.target.value, accountNumber })}>
          <option value="">Choose your bank…</option>
          {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Account number</span>
        <input inputMode="numeric" maxLength={10} placeholder="10 digits" value={accountNumber} onChange={(e) => onChange({ bankCode, accountNumber: e.target.value.replace(/\D/g, '') })} />
      </label>
    </div>
  );
}

/** The page a seller opens from a buyer's link (?seller-bank=<id>&t=<token>). No sign-in. */
export function SellerBankPage({ sellerId, token }: { sellerId: string; token: string }) {
  const [info, setInfo] = useState<{ name: string; transfers: boolean; test: boolean } | null>(null);
  const [v, setV] = useState({ bankCode: '', accountNumber: '' });
  const [done, setDone] = useState<{ accountName: string; bankName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { server.sellerBankInfo(sellerId, token).then(setInfo).catch((e) => setError(e.message)); }, [sellerId, token]);
  const banks = useBanks(!!info?.transfers);

  if (error && !info) return <p className="alert">{error}</p>;
  if (!info) return <p className="muted">Loading…</p>;
  return (
    <section className="stack">
      <header className="screen-head">
        <p className="eyebrow">StockRun · for sellers</p>
        <h1>Get paid for StockRun orders</h1>
        <p className="muted">Add the bank account for <strong>{info.name}</strong>. When a buyer collects goods from you and confirms the count, StockRun sends the money to this account.</p>
      </header>
      <div className="panel stack">
        {!info.transfers ? <p className="warn">Bank payments are not switched on yet. Send your account details to the buyer on WhatsApp.</p>
          : done ? (
            <div className="stack">
              <p className="ok">Saved: <strong>{done.accountName}</strong>, {done.bankName}.</p>
              <p className="fine">StockRun checks the account before the first payment. After that, payments for collected orders go straight to this account.</p>
            </div>
          ) : (<>
            <BankFields banks={banks} bankCode={v.bankCode} accountNumber={v.accountNumber} onChange={setV} />
            <button className="btn primary" disabled={busy || !v.bankCode || v.accountNumber.length !== 10} onClick={async () => {
              setBusy(true); setError('');
              try { setDone(await server.sellerBankSubmit(sellerId, token, v)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
            }}>{busy ? 'Checking with your bank…' : 'Save my bank account'}</button>
            <p className="fine">We check the account name with your bank. Only an account in your business's or your own name will be approved.{info.test ? ' (Test mode: no real money moves.)' : ''}</p>
          </>)}
        {error && <p className="alert">{error}</p>}
      </div>
    </section>
  );
}

/** Money tab: take spendable naira out to your own bank. */
export function WithdrawPanel({ available, onDone }: { available: number; onDone: () => void }) {
  const banks = useBanks(true);
  const [amount, setAmount] = useState('');
  const [v, setV] = useState({ bankCode: '', accountNumber: '' });
  const [list, setList] = useState<Withdrawal[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => server.withdrawals().then(setList).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const n = Number(amount.replace(/\D/g, '')) || 0;

  return (
    <div className="stack">
      <label className="field"><span>Amount (₦)</span><input className="money" inputMode="numeric" placeholder="10,000" value={n ? n.toLocaleString('en-NG') : ''} onChange={(e) => setAmount(e.target.value)} /></label>
      <BankFields banks={banks} bankCode={v.bankCode} accountNumber={v.accountNumber} onChange={setV} />
      <button className="btn primary big" disabled={busy || n < 100 || n > available || !v.bankCode || v.accountNumber.length !== 10} onClick={async () => {
        setBusy(true); setMsg(null);
        try {
          const w = await server.withdraw(n, v.bankCode, v.accountNumber);
          setMsg(w.status === 'failed' ? { ok: false, text: w.note ?? 'The withdrawal failed; your money is back.' }
            : w.status === 'review' ? { ok: true, text: `${naira(w.amountKobo / 100)} to ${w.accountName}, ${w.bankName}: waiting for StockRun to check it.${w.note ? ` ${w.note}` : ''}` }
            : { ok: true, text: `${naira(w.amountKobo / 100)} sent to ${w.accountName}, ${w.bankName}.${w.note ? ` ${w.note}` : ''}` });
          setAmount(''); refresh(); onDone();
        } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
      }}>{busy ? 'Sending…' : `Withdraw ${n ? naira(n) : ''}`}</button>
      {n > available && <p className="warn">That is more than your spendable {naira(available)}.</p>}
      {msg && <p className={msg.ok ? 'ok' : 'alert'}>{msg.text}</p>}
      {list.length > 0 && (
        <ul className="plain">{list.map((w) => (
          <li key={w.reference} className="fine">{naira(w.amountKobo / 100)} to {w.accountName} ({w.bankName}) · {w.status === 'sent' ? 'sent' : w.status === 'failed' ? 'failed, money returned' : w.status === 'review' ? 'being checked by StockRun' : 'sending'}{w.note ? ` · ${w.note}` : ''}</li>
        ))}</ul>
      )}
    </div>
  );
}
