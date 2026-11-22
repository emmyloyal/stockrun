// Small stroke icons (24px grid, currentColor), so the app needs no icon library.
import type { ReactNode } from 'react';

const Svg = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const Icon = {
  search: (p: { size?: number }) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>,
  box: (p: { size?: number }) => <Svg {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></Svg>,
  chat: (p: { size?: number }) => <Svg {...p}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></Svg>,
  wallet: (p: { size?: number }) => <Svg {...p}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h2" /><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3H18" /></Svg>,
  user: (p: { size?: number }) => <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>,
  shield: (p: { size?: number }) => <Svg {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></Svg>,
  pin: (p: { size?: number }) => <Svg {...p}><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></Svg>,
  locate: (p: { size?: number }) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>,
  lock: (p: { size?: number }) => <Svg {...p}><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>,
  check: (p: { size?: number }) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>,
  plus: (p: { size?: number }) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  arrowUp: (p: { size?: number }) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>,
  arrowDown: (p: { size?: number }) => <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>,
  map: (p: { size?: number }) => <Svg {...p}><path d="m9 4-6 2.5v13L9 17l6 2.5 6-2.5v-13L15 6.5z" /><path d="M9 4v13M15 6.5v13" /></Svg>,
  truck: (p: { size?: number }) => <Svg {...p}><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="1.8" /><circle cx="17.5" cy="18" r="1.8" /></Svg>,
  walk: (p: { size?: number }) => <Svg {...p}><circle cx="13" cy="4.5" r="1.8" /><path d="m10 21 2-6 3 2v4M8.5 12l1.5-4.5 4 1.5 2 3.5M10 7.5 7 10" /></Svg>,
  spark: (p: { size?: number }) => <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></Svg>,
  info: (p: { size?: number }) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>,
  admin: (p: { size?: number }) => <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>,
  whatsapp: (p: { size?: number }) => <Svg {...p}><path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.5L3.5 20.5l1.4-4.3a8.5 8.5 0 1 1 15.6-4.6z" /><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-1 .8a4.6 4.6 0 0 1-2.7-2.7l.8-1-1-2z" /></Svg>,
  handshake: (p: { size?: number }) => <Svg {...p}><path d="m11 17 2 2a1.4 1.4 0 0 0 2-2M13 15l2.5 2.5a1.4 1.4 0 0 0 2-2l-3.8-3.8a2 2 0 0 0-2.8 0l-.9.9a1.4 1.4 0 0 1-2-2l2.8-2.8a3.5 3.5 0 0 1 4.3-.5l.4.3a3 3 0 0 0 2 .5H21M3 7h3l5 5M21 15h-2M3 15h3l3 3a1.4 1.4 0 0 0 2-2" /></Svg>,
  chevron: (p: { size?: number }) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>,
  logout: (p: { size?: number }) => <Svg {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></Svg>,
};
