'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import AdminProductCard, { type StockHistory } from './AdminProductCard';
import DayCountPicker, { ymd, fmtYmd } from './DayCountPicker';
import { supabase } from '@/lib/supabase';
import type { Product, StockByLoc, LocationInfo } from '@/lib/types';

// One stock change at this location, in pieces.
interface Change { pid: number; t: number; d: number }

// Every stock change since mid-July 2026 carries a "(was: X → now: Y)"
// snapshot; older records don't, and the log overlaps an older table, so
// figures before this date are best-effort.
const HISTORY_RELIABLE_FROM = '2026-07-16';

type LogRow = {
  product_id: number; request_type: string; quantity: number | null;
  from_location_id: number | null; to_location_id: number | null;
  notes: string | null; requested_at: string | null; approved_at: string | null;
};

// Stock changes at `loc` from the approved stock log. The stock engine
// logs one row per change with a before/after snapshot of the row it
// changed; a transfer is logged once, on the source, so the destination
// gets the mirror of it.
function toChanges(rows: LogRow[], loc: number): Change[] {
  const out: Change[] = [];
  for (const r of rows) {
    const iso = r.approved_at ?? r.requested_at;
    if (!iso) continue;
    const t = new Date(iso).getTime();
    const snap = r.notes?.match(/\(was: (-?\d+) → now: (-?\d+)\)/);
    const isTransfer = r.request_type.startsWith('TRANSFER');
    let d = 0;
    if (snap) {
      const delta = Number(snap[2]) - Number(snap[1]);
      if (isTransfer) d = r.from_location_id === loc ? delta : r.to_location_id === loc ? -delta : 0;
      else if (r.from_location_id === loc || r.to_location_id === loc) d = delta;
    } else {
      const q = r.quantity ?? 0;
      if (r.to_location_id === loc) d += q;
      if (r.from_location_id === loc) d -= q;
    }
    if (d !== 0) out.push({ pid: r.product_id, t, d });
  }
  return out;
}

export type StockFilter = 'all' | 'in_stock' | 'out_of_stock';

interface Props {
  products:    Product[];
  locations:   LocationInfo[];
  stockByLoc:  StockByLoc;
  boxByLoc:    StockByLoc;
  onAdjust:    (product: Product, direction: 'plus' | 'minus', locationId: number) => void;
  onEdit?:     (product: Product) => void;
  stockFilter?: StockFilter;
  // When set, the location is chosen from the admin menu (?loc=) and the
  // in-page location switcher is hidden.
  locationId?: number;
}

export default function ProductList({
  products, locations, stockByLoc, boxByLoc, onAdjust, onEdit,
  stockFilter = 'all', locationId: fixedLocId,
}: Props) {
  const firstLocId = locations[0]?.location_id ?? 0;
  const [pickedLocId, setLocationId] = useState<number>(firstLocId);
  const locationId = fixedLocId ?? pickedLocId;
  const [category,   setCategory]   = useState('All');
  const [search,     setSearch]     = useState('');
  const [scanMsg,    setScanMsg]    = useState<{ text: string; ok: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Stock on date: rebuild this location's stock for a past period ──
  const [historyOn,   setHistoryOn]   = useState(false);
  const [histFrom,    setHistFrom]    = useState(() => ymd(new Date()));
  const [histTo,      setHistTo]      = useState(() => ymd(new Date()));
  const [changedOnly, setChangedOnly] = useState(false);
  const [logRows,     setLogRows]     = useState<{ loc: number; rows: LogRow[] } | null>(null);
  const [logError,    setLogError]    = useState<string | null>(null);

  useEffect(() => {
    if (!historyOn || !locationId || logRows?.loc === locationId) return;
    let cancelled = false;
    (async () => {
      const PAGE = 1000;
      const rows: LogRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('stock_requests')
          .select('product_id, request_type, quantity, from_location_id, to_location_id, notes, requested_at, approved_at')
          .eq('status', 'APPROVED')
          .or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`)
          .order('request_id').range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) { setLogError(error.message); return; }
        rows.push(...((data ?? []) as LogRow[]));
        if ((data ?? []).length < PAGE) break;
      }
      setLogError(null);
      setLogRows({ loc: locationId, rows });
    })();
    return () => { cancelled = true; };
  }, [historyOn, locationId, logRows]);

  const changes = useMemo(
    () => (logRows && logRows.loc === locationId ? toChanges(logRows.rows, locationId) : null),
    [logRows, locationId],
  );

  const dayCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of changes ?? []) { const k = ymd(new Date(ch.t)); c[k] = (c[k] ?? 0) + 1; }
    return c;
  }, [changes]);

  // pid → figures for [start of From, end of To). Stock at an instant is
  // today's stock minus every change since then.
  const historyByPid = useMemo(() => {
    if (!historyOn || !changes) return null;
    const start = new Date(`${histFrom}T00:00:00`).getTime();
    const endD = new Date(`${histTo}T00:00:00`);
    endD.setDate(endD.getDate() + 1);
    const end = endD.getTime();
    const acc = new Map<number, { sinceStart: number; sinceEnd: number; inQty: number; outQty: number }>();
    for (const ch of changes) {
      if (ch.t < start) continue;
      let a = acc.get(ch.pid);
      if (!a) { a = { sinceStart: 0, sinceEnd: 0, inQty: 0, outQty: 0 }; acc.set(ch.pid, a); }
      a.sinceStart += ch.d;
      if (ch.t >= end) a.sinceEnd += ch.d;
      else if (ch.d > 0) a.inQty += ch.d;
      else a.outQty -= ch.d;
    }
    return acc;
  }, [historyOn, changes, histFrom, histTo]);

  // Products with a change inside the chosen period (not just after it).
  const changedInPeriod = useMemo(() => {
    if (!historyByPid) return null;
    const ids = new Set<number>();
    for (const [pid, a] of historyByPid) if (a.inQty > 0 || a.outQty > 0) ids.add(pid);
    return ids;
  }, [historyByPid]);

  function historyFor(p: Product): StockHistory | undefined {
    if (!historyByPid) return undefined;
    const now = ((stockByLoc[locationId] ?? {})[p.product_id] ?? 0)
      + ((boxByLoc[locationId] ?? {})[p.product_id] ?? 0) * (p.pieces_per_box || 1);
    const a = historyByPid.get(p.product_id);
    return {
      opening:   now - (a?.sinceStart ?? 0),
      closing:   now - (a?.sinceEnd ?? 0),
      inQty:     a?.inQty ?? 0,
      outQty:    a?.outQty ?? 0,
      fromLabel: fmtYmd(histFrom),
      toLabel:   fmtYmd(histTo),
    };
  }

  // When locations load, set default if not set
  useEffect(() => {
    if (!pickedLocId && locations.length > 0) setLocationId(locations[0].location_id);
  }, [locations, pickedLocId]);

  // The search bar is focused on open so a barcode scanner can type
  // straight into it.
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.key === 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName !== 'HTML') {
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      }
      if (document.querySelector('.fixed.inset-0')) return;
      searchRef.current?.focus();
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  useEffect(() => {
    if (!scanMsg) return;
    const t = setTimeout(() => setScanMsg(null), 2500);
    return () => clearTimeout(t);
  }, [scanMsg]);

  // Scanners type the code and press Enter. Typing already filters the
  // list; Enter confirms an exact barcode match and selects the text so
  // the next scan replaces it.
  function handleSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const input = e.currentTarget;
    const code = input.value.trim();
    if (!code) return;
    const lc = code.toLowerCase();
    const match = products.find(p => (p.stock_keeping_unit ?? '').toLowerCase() === lc);
    if (match) {
      setCategory('All');
      setScanMsg({ text: `Found: ${match.product_name}`, ok: true });
    } else if (!products.some(p => p.product_name.toLowerCase().includes(lc))) {
      setScanMsg({ text: `No product matches "${code}"`, ok: false });
    }
    input.select();
  }

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const sm = stockByLoc[locationId] ?? {};
  const bm = boxByLoc[locationId]   ?? {};

  // Total stock across ALL locations per product
  function totalAllLocs(pid: number): number {
    return locations.reduce((sum, loc) => {
      const ppb = products.find(p => p.product_id === pid)?.pieces_per_box ?? 0;
      return sum + ((stockByLoc[loc.location_id] ?? {})[pid] ?? 0) + ((boxByLoc[loc.location_id] ?? {})[pid] ?? 0) * ppb;
    }, 0);
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (stockFilter !== 'all') {
        const total = totalAllLocs(p.product_id);
        if (stockFilter === 'in_stock'     && total === 0) return false;
        if (stockFilter === 'out_of_stock' && total > 0)  return false;
      }
      if (category !== 'All' && p.type !== category) return false;
      if (changedOnly && changedInPeriod && !changedInPeriod.has(p.product_id)) return false;
      if (q) {
        const hay = [p.product_name, p.brand, p.model, p.stock_keeping_unit, p.type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, category, search, stockFilter, stockByLoc, boxByLoc, locations, changedOnly, changedInPeriod]);

  const outCount = useMemo(() => visible.filter(p => {
    const ppb = p.pieces_per_box || 0;
    return ((sm[p.product_id] ?? 0) + (bm[p.product_id] ?? 0) * (ppb || 1)) === 0;
  }).length, [visible, sm, bm]);

  return (
    <div className="px-4 flex flex-col flex-1 min-h-0">
      <div className="shrink-0">
        {/* Dynamic location tabs — segmented control */}
        {fixedLocId === undefined && (
        <div className="flex gap-1 mb-4 p-1 rounded-2xl card-lux overflow-x-auto scrollbar-none">
          {locations.map(loc => (
            <button
              key={loc.location_id}
              onClick={() => setLocationId(loc.location_id)}
              className={`shrink-0 flex-1 py-2.5 px-3 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                locationId === loc.location_id
                  ? 'btn-primary'
                  : 'text-muted hover:text-slate-100 hover:bg-white/5'
              }`}
            >
              {loc.location_name}
            </button>
          ))}
        </div>
        )}

        <div className="relative mb-2">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm">📷</span>
          <input
            ref={searchRef} type="text" value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleSearchKey}
            placeholder="Scan a barcode or search products…"
            aria-label="Scan a barcode or search products"
            autoComplete="off" inputMode="text"
            className="w-full pl-9 pr-9 py-2.5 card-lux rounded-xl text-sm text-slate-100 placeholder:text-muted/60 outline-none focus:ring-2 focus:ring-teal/30 transition-all"
          />
          {search && (
            <button onClick={() => { setSearch(''); searchRef.current?.focus(); }} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg leading-none">×</button>
          )}
        </div>
        {scanMsg && (
          <div className={`mb-2 px-3 py-1.5 rounded-lg text-xs font-semibold ${scanMsg.ok ? 'bg-success/10 text-success border border-success/20' : 'bg-danger/10 text-danger border border-danger/20'}`}>
            {scanMsg.ok ? '✓ ' : '✕ '}{scanMsg.text}
          </div>
        )}

        <div className="mb-3">
          <button
            onClick={() => setHistoryOn(o => !o)}
            className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${historyOn ? 'border-teal bg-teal/10 text-teal' : 'border-white/8 bg-surface2 text-muted hover:border-white/20'}`}
          >📅 Stock on date{historyOn ? ' ✕' : ''}</button>
          {historyOn && (
            <div className="mt-2 p-3 rounded-2xl card-lux">
              <div className="flex flex-wrap items-end gap-2">
                <DayCountPicker label="From" value={histFrom} max={histTo} counts={dayCounts} onChange={setHistFrom} />
                <DayCountPicker label="To" value={histTo} min={histFrom} counts={dayCounts} onChange={setHistTo} />
                <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none pb-2.5">
                  <input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} className="accent-teal w-4 h-4" />
                  Only items that changed
                </label>
              </div>
              <p className="text-[10px] text-muted mt-2">
                {logError ? <span className="text-danger">Couldn&apos;t load stock history: {logError}</span>
                  : !changes ? 'Loading stock history…'
                  : 'Each item shows its stock here at the start of From and the end of To, with what came in and went out in between (pieces).'}
              </p>
              {histFrom < HISTORY_RELIABLE_FROM && (
                <p className="text-[10px] text-orange-500 mt-1">⚠ Stock history before {fmtYmd(HISTORY_RELIABLE_FROM)} is incomplete, so figures for earlier dates may be off.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 mb-3 scrollbar-none">
          {categories.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
                category === cat
                  ? 'border-gold bg-gold/10 text-gold'
                  : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}>
              {cat}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-muted mb-3 font-medium flex items-center flex-wrap gap-2">
          <span>{visible.length} product{visible.length !== 1 ? 's' : ''}</span>
          {outCount > 0 && <span className="text-danger">· {outCount} out of stock here</span>}
          {stockFilter !== 'all' && (
            <a href={fixedLocId !== undefined ? `/admin?loc=${fixedLocId}` : '/admin'} className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gold/10 border border-gold/30 text-gold text-[10px] font-bold hover:bg-gold/20 transition-all">
              Clear filter ✕
            </a>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 flex-1 landscape:flex-none overflow-y-auto landscape:overflow-visible min-h-0 pb-6 auto-rows-min">
        <AnimatePresence>
          {visible.length === 0 ? (
            <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center py-16 text-muted">
              <p className="text-4xl mb-3">📭</p>
              <p className="text-sm font-medium">No products found</p>
              {search && <button onClick={() => setSearch('')} className="mt-2 text-xs text-teal hover:underline">Clear search</button>}
            </motion.div>
          ) : visible.map((p, i) => (
            <AdminProductCard
              key={p.product_id}
              history={historyFor(p)}
              product={p}
              index={i}
              locationId={locationId}
              locations={locations}
              stockByLoc={stockByLoc}
              boxByLoc={boxByLoc}
              onAdjust={onAdjust}
              onEdit={onEdit}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
