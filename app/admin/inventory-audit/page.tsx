'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { SESSION_KEY } from '@/lib/types';
import type { Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocationInfo {
  location_id:   number;
  location_name: string;
}

interface AuditRow {
  product:      Product;
  quantity:     number;   // loose pieces
  box_quantity: number;   // whole boxes
}

interface Movement {
  id:               number;
  created_at:       string;
  movement_type:    string;
  quantity:         number;
  from_location_id: number | null;
  to_location_id:   number | null;
  reason:           string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateLong(d: Date) {
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Human-readable stock string for an audit row
function stockLabel(row: AuditRow): string {
  const ppb = row.product.pieces_per_box ?? 0;
  const bx  = row.box_quantity;
  const pc  = row.quantity;
  const tot = pc + bx * ppb;

  if (ppb > 0) {
    if (bx > 0 && pc > 0) return `${bx} box${bx > 1 ? 'es' : ''} + ${pc} pc${pc > 1 ? 's' : ''}`;
    if (bx > 0)            return `${bx} box${bx > 1 ? 'es' : ''}`;
  }
  const unit = row.product.unit_of_measure?.toLowerCase() ?? 'pc';
  return `${tot} ${unit}${tot !== 1 ? 's' : ''}`;
}

// Total as a simple piece count for print table
function stockPrint(row: AuditRow): string {
  const ppb = row.product.pieces_per_box ?? 0;
  const bx  = row.box_quantity;
  const pc  = row.quantity;
  if (ppb > 0 && bx > 0) {
    if (pc > 0) return `${bx}bx + ${pc}pc`;
    return `${bx}bx`;
  }
  return String(pc + bx * (ppb || 1));
}

const MOVEMENT_META: Record<string, { label: string; emoji: string; color: string }> = {
  SALE:           { label: 'Sale',       emoji: '💰', color: 'text-danger'  },
  TRANSFER:       { label: 'Transfer',   emoji: '🔄', color: 'text-teal'   },
  ADJUSTMENT_IN:  { label: 'Adj In',     emoji: '➕', color: 'text-success' },
  ADJUSTMENT_OUT: { label: 'Adj Out',    emoji: '➖', color: 'text-gold'   },
  PURCHASE_IN:    { label: 'Purchase',   emoji: '📦', color: 'text-blue-400'},
  AUTO_DEDUCT:    { label: 'Component',  emoji: '🔧', color: 'text-muted'  },
  DAMAGED:        { label: 'Damaged',    emoji: '💔', color: 'text-danger'  },
};

// ─── Auth gate ────────────────────────────────────────────────────────────────

export default function InventoryAuditPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);

  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <InventoryAuditDashboard />;
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

function InventoryAuditDashboard() {
  const [locations,   setLocations]   = useState<LocationInfo[]>([]);
  const [locationId,  setLocationId]  = useState<number>(0);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [auditRows,   setAuditRows]   = useState<AuditRow[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [search,      setSearch]      = useState('');
  const [selected,    setSelected]    = useState<AuditRow | null>(null);
  const [history,     setHistory]     = useState<Movement[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [toast,       setToast]       = useState<ToastState | null>(null);
  const toastId = useRef(0);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  // ── Load locations + products once ───────────────────────────────────────
  useEffect(() => {
    Promise.all([
      supabase.from('products').select('*').eq('active_status', true).order('product_name'),
      supabase.from('locations').select('location_id, location_name').eq('active_status', true).order('location_id'),
    ]).then(([{ data: prods }, { data: locs }]) => {
      setAllProducts((prods ?? []) as Product[]);
      const locList = (locs ?? []) as LocationInfo[];
      setLocations(locList);
      if (locList.length > 0 && !locationId) setLocationId(locList[0].location_id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load audit rows whenever location or product list changes ─────────────
  const loadAuditRows = useCallback(async () => {
    if (allProducts.length === 0) return;
    setLoading(true);
    setSelected(null);

    const locId = locationId;
    if (!locId) return;

    try {
      // 1. All stock rows for this location (any qty, including 0)
      const { data: stockData, error: stockErr } = await supabase
        .from('stock_by_location')
        .select('product_id, quantity, box_quantity')
        .eq('location_id', locId);
      if (stockErr) throw new Error(stockErr.message);

      // 2. Products that have ever been transferred involving this location
      //    NB: actual DB column is request_type, not movement_type
      const { data: transferData, error: txErr } = await supabase
        .from('stock_requests')
        .select('product_id')
        .eq('request_type', 'TRANSFER')
        .or(`from_location_id.eq.${locId},to_location_id.eq.${locId}`);
      if (txErr) throw new Error(txErr.message);

      // Build a stock map: product_id → { quantity, box_quantity }
      const stockMap: Record<number, { quantity: number; box_quantity: number }> = {};
      for (const row of stockData ?? []) {
        stockMap[row.product_id] = {
          quantity:     row.quantity     ?? 0,
          box_quantity: row.box_quantity ?? 0,
        };
      }

      // Union of product IDs that qualify for this location:
      //   a) currently has stock > 0 at this location
      //   b) has been part of a transfer involving this location
      const qualifiedIds = new Set<number>();

      for (const row of stockData ?? []) {
        const sm = stockMap[row.product_id];
        if (sm.quantity > 0 || sm.box_quantity > 0) qualifiedIds.add(row.product_id);
      }
      for (const row of transferData ?? []) {
        if (row.product_id) qualifiedIds.add(row.product_id);
      }

      // Build sorted audit rows
      const rows: AuditRow[] = [];
      for (const pid of qualifiedIds) {
        const product = allProducts.find(p => p.product_id === pid);
        if (!product) continue;
        const stock = stockMap[pid] ?? { quantity: 0, box_quantity: 0 };
        rows.push({ product, quantity: stock.quantity, box_quantity: stock.box_quantity });
      }

      // Sort by category then name
      rows.sort((a, b) => {
        const tc = (a.product.type ?? '').localeCompare(b.product.type ?? '');
        return tc !== 0 ? tc : a.product.product_name.localeCompare(b.product.product_name);
      });

      setAuditRows(rows);
    } catch (e) {
      showToast('Failed to load audit data: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    } finally {
      setLoading(false);
    }
  }, [locationId, allProducts]);

  useEffect(() => { loadAuditRows(); }, [loadAuditRows]);

  // ── Open product history drawer ───────────────────────────────────────────
  async function openProduct(row: AuditRow) {
    setSelected(row);
    setHistLoading(true);
    setHistory([]);
    const locId = locationId;
    const { data, error } = await supabase
      .from('stock_requests')
      .select('request_id, request_type, quantity, from_location_id, to_location_id, notes, requested_at')
      .eq('product_id', row.product.product_id)
      .or(`from_location_id.eq.${locId},to_location_id.eq.${locId}`)
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) showToast('Could not load history: ' + error.message, 'error');
    // Normalise stock_requests columns → Movement interface
    const movements: Movement[] = (data ?? []).map((r) => ({
      id:               (r as Record<string,unknown>).request_id as number,
      created_at:       (r as Record<string,unknown>).requested_at as string,
      movement_type:    (r as Record<string,unknown>).request_type as string,
      quantity:         (r as Record<string,unknown>).quantity as number,
      from_location_id: (r as Record<string,unknown>).from_location_id as number | null,
      to_location_id:   (r as Record<string,unknown>).to_location_id as number | null,
      reason:           (r as Record<string,unknown>).notes as string | null,
    }));
    setHistory(movements);
    setHistLoading(false);
  }

  // ── Search filter ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return auditRows;
    return auditRows.filter(r =>
      r.product.product_name.toLowerCase().includes(q) ||
      (r.product.type  ?? '').toLowerCase().includes(q) ||
      (r.product.brand ?? '').toLowerCase().includes(q) ||
      (r.product.stock_keeping_unit ?? '').toLowerCase().includes(q)
    );
  }, [auditRows, search]);

  // ── Group by category for the grid ───────────────────────────────────────
  const groups = useMemo(() => {
    const map = new Map<string, AuditRow[]>();
    for (const row of filtered) {
      const cat = row.product.type ?? 'Uncategorised';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(row);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const locName = locations.find(l => l.location_id === locationId)?.location_name ?? 'Location';
  const today   = fmtDateLong(new Date());

  return (
    <div className="min-h-screen bg-navy">

      {/* ═══════════════════════════════════════════════════════════════════
          PRINT-ONLY AUDIT SHEET
          Hidden on screen; shows when the user hits Print / Save as PDF
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="hidden print:block">
        <style>{`
          @page { size: A4; margin: 18mm 15mm; }
          body   { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        `}</style>

        {/* Header */}
        <div style={{ fontFamily: 'Arial, sans-serif', fontSize: '12px', color: '#111' }}>
          <div style={{ textAlign: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '12px' }}>
            <p style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>Jay Aadinath Enterprises LTD</p>
            <p style={{ fontSize: '13px', margin: '3px 0 0' }}>Inventory Count Sheet — {locName}</p>
            <p style={{ fontSize: '11px', color: '#555', margin: '4px 0 0' }}>Date: {today}</p>
          </div>

          {/* Sign-off row */}
          <div style={{ display: 'flex', gap: '40px', marginBottom: '14px', fontSize: '11px' }}>
            <span>Counted by: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '160px' }}>&nbsp;</span></span>
            <span>Verified by: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '160px' }}>&nbsp;</span></span>
            <span>Signature: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '120px' }}>&nbsp;</span></span>
          </div>

          {/* Table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px' }}>
            <thead>
              <tr style={{ backgroundColor: '#e8e8e8' }}>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '28px'  }}>#</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left'                  }}>Product Name</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '100px' }}>Category</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'center',width: '100px' }}>Physical Count</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '140px' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr key={row.product.product_id}
                  style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8f8f8', pageBreakInside: 'avoid' }}>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px', color: '#666' }}>{i + 1}</td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>
                    <span style={{ fontWeight: 600 }}>{row.product.product_name}</span>
                    {row.product.brand
                      ? <span style={{ color: '#777', fontSize: '9.5px' }}> · {row.product.brand}</span>
                      : null}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px', color: '#555' }}>
                    {row.product.type ?? '—'}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>&nbsp;</td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>&nbsp;</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <p style={{ marginTop: '10px', fontSize: '10px', color: '#888' }}>
            Generated: {new Date().toLocaleString('en-KE')} &nbsp;·&nbsp;
            Location: {locName} &nbsp;·&nbsp;
            Total products: {filtered.length}
          </p>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SCREEN UI
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="print:hidden">
        <AdminNavbar onLogout={handleLogout} />

        <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-12">

          {/* ── Page header ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between pt-5 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-100">🗂️ Inventory Audit</h2>
              <p className="text-xs text-muted mt-0.5">
                {loading ? 'Loading…' : `${auditRows.length} product${auditRows.length !== 1 ? 's' : ''} · ${locName}`}
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="px-4 py-2 rounded-xl bg-gold/10 border border-gold/30 text-gold text-xs font-bold hover:bg-gold/20 transition-all flex items-center gap-2"
            >
              🖨️ Generate PDF
            </button>
          </div>

          {/* ── Location toggle (dynamic) ────────────────────────────── */}
          <div className="flex gap-2 mb-4 overflow-x-auto scrollbar-none">
            {locations.map(loc => (
              <button
                key={loc.location_id}
                onClick={() => { setLocationId(loc.location_id); setSearch(''); }}
                className={`shrink-0 flex-1 py-2.5 rounded-xl border text-sm font-bold transition-all ${
                  locationId === loc.location_id
                    ? 'border-teal bg-teal/10 text-teal'
                    : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                }`}
              >
                {loc.location_name}
              </button>
            ))}
          </div>

          {/* ── Search ──────────────────────────────────────────────────── */}
          <div className="relative mb-4">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, category, brand, SKU…"
              className="w-full pl-9 pr-4 py-2 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg"
              >×</button>
            )}
          </div>

          {/* ── Content ─────────────────────────────────────────────────── */}
          {loading ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-muted">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-sm">No products found for {locName}</p>
              {search && <p className="text-xs mt-1 text-muted/60">Try clearing the search filter</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.map(([cat, rows]) => (
                <div key={cat}>
                  {/* Category divider */}
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[10px] font-bold text-muted uppercase tracking-widest whitespace-nowrap">{cat}</span>
                    <div className="flex-1 h-px bg-white/6" />
                    <span className="text-[10px] text-muted/60">{rows.length}</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {rows.map((row, i) => {
                      const ppb   = row.product.pieces_per_box ?? 0;
                      const tot   = row.quantity + row.box_quantity * ppb;
                      const reorder = row.product.reorder_level ?? 2;
                      const stockCls =
                        tot === 0           ? 'text-danger' :
                        tot <= reorder      ? 'text-gold'   :
                                              'text-success';
                      const borderCls =
                        tot === 0           ? 'border-danger/15 hover:border-danger/30' :
                        tot <= reorder      ? 'border-gold/15 hover:border-gold/30'     :
                                              'border-white/8 hover:border-teal/20';

                      return (
                        <motion.div
                          key={row.product.product_id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(i * 0.02, 0.4) }}
                          onClick={() => openProduct(row)}
                          className={`bg-surface border rounded-xl p-4 cursor-pointer transition-all ${borderCls}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-sm text-slate-100 truncate leading-tight">
                                {row.product.product_name}
                              </p>
                              <p className="text-[11px] text-muted mt-0.5 truncate">
                                {[row.product.brand, row.product.model].filter(Boolean).join(' · ')
                                  || row.product.stock_keeping_unit
                                  || '—'}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className={`text-sm font-bold tabular-nums ${stockCls}`}>
                                {stockLabel(row)}
                              </p>
                              {ppb > 0 && row.box_quantity > 0 && (
                                <p className="text-[9px] text-muted/60 tabular-nums">
                                  = {tot} pc{tot !== 1 ? 's' : ''}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center justify-between mt-2">
                            <span className="text-[9px] text-muted/50 font-mono">
                              {row.product.stock_keeping_unit || ''}
                            </span>
                            <span className="text-[9px] text-muted/50 flex items-center gap-1">
                              View history →
                            </span>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>

        {/* ── Product history drawer ───────────────────────────────────── */}
        <AnimatePresence>
          {selected && (
            <>
              <motion.div
                key="hist-bd"
                className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setSelected(null)}
              />
              <motion.div
                key="hist-panel"
                className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[88vh] overflow-y-auto"
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
              >
                <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />

                {/* Drawer header */}
                <div className="flex items-start justify-between mb-1">
                  <div className="flex-1 min-w-0 mr-3">
                    <h3 className="font-bold text-slate-100 text-sm leading-snug">
                      {selected.product.product_name}
                    </h3>
                    <p className="text-[11px] text-muted mt-0.5">
                      {selected.product.type ?? '—'}
                      {selected.product.brand ? ` · ${selected.product.brand}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="text-muted hover:text-slate-100 text-xl shrink-0 transition-colors"
                  >×</button>
                </div>

                {/* Current stock summary card */}
                <div className="bg-surface2 rounded-xl px-4 py-3 mb-4 flex items-center justify-between border border-white/8">
                  <div>
                    <p className="text-[10px] font-bold text-muted uppercase tracking-widest">{locName} · Current Stock</p>
                    <p className={`text-lg font-bold tabular-nums mt-0.5 ${
                      (selected.quantity + selected.box_quantity * (selected.product.pieces_per_box ?? 0)) === 0
                        ? 'text-danger' : 'text-teal'
                    }`}>
                      {stockLabel(selected)}
                    </p>
                  </div>
                  {selected.product.pieces_per_box && selected.product.pieces_per_box > 0 && selected.box_quantity > 0 && (
                    <div className="text-right">
                      <p className="text-[10px] text-muted">Boxes</p>
                      <p className="text-base font-bold text-gold tabular-nums">{selected.box_quantity}</p>
                      <p className="text-[10px] text-muted">Loose</p>
                      <p className="text-base font-bold text-slate-300 tabular-nums">{selected.quantity}</p>
                    </div>
                  )}
                </div>

                {/* History list */}
                <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-3">
                  Movement History at {locName}
                </div>

                {histLoading ? (
                  <div className="flex justify-center py-10">
                    <div className="w-6 h-6 rounded-full border-2 border-teal border-t-transparent animate-spin" />
                  </div>
                ) : history.length === 0 ? (
                  <div className="text-center py-10">
                    <p className="text-muted text-sm">No movements found for this location</p>
                    <p className="text-muted/60 text-xs mt-1">This product may have been added directly to stock without a movement record</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {history.map(mov => {
                      const meta = MOVEMENT_META[mov.movement_type] ?? {
                        label: mov.movement_type, emoji: '📝', color: 'text-muted',
                      };
                      // Direction label relative to the current location
                      const isIn  = mov.to_location_id   === locationId;
                      const isOut = mov.from_location_id === locationId;
                      const dirLabel =
                        isIn && isOut  ? '↔ Both'  :
                        isIn           ? '↓ In'    :
                        isOut          ? '↑ Out'   : '';
                      const dirColor =
                        isIn && isOut  ? 'text-muted'   :
                        isIn           ? 'text-success' :
                                         'text-danger';
                      return (
                        <div key={mov.id}
                          className="bg-surface2 rounded-xl px-3 py-2.5 border border-white/5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-base">{meta.emoji}</span>
                              <div>
                                <span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span>
                                {dirLabel && (
                                  <span className={`text-[10px] font-bold ml-2 ${dirColor}`}>{dirLabel}</span>
                                )}
                              </div>
                            </div>
                            <span className="text-sm font-bold text-slate-200 tabular-nums">
                              {mov.quantity}
                            </span>
                          </div>
                          {mov.reason && (
                            <p className="text-[10px] text-muted mt-1 line-clamp-2">{mov.reason}</p>
                          )}
                          <p className="text-[10px] text-muted/50 mt-0.5">
                            {fmtDateTime(mov.created_at)}
                          </p>
                        </div>
                      );
                    })}

                    {history.length >= 200 && (
                      <p className="text-[10px] text-muted/60 text-center py-2">
                        Showing last 200 movements
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
