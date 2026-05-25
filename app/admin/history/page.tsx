'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { StockMovement, Product } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

const MOVEMENT_TYPES = ['ALL', 'SALE', 'TRANSFER', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'PURCHASE_IN', 'AUTO_DEDUCT', 'DAMAGED'];

const TYPE_META: Record<string, { label: string; emoji: string; color: string }> = {
  TRANSFER:         { label: 'Transfer',    emoji: '↔️',  color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  TRANSFER_TO_MAIN: { label: 'Transfer',    emoji: '↔️',  color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  TRANSFER_TO_BACK: { label: 'Transfer',    emoji: '↔️',  color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  ADJUSTMENT_IN:    { label: 'Stock In',    emoji: '➕',  color: 'text-success bg-success/10 border-success/20' },
  ADJUSTMENT_OUT:   { label: 'Stock Out',   emoji: '➖',  color: 'text-danger bg-danger/10 border-danger/20' },
  PURCHASE_IN:      { label: 'Purchase',    emoji: '🧾',  color: 'text-teal bg-teal/10 border-teal/20' },
  DAMAGED:          { label: 'Damaged',     emoji: '⚠️',  color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' },
  SALE:             { label: 'Sale',        emoji: '🛒',  color: 'text-gold bg-gold/10 border-gold/20' },
  AUTO_DEDUCT:      { label: 'Component',   emoji: '🔧',  color: 'text-muted bg-surface2 border-white/15' },
};

const LOC_NAME: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown' };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Reason strings written by logMovement are prefixed "[User] …" — pull
// the user out for display and return the rest as the clean reason.
function parseReason(raw: string | null): { user: string | null; rest: string } {
  if (!raw) return { user: null, rest: '' };
  const m = raw.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!m) return { user: null, rest: raw };
  return { user: m[1].trim(), rest: m[2].trim() };
}

function fmtKsh(n: number | null | undefined) {
  if (n == null) return '—';
  return 'Ksh ' + Number(n).toLocaleString('en-KE');
}

// Extract the actual line total written into the movement reason by
// logMovement, e.g. "Sold from Back Godown · 2 pieces @ Ksh 500 = Ksh 1,000"
// → 1000. Returns null when the reason has no price info.
function parseSaleTotal(reason: string | null): number | null {
  if (!reason) return null;
  const m = reason.match(/= Ksh ([\d,]+)/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

function HistoryDashboard() {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [search,    setSearch]    = useState('');
  const [toast,     setToast]     = useState<ToastState | null>(null);
  // Which movement row is expanded into the details panel. We allow
  // one at a time to keep the page scannable.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const toastId = useRef(0);
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined' || localStorage.getItem(SESSION_KEY) !== '1') router.replace('/admin');
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [movRes, reqRes, prodRes] = await Promise.all([
      supabase.from('stock_movements').select('*').order('id', { ascending: false }).limit(500),
      supabase.from('stock_requests').select('*').order('request_id', { ascending: false }).limit(500),
      // Load enough fields to render unit-of-measure, prices, brand,
      // model on the detail panel without a follow-up query.
      supabase.from('products').select('product_id, product_name, brand, model, unit_of_measure, display_unit, pieces_per_box, selling_price, buying_price, box_selling_price'),
    ]);

    const fromMovements: StockMovement[] = (movRes.data ?? []) as StockMovement[];
    const fromRequests: StockMovement[] = (reqRes.data ?? []).map(r => ({
      id:               r.request_id as number,
      product_id:       r.product_id as number,
      from_location_id: (r.from_location_id ?? null) as number | null,
      to_location_id:   (r.to_location_id ?? null) as number | null,
      quantity:         r.quantity as number,
      movement_type:    r.request_type as string,
      reason:           (r.notes ?? null) as string | null,
      created_at:       r.requested_at as string,
    }));
    const merged = [...fromMovements, ...fromRequests].sort((a, b) => {
      const ad = a.created_at ?? a.movement_date ?? '';
      const bd = b.created_at ?? b.movement_date ?? '';
      return bd.localeCompare(ad);
    });

    setMovements(merged);
    setProducts((prodRes.data ?? []) as Product[]);

    // Surface error only if BOTH movement sources fail; an empty result
    // from one is fine (table may not exist in this deployment).
    if (movRes.error && reqRes.error) {
      const msg = movRes.error.message + (reqRes.error ? ' / ' + reqRes.error.message : '');
      setLoadError(msg);
      setToast({ msg: 'Failed to load history: ' + msg, type: 'error', id: ++toastId.current });
    } else if (prodRes.error) {
      setLoadError(prodRes.error.message);
      setToast({ msg: 'Failed to load products: ' + prodRes.error.message, type: 'error', id: ++toastId.current });
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function productName(id: number) {
    return products.find(p => p.product_id === id)?.product_name ?? `#${id}`;
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  const filtered = movements.filter(m => {
    if (typeFilter !== 'ALL' && m.movement_type !== typeFilter) return false;
    if (search) {
      const name = productName(m.product_id).toLowerCase();
      if (!name.includes(search.toLowerCase()) && !(m.reason ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">

        <div className="pt-5 pb-3">
          <h2 className="text-base font-bold text-slate-100">Stock Movement History</h2>
          <p className="text-xs text-muted mt-0.5">{filtered.length} records</p>
        </div>

        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search product or reason..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-surface border border-white/8 text-slate-100 text-sm placeholder:text-muted/50 outline-none focus:border-teal/40"
          />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-none">
          {MOVEMENT_TYPES.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                typeFilter === t
                  ? 'bg-teal/10 border-teal/30 text-teal'
                  : 'bg-surface border-white/8 text-muted hover:text-slate-100'
              }`}
            >
              {t === 'ALL' ? 'All' : (TYPE_META[t]?.label ?? t)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-sm">No movements found</p>
            {loadError && (
              <p className="mt-3 text-xs text-danger/80 break-words px-4">{loadError}</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {filtered.map((m, i) => {
              const meta = TYPE_META[m.movement_type] ?? { label: m.movement_type, emoji: '•', color: 'text-muted bg-surface2 border-white/10' };
              const isIn         = m.movement_type === 'ADJUSTMENT_IN' || m.movement_type === 'PURCHASE_IN';
              const isTransfer   = m.movement_type === 'TRANSFER' || m.movement_type === 'TRANSFER_TO_MAIN' || m.movement_type === 'TRANSFER_TO_BACK';
              const isSale       = m.movement_type === 'SALE';
              const isAutoDeduct = m.movement_type === 'AUTO_DEDUCT';
              const isOut        = !isIn && !isTransfer;  // sales, stock-out, damaged, component deductions
              const product = products.find(p => p.product_id === m.product_id);
              const { user, rest: cleanReason } = parseReason(m.reason);
              const fromLoc = m.from_location_id ? LOC_NAME[m.from_location_id] ?? `Location #${m.from_location_id}` : null;
              const toLoc   = m.to_location_id   ? LOC_NAME[m.to_location_id]   ?? `Location #${m.to_location_id}`   : null;
              const ts = m.movement_date ?? m.created_at;
              const isExpanded = expandedId === m.id;

              // For sales: use the actual total embedded in the reason
              // string first, fall back to catalog price × qty.
              // Component auto-deductions are never revenue.
              const actualSaleTotal = isSale ? parseSaleTotal(m.reason) : null;
              const estRevenue = isSale
                ? (actualSaleTotal ?? (product?.selling_price != null ? product.selling_price * m.quantity : null))
                : null;
              const estCost = m.movement_type === 'PURCHASE_IN' && product?.buying_price
                ? product.buying_price * m.quantity
                : null;
              // Parent product name for component auto-deductions
              const parentName = isAutoDeduct
                ? cleanReason.replace(/^Auto: component of\s*/i, '').trim()
                : null;

              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.02 }}
                  onClick={() => setExpandedId(isExpanded ? null : m.id)}
                  className={`bg-surface border rounded-xl cursor-pointer transition-colors ${isExpanded ? 'border-teal/40' : 'border-white/8 hover:border-white/15'}`}
                >
                  {/* Compact summary row — always visible */}
                  <div className="p-3.5 flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-xl border flex items-center justify-center text-base shrink-0 ${meta.color}`}>
                      {meta.emoji}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-slate-100 truncate">{productName(m.product_id)}</div>
                      <div className="text-xs text-muted mt-0.5 truncate">
                        {isTransfer
                          ? `${fromLoc ?? '?'} → ${toLoc ?? '?'}`
                          : isIn
                            ? `→ ${toLoc ?? 'Unknown'}`
                            : `← ${fromLoc ?? 'Unknown'}`}
                        {isAutoDeduct && parentName
                          ? ` · used for ${parentName}`
                          : cleanReason ? ` · ${cleanReason}` : ''}
                      </div>
                      {ts && (
                        <div className="text-[10px] text-muted/60 mt-1">
                          {formatDate(ts)}
                          {user && <span className="ml-2 text-gold/80">· {user}</span>}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <div className={`text-lg font-bold ${isIn ? 'text-success' : isTransfer ? 'text-blue-400' : 'text-danger'}`}>
                        {isIn ? '+' : isTransfer ? '↔' : '−'}{m.quantity}
                      </div>
                      <span className="text-[9px] text-muted/60 mt-0.5">{isExpanded ? '▴ hide' : '▾ details'}</span>
                    </div>
                  </div>

                  {/* Expanded detail panel */}
                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        key="detail"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden border-t border-white/8"
                        onClick={e => e.stopPropagation()}
                      >
                        <div className="p-3.5 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                          <DetailRow label="Type"     value={`${meta.emoji} ${meta.label}`} />
                          <DetailRow label="Quantity" value={`${m.quantity}${product?.unit_of_measure ? ' ' + product.unit_of_measure.toLowerCase() + (m.quantity === 1 ? '' : 's') : ''}`} />
                          {fromLoc && <DetailRow label="From" value={fromLoc} />}
                          {toLoc   && <DetailRow label="To"   value={toLoc} />}
                          {!fromLoc && !isTransfer && !isIn && <DetailRow label="From" value="(not recorded)" />}
                          {!toLoc   && !isTransfer && isIn   && <DetailRow label="To"   value="(not recorded)" />}
                          {product?.brand &&  <DetailRow label="Brand" value={product.brand} />}
                          {product?.model &&  <DetailRow label="Model" value={product.model} />}
                          {product?.pieces_per_box ? (
                            <DetailRow label={`${product.display_unit || 'Bulk'} size`} value={`${product.pieces_per_box} ${(product.unit_of_measure || 'piece').toLowerCase()}s`} />
                          ) : null}
                          {!isAutoDeduct && product?.selling_price != null && (
                            <DetailRow label="Sell price" value={`${fmtKsh(product.selling_price)}${product.unit_of_measure ? ' / ' + product.unit_of_measure.toLowerCase() : ''}`} />
                          )}
                          {product?.buying_price != null && (
                            <DetailRow label="Buy price" value={`${fmtKsh(product.buying_price)}${product.unit_of_measure ? ' / ' + product.unit_of_measure.toLowerCase() : ''}`} />
                          )}
                          {estRevenue != null && (
                            <DetailRow
                              label={actualSaleTotal != null ? 'Revenue' : 'Est. revenue'}
                              value={fmtKsh(estRevenue)}
                              highlight="text-gold"
                            />
                          )}
                          {estCost != null && (
                            <DetailRow label="Est. cost" value={fmtKsh(estCost)} highlight="text-teal" />
                          )}
                          {isAutoDeduct && parentName && (
                            <DetailRow label="Parent sale" value={parentName} highlight="text-muted" />
                          )}
                          {user && <DetailRow label="By" value={user} />}
                          {ts &&   <DetailRow label="When" value={formatDate(ts)} />}
                          {cleanReason && !isAutoDeduct && (
                            <div className="col-span-2 mt-1 pt-2 border-t border-white/5">
                              <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Reason</span>
                              <p className="text-slate-300 text-xs mt-1 leading-relaxed break-words">{cleanReason}</p>
                            </div>
                          )}
                          <DetailRow label="Record #" value={String(m.id)} mono />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function DetailRow({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-muted uppercase tracking-widest">{label}</span>
      <span className={`text-xs mt-0.5 break-words ${mono ? 'font-mono' : ''} ${highlight ?? 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  );
}

export default function HistoryPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <HistoryDashboard />;
}
