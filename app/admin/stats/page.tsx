'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { SESSION_KEY, USER_KEY, ROLE_KEY, type Supplier } from '@/lib/types';
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
  const { products, locations, companies, stockByLoc, boxByLoc, stockByCompany, boxByCompany, loading } = useProducts();

  function companyTotalPieces(cid: number): number {
    const sc = stockByCompany[cid] ?? {}; const bc = boxByCompany[cid] ?? {};
    return products.reduce((s, p) => {
      const ppb = p.pieces_per_box ?? 0;
      return s + locations.reduce((ls, l) => ls + ((sc[l.location_id] ?? {})[p.product_id] ?? 0) + ((bc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb, 0);
    }, 0);
  }
  function companyProductCount(cid: number): number {
    const sc = stockByCompany[cid] ?? {}; const bc = boxByCompany[cid] ?? {};
    return products.filter(p => {
      const ppb = p.pieces_per_box ?? 0;
      return locations.some(l => ((sc[l.location_id] ?? {})[p.product_id] ?? 0) + ((bc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb > 0);
    }).length;
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/admin';
  }

  function totalForProduct(pid: number, ppb: number): number {
    return locations.reduce((s, l) =>
      s + ((stockByLoc[l.location_id] ?? {})[pid] ?? 0) + ((boxByLoc[l.location_id] ?? {})[pid] ?? 0) * ppb, 0);
  }

  // Back Godown and Main Store shims (for the location-specific stat cards)
  const backId = locations.find(l => l.location_name === 'Back Godown')?.location_id ?? 2;
  const mainId = locations.find(l => l.location_name === 'Main Store')?.location_id  ?? 1;
  function locTotal(locId: number, pid: number, ppb: number) {
    return ((stockByLoc[locId] ?? {})[pid] ?? 0) + ((boxByLoc[locId] ?? {})[pid] ?? 0) * ppb;
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

  const totalBack = products.reduce((s, p) => s + locTotal(backId, p.product_id, p.pieces_per_box ?? 0), 0);
  const totalMain = products.reduce((s, p) => s + locTotal(mainId, p.product_id, p.pieces_per_box ?? 0), 0);
  const inStock   = products.filter(p => totalForProduct(p.product_id, p.pieces_per_box ?? 0) > 0).length;
  const outStock  = products.length - inStock;
  const backCount = products.filter(p => locTotal(backId, p.product_id, p.pieces_per_box ?? 0) > 0).length;
  const mainCount = products.filter(p => locTotal(mainId, p.product_id, p.pieces_per_box ?? 0) > 0).length;

  // value = the total piece count for piece-pool cards, or the product
  // count for status cards. sub = the secondary line under the value.
  const CARDS: { label: string; value: number; sub: string; icon: string; href: string; tone: 'teal' | 'gold' | 'success' | 'danger' }[] = [
    { label: 'Total Products', value: products.length, sub: 'all active products',     icon: '🗂️',  href: '/admin',                     tone: 'teal'    },
    { label: 'In Stock',       value: inStock,         sub: `${products.length ? Math.round(100 * inStock / products.length) : 0}% of catalog`, icon: '✅', href: '/admin?filter=in_stock',     tone: 'success' },
    { label: 'Out of Stock',   value: outStock,        sub: 'needs reorder',           icon: '⚠️',  href: '/admin?filter=out_of_stock', tone: 'danger'  },
    { label: 'Back Godown',    value: totalBack,       sub: `${backCount} product${backCount === 1 ? '' : 's'}`, icon: '🏭', href: '/admin?filter=back_only', tone: 'gold' },
    { label: 'Main Store',     value: totalMain,       sub: `${mainCount} product${mainCount === 1 ? '' : 's'}`, icon: '🏪', href: '/admin?filter=main_only', tone: 'teal' },
    ...(companies.length > 1 ? companies.map((c, i) => ({
      label: c.company_name.replace(/\s*Enterprise$/i, '') + ' stock',
      value: companyTotalPieces(c.company_id),
      sub:   `${companyProductCount(c.company_id)} product${companyProductCount(c.company_id) === 1 ? '' : 's'} in stock`,
      icon:  '🏢',
      href:  '/admin',
      tone:  (i === 0 ? 'teal' : 'gold') as 'teal' | 'gold' | 'success' | 'danger',
    })) : []),
  ];

  const toneClass: Record<typeof CARDS[number]['tone'], { border: string; value: string }> = {
    teal:    { border: 'border-teal/20 hover:border-teal/40',       value: 'text-teal' },
    gold:    { border: 'border-gold/20 hover:border-gold/40',       value: 'text-gold' },
    success: { border: 'border-success/20 hover:border-success/40', value: 'text-success' },
    danger:  { border: 'border-danger/20 hover:border-danger/40',   value: 'text-danger' },
  };

  return (
    <div className="min-h-screen">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="pt-5 pb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-100">Stats</h2>
            <p className="text-xs text-muted mt-0.5">Tap a card to open the inventory filtered to it</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {CARDS.map((c, i) => (
              <motion.div
                key={c.label}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.3 }}
              >
                <Link
                  href={c.href}
                  className={`flex flex-col p-5 rounded-2xl bg-surface border ${toneClass[c.tone].border} relative overflow-hidden cursor-pointer transition-all group`}
                >
                  <div className="absolute top-3 right-3 text-2xl opacity-50 group-hover:opacity-90 transition-opacity">{c.icon}</div>
                  <span className={`text-3xl font-bold tabular-nums ${toneClass[c.tone].value}`}>
                    {c.value}
                  </span>
                  <span className="text-xs text-slate-200 font-semibold mt-1">{c.label}</span>
                  <span className="text-[10px] text-muted mt-0.5">{c.sub}</span>
                  <span className="text-[10px] text-muted/60 mt-2 group-hover:text-teal transition-colors">
                    Open filtered inventory →
                  </span>
                </Link>
              </motion.div>
            ))}
          </div>
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
  );
}
