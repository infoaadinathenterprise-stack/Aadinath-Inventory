'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { SESSION_KEY, USER_KEY, ROLE_KEY, type Supplier, type Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import { downloadXlsx } from '@/lib/xlsx';
import { openOrderPdf, type OrderLine, type SavedOrder } from '@/lib/orderPdf';

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
  const { products, locations, stockByLoc, boxByLoc, loading, refresh } = useProducts();

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

  // Products typed in on this page have no purchase history yet, so they
  // stay visible whichever supplier is picked.
  const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
  const bySupplier = (list: Product[]) => supplierActive
    ? list.filter(p => addedIds.has(p.product_id) || lastBySupplier.get(p.product_id)?.has(selKey))
    : list;

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

  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  // ── Add a product that isn't in the database yet ──
  // Saved with just its name; the rest (type, brand, prices) is filled in
  // later from the inventory tab, which also generates its SKU. `type` is
  // required, so it starts as a placeholder group until then.
  const [newName, setNewName] = useState('');
  const [adding,  setAdding]  = useState(false);

  async function addManualProduct() {
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const existing = products.find(p => p.product_name.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      const inStock = totalForProduct(existing.product_id, existing.pieces_per_box ?? 0) > 0;
      setActiveList(inStock ? 'in_stock' : 'out_of_stock');
      (inStock ? setSelectedIn : setSelectedOut)(prev => new Set(prev).add(existing.product_id));
      setAddedIds(prev => new Set(prev).add(existing.product_id));
      setNewName('');
      setNotice({ text: `"${existing.product_name}" is already on file — ticked it for you.` });
      return;
    }
    setAdding(true);
    const { data, error } = await supabase.from('products')
      .insert({ product_name: name, type: 'New Product', unit_of_measure: 'Piece', unit_type: 'piece', reorder_level: 0, active_status: true })
      .select('product_id').single();
    setAdding(false);
    if (error || !data) { setNotice({ text: `Couldn't add "${name}": ${error?.message ?? 'no row returned'}`, error: true }); return; }
    const pid = (data as { product_id: number }).product_id;
    setAddedIds(prev => new Set(prev).add(pid));
    setSelectedOut(prev => new Set(prev).add(pid));
    setActiveList('out_of_stock');
    setNewName('');
    refresh();
    setNotice({ text: `Added "${name}". Fill in its details from the inventory tab later to give it a SKU.` });
  }

  // ── Place order: save it, then show its PDF ──
  const [placing, setPlacing] = useState(false);

  async function placeOrder() {
    const items = activeItems
      .filter(p => activeSelected.has(p.product_id))
      .sort((a, b) => a.product_name.localeCompare(b.product_name));
    if (items.length === 0) { setNotice({ text: 'Tick the products to order first.', error: true }); return; }
    const lines: OrderLine[] = items.map(p => ({
      product_id:   p.product_id,
      product_name: p.product_name,
      price:        toNum(orderInputs[p.product_id]?.price),
      qty:          toNum(orderInputs[p.product_id]?.qty),
    }));
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const pdfWin = window.open('', '_blank');
    setPlacing(true);
    const { data, error } = await supabase.from('purchase_orders').insert({
      supplier_id:   supplierActive ? supplierId : null,
      supplier_name: selSupplierName,
      created_by:    localStorage.getItem(USER_KEY),
      items:         lines,
      total_amount:  total,
    }).select('*').single();
    setPlacing(false);
    if (error || !data) {
      pdfWin?.close();
      setNotice({ text: `Couldn't save the order: ${error?.message ?? 'no row returned'}`, error: true });
      return;
    }
    const order = data as SavedOrder;
    setOrders(prev => prev ? [order, ...prev] : prev);
    setActiveSelected(new Set());
    setOrderInputs(prev => {
      const next = { ...prev };
      for (const p of items) delete next[p.product_id];
      return next;
    });
    setNotice({ text: `Order ${order.order_no} saved.` });
    await openOrderPdf(order, pdfWin);
  }

  // ── Previous orders ──
  const [ordersOpen,  setOrdersOpen]  = useState(false);
  const [orders,      setOrders]      = useState<SavedOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderSearch, setOrderSearch] = useState('');
  const [orderFrom,   setOrderFrom]   = useState('');   // yyyy-mm-dd, inclusive
  const [orderTo,     setOrderTo]     = useState('');

  // The date range is applied in the query, so it reaches past the newest
  // 500 orders when looking further back.
  async function loadOrders(from: string, to: string) {
    setOrders(null);
    setOrdersError(null);
    let q = supabase.from('purchase_orders').select('*');
    if (from) q = q.gte('order_date', from);
    if (to)   q = q.lte('order_date', to);
    const { data, error } = await q.order('order_id', { ascending: false }).limit(500);
    if (error) { setOrdersError(error.message); return; }
    setOrders((data ?? []) as SavedOrder[]);
  }

  function openPreviousOrders() {
    setOrdersOpen(true);
    loadOrders(orderFrom, orderTo);
  }

  function setOrderRange(from: string, to: string) {
    setOrderFrom(from);
    setOrderTo(to);
    loadOrders(from, to);
  }

  const orderQuery = orderSearch.trim().toLowerCase();
  const visibleOrders = (orders ?? []).filter(o => !orderQuery
    || o.order_no.toLowerCase().includes(orderQuery)
    || o.order_no.replace(/^PO-0*/i, '') === orderQuery.replace(/^(po-?)?0*/i, '')
    || (o.supplier_name ?? '').toLowerCase().includes(orderQuery));
  const visibleOrdersTotal = visibleOrders.reduce((s, o) => s + Number(o.total_amount), 0);

  // ── Last time each product's stock changed (for the out-of-stock list) ──
  // Taken from the stock movement history (sales, purchases, transfers,
  // adjustments), newest first, so the first movement seen per product is
  // its latest. stock_by_location.updated_at isn't usable: the company
  // merge (10_merge_companies.sql) re-stamped every row. Products with no
  // movements fall back to when they were created.
  const [stockChangedAt, setStockChangedAt] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const PAGE = 1000;
      const latest = new Map<number, string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('stock_movements')
          .select('product_id, movement_at')
          .not('movement_at', 'is', null)
          .order('movement_id', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error || cancelled) return;
        for (const r of (data ?? []) as { product_id: number; movement_at: string }[]) {
          if (!latest.has(r.product_id)) latest.set(r.product_id, r.movement_at);
        }
        if ((data ?? []).length < PAGE) break;
      }
      if (!cancelled) setStockChangedAt(latest);
    })();
    return () => { cancelled = true; };
  }, []);

  function lastChanged(p: Product): string | null {
    const iso = stockChangedAt.get(p.product_id) ?? (p as Product & { created_at?: string | null }).created_at ?? null;
    if (!iso) return null;
    return new Date(iso).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── Running total for the order being built ──
  // Covers the checked rows, or the whole list when nothing is checked —
  // the same rows Print / Excel export.
  const totalRows = activeItems.filter(p => activeSelected.size === 0 || activeSelected.has(p.product_id));
  const totalQty    = totalRows.reduce((s, p) => s + toNum(orderInputs[p.product_id]?.qty), 0);
  const totalAmount = totalRows.reduce((s, p) => s + toNum(orderInputs[p.product_id]?.price) * toNum(orderInputs[p.product_id]?.qty), 0);

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
        <div className="pt-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Place an Order</h2>
            <p className="text-xs text-muted mt-0.5">Pick a supplier, tick products, enter the new price and quantity, then place the order. Blank price or quantity counts as 0.</p>
          </div>
          <button
            onClick={openPreviousOrders}
            className="shrink-0 px-4 py-2.5 rounded-xl bg-surface2 border border-white/10 text-slate-100 text-xs font-bold hover:border-teal/40 transition-colors"
          >
            🧾 Previous Orders
          </button>
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

            <form
              onSubmit={e => { e.preventDefault(); addManualProduct(); }}
              className="flex flex-wrap items-center gap-2 mb-3"
            >
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Buying something new? Type its name…"
                aria-label="New product name"
                className="flex-1 min-w-56 px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40"
              />
              <button
                type="submit"
                disabled={!newName.trim() || adding}
                className="px-4 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/25 transition-all disabled:opacity-40"
              >
                {adding ? 'Adding…' : '➕ Add product'}
              </button>
            </form>

            <div className="flex items-center justify-between mb-2 gap-3">
              <p className="text-[11px] text-muted">
                {activeSelected.size > 0
                  ? `${activeSelected.size} checked — only these go in the order`
                  : 'Nothing checked — Print / Excel will include everything below'}
              </p>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setActiveSelected(new Set(activeItems.map(i => i.product_id)))}
                  className="px-3 py-1.5 rounded-lg bg-teal/15 border border-teal/30 text-teal text-[11px] font-bold hover:bg-teal/25 transition-all"
                >Select all</button>
                <button
                  onClick={() => setActiveSelected(new Set())}
                  disabled={activeSelected.size === 0}
                  className="px-3 py-1.5 rounded-lg bg-surface2 border border-white/10 text-slate-300 text-[11px] font-bold hover:border-white/25 transition-all disabled:opacity-40"
                >Clear</button>
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
                              <span className="block text-[10px] text-muted">
                                In stock: {stock}
                                {activeList === 'out_of_stock' && lastChanged(p) && <> · Last changed: {lastChanged(p)}</>}
                              </span>
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
                  <tfoot className="sticky bottom-0 z-10 bg-surface">
                    <tr className="border-t-2 border-white/15 text-sm font-bold">
                      <td className="px-3 py-2.5"></td>
                      <td className="px-2 py-2.5 text-slate-100">
                        Total
                        <span className="block text-[10px] font-normal text-muted">
                          {activeSelected.size > 0 ? `${activeSelected.size} checked` : `All ${activeItems.length} in list`}
                        </span>
                      </td>
                      <td className="px-2 py-2.5"></td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gold whitespace-nowrap">{fmtKsh(totalAmount)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-100">{totalQty.toLocaleString('en-KE')}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 mb-8">
              <span className="text-[11px] text-muted mr-1">
                {activeSelected.size > 0 ? `${activeSelected.size} checked` : 'All in list'} · Product, Price, Quantity
              </span>
              <button
                onClick={placeOrder}
                disabled={activeSelected.size === 0 || placing}
                className="px-4 py-2.5 rounded-xl btn-primary text-xs font-bold transition-all disabled:opacity-40"
              >
                {placing ? 'Saving…' : '📦 Place Order'}
              </button>
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

    {ordersOpen && (
      <div className="print-hide fixed inset-0 z-150 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={() => setOrdersOpen(false)}>
        <div
          className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface border border-white/10 rounded-t-3xl sm:rounded-3xl"
          onClick={e => e.stopPropagation()}
        >
          <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-slate-100">🧾 Previous Orders</h3>
            <button onClick={() => setOrdersOpen(false)} className="px-3 py-1.5 rounded-lg bg-surface2 border border-white/10 text-slate-300 text-xs font-bold hover:border-white/25">Close</button>
          </div>
          <div className="px-5 pb-3">
            <input
              value={orderSearch}
              onChange={e => setOrderSearch(e.target.value)}
              placeholder="Search by order no (e.g. PO-0012 or 12) or supplier…"
              aria-label="Search orders"
              className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40"
            />
            <div className="flex flex-wrap items-end gap-2 mt-2">
              <label className="flex-1 min-w-32">
                <span className="text-[10px] text-muted block mb-1">From</span>
                <input
                  type="date" value={orderFrom} max={orderTo || undefined}
                  onChange={e => setOrderRange(e.target.value, orderTo)}
                  className="w-full px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40"
                />
              </label>
              <label className="flex-1 min-w-32">
                <span className="text-[10px] text-muted block mb-1">To</span>
                <input
                  type="date" value={orderTo} min={orderFrom || undefined}
                  onChange={e => setOrderRange(orderFrom, e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40"
                />
              </label>
              <button
                onClick={() => setOrderRange('', '')}
                disabled={!orderFrom && !orderTo}
                className="px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-slate-300 text-xs font-bold hover:border-white/25 disabled:opacity-40"
              >Clear dates</button>
            </div>
            {orders && orders.length > 0 && (
              <p className="text-[11px] text-muted mt-2">
                {visibleOrders.length} order{visibleOrders.length === 1 ? '' : 's'} · Total {fmtKsh(visibleOrdersTotal)}
              </p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            {ordersError ? (
              <p className="text-xs text-danger py-6 text-center">Couldn&apos;t load orders: {ordersError}</p>
            ) : orders === null ? (
              <div className="flex justify-center py-10">
                <div className="w-6 h-6 rounded-full border-2 border-teal border-t-transparent animate-spin" />
              </div>
            ) : visibleOrders.length === 0 ? (
              <p className="text-sm text-muted py-10 text-center">{orders.length === 0 ? 'No orders placed yet.' : 'No order matches.'}</p>
            ) : (
              <ul className="rounded-2xl border border-white/8 divide-y divide-white/5">
                {visibleOrders.map(o => (
                  <li key={o.order_id} className="px-3 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-100 tabular-nums">{o.order_no}</p>
                      <p className="text-[11px] text-muted truncate">
                        {o.order_date} · {o.supplier_name ?? 'All suppliers'} · {o.items.length} item{o.items.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span className="text-xs font-semibold text-gold tabular-nums whitespace-nowrap">{fmtKsh(Number(o.total_amount))}</span>
                    <button
                      onClick={() => openOrderPdf(o)}
                      className="px-3 py-1.5 rounded-lg bg-teal/15 border border-teal/30 text-teal text-[11px] font-bold hover:bg-teal/25 transition-all"
                    >📄 PDF</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    )}

    {notice && (
      <div className={`print-hide fixed bottom-6 left-1/2 -translate-x-1/2 z-300 max-w-[90vw] px-5 py-2.5 rounded-xl border text-sm font-semibold shadow-2xl pointer-events-none ${
        notice.error ? 'bg-danger/15 border-danger/30 text-danger' : 'bg-success/15 border-success/30 text-success'
      }`}>
        {notice.text}
      </div>
    )}

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
