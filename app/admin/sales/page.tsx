'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Sale, SaleItem } from '@/lib/types';
import { SESSION_KEY, USER_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

// ── Auth gate ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <SalesDashboard />;
}

const LOC_NAME: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown' };

function fmtKsh(n: number | null | undefined) {
  if (n == null) return '—';
  return 'Ksh ' + Number(n).toLocaleString('en-KE');
}

function fmtDayHeader(iso: string) {
  // Display as e.g. "Sat, 9 May 2026". Compares against today/yesterday
  // for friendlier labels.
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const friendly = d.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (sameDay(d, today))     return `Today · ${friendly}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${friendly}`;
  return friendly;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}

// ── Dashboard ────────────────────────────────────────────────────────────────

interface DayGroup {
  date:    string;            // YYYY-MM-DD
  sales:   Sale[];
  total:   number;
  items:   number;
}

function SalesDashboard() {
  const [sales,   setSales]   = useState<Sale[]>([]);
  const [items,   setItems]   = useState<Record<number, SaleItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [toast,   setToast]   = useState<ToastState | null>(null);
  const [expandedSaleId, setExpandedSaleId] = useState<number | null>(null);
  const [days,    setDays]    = useState<7 | 30 | 90 | 0>(30);   // 0 = all
  const toastId = useRef(0);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    let salesQuery = supabase.from('sales').select('*').order('created_at', { ascending: false });
    if (days > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      salesQuery = salesQuery.gte('sale_date', cutoff.toISOString().split('T')[0]);
    }
    const { data: salesData, error: salesErr } = await salesQuery;
    if (salesErr) {
      setError(salesErr.message);
      setLoading(false);
      return;
    }
    const salesRows = (salesData ?? []) as Sale[];
    setSales(salesRows);

    if (salesRows.length > 0) {
      const saleIds = salesRows.map(s => s.sale_id);
      const { data: itemsData } = await supabase
        .from('sale_items').select('*')
        .in('sale_id', saleIds)
        .order('id', { ascending: true });
      const map: Record<number, SaleItem[]> = {};
      for (const it of (itemsData ?? []) as SaleItem[]) {
        (map[it.sale_id] ||= []).push(it);
      }
      setItems(map);
    } else {
      setItems({});
    }
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/admin';
  }

  // Group sales by sale_date for the daily-journal layout.
  const dayGroups: DayGroup[] = useMemo(() => {
    const byDate = new Map<string, Sale[]>();
    for (const s of sales) {
      const d = s.sale_date;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(s);
    }
    return [...byDate.entries()]
      .map(([date, rows]) => ({
        date,
        sales: rows,
        total: rows.reduce((a, r) => a + (r.total_amount || 0), 0),
        items: rows.reduce((a, r) => a + (r.item_count || 0), 0),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [sales]);

  // Aggregate totals across whatever's in view.
  const overall = useMemo(() => {
    const total = sales.reduce((s, r) => s + (r.total_amount || 0), 0);
    const items = sales.reduce((s, r) => s + (r.item_count || 0), 0);
    return { total, items, count: sales.length };
  }, [sales]);

  async function voidSale(sale: Sale) {
    if (!window.confirm(`Void this sale?\n\nTotal: ${fmtKsh(sale.total_amount)}\n${sale.item_count} item(s)\n\nThis marks the sale as voided in the journal. It does NOT restock the items — adjust inventory manually if needed.`)) return;
    const { error: e } = await supabase.from('sales').update({ status: 'VOIDED' }).eq('sale_id', sale.sale_id);
    if (e) { showToast('Could not void: ' + e.message, 'error'); return; }
    showToast('Sale voided ✓', 'success');
    load();
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="pt-5 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Sales Journal</h2>
            <p className="text-xs text-muted mt-0.5">{overall.count} sale{overall.count === 1 ? '' : 's'} · {overall.items} item{overall.items === 1 ? '' : 's'} · {fmtKsh(overall.total)} total</p>
          </div>
          <div className="flex gap-1.5">
            {([[7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']] as const).map(([d, label]) => (
              <button
                key={label}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${
                  days === d
                    ? 'border-teal/40 bg-teal/10 text-teal'
                    : 'border-white/8 bg-surface text-muted hover:text-slate-100'
                }`}
              >{label}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-xl bg-danger/10 border border-danger/30 p-4 text-danger text-sm">
            <p className="font-bold mb-2">Could not load sales:</p>
            <p className="break-words">{error}</p>
            <p className="mt-3 text-xs text-muted">
              Likely the <code className="font-mono">sales</code> and <code className="font-mono">sale_items</code> tables don&apos;t exist yet. Run the SQL block at the bottom of this page&apos;s PR description in Supabase to create them.
            </p>
          </div>
        ) : dayGroups.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">🧾</div>
            <p className="text-sm">No sales recorded in this window.</p>
            <p className="text-xs mt-2 text-muted/70">Sales from the POS page will appear here grouped by day.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {dayGroups.map(g => (
              <DayBlock
                key={g.date}
                group={g}
                items={items}
                expandedSaleId={expandedSaleId}
                onToggleSale={id => setExpandedSaleId(prev => prev === id ? null : id)}
                onVoid={voidSale}
              />
            ))}
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ── Day block — header + list of sales for one date ──────────────────────────

function DayBlock({
  group, items, expandedSaleId, onToggleSale, onVoid,
}: {
  group: DayGroup;
  items: Record<number, SaleItem[]>;
  expandedSaleId: number | null;
  onToggleSale: (id: number) => void;
  onVoid: (sale: Sale) => void;
}) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-bold text-slate-100">{fmtDayHeader(group.date)}</h3>
        <span className="text-xs font-mono text-teal">{fmtKsh(group.total)} · {group.items} item{group.items === 1 ? '' : 's'} · {group.sales.length} sale{group.sales.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {group.sales.map(s => (
          <SaleCard
            key={s.sale_id}
            sale={s}
            saleItems={items[s.sale_id] ?? []}
            expanded={expandedSaleId === s.sale_id}
            onToggle={() => onToggleSale(s.sale_id)}
            onVoid={() => onVoid(s)}
          />
        ))}
      </div>
    </section>
  );
}

// ── Single-sale card with expandable item list ───────────────────────────────

function SaleCard({
  sale, saleItems, expanded, onToggle, onVoid,
}: {
  sale: Sale;
  saleItems: SaleItem[];
  expanded: boolean;
  onToggle: () => void;
  onVoid: () => void;
}) {
  const voided = sale.status === 'VOIDED';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      onClick={onToggle}
      className={`bg-surface border rounded-xl cursor-pointer transition-colors ${
        expanded ? 'border-teal/40' : voided ? 'border-danger/30 opacity-70' : 'border-white/8 hover:border-white/15'
      }`}
    >
      <div className="p-3.5 flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl border flex items-center justify-center text-base shrink-0 ${voided ? 'border-danger/30 bg-danger/10 text-danger' : 'border-teal/30 bg-teal/10 text-teal'}`}>
          {voided ? '🚫' : '🛒'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-slate-100">
            Sale #{sale.sale_id}
            {voided && <span className="ml-2 text-[10px] font-bold text-danger">VOIDED</span>}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {sale.item_count} item{sale.item_count === 1 ? '' : 's'}
            {sale.location_id != null && ` · ${LOC_NAME[sale.location_id] ?? '?'}`}
            {sale.performed_by && ` · ${sale.performed_by}`}
          </div>
          <div className="text-[10px] text-muted/60 mt-1">{fmtTime(sale.created_at)}</div>
        </div>
        <div className="flex flex-col items-end shrink-0">
          <div className={`text-lg font-bold ${voided ? 'text-muted line-through' : 'text-gold'}`}>
            {fmtKsh(sale.total_amount)}
          </div>
          <span className="text-[9px] text-muted/60 mt-0.5">{expanded ? '▴ hide' : '▾ details'}</span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-white/8"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-3.5 flex flex-col gap-2">
              {saleItems.length === 0 ? (
                <p className="text-xs text-muted">No line items recorded.</p>
              ) : saleItems.map(it => (
                <div key={it.id} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-100 truncate">{it.product_name || `#${it.product_id ?? '?'}`}</div>
                    <div className="text-[10px] text-muted mt-0.5">
                      {it.quantity} {it.unit.toLowerCase()}{it.quantity === 1 ? '' : 's'}
                      {it.unit_price != null && ` · @ ${fmtKsh(it.unit_price)}`}
                    </div>
                  </div>
                  {it.line_total != null && (
                    <span className="text-teal font-bold tabular-nums shrink-0">{fmtKsh(it.line_total)}</span>
                  )}
                </div>
              ))}

              {!voided && (
                <button
                  onClick={onVoid}
                  className="mt-2 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30 text-danger text-[11px] font-bold hover:bg-danger/20 transition-colors self-end"
                >
                  🚫 Void this sale
                </button>
              )}

              {sale.notes && (
                <div className="mt-2 pt-2 border-t border-white/5">
                  <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Notes</span>
                  <p className="text-slate-300 text-xs mt-1 break-words">{sale.notes}</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
