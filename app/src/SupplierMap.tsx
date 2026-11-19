// Owner's map: the shop, the search radius, suppliers coloured by vault status with their latest prices, and a line
// from supplier to shop for every order still in progress. Leaflet + OpenStreetMap tiles (no API key).
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, naira, type MapData, type Order } from './lib';

const STATUS: Record<number, { label: string; color: string; dash?: string }> = {
  2: { label: 'Preferred', color: '#18794A' },
  1: { label: 'Approved', color: '#1F4E99' },
  0: { label: 'Not approved: suggest only', color: '#7A8194', dash: '3 4' },
};
const SOURCE: Record<string, string> = { deal: 'agreed', quote: 'quoted', price_list: 'price list', catalogue: 'StockRun list price' };
const RADII = [5, 10, 15];

export function SupplierMap({ orders }: { orders: Order[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const [data, setData] = useState<MapData | null>(null);
  const [radius, setRadius] = useState(5);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => api.map().then(setData).catch((e) => setError(e.message));
    load(); const t = setInterval(load, 10_000); return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([6.58, 3.38], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g || !data) return;
    g.clearLayers();
    const shop = data.shop;
    const circle = L.circle([shop.lat, shop.lng], { radius: radius * 1000, color: '#141B2E', weight: 1.5, fillColor: '#F4C20D', fillOpacity: 0.08 }).addTo(g);
    // Active orders: supplier -> shop.
    for (const o of orders) {
      if (o.status !== 'Locked' && o.status !== 'PickedUp' && o.status !== 'AwaitingOwner') continue;
      L.polyline([[o.supplier.lat, o.supplier.lng], [shop.lat, shop.lng]], { color: o.status === 'PickedUp' ? '#18794A' : '#A35F00', weight: 5, opacity: 0.8, dashArray: o.status === 'AwaitingOwner' ? '6 6' : undefined })
        .bindTooltip(`Order #${o.orderId}: ${o.ordered} × ${o.item} (${o.status === 'PickedUp' ? 'on the way' : o.status === 'Locked' ? 'pickup next' : 'needs your OK'})`).addTo(g);
    }
    for (const s of data.suppliers) {
      const st = STATUS[s.status] ?? STATUS[0];
      const inRange = s.km <= radius;
      const rows = s.prices.map((p) => `<tr><td>${esc(p.item)}</td><td class="num">${naira(p.priceNaira)}</td><td class="src">${SOURCE[p.source] ?? p.source}${p.age ? `, ${p.age}` : ''}</td></tr>`).join('');
      L.circleMarker([s.lat, s.lng], { pane: 'markerPane', radius: 9, color: st.color, weight: 3, dashArray: st.dash, fillColor: st.color, fillOpacity: inRange ? 0.85 : 0.25 })
        .bindPopup(`<div class="pop"><strong>${esc(s.name)}</strong><span>${esc(s.market)} · ${s.km} km${inRange ? '' : ' (outside radius)'}</span><span class="tag" style="color:${st.color}">${st.label}${s.simulated ? ' · simulated' : ''}</span><table>${rows}</table></div>`, { maxWidth: 300 })
        .addTo(g);
    }
    L.circleMarker([shop.lat, shop.lng], { pane: 'markerPane', radius: 11, color: '#141B2E', weight: 3, fillColor: '#F4C20D', fillOpacity: 1 }).bindTooltip(shop.name, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'shop-label' }).addTo(g);
    m.fitBounds(circle.getBounds(), { padding: [12, 12] });
  }, [data, orders, radius]);

  const visible = (data?.suppliers ?? []).filter((s) => s.km <= radius).sort((a, b) => b.status - a.status || a.km - b.km);
  return (
    <section className="stack" aria-label="Suppliers near your shop">
      <div className="row between wrap">
        <h2>Suppliers near you</h2>
        <div className="seg" role="group" aria-label="Search radius">
          {RADII.map((r) => <button key={r} className={r === radius ? 'on' : ''} aria-pressed={r === radius} onClick={() => setRadius(r)}>{r} km</button>)}
        </div>
      </div>
      {error && <p className="alert">{error}</p>}
      <div ref={el} className="map" />
      <ul className="legend">
        {[2, 1, 0].map((k) => <li key={k}><i style={{ borderColor: STATUS[k].color, borderStyle: STATUS[k].dash ? 'dashed' : 'solid', background: STATUS[k].color }} />{STATUS[k].label}</li>)}
        <li><i className="line amber" />Order: pickup next</li>
        <li><i className="line green" />Order: on the way</li>
      </ul>
      <p className="fine">Distances are straight-line. Live rider position is not shared yet.</p>
      <details className="supplier-list">
        <summary>{visible.length} supplier{visible.length === 1 ? '' : 's'} within {radius} km (list)</summary>
        <ul className="cards">
          {visible.map((s) => (
            <li key={s.id} className="card">
              <span className="row between"><strong>{s.name}</strong><span className="pill" style={{ color: (STATUS[s.status] ?? STATUS[0]).color }}>{(STATUS[s.status] ?? STATUS[0]).label}</span></span>
              <span className="muted">{s.market} · {s.km} km{s.simulated ? ' · simulated' : ''}</span>
              {s.prices.map((p) => <span key={p.item} className="price-row"><span>{p.item}</span><span className="num">{naira(p.priceNaira)}</span><span className="fine">{SOURCE[p.source] ?? p.source}{p.age ? `, ${p.age}` : ''}</span></span>)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
