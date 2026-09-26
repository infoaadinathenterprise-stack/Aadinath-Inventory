'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { SESSION_KEY, USER_KEY, ROLE_KEY, type Supplier, type Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import { downloadXlsx } from '@/lib/xlsx';

// One purchase_items row flattened with its purchase's supplier/date.
interface PurchaseRecord {
  productId:    number;
  supplierKey:  string;          // 'id:<supplier_id>' or 'raw:<name>' for unlinked suppliers
  supplierName: string;
  price:        number | null;
  date:         string | null;
  purchaseId:   number;
}

// What the user types for an order line. Blank = 0 in the PDF.
interface OrderInput { price: string; qty: string }

function fmtKsh(n: number) {
  return 'Ksh ' + n.toLocaleString('en-KE');
}

function toNum(s: string | undefined): number {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) && n > 0 ? n : 0;
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

// Supabase caps a select at 1000 rows, so page through the whole table.
// The order keeps paging stable; rows that tie on every column are
// identical for our purposes anyway.
async function loadPurchaseRecords(supplierNames: Map<number, string>): Promise<PurchaseRecord[]> {
  type Row = {
    product_id: number; unit_price: number | null;
    purchases: { purchase_id: number; supplier_id: number | null; supplier_name_raw: string | null; purchase_date: string | null } | null;
  };
  const idByName = new Map(Array.from(supplierNames, ([id, name]) => [name.trim().toLowerCase(), id]));
  const PAGE = 1000;
  const out: PurchaseRecord[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('purchase_items')
      .select('product_id, unit_price, purchases!inner(purchase_id, supplier_id, supplier_name_raw, purchase_date)')
      .not('product_id', 'is', null)
      .order('purchase_id').order('product_id').order('unit_price').order('quantity')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as Row[]) {
      const pu = r.purchases;
      if (!pu) continue;
      const raw = pu.supplier_name_raw?.trim() || '';
      // A purchase with only a typed name still counts as that supplier
      // when the name matches one on file.
      const sid = pu.supplier_id ?? idByName.get(raw.toLowerCase()) ?? null;
      if (sid == null && !raw) continue;   // no supplier recorded at all
      out.push({
        productId:    r.product_id,
        supplierKey:  sid != null ? `id:${sid}` : `raw:${raw.toLowerCase()}`,
        supplierName: sid != null ? (supplierNames.get(sid) || raw || `Supplier #${sid}`) : raw,
        price:        r.unit_price,
        date:         pu.purchase_date,
        purchaseId:   pu.purchase_id,
      });
    }
    if ((data ?? []).length < PAGE) break;
  }
  // Newest purchase first, so the first record seen per product/supplier
  // is the last price paid.
  out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.purchaseId - a.purchaseId);
  return out;
}

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

  // ── Suppliers + full purchase history (last price per product/supplier) ──
  const [suppliers,       setSuppliers]       = useState<Supplier[]>([]);
  const [supplierId,      setSupplierId]      = useState<number | ''>('');
  const [records,         setRecords]         = useState<PurchaseRecord[]>([]);
  const [recordsLoading,  setRecordsLoading]  = useState(true);
  const [recordsError,    setRecordsError]    = useState<string | null>(null);
  const [lowOnly,         setLowOnly]         = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Every supplier (inactive too) for names in the history; only
      // active ones go in the picker.
      const { data } = await supabase.from('suppliers')
        .select('supplier_id, supplier_name, phone, address, notes, active_status').order('supplier_name');
      const all = (data ?? []) as Supplier[];
      if (cancelled) return;
      setSuppliers(all.filter(s => s.active_status));
      try {
        const recs = await loadPurchaseRecords(new Map(all.map(s => [s.supplier_id, s.supplier_name])));
        if (!cancelled) setRecords(recs);
      } catch (e) {
        if (!cancelled) setRecordsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRecordsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // product_id → (supplierKey → latest record), plus latest from anyone.
  const { lastBySupplier, lastAny } = useMemo(() => {
    const bySup = new Map<number, Map<string, PurchaseRecord>>();
    const any   = new Map<number, PurchaseRecord>();
    for (const r of records) {
      if (!any.has(r.productId)) any.set(r.productId, r);
      let m = bySup.get(r.productId);
      if (!m) { m = new Map(); bySup.set(r.productId, m); }
      if (!m.has(r.supplierKey)) m.set(r.supplierKey, r);
    }
    return { lastBySupplier: bySup, lastAny: any };
  }, [records]);

  const supplierActive = supplierId !== '';
  const selKey = supplierActive ? `id:${supplierId}` : '';
  const selSupplierName = suppliers.find(s => s.supplier_id === supplierId)?.supplier_name ?? null;

  // Last price for the row: from the picked supplier, else from whoever
  // we bought it from most recently.
  function lastRecord(pid: number): PurchaseRecord | undefined {
    return supplierActive ? lastBySupplier.get(pid)?.get(selKey) : lastAny.get(pid);
  }

  // ── Lists + checklist ──
  const [activeList,  setActiveList]  = useState<'out_of_stock' | 'in_stock'>('out_of_stock');
  const [selectedOut, setSelectedOut] = useState<Set<number>>(new Set());
  const [selectedIn,  setSelectedIn]  = useState<Set<number>>(new Set());
  const [orderInputs, setOrderInputs] = useState<Record<number, OrderInput>>({});
  const [printItems,  setPrintItems]  = useState<Product[] | null>(null);

  useEffect(() => {
    if (!printItems) return;
    const id = setTimeout(() => window.print(), 50);
    function handleAfterPrint() { setPrintItems(null); }
    window.addEventListener('afterprint', handleAfterPrint);
    return () => { clearTimeout(id); window.removeEventListener('afterprint', handleAfterPrint); };
  }, [printItems]);

  function setInput(pid: number, field: keyof OrderInput, value: string) {
    setOrderInputs(prev => ({ ...prev, [pid]: { ...(prev[pid] ?? { price: '', qty: '' }), [field]: value } }));
  }

  const inStockAll    = products.filter(p => totalForProduct(p.product_id, p.pieces_per_box ?? 0) > 0);
  const outOfStockAll = products.filter(p => totalForProduct(p.product_id, p.pieces_per_box ?? 0) === 0);

  const bySupplier = (list: Product[]) => supplierActive ? list.filter(p => lastBySupplier.get(p.product_id)?.has(selKey)) : list;

  const inStockList    = bySupplier(inStockAll).filter(p => !lowOnly || totalForProduct(p.product_id, p.pieces_per_box ?? 0) <= (p.reorder_level ?? 0));
  const outOfStockList = bySupplier(outOfStockAll);

  const activeItems       = activeList === 'in_stock' ? inStockList  : outOfStockList;
  const activeGroups      = groupByType(activeItems);
  const activeSelected    = activeList === 'in_stock' ? selectedIn   : selectedOut;
  const setActiveSelected = activeList === 'in_stock' ? setSelectedIn : setSelectedOut;

  function toggleSelect(pid: number) {
    setActiveSelected(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }

  // What an export contains: the checked rows, or the whole list if none.
  function orderItems(): Product[] {
    return activeItems
      .filter(p => activeSelected.size === 0 || activeSelected.has(p.product_id))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));
  }

  function generatePdf() {
    setPrintItems(orderItems());
  }

  function exportExcel() {
    const items = orderItems();
    const today = new Date();
    const dateLabel = today.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    const rows: (string | number)[][] = [
      ['Jay Aadinath Enterprises — Purchase Order'],
      [`Date: ${dateLabel}`],
      ...(selSupplierName ? [[`To: ${selSupplierName}`]] : []),
      [],
      ['Product', 'Price', 'Quantity'],
      ...items.map(p => {
        const inp = orderInputs[p.product_id];
        return [p.product_name, toNum(inp?.price), toNum(inp?.qty)];
      }),
    ];
    const headerRow = rows.findIndex(r => r[0] === 'Product');
    const safe = (selSupplierName ?? 'All suppliers').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
    downloadXlsx(`Purchase-Order-${safe}-${today.toISOString().slice(0, 10)}`, rows, {
      sheetName: 'Purchase Order',
      boldRows:  [0, headerRow],
      colWidths: [50, 14, 12],
    });
  }

  // Products in the current list that we've also bought from another
  // supplier (with a supplier picked), or from 2+ suppliers (no pick).
  const commonProducts = activeItems
    .map(p => {
      const entries = Array.from(lastBySupplier.get(p.product_id)?.values() ?? []);
      const others  = supplierActive ? entries.filter(e => e.supplierKey !== selKey) : entries;
      const show    = supplierActive ? others.length >= 1 : entries.length >= 2;
      return show ? { p, others } : null;
    })
    .filter((x): x is { p: Product; others: PurchaseRecord[] } => x !== null)
    .sort((a, b) => a.p.product_name.localeCompare(b.p.product_name));

  const busy = loading || recordsLoading;
  const inputCls = 'w-24 px-2 py-1.5 rounded-lg bg-surface2 border border-white/10 text-sm text-slate-100 text-right tabular-nums outline-none focus:border-teal/40';

  return (
    <div className="min-h-screen">
    <div className="print-hide">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="pt-5 pb-3">
          <h2 className="text-base font-bold text-slate-100">Stock Checklist</h2>
          <p className="text-xs text-muted mt-0.5">Pick a supplier, tick products, enter the new price and quantity, then generate an order PDF. Blank price or quantity prints as 0.</p>
        </div>

        {/* ── Supplier filter ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            value={supplierId}
            onChange={e => setSupplierId(e.target.value ? Number(e.target.value) : '')}
            className="px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40 min-w-48"
          >
            <option value="">All suppliers</option>
            {suppliers.map(s => (
              <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input type="checkbox" checked={lowOnly} onChange={e => setLowOnly(e.target.checked)} className="accent-danger w-4 h-4" />
            Low stock only (in-stock tab)
          </label>
        </div>

        {recordsError && (
          <p className="mb-4 text-xs text-danger">Couldn&apos;t load purchase history: {recordsError}</p>
        )}

        {busy ? (
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
                <button onClick={() => setActiveSelected(new Set(activeItems.map(i => i.product_id)))} className="text-[11px] font-semibold text-teal hover:underline">Select all</button>
                <button onClick={() => setActiveSelected(new Set())} className="text-[11px] font-semibold text-muted hover:underline">Clear</button>
              </div>
            </div>

            <div className="rounded-2xl border border-white/8 max-h-[60vh] overflow-auto mb-3">
              {activeGroups.length === 0 ? (
                <p className="text-center text-sm text-muted py-10">
                  {supplierActive ? 'Nothing from this supplier is in this list.' : 'Nothing here.'}
                </p>
              ) : (
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-muted border-b border-white/8">
                      <th className="w-10 px-3 py-2"></th>
                      <th className="px-2 py-2">Product</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">Last purchase price</th>
                      <th className="px-2 py-2 text-right whitespace-nowrap">New purchase price</th>
                      <th className="px-3 py-2 text-right">Quantity</th>
                    </tr>
                  </thead>
                  {activeGroups.map(({ type, items }) => (
                    <tbody key={type}>
                      <tr>
                        <td colSpan={5} className="px-3 py-1.5 bg-surface2 text-[10px] font-bold uppercase tracking-wide text-muted">{type} ({items.length})</td>
                      </tr>
                      {items.map(p => {
                        const stock = totalForProduct(p.product_id, p.pieces_per_box ?? 0);
                        const last  = lastRecord(p.product_id);
                        const inp   = orderInputs[p.product_id];
                        return (
                          <tr key={p.product_id} className="border-t border-white/5 hover:bg-white/[0.02]">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={activeSelected.has(p.product_id)}
                                onChange={() => toggleSelect(p.product_id)}
                                aria-label={`Select ${p.product_name}`}
                                className="accent-teal w-4 h-4 block"
                              />
                            </td>
                            <td className="px-2 py-2 cursor-pointer" onClick={() => toggleSelect(p.product_id)}>
                              <span className="block text-slate-200">{p.product_name}</span>
                              <span className="block text-[10px] text-muted">In stock: {stock}</span>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                              {last?.price != null ? (
                                <>
                                  <span className="block text-slate-300">{fmtKsh(last.price)}</span>
                                  <span className="block text-[10px] text-muted">
                                    {last.date ?? ''}{!supplierActive ? `${last.date ? ' · ' : ''}${last.supplierName}` : ''}
                                  </span>
                                </>
                              ) : <span className="text-muted">—</span>}
                            </td>
                            <td className="px-2 py-2 text-right">
                              <input
                                type="number" inputMode="decimal" min="0" placeholder="0"
                                value={inp?.price ?? ''}
                                onChange={e => setInput(p.product_id, 'price', e.target.value)}
                                onWheel={e => e.currentTarget.blur()}
                                aria-label={`New purchase price for ${p.product_name}`}
                                className={inputCls}
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <input
                                type="number" inputMode="numeric" min="0" placeholder="0"
                                value={inp?.qty ?? ''}
                                onChange={e => setInput(p.product_id, 'qty', e.target.value)}
                                onWheel={e => e.currentTarget.blur()}
                                aria-label={`Quantity for ${p.product_name}`}
                                className={inputCls}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  ))}
                </table>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 mb-8">
              <span className="text-[11px] text-muted mr-1">
                {activeSelected.size > 0 ? `${activeSelected.size} checked` : 'All in list'} · Product, Price, Quantity
              </span>
              <button
                onClick={generatePdf}
                disabled={activeItems.length === 0}
                className="px-4 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/25 transition-all disabled:opacity-40"
              >
                🖨️ Print / PDF
              </button>
              <button
                onClick={exportExcel}
                disabled={activeItems.length === 0}
                className="px-4 py-2.5 rounded-xl bg-success/10 border border-success/30 text-success text-xs font-bold hover:bg-success/20 transition-all disabled:opacity-40"
              >
                📊 Excel
              </button>
            </div>

            {/* ── Same product, other suppliers ─────────────────────── */}
            {commonProducts.length > 0 && (
              <section className="mb-8">
                <h3 className="text-sm font-bold text-slate-100">
                  {supplierActive ? `Also bought from other suppliers (${commonProducts.length})` : `Bought from more than one supplier (${commonProducts.length})`}
                </h3>
                <p className="text-[11px] text-muted mb-2">Last price paid to each supplier, for comparison.</p>
                <ul className="rounded-2xl border border-white/8 divide-y divide-white/5">
                  {commonProducts.map(({ p, others }) => {
                    const mine = supplierActive ? lastBySupplier.get(p.product_id)?.get(selKey) : undefined;
                    return (
                      <li key={p.product_id} className="px-3 py-2 text-xs text-slate-300 leading-relaxed">
                        <span className="font-semibold text-slate-100">{p.product_name}</span>
                        {mine && (
                          <span> — {selSupplierName}: {mine.price != null ? fmtKsh(mine.price) : '—'}{mine.date ? ` (${mine.date})` : ''}</span>
                        )}
                        <span className="text-muted"> {supplierActive ? '· also bought from ' : '— '}</span>
                        {others.map((o, i) => (
                          <span key={o.supplierKey}>
                            {i > 0 && <span className="text-muted"> · </span>}
                            <span className="font-medium text-slate-200">{o.supplierName}</span>
                            {' '}at <span className="text-gold tabular-nums">{o.price != null ? fmtKsh(o.price) : '—'}</span>
                            {o.date && <span className="text-muted"> ({o.date})</span>}
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>

    {printItems && (
      <div className="fixed inset-0 z-200 bg-white overflow-y-auto">
        <div className="print-hide sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-gray-700">
            Purchase Order — {printItems.length} item{printItems.length === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-bold hover:bg-teal-700 transition-colors">Print / Save as PDF</button>
            <button onClick={() => setPrintItems(null)} className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-bold hover:bg-gray-200 transition-colors">Close</button>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-6 py-8 text-black">
          <div className="flex items-start justify-between gap-4 border-b-2 border-black pb-3 mb-5">
            <div>
              <h1 className="text-xl font-bold">Jay Aadinath Enterprises</h1>
              <p className="text-sm font-semibold uppercase tracking-wide text-gray-700">Purchase Order</p>
            </div>
            <div className="text-right text-sm">
              <p>Date: {new Date().toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
              {selSupplierName && <p>To: <span className="font-semibold">{selSupplierName}</span></p>}
            </div>
          </div>

          {printItems.length === 0 ? (
            <p className="text-sm text-gray-500">No products match.</p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left border-b border-gray-400">
                  <th className="py-1.5 pr-2 font-semibold w-8">#</th>
                  <th className="py-1.5 pr-2 font-semibold">Product</th>
                  <th className="py-1.5 pr-2 font-semibold text-right">Price</th>
                  <th className="py-1.5 font-semibold text-right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {printItems.map((p, i) => {
                  const inp = orderInputs[p.product_id];
                  return (
                    <tr key={p.product_id} className="border-b border-gray-200">
                      <td className="py-1.5 pr-2 text-gray-500">{i + 1}</td>
                      <td className="py-1.5 pr-2">{p.product_name}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{fmtKsh(toNum(inp?.price))}</td>
                      <td className="py-1.5 text-right tabular-nums">{toNum(inp?.qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )}
    </div>
  );
}
