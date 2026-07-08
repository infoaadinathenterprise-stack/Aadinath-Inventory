'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { logout as apiLogout, isAuthenticated } from '@/lib/auth';
import { ROLE_KEY } from '@/lib/types';
import type { Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

function fmtKsh(n: number | null): string {
  return n == null ? '' : `Ksh ${n.toLocaleString('en-KE')}`;
}

export default function PricingPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    const ok   = isAuthenticated();
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') { router.replace('/admin'); return; }
    setAuthed(true);
  }, [router]);

  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <PricingDashboard />;
}

function PricingDashboard() {
  const { products, loading, error, refresh } = useProducts();
  const [category, setCategory] = useState('All');
  const [search,   setSearch]   = useState('');
  const [edits,    setEdits]    = useState<Record<number, string>>({});   // product_id → price text
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<ToastState | null>(null);
  const toastId = useRef(0);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function handleLogout() {
    apiLogout();
    window.location.href = '/admin';
  }

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter(p => {
        if (category !== 'All' && p.type !== category) return false;
        if (q) {
          const hay = [p.product_name, p.brand, p.model, p.stock_keeping_unit, p.type].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.product_name.localeCompare(b.product_name));
  }, [products, category, search]);

  // Effective price for a product = the edited value if present, else the DB value.
  function priceText(p: Product): string {
    if (p.product_id in edits) return edits[p.product_id];
    return p.selling_price != null ? String(p.selling_price) : '';
  }
  function priceValue(p: Product): number | null {
    const t = priceText(p).trim();
    if (t === '') return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }

  function setEdit(productId: number, value: string) {
    setEdits(prev => ({ ...prev, [productId]: value }));
  }

  // Which rows actually changed vs the DB?
  const dirtyIds = useMemo(() => {
    return Object.keys(edits)
      .map(Number)
      .filter(id => {
        const p = products.find(pr => pr.product_id === id);
        if (!p) return false;
        const original = p.selling_price != null ? String(p.selling_price) : '';
        return (edits[id] ?? '').trim() !== original.trim();
      });
  }, [edits, products]);

  async function saveAll() {
    if (dirtyIds.length === 0) return;
    setSaving(true);
    let ok = 0, fail = 0;
    for (const id of dirtyIds) {
      const p = products.find(pr => pr.product_id === id);
      if (!p) continue;
      const val = priceValue(p);
      const { error: e } = await supabase.from('products').update({ selling_price: val }).eq('product_id', id);
      if (e) fail++; else ok++;
    }
    setSaving(false);
    if (fail > 0) showToast(`Saved ${ok}, failed ${fail}. Check your connection / permissions.`, 'error');
    else showToast(`Saved ${ok} price${ok === 1 ? '' : 's'} ✓`, 'success');
    setEdits({});
    refresh();
  }

  // ── PDF: open a print window with a 3-column table whose header repeats
  //    on every page. Save-as-PDF from the browser print dialog. ──
  function makePdf() {
    const title = category === 'All' ? 'Product Price List' : `Price List — ${category}`;
    const today = new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const rows = visible.map(p => {
      const price = priceValue(p);
      return `<tr>
        <td class="name">${esc(p.product_name)}</td>
        <td class="price">${price != null ? esc(fmtKsh(price)) : ''}</td>
        <td class="comment"></td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 24px; }
      h1 { font-size: 18px; margin: 0 0 2px; }
      .sub { font-size: 11px; color: #555; margin: 0 0 14px; }
      table { border-collapse: collapse; width: 100%; }
      thead { display: table-header-group; }   /* repeat header on every printed page */
      tr { page-break-inside: avoid; }
      th, td { border: 1px solid #333; padding: 7px 9px; font-size: 12px; text-align: left; vertical-align: top; }
      th { background: #f0f0f0; font-size: 12px; }
      td.price { width: 20%; white-space: nowrap; }
      td.comment { width: 32%; }
      th.price { width: 20%; }
      th.comment { width: 32%; }
      @media print { body { margin: 12mm; } }
    </style></head><body>
      <h1>${esc(title)}</h1>
      <p class="sub">${esc(today)} · ${visible.length} product${visible.length === 1 ? '' : 's'}</p>
      <table>
        <thead>
          <tr><th class="name">Product Name</th><th class="price">Price</th><th class="comment">Comment</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <script>window.onload = function(){ window.print(); };</script>
    </body></html>`;

    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to generate the PDF', 'error'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-4xl mx-auto px-4 pb-28">
        <div className="pt-5 pb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">💲 Product Pricing</h2>
            <p className="text-xs text-muted mt-0.5">{visible.length} product{visible.length === 1 ? '' : 's'}{category !== 'All' ? ` in ${category}` : ''}</p>
          </div>
          <button
            onClick={makePdf}
            className="px-4 py-2 rounded-xl bg-gold/10 border border-gold/30 text-gold text-xs font-bold hover:bg-gold/20 transition-all shrink-0"
          >
            📄 Make PDF
          </button>
        </div>

        {error && <div className="mb-3 px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs">{error}</div>}

        {/* Category filter */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
                category === cat
                  ? 'bg-teal/10 border-teal/30 text-teal'
                  : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative my-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, brand, SKU…"
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
          />
        </div>

        {/* Product rows */}
        <div className="flex flex-col gap-2">
          {visible.length === 0 && (
            <p className="text-center text-sm text-muted py-12">No products found.</p>
          )}
          {visible.map(p => {
            const dirty = dirtyIds.includes(p.product_id);
            return (
              <div
                key={p.product_id}
                className={`bg-surface border rounded-xl px-4 py-3 flex items-center gap-3 ${dirty ? 'border-teal/40' : 'border-white/8'}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-100 truncate">{p.product_name}</p>
                  <p className="text-[11px] text-muted mt-0.5 truncate">
                    <span className="text-teal/80">{p.type || '—'}</span>
                    {(p.brand || p.model) && <span> · {[p.brand, p.model].filter(Boolean).join(' · ')}</span>}
                    {p.stock_keeping_unit && <span className="text-muted/60"> · {p.stock_keeping_unit}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[11px] font-bold text-muted">Ksh</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={priceText(p)}
                    onChange={e => setEdit(p.product_id, e.target.value)}
                    onWheel={e => e.currentTarget.blur()}
                    placeholder="0.00"
                    className="w-24 text-right px-2.5 py-2 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-sm font-bold tabular-nums outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Sticky save bar */}
      {dirtyIds.length > 0 && (
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-surface/95 backdrop-blur px-4 py-3"
        >
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
            <span className="text-xs text-slate-300">{dirtyIds.length} unsaved price change{dirtyIds.length === 1 ? '' : 's'}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEdits({})}
                disabled={saving}
                className="px-4 py-2 rounded-xl border border-white/10 bg-surface2 text-muted text-xs font-semibold hover:text-slate-100 disabled:opacity-50 transition-colors"
              >
                Discard
              </button>
              <button
                onClick={saveAll}
                disabled={saving}
                className="btn-primary px-5 py-2 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center gap-2"
              >
                {saving && <div className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />}
                Save changes
              </button>
            </div>
          </div>
        </motion.div>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
