// The feed: posts from stores registered on StockRun. Shop owners with a live store post what they have in stock;
// buyers see every post, open the store's page, and message the store in the app.
import { useCallback, useEffect, useState } from 'react';
import { naira, postPhotoUrl, preparePhoto, server, type Post, type StorePage, type User } from './lib';
import { Sheet } from './ui';
import { Icon } from './icons';

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
};
const kindLabel = (k: string) => k.replace(/_/g, ' ');

export function FeedTab({ user, onChat, goStore }: { user: User; onChat: (sellerId: string) => Promise<void>; goStore: () => void }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState('');
  const [store, setStore] = useState<StorePage | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { const p = await server.feed(); setPosts(p); setMore(p.length >= 20); } catch (e) { setError((e as Error).message); setPosts([]); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  const loadMore = async () => {
    if (!posts?.length) return;
    const next = await server.feed(posts[posts.length - 1].id).catch(() => []);
    setPosts([...posts, ...next]); setMore(next.length >= 20);
  };
  const message = async (sellerId: string) => {
    setBusy(sellerId); setError('');
    try { await onChat(sellerId); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const openStore = async (sellerId: string) => {
    try { setStore(await server.store(sellerId)); } catch (e) { setError((e as Error).message); }
  };
  const remove = async (id: number) => {
    if (!confirm('Delete this post?')) return;
    try { await server.deletePost(id); setPosts((p) => p?.filter((x) => x.id !== id) ?? null); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="stack">
      <header className="screen-head">
        <h1 className="h-page">Feed</h1>
        <p className="fine">Fresh stock from stores on StockRun</p>
      </header>
      {user.role === 'shop' && <Composer onPosted={(p) => setPosts((x) => [p, ...(x ?? [])])} goStore={goStore} />}
      {error && <p className="alert">{error}</p>}
      {!posts ? <div className="loading"><span className="spinner" aria-hidden="true" /></div>
        : posts.length === 0 ? (
          <div className="empty big">
            <span className="empty-icon"><Icon.home size={28} /></span>
            <p><strong>No posts yet</strong></p>
            <p className="muted">When stores on StockRun post their stock, it shows up here.</p>
          </div>
        ) : (
          <ul className="cards feed">
            {posts.map((p) => (
              <PostCard key={p.id} p={p} busy={busy === p.store.sellerId} onMessage={() => message(p.store.sellerId)} onStore={() => openStore(p.store.sellerId)} onDelete={() => remove(p.id)} />
            ))}
          </ul>
        )}
      {posts && posts.length > 0 && more && <button className="btn ghost" onClick={loadMore}>Load more</button>}
      {store && <StoreSheet page={store} onClose={() => setStore(null)} onMessage={() => { const id = store.sellerId; setStore(null); message(id); }} />}
    </div>
  );
}

function PostCard({ p, busy, onMessage, onStore, onDelete }: { p: Post; busy: boolean; onMessage: () => void; onStore: () => void; onDelete: () => void }) {
  return (
    <li className="card post">
      <button className="post-head" onClick={onStore}>
        <span className="seller-avatar listed" aria-hidden="true">{p.store.name.slice(0, 1).toUpperCase()}</span>
        <span className="grow">
          <strong>{p.store.name} <span className="verified" title="Registered on StockRun">✓</span></strong>
          <span className="fine">{kindLabel(p.store.kind)} · {p.store.address}</span>
        </span>
        <span className="fine nowrap">{ago(p.at)}</span>
      </button>
      <p className="post-text">{p.text}</p>
      {p.hasPhoto && <img className="post-photo" src={postPhotoUrl(p.id)} alt="" loading="lazy" />}
      {p.priceNaira !== null && <span className="price-tag">{naira(p.priceNaira)}<small> / {p.unit}</small></span>}
      <div className="actions">
        {p.mine
          ? <><button className="btn ghost" onClick={onStore}><Icon.home size={18} /> Your store</button><button className="btn ghost" onClick={onDelete}>Delete</button></>
          : <><button className="btn primary" disabled={busy} onClick={onMessage}><Icon.chat size={18} /> {busy ? 'Opening…' : 'Message'}</button><button className="btn ghost" onClick={onStore}>View store</button></>}
      </div>
    </li>
  );
}

function StoreSheet({ page, onClose, onMessage }: { page: StorePage; onClose: () => void; onMessage: () => void }) {
  return (
    <Sheet title={page.name} onClose={onClose}>
      <div className="stack">
        <div className="seller-line">
          <span className="seller-avatar listed" aria-hidden="true">{page.name.slice(0, 1).toUpperCase()}</span>
          <span className="grow"><strong>{kindLabel(page.kind)}</strong><span className="fine">{page.address}</span></span>
          <span className="pill listed">✓ On StockRun</span>
        </div>
        {!page.mine && <button className="btn primary big" onClick={onMessage}><Icon.chat size={20} /> Message {page.name}</button>}
        {page.products.length > 0 && (
          <section className="stack tight">
            <h3 className="section-label">Price list</h3>
            <ul className="price-list">{page.products.map((p, i) => <li key={i}><span>{p.item}</span><span className="num">{naira(p.priceNaira)} / {p.unit}</span></li>)}</ul>
          </section>
        )}
        <section className="stack">
          <h3 className="section-label">Posts</h3>
          {page.posts.length === 0 ? <p className="muted">No posts yet.</p> : page.posts.map((p) => (
            <div key={p.id} className="mini-post">
              <p>{p.text}</p>
              {p.hasPhoto && <img className="post-photo" src={postPhotoUrl(p.id)} alt="" loading="lazy" />}
              <span className="fine">{p.priceNaira !== null ? `${naira(p.priceNaira)} / ${p.unit} · ` : ''}{ago(p.at)}</span>
            </div>
          ))}
        </section>
        <p className="fine">When you agree a price in chat, record the deal under Ask so your money is locked, not paid, until you collect.</p>
      </div>
    </Sheet>
  );
}

/** Shop owners: post what's in stock. Only a live store (approved and paid) can post; the server checks too. */
function Composer({ onPosted, goStore }: { onPosted: (p: Post) => void; goStore: () => void }) {
  const [live, setLive] = useState<boolean | null>(null);
  const [text, setText] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState('carton');
  const [photo, setPhoto] = useState<{ mediaType: string; data: string; previewUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { server.myBusiness().then((r) => setLive(!!r.business?.live)).catch(() => setLive(false)); }, []);
  const n = Number(price.replace(/\D/g, '')) || 0;

  if (live === null) return null;
  if (!live) return (
    <button className="nudge" onClick={goStore}><Icon.home size={18} /> Your store can post here once it's approved and this month is paid <Icon.chevron size={16} /></button>
  );
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const p = await server.post({ text: text.trim(), ...(n ? { priceNaira: n, unit } : {}), ...(photo ? { photo: { mediaType: photo.mediaType, data: photo.data } } : {}) });
      onPosted(p); setText(''); setPrice(''); setPhoto(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="panel stack composer">
      <textarea rows={3} maxLength={500} placeholder="What's in stock today? e.g. New Indomie cartons just arrived" value={text} onChange={(e) => setText(e.target.value)} />
      {photo && (
        <div className="photo-preview"><img src={photo.previewUrl} alt="" /><button className="sheet-x" aria-label="Remove photo" onClick={() => setPhoto(null)}>✕</button></div>
      )}
      <div className="composer-row">
        <label className="field"><span>Price (optional)</span><span className="input-icon"><span className="prefix">₦</span><input inputMode="numeric" placeholder="13,000" value={n ? n.toLocaleString('en-NG') : ''} onChange={(e) => setPrice(e.target.value)} /></span></label>
        <label className="field"><span>per</span><input value={unit} maxLength={20} onChange={(e) => setUnit(e.target.value)} /></label>
      </div>
      <div className="row between">
        <label className="link-btn file-btn"><Icon.plus size={16} /> {photo ? 'Change photo' : 'Add photo'}
          <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { setPhoto(await preparePhoto(f, 1200, 0.8)); } catch (err) { setError((err as Error).message); } } e.target.value = ''; }} />
        </label>
        <button className="btn primary" disabled={busy || text.trim().length < 2} onClick={submit}>{busy ? 'Posting…' : 'Post'}</button>
      </div>
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
