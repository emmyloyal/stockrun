import { useCallback, useEffect, useState } from 'react';
import { api, currentPosition, distanceM, GEOFENCE_M, naira, preparePhoto, short, signer, type CheckResult, type Config, type Order, type Place } from './lib';
import { Outcome, StatusPill, Tx } from './ui';

type Signer = ReturnType<typeof signer>;

export function Rider({ cfg, me }: { cfg: Config; me: Signer }) {
  const [jobs, setJobs] = useState<Order[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => api.riderJobs(me.address).then((j) => { setJobs(j); setError(''); }).catch((e) => setError(e.message)), [me.address]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, [refresh]);

  const job = jobs?.find((j) => j.orderId === open);
  if (job) return <JobScreen cfg={cfg} me={me} job={job} back={() => setOpen(null)} refresh={refresh} />;

  return (
    <section className="stack">
      <header className="screen-head">
        <p className="eyebrow">Rider</p>
        <h1>Your jobs</h1>
        <p className="muted mono">{short(me.address)}</p>
      </header>
      {error && <p className="alert">{error}</p>}
      {jobs === null ? <p className="muted">Loading…</p> : jobs.length === 0 ? (
        <div className="empty"><p>No jobs yet.</p><p className="muted">When the owner's order is approved and paid into escrow, it appears here.</p></div>
      ) : (
        <ul className="cards">
          {jobs.map((j) => (
            <li key={j.orderId}>
              <button className="card job" onClick={() => setOpen(j.orderId)}>
                <span className="row between"><strong>{j.ordered} × {j.item}</strong><StatusPill o={j} /></span>
                <span className="muted">{j.supplier.name} → {j.shop.name}</span>
                <span className="row between"><span className="muted">Order #{j.orderId}</span><span>Your fee {naira(j.riderFeeNaira)}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JobScreen({ cfg, me, job, back, refresh }: { cfg: Config; me: Signer; job: Order; back: () => void; refresh: () => void }) {
  const stage = job.status === 'Locked' ? 'pickup' : job.status === 'PickedUp' ? 'delivery' : null;
  return (
    <section className="stack">
      <button className="link" onClick={back}>← All jobs</button>
      <header className="screen-head">
        <p className="eyebrow">Order #{job.orderId}</p>
        <h1>{job.ordered} × {job.item}</h1>
        <StatusPill o={job} />
      </header>
      <dl className="facts">
        <div><dt>Pick up from</dt><dd>{job.supplier.name}</dd></div>
        <div><dt>Deliver to</dt><dd>{job.shop.name}</dd></div>
        <div><dt>Goods</dt><dd>{job.ordered} × {naira(job.unitPriceNaira)}</dd></div>
        <div><dt>Your fee</dt><dd>{naira(job.riderFeeNaira)}</dd></div>
      </dl>
      {stage === 'pickup' && <Stage key="pickup" cfg={cfg} me={me} job={job} stage="pickup" place={job.supplier} refresh={refresh} />}
      {stage === 'delivery' && <Stage key="delivery" cfg={cfg} me={me} job={job} stage="delivery" place={job.shop} refresh={refresh} />}
      {job.status === 'Delivered' && <div className="panel"><h2>Job finished</h2>{job.lastCheck && <Outcome r={job.lastCheck} />}</div>}
      {job.status === 'PickedUp' && job.lastCheck && <div className="panel"><h3>Pickup result</h3><Outcome r={job.lastCheck} /></div>}
    </section>
  );
}

function Stage({ cfg, me, job, stage, place, refresh }: { cfg: Config; me: Signer; job: Order; stage: 'pickup' | 'delivery'; place: Place; refresh: () => void }) {
  const [where, setWhere] = useState<{ here: boolean; how: 'gps' | 'simulated'; meters?: number } | null>(null);
  const [count, setCount] = useState(job.ordered);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tx, setTx] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const signed = stage === 'pickup' ? job.pickup.riderCounted : job.delivery.atShop || job.delivery.arrivedAt > 0;
  const photoDone = stage === 'pickup' ? job.pickup.aiCounted : job.delivery.aiCounted;

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setError('');
    try { await f(); refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const checkLocation = () => run('Getting your location…', async () => {
    const p = await currentPosition();
    const meters = distanceM(p, place);
    setWhere({ here: meters <= GEOFENCE_M, how: 'gps', meters });
  });

  const sign = () => run('Signing with your key…', async () => {
    if (!where) throw new Error('Check your location first.');
    const hash = stage === 'pickup'
      ? await me.send('riderPickup', [BigInt(job.orderId), where.here, count])
      : await me.send('riderArrive', [BigInt(job.orderId), where.here]);
    setTx(hash);
    // If the photo was checked first, the vault can settle now that the rider's step is in.
    if (stage === 'pickup' && photoDone) setResult(await api.settle(job.orderId, 'pickup'));
  });

  const sendPhoto = (file: File) => run('Checking the photo…', async () => {
    const p = await preparePhoto(file);
    setPreview(p.previewUrl);
    setResult(await api.photo(job.orderId, stage, { mediaType: p.mediaType, data: p.data }));
  });

  const placeWord = stage === 'pickup' ? 'the supplier' : 'the shop';
  return (
    <div className="panel stack">
      <h2>{stage === 'pickup' ? 'At the supplier' : 'At the shop'}</h2>

      <ol className="steps">
        <li className={where ? 'done' : ''}>
          <h3>1. Check you are at {placeWord}</h3>
          {where ? (
            <p className={where.here ? 'ok' : 'warn'}>
              {where.how === 'simulated' ? 'Simulated location (demo): at ' + placeWord + '.'
                : where.here ? `You are at ${placeWord} (${Math.round(where.meters!)} m).`
                : `You are ${(where.meters! / 1000).toFixed(1)} km from ${placeWord}. The circuit will hold payment until you are there.`}
            </p>
          ) : <p className="muted">Your phone's location is compared with {place.name}. You must be within {GEOFENCE_M} m.</p>}
          <div className="row wrap">
            <button className="btn" disabled={!!busy} onClick={checkLocation}>Check my location</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => setWhere({ here: true, how: 'simulated' })}>Demo: simulate being there</button>
          </div>
        </li>

        <li className={signed ? 'done' : ''}>
          <h3>2. {stage === 'pickup' ? 'Count the goods and sign' : 'Sign that you have arrived'}</h3>
          {stage === 'pickup' && (
            <label className="field">
              <span>How many {job.unit}s did you count?</span>
              <input id={`count-${job.orderId}`} type="number" inputMode="numeric" min={0} max={255} value={count} onChange={(e) => setCount(Math.max(0, Math.min(255, Number(e.target.value) || 0)))} />
            </label>
          )}
          {signed && !tx ? <p className="ok">Signed on-chain{stage === 'pickup' ? `: you counted ${job.pickup.riderCount}.` : '.'}</p> : null}
          {tx && <p className="ok">Signed. <Tx hash={tx} /></p>}
          <button className="btn" disabled={!!busy || !where} onClick={sign}>{signed ? 'Sign again' : 'Sign with my key'}</button>
          <p className="fine">Only your key can sign this. StockRun's server never holds it.</p>
        </li>

        <li className={photoDone ? 'done' : ''}>
          <h3>3. Photo of the goods</h3>
          <p className="muted">Spread the {job.unit}s out so every one can be seen.</p>
          <label className="btn file">
            {photoDone ? 'Take another photo' : 'Take photo'}
            <input id={`photo-${stage}-${job.orderId}`} type="file" accept="image/*" capture="environment" disabled={!!busy || !cfg.photoCheck} onChange={(e) => { const f = e.target.files?.[0]; if (f) sendPhoto(f); e.target.value = ''; }} />
          </label>
          {!cfg.photoCheck && <p className="warn">Photo check is off on this server (no GEMINI_API_KEY).</p>}
          {preview && <img className="preview" src={preview} alt="Your photo" />}
        </li>
      </ol>

      {busy && <p className="busy">{busy}</p>}
      {error && <p className="alert">{error}</p>}
      {result && <Outcome r={result} />}
    </div>
  );
}
