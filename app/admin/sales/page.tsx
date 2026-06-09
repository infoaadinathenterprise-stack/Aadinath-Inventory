'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Sale, SaleItem, Withdrawal } from '@/lib/types';
import { SESSION_KEY, USER_KEY, ROLE_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

// ── Auth gate ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <SalesDashboard />;
}

let LOC_NAME: Record<number, string> = { 1: 'Back Godown', 2: 'Main Store', 3: 'Main Store First Floor' };
const DASH = '—';

function fmtKsh(n: number | null | undefined) {
  if (n == null) return DASH;
  return 'Ksh ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
}

function fmtSignedKsh(n: number) {
  const sign = n < 0 ? '−' : '';
  return sign + 'Ksh ' + Math.abs(n).toLocaleString('en-KE', { maximumFractionDigits: 2 });
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function fmtDay(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const friendly = d.toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (sameDay(d, today))     return `Today · ${friendly}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${friendly}`;
  return friendly;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function SalesDashboard() {
  const [day,         setDay]         = useState<string>(todayISO());
  const [sales,       setSales]       = useState<Sale[]>([]);
  const [items,       setItems]       = useState<Record<number, SaleItem[]>>({});
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  // Map of product_id → current buying_price, used to back-fill the
  // cost column for sales saved before the Purchases page started
  // pushing buying_price into products. Live value, not snapshot — if
  // the user updates a buying price later, past sales' profit
  // numbers will reflect the new cost.
  const [buyMap,      setBuyMap]      = useState<Record<number, number>>({});
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [toast,       setToast]       = useState<ToastState | null>(null);
  const [expandedSaleId, setExpandedSaleId] = useState<number | null>(null);
  const [wOpen,       setWOpen]       = useState(false);
  const [wAmount,     setWAmount]     = useState('');
  const [wReason,     setWReason]     = useState('');
  const [wSaving,     setWSaving]     = useState(false);
  const toastId = useRef(0);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [salesRes, withdrawRes, locRes] = await Promise.all([
      supabase.from('sales').select('*').eq('sale_date', day).order('created_at', { ascending: false }),
      supabase.from('withdrawals').select('*').eq('withdrawal_date', day).order('created_at', { ascending: false }),
      supabase.from('locations').select('location_id, location_name'),
    ]);
    for (const loc of locRes.data ?? []) {
      LOC_NAME[loc.location_id as number] = loc.location_name as string;
    }

    if (salesRes.error) {
      setError('Sales: ' + salesRes.error.message);
      setLoading(false);
      return;
    }
    // Withdrawals table may not exist yet — soft-fail so the sales
    // section still renders even before the user runs the SQL.
    if (withdrawRes.error) {
      setWithdrawals([]);
    } else {
      setWithdrawals((withdrawRes.data ?? []) as Withdrawal[]);
    }

    const salesRows = (salesRes.data ?? []) as Sale[];
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

      // Fetch current buying prices for every product referenced by
      // these sales — used as a fallback when sale_items.cost_price
      // wasn't snapshotted (older sales / pre-migration data).
      const productIds = Array.from(new Set(
        (itemsData ?? [])
          .map(it => (it as SaleItem).product_id)
          .filter((id): id is number => id != null),
      ));
      if (productIds.length > 0) {
        const { data: prods } = await supabase
          .from('products')
          .select('product_id, buying_price')
          .in('product_id', productIds);
        const bm: Record<number, number> = {};
        for (const p of (prods ?? []) as { product_id: number; buying_price: number | null }[]) {
          if (p.buying_price != null) bm[p.product_id] = p.buying_price;
        }
        setBuyMap(bm);
      } else {
        setBuyMap({});
      }
    } else {
      setItems({});
      setBuyMap({});
    }
    setLoading(false);
  }, [day]);
  useEffect(() => { load(); }, [load]);

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/admin';
  }

  // Aggregate the day. Profit is computed only on lines where BOTH
  // sell + cost are set; otherwise the line is "incomplete" and we
  // surface that in the UI so the user knows where to fill in prices.
  //
  // Fallback: if a sale has no sale_items rows at all (older saves
  // before the cost_price migration, or a failed item insert), use
  // the sale's stored total_amount + item_count so the revenue card
  // doesn't read "—" when there's clearly a sale with a price.
  const summary = useMemo(() => {
    let revenue   = 0;
    let cost      = 0;
    let qtySold   = 0;
    let knownLines    = 0;
    let totalLines    = 0;
    let voidedSales   = 0;
    let salesNoItems  = 0;  // sales without line items — counted as "incomplete" for profit

    for (const s of sales) {
      if (s.status === 'VOIDED') { voidedSales++; continue; }
      const its = items[s.sale_id] ?? [];
      if (its.length === 0) {
        // No line items found — fall back to the sales row totals so
        // revenue reflects this sale. Profit can't be computed without
        // the line breakdown, so it stays incomplete.
        if (s.total_amount) {
          revenue += s.total_amount;
          qtySold += s.item_count;
          totalLines += Math.max(s.item_count, 1);
          salesNoItems++;
        }
        continue;
      }
      for (const it of its) {
        totalLines++;
        qtySold += it.quantity;
        if (it.unit_price != null) revenue += it.unit_price * it.quantity;
        // Cost preference: snapshot on the line (most accurate at time
        // of sale) → fall back to the product's current buying_price
        // when the snapshot is missing.
        const effectiveCost = it.cost_price ?? (it.product_id != null ? buyMap[it.product_id] : null) ?? null;
        if (it.unit_price != null && effectiveCost != null) {
          knownLines++;
          cost += effectiveCost * it.quantity;
        }
      }
    }
    const withdrawTotal = withdrawals.reduce((s, w) => s + (w.amount || 0), 0);
    const profit = (knownLines === totalLines && totalLines > 0) ? revenue - cost : null;
    const netCash = revenue - withdrawTotal;

    return { revenue, cost, profit, qtySold, knownLines, totalLines, voidedSales, salesNoItems, withdrawTotal, netCash };
  }, [sales, items, withdrawals, buyMap]);

  async function addWithdrawal() {
    const amt = parseFloat(wAmount);
    if (!amt || amt <= 0) { showToast('Enter a positive amount', 'error'); return; }
    setWSaving(true);
    const { error: e } = await supabase.from('withdrawals').insert({
      withdrawal_date: day,
      amount:          amt,
      reason:          wReason.trim() || null,
      performed_by:    (typeof window !== 'undefined' && localStorage.getItem(USER_KEY)) || 'Admin',
    });
    setWSaving(false);
    if (e) { showToast('Could not record: ' + e.message, 'error'); return; }
    setWAmount(''); setWReason(''); setWOpen(false);
    load();
    showToast('Withdrawal recorded ✓', 'success');
  }

  async function deleteWithdrawal(id: number) {
    if (!window.confirm('Delete this withdrawal?')) return;
    const { error: e, data } = await supabase.from('withdrawals').delete().eq('withdrawal_id', id).select();
    if (e) { showToast('Could not delete: ' + e.message, 'error'); return; }
    if (!data || data.length === 0) {
      showToast('Delete blocked by RLS — run: CREATE POLICY "Allow public delete" ON withdrawals FOR DELETE TO anon USING (true);', 'error');
      return;
    }
    load();
  }

  async function voidSale(sale: Sale) {
    if (!window.confirm(`Void this sale?\n\nTotal: ${fmtKsh(sale.total_amount)}\n${sale.item_count} item(s)\n\nThis marks the sale as voided in the journal. It does NOT restock the items — adjust inventory manually if needed.`)) return;
    const { error: e } = await supabase.from('sales').update({ status: 'VOIDED' }).eq('sale_id', sale.sale_id);
    if (e) { showToast('Could not void: ' + e.message, 'error'); return; }
    showToast('Sale voided ✓', 'success');
    load();
  }

  // Step the day picker by N days.
  function shiftDay(deltaDays: number) {
    const d = new Date(day + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    setDay(d.toISOString().split('T')[0]);
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">

        {/* ── Day picker strip ── */}
        <div className="pt-5 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Sales · {fmtDay(day)}</h2>
            <p className="text-xs text-muted mt-0.5">
              {sales.length} sale{sales.length === 1 ? '' : 's'}
              {summary.voidedSales > 0 && ` · ${summary.voidedSales} voided`}
              {' · '}{summary.qtySold} item{summary.qtySold === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => shiftDay(-1)} className="w-8 h-8 rounded-lg border border-white/8 bg-surface2 text-slate-200 text-sm hover:border-teal/30">‹</button>
            <input
              type="date"
              value={day}
              max={todayISO()}
              onChange={e => setDay(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-white/8 bg-surface2 text-slate-100 text-xs font-bold outline-none focus:border-teal/40"
            />
            <button onClick={() => shiftDay(1)} disabled={day >= todayISO()} className="w-8 h-8 rounded-lg border border-white/8 bg-surface2 text-slate-200 text-sm hover:border-teal/30 disabled:opacity-30 disabled:cursor-not-allowed">›</button>
            <button onClick={() => setDay(todayISO())} className="px-3 py-1.5 rounded-lg border border-teal/30 bg-teal/10 text-teal text-[11px] font-bold hover:bg-teal/20">Today</button>
          </div>
        </div>

        {/* ── Day summary card ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
          <SummaryCell label="Revenue"      value={summary.revenue > 0 ? fmtKsh(summary.revenue) : DASH} tone="teal" />
          <SummaryCell label="Cost"         value={summary.totalLines === 0 ? DASH : (summary.knownLines === summary.totalLines ? fmtKsh(summary.cost) : `${fmtKsh(summary.cost)} (partial)`)} tone="muted" />
          <SummaryCell
            label="Profit / Loss"
            value={summary.profit == null ? DASH : fmtSignedKsh(summary.profit)}
            tone={summary.profit == null ? 'muted' : summary.profit >= 0 ? 'success' : 'danger'}
            sub={summary.profit == null && summary.totalLines > 0 ? `Add prices on ${summary.totalLines - summary.knownLines} line${summary.totalLines - summary.knownLines === 1 ? '' : 's'}` : undefined}
          />
          <SummaryCell label="Withdrawals" value={summary.withdrawTotal > 0 ? fmtKsh(summary.withdrawTotal) : DASH} tone="gold" />
          <SummaryCell label="Net cash"    value={summary.revenue === 0 && summary.withdrawTotal === 0 ? DASH : fmtSignedKsh(summary.netCash)} tone={summary.netCash >= 0 ? 'success' : 'danger'} sub="Revenue − Withdrawals" />
        </div>

        {/* ── Withdrawals strip ── */}
        <div className="mb-4 rounded-xl bg-surface border border-white/8 p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest">💸 Withdrawals · {withdrawals.length}</h3>
            <button
              onClick={() => setWOpen(o => !o)}
              className="px-3 py-1.5 rounded-lg bg-gold/10 border border-gold/30 text-gold text-[11px] font-bold hover:bg-gold/20 transition-colors"
            >{wOpen ? '× Cancel' : '+ Add'}</button>
          </div>

          <AnimatePresence initial={false}>
            {wOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden mb-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 items-end pt-1">
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Amount (Ksh)</label>
                    <input
                      type="number" min={0} step="0.01" value={wAmount}
                      onChange={e => setWAmount(e.target.value)}
                      onWheel={e => e.currentTarget.blur()}
                      placeholder="0.00"
                      className="w-full px-3 py-2 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-sm outline-none focus:border-gold/40"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Reason (optional)</label>
                    <input
                      value={wReason} onChange={e => setWReason(e.target.value)}
                      placeholder="e.g. supplier payment, salary, owner take"
                      className="w-full px-3 py-2 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-sm outline-none focus:border-gold/40"
                    />
                  </div>
                  <button
                    onClick={addWithdrawal}
                    disabled={wSaving || !wAmount}
                    className="px-4 py-2 rounded-lg bg-gold/15 border border-gold/30 text-gold text-xs font-bold disabled:opacity-50 hover:bg-gold/25"
                  >{wSaving ? 'Saving…' : 'Record'}</button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {withdrawals.length === 0 ? (
            <p className="text-xs text-muted/70">No withdrawals recorded for this day.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {withdrawals.map(w => (
                <div key={w.withdrawal_id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface2 border border-white/5 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="text-slate-200 font-semibold">{w.reason || 'Cash out'}</div>
                    <div className="text-[10px] text-muted/70">{fmtTime(w.created_at)}{w.performed_by ? ' · ' + w.performed_by : ''}</div>
                  </div>
                  <span className="font-bold text-gold tabular-nums">{fmtKsh(w.amount)}</span>
                  <button onClick={() => deleteWithdrawal(w.withdrawal_id)} className="text-muted hover:text-danger text-sm">×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Sales list ── */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-xl bg-danger/10 border border-danger/30 p-4 text-danger text-sm">
            <p className="font-bold mb-2">Could not load sales:</p>
            <p className="break-words">{error}</p>
            <p className="mt-3 text-xs text-muted">
              If the message mentions <code className="font-mono">sales</code> or <code className="font-mono">withdrawals</code>, run the SQL block from the latest commit description in Supabase to create the missing tables/columns.
            </p>
          </div>
        ) : sales.length === 0 ? (
          <div className="text-center py-16 text-muted">
            <div className="text-4xl mb-3">🧾</div>
            <p className="text-sm">No sales for this day.</p>
            <p className="text-xs mt-2 text-muted/70">Pick a different date or head to POS to record one.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {sales.map(s => (
              <SaleCard
                key={s.sale_id}
                sale={s}
                saleItems={items[s.sale_id] ?? []}
                buyMap={buyMap}
                expanded={expandedSaleId === s.sale_id}
                onToggle={() => setExpandedSaleId(prev => prev === s.sale_id ? null : s.sale_id)}
                onVoid={() => voidSale(s)}
              />
            ))}
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ── Summary cell ─────────────────────────────────────────────────────────────

function SummaryCell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'teal' | 'gold' | 'success' | 'danger' | 'muted' }) {
  const colorMap: Record<typeof tone, string> = {
    teal:    'text-teal',
    gold:    'text-gold',
    success: 'text-success',
    danger:  'text-danger',
    muted:   'text-slate-200',
  };
  return (
    <div className="rounded-xl bg-surface border border-white/8 p-3">
      <div className="text-[10px] font-bold text-muted uppercase tracking-widest">{label}</div>
      <div className={`text-base font-bold tabular-nums mt-1 ${colorMap[tone]}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Single sale card ─────────────────────────────────────────────────────────

function SaleCard({
  sale, saleItems, buyMap, expanded, onToggle, onVoid,
}: {
  sale: Sale;
  saleItems: SaleItem[];
  buyMap: Record<number, number>;
  expanded: boolean;
  onToggle: () => void;
  onVoid: () => void;
}) {
  const voided = sale.status === 'VOIDED';

  // Effective cost per line: snapshot on the row first, then the
  // product's current buying_price (so sales saved before the
  // Purchases page started populating buying_price still get a cost
  // figure as soon as the user records the buy).
  const effectiveCost = (it: SaleItem): number | null =>
    it.cost_price ?? (it.product_id != null ? (buyMap[it.product_id] ?? null) : null);

  // Line-level profit summary for the collapsed view.
  let lineRevenue = 0, lineCost = 0, knownLines = 0;
  for (const it of saleItems) {
    if (it.unit_price != null) lineRevenue += it.unit_price * it.quantity;
    const ec = effectiveCost(it);
    if (it.unit_price != null && ec != null) { knownLines++; lineCost += ec * it.quantity; }
  }
  const cardProfit = knownLines === saleItems.length && saleItems.length > 0 ? lineRevenue - lineCost : null;

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
          {!voided && cardProfit != null && (
            <div className={`text-[10px] font-mono mt-0.5 ${cardProfit >= 0 ? 'text-success' : 'text-danger'}`}>
              {cardProfit >= 0 ? '+' : '−'}{fmtKsh(Math.abs(cardProfit)).replace('Ksh ', 'Ksh ')}
            </div>
          )}
          <span className="text-[9px] text-muted/60 mt-0.5">{expanded ? '▴ hide' : '▾ details'}</span>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-white/8"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-3.5">
              {/* Line-items table */}
              <div className="grid grid-cols-[1fr_60px_75px_75px_75px] gap-2 text-[10px] font-bold text-muted uppercase tracking-widest pb-2 border-b border-white/5">
                <span>Item</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Buy</span>
                <span className="text-right">Sell</span>
                <span className="text-right">Profit</span>
              </div>
              {saleItems.length === 0 ? (
                <div className="py-2 px-3 mt-2 rounded-lg bg-gold/5 border border-gold/20 text-xs text-gold/90">
                  <p className="font-bold mb-1">No line items recorded for this sale.</p>
                  <p className="text-[11px] text-muted/80 leading-relaxed">
                    Likely the <code className="font-mono text-gold">sale_items</code> table is missing the <code className="font-mono text-gold">cost_price</code> column.
                    Run this SQL in Supabase to enable line-item + profit tracking on future sales:
                  </p>
                  <pre className="mt-2 text-[10px] bg-navy/60 border border-white/8 rounded p-2 overflow-x-auto text-slate-300 font-mono">
ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS cost_price numeric(12, 2);
                  </pre>
                </div>
              ) : saleItems.map(it => {
                const ec = effectiveCost(it);
                const sellLine = it.unit_price != null ? it.unit_price * it.quantity : null;
                const costLine = ec != null ? ec * it.quantity : null;
                const profit = sellLine != null && costLine != null ? sellLine - costLine : null;
                // Asterisk when the cost came from the catalog fallback
                // (sale_items.cost_price was null but product.buying_price
                // is set) — gives the user a visual cue this row was
                // back-filled from current data, not the at-sale snapshot.
                const costFromFallback = it.cost_price == null && ec != null;
                return (
                  <div key={it.id} className="grid grid-cols-[1fr_60px_75px_75px_75px] gap-2 py-2 border-b border-white/5 last:border-0 text-xs items-start">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-100 truncate">{it.product_name || `#${it.product_id ?? '?'}`}</div>
                      <div className="text-[10px] text-muted/70">{it.unit.toLowerCase()}</div>
                    </div>
                    <span className="text-right text-slate-200 tabular-nums">{it.quantity}</span>
                    <span className="text-right tabular-nums text-muted" title={costFromFallback ? 'From current catalog buying price' : 'Snapshot at time of sale'}>
                      {ec != null ? fmtKsh(ec) + (costFromFallback ? '*' : '') : DASH}
                    </span>
                    <span className="text-right tabular-nums text-teal">{it.unit_price != null ? fmtKsh(it.unit_price) : DASH}</span>
                    <span className={`text-right tabular-nums font-bold ${profit == null ? 'text-muted' : profit >= 0 ? 'text-success' : 'text-danger'}`}>
                      {profit == null ? DASH : (profit >= 0 ? '+' : '−') + fmtKsh(Math.abs(profit))}
                    </span>
                  </div>
                );
              })}

              {/* Totals row */}
              <div className="grid grid-cols-[1fr_60px_75px_75px_75px] gap-2 pt-2 mt-1 border-t border-white/8 text-xs font-bold items-center">
                <span className="text-slate-100">Total</span>
                <span className="text-right text-slate-200 tabular-nums">{saleItems.reduce((s, i) => s + i.quantity, 0)}</span>
                <span className="text-right tabular-nums text-muted">{knownLines > 0 ? fmtKsh(lineCost) : DASH}</span>
                <span className="text-right tabular-nums text-teal">{lineRevenue > 0 ? fmtKsh(lineRevenue) : DASH}</span>
                <span className={`text-right tabular-nums ${cardProfit == null ? 'text-muted' : cardProfit >= 0 ? 'text-success' : 'text-danger'}`}>
                  {cardProfit == null ? DASH : (cardProfit >= 0 ? '+' : '−') + fmtKsh(Math.abs(cardProfit))}
                </span>
              </div>

              {!voided && (
                <button
                  onClick={onVoid}
                  className="mt-3 px-3 py-1.5 rounded-lg bg-danger/10 border border-danger/30 text-danger text-[11px] font-bold hover:bg-danger/20 transition-colors"
                >🚫 Void this sale</button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
