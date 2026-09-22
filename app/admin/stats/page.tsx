'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { SESSION_KEY, USER_KEY, ROLE_KEY, type Supplier, type Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';

interface SupplierRow {
  product_id:    number;
  product_name:  string;
  reorder_level: number;
  stock:         number;
  lastPrice:     number | null;
  lastDate:      string | null;
  timesBought:   number;
}

function fmtKsh(n: number) {
  return 'Ksh ' + n.toLocaleString('en-KE');
}

function groupByType(list: Product[]) {
  const map = new Map<string, Product[]>();
  for (const p of list) {
    const key = p.type || 'Uncategorized';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, items]) => ({ type, items: items.slice().sort((a, b) => a.product_name.localeCompare(b.product_name)) }));
}

// Stock-totals dashboard moved off the Inventory page so it doesn't eat
// vertical space from the scrollable product list. Each card here is a
// link back to /admin?filter=… that pre-filters the inventory list to
// the matching set of products.

export default function StatsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen" />;
  return <StatsDashboard />;
}

function StatsDashboard() {
  const { products, locations, stockByLoc, boxByLoc, loading } = useProducts();

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/admin';
  }

  function totalForProduct(pid: number, ppb: number): number {
    return locations.reduce((s, l) =>
      s + ((stockByLoc[l.location_id] ?? {})[pid] ?? 0) + ((boxByLoc[l.location_id] ?? {})[pid] ?? 0) * ppb, 0);
  }

  // ── Supplier lookup: pick a supplier, see every product we've bought
  // from them, current stock, and the price we paid last time. ──────────
  const [suppliers,       setSuppliers]       = useState<Supplier[]>([]);
  const [supplierId,      setSupplierId]      = useState<number | ''>('');
  const [supplierRows,    setSupplierRows]    = useState<SupplierRow[]>([]);
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [lowOnly,         setLowOnly]         = useState(false);

  useEffect(() => {
    supabase.from('suppliers').select('supplier_id, supplier_name, phone, address, notes, active_status')
      .eq('active_status', true).order('supplier_name')
      .then(({ data }) => setSuppliers((data ?? []) as Supplier[]));
  }, []);

  useEffect(() => {
    if (supplierId === '') return;
    let cancelled = false;
    setSupplierLoading(true);
    supabase
      .from('purchase_items')
      .select('product_id, unit_price, purchases!inner(supplier_id, purchase_date)')
      .eq('purchases.supplier_id', supplierId)
      .not('product_id', 'is', null)
      .order('purchase_date', { foreignTable: 'purchases', ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) { setSupplierRows([]); setSupplierLoading(false); return; }
        // Rows arrive newest-purchase-first, so the first time we see a
        // product_id its unit_price/date IS the last price paid.
        const byProduct = new Map<number, { lastPrice: number | null; lastDate: string | null; timesBought: number }>();
        for (const row of data as unknown as { product_id: number; unit_price: number | null; purchases: { purchase_date: string | null } | null }[]) {
          const pid = row.product_id;
          const existing = byProduct.get(pid);
          if (!existing) {
            byProduct.set(pid, { lastPrice: row.unit_price, lastDate: row.purchases?.purchase_date ?? null, timesBought: 1 });
          } else {
            existing.timesBought++;
          }
        }
        const rows: SupplierRow[] = [];
        for (const [pid, agg] of byProduct) {
          const p = products.find(pp => pp.product_id === pid);
          if (!p) continue;
          rows.push({
            product_id:    pid,
            product_name:  p.product_name,
            reorder_level: p.reorder_level ?? 0,
            stock:         totalForProduct(pid, p.pieces_per_box ?? 0),
            lastPrice:     agg.lastPrice,
            lastDate:      agg.lastDate,
            timesBought:   agg.timesBought,
          });
        }
        rows.sort((a, b) => a.product_name.localeCompare(b.product_name));
        setSupplierRows(rows);
        setSupplierLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, products]);

  const visibleSupplierRows = supplierRows.filter(r => !lowOnly || r.stock <= r.reorder_level);

  // ── In-stock / out-of-stock lists, grouped by category, with a
  // checklist so an order run can pick just what it needs for the PDF —
  // leave nothing checked and the PDF includes everything in that list. ──
  const [activeList, setActiveList]     = useState<'out_of_stock' | 'in_stock'>('out_of_stock');
  const [selectedOut, setSelectedOut]   = useState<Set<number>>(new Set());
  const [selectedIn,  setSelectedIn]    = useState<Set<number>>(new Set());
  const [printReport, setPrintReport]   = useState<'in_stock' | 'out_of_stock' | null>(null);

  useEffect(() => {
    if (!printReport) return;
    const id = setTimeout(() => window.print(), 50);
    function handleAfterPrint() { setPrintReport(null); }
    window.addEventListener('afterprint', handleAfterPrint);
    return () => { clearTimeout(id); window.removeEventListener('afterprint', handleAfterPrint); };
  }, [printReport]);

  const inStockList     = products.filter(p => totalForProduct(p.product_id, p.pieces_per_box ?? 0) > 0);
  const outOfStockList  = products.filter(p => totalForProduct(p.product_id, p.pieces_per_box ?? 0) === 0);
  const inStockGroups   = groupByType(inStockList);
  const outOfStockGroups = groupByType(outOfStockList);

  const activeGroups      = activeList === 'in_stock' ? inStockGroups   : outOfStockGroups;
  const activeSelected    = activeList === 'in_stock' ? selectedIn      : selectedOut;
  const setActiveSelected = activeList === 'in_stock' ? setSelectedIn   : setSelectedOut;

  function toggleSelect(pid: number) {
    setActiveSelected(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }

  const printBaseList = printReport === 'in_stock' ? inStockList : outOfStockList;
  const printSelected = printReport === 'in_stock' ? selectedIn  : selectedOut;
  const printMatches  = printReport
    ? printBaseList.filter(p => printSelected.size === 0 || printSelected.has(p.product_id))
    : [];
  const printGroups = printReport ? groupByType(printMatches) : [];

  return (
    <div className="min-h-screen">
    <div className="print-hide">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="pt-5 pb-3">
          <h2 className="text-base font-bold text-slate-100">Reports</h2>
          <p className="text-xs text-muted mt-0.5">Check off what you need, then export a PDF — leave nothing checked to include everything in the list.</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex gap-1 p-1 rounded-2xl card-lux mb-3 w-fit">
              <button
                onClick={() => setActiveList('out_of_stock')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeList === 'out_of_stock' ? 'btn-primary' : 'text-muted hover:text-slate-100'}`}
              >Out of Stock ({outOfStockList.length})</button>
              <button
                onClick={() => setActiveList('in_stock')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeList === 'in_stock' ? 'btn-primary' : 'text-muted hover:text-slate-100'}`}
              >In Stock ({inStockList.length})</button>
            </div>

            <div className="flex items-center justify-between mb-2 gap-3">
              <p className="text-[11px] text-muted">
                {activeSelected.size > 0
                  ? `${activeSelected.size} checked — only these go in the PDF`
                  : 'Nothing checked — the PDF will include everything below'}
              </p>
              <div className="flex gap-3 shrink-0">
                <button onClick={() => setActiveSelected(new Set(activeGroups.flatMap(g => g.items.map(i => i.product_id))))} className="text-[11px] font-semibold text-teal hover:underline">Select all</button>
                <button onClick={() => setActiveSelected(new Set())} className="text-[11px] font-semibold text-muted hover:underline">Clear</button>
              </div>
            </div>

            <div className="rounded-2xl border border-white/8 divide-y divide-white/5 max-h-[60vh] overflow-y-auto mb-3">
              {activeGroups.length === 0 ? (
                <p className="text-center text-sm text-muted py-10">Nothing here.</p>
              ) : activeGroups.map(({ type, items }) => (
                <div key={type}>
                  <div className="px-3 py-1.5 bg-surface2 text-[10px] font-bold uppercase tracking-wide text-muted sticky top-0">{type} ({items.length})</div>
                  {items.map(p => {
                    const stock = totalForProduct(p.product_id, p.pieces_per_box ?? 0);
                    return (
                      <label key={p.product_id} className="flex items-center gap-3 px-3 py-2 hover:bg-white/[0.02] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeSelected.has(p.product_id)}
                          onChange={() => toggleSelect(p.product_id)}
                          className="accent-teal w-4 h-4 shrink-0"
                        />
                        <span className="flex-1 text-sm text-slate-200 truncate">{p.product_name}</span>
                        <span className="text-xs text-muted tabular-nums shrink-0">{stock}</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="flex justify-end mb-8">
              <button
                onClick={() => setPrintReport(activeList)}
                disabled={activeGroups.length === 0}
                className="px-4 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/25 transition-all disabled:opacity-40"
              >
                📄 Generate {activeList === 'in_stock' ? 'In-Stock' : 'Out-of-Stock'} PDF{activeSelected.size > 0 ? ` (${activeSelected.size})` : ' (all)'}
              </button>
            </div>
          </>
        )}

        {/* ── Supplier lookup ──────────────────────────────────────── */}
        <div className="pt-8 pb-3">
          <h2 className="text-base font-bold text-slate-100">Supplier Lookup</h2>
          <p className="text-xs text-muted mt-0.5">Pick a supplier to see everything we buy from them — current stock and the price we paid last time.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <select
            value={supplierId}
            onChange={e => setSupplierId(e.target.value ? Number(e.target.value) : '')}
            className="px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40 min-w-48"
          >
            <option value="">Select a supplier…</option>
            {suppliers.map(s => (
              <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>
            ))}
          </select>
          {supplierId !== '' && (
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
              <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} className="accent-danger w-4 h-4" />
              Low stock only
            </label>
          )}
        </div>

        {supplierId !== '' && (
          supplierLoading ? (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 rounded-full border-2 border-teal border-t-transparent animate-spin" />
            </div>
          ) : supplierRows.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">No purchases recorded from this supplier yet.</p>
          ) : visibleSupplierRows.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">Nothing from this supplier is low on stock.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-white/8">
              <table className="w-full text-xs">
                <thead className="bg-surface2 text-muted">
                  <tr>
                    <th className="text-left  px-3 py-2.5 font-semibold">Product</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Stock</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Reorder at</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Last price</th>
                    <th className="text-right px-3 py-2.5 font-semibold">Last bought</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visibleSupplierRows.map(r => {
                    const low = r.stock <= r.reorder_level;
                    return (
                      <tr key={r.product_id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2.5 text-slate-200 font-medium">{r.product_name}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${low ? 'text-danger' : 'text-slate-200'}`}>
                          {r.stock}
                          {low && <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wide bg-danger/15 text-danger px-1.5 py-0.5 rounded-full align-middle">Low</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted">{r.reorder_level}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gold font-semibold">
                          {r.lastPrice != null ? fmtKsh(r.lastPrice) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted">{r.lastDate ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </main>
    </div>

    {printReport && (
      <div className="fixed inset-0 z-200 bg-white overflow-y-auto">
        <div className="print-hide sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-gray-700">
            {printReport === 'in_stock' ? 'In-Stock Report' : 'Out-of-Stock Report'} — {printMatches.length} product{printMatches.length === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-bold hover:bg-teal-700 transition-colors">Print / Save as PDF</button>
            <button onClick={() => setPrintReport(null)} className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-bold hover:bg-gray-200 transition-colors">Close</button>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-6 py-8 text-black">
          <h1 className="text-xl font-bold mb-1">Jay Aadinath Enterprises</h1>
          <p className="text-sm text-gray-600 mb-6">
            {printReport === 'in_stock' ? 'In-Stock Products' : 'Out-of-Stock Products'} by category — {new Date().toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>

          {printGroups.length === 0 ? (
            <p className="text-sm text-gray-500">No products match.</p>
          ) : printGroups.map(({ type, items }) => (
            <div key={type} className="mb-6 break-inside-avoid">
              <h2 className="text-xs font-bold uppercase tracking-wide border-b border-gray-300 pb-1 mb-2">{type} ({items.length})</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-2 font-semibold">Product</th>
                    <th className="py-1 pr-2 font-semibold">SKU</th>
                    <th className="py-1 pr-2 font-semibold text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(p => (
                    <tr key={p.product_id} className="border-t border-gray-100">
                      <td className="py-1 pr-2">{p.product_name}{p.brand ? ` · ${p.brand}` : ''}</td>
                      <td className="py-1 pr-2 text-gray-500">{p.stock_keeping_unit || '—'}</td>
                      <td className="py-1 pr-2 text-right font-semibold">{totalForProduct(p.product_id, p.pieces_per_box ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    )}
    </div>
  );
}
