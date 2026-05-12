'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import AdminProductCard from './AdminProductCard';
import type { Product, StockMap, Location } from '@/lib/types';

export type StockFilter = 'all' | 'in_stock' | 'out_of_stock' | 'back_only' | 'main_only';

function filterLabel(f: StockFilter): string {
  switch (f) {
    case 'in_stock':     return 'In stock';
    case 'out_of_stock': return 'Out of stock';
    case 'back_only':    return 'Back Godown';
    case 'main_only':    return 'Main Store';
    default:             return 'All';
  }
}

interface Props {
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
  onAdjust:     (product: Product, direction: 'plus' | 'minus', location: Location) => void;
  onEdit?:      (product: Product) => void;
  stockFilter?: StockFilter;
}

export default function ProductList({
  products, backStockMap, mainStockMap, backBoxMap, mainBoxMap, onAdjust, onEdit,
  stockFilter = 'all',
}: Props) {
  const [location, setLocation]   = useState<Location>('main');
  const [category, setCategory]   = useState('All');
  const [search,   setSearch]     = useState('');
  const [scanMsg,  setScanMsg]    = useState<{ text: string; ok: boolean } | null>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Auto-focus the barcode input on mount so a USB scanner "just works"
  // without the user having to click into the field.
  useEffect(() => {
    const t = setTimeout(() => barcodeRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  // Snap focus back to the barcode field when keystrokes arrive but
  // nothing is focused (USB scanners type characters very fast). Skip
  // when an input/textarea/select is already focused (don't disrupt
  // typing) and skip when any modal is open (any element with the
  // `fixed inset-0` overlay class — both AdjustStockModal and
  // ProductModal use that pattern).
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      // Ignore modifier-only events and our own Enter on the barcode field
      if (e.key === 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName !== 'HTML') {
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      }
      if (document.querySelector('.fixed.inset-0')) return; // modal/drawer open
      barcodeRef.current?.focus();
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  // Auto-clear the scan-result banner after a couple seconds.
  useEffect(() => {
    if (!scanMsg) return;
    const t = setTimeout(() => setScanMsg(null), 2500);
    return () => clearTimeout(t);
  }, [scanMsg]);

  function handleBarcodeKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const code = e.currentTarget.value.trim();
    e.currentTarget.value = '';
    if (!code) return;
    const lc = code.toLowerCase();
    const match =
      products.find(p => (p.stock_keeping_unit ?? '').toLowerCase() === lc) ??
      products.find(p => p.product_name.toLowerCase().includes(lc));
    if (!match) {
      setSearch(code);
      setScanMsg({ text: `No product matches "${code}"`, ok: false });
      return;
    }
    // Filter the list down to this product and confirm visually.
    setSearch(match.product_name);
    setCategory('All');
    setScanMsg({ text: `Found: ${match.product_name}`, ok: true });
  }

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const sm = location === 'back' ? backStockMap : mainStockMap;
  const bm = location === 'back' ? backBoxMap   : mainBoxMap;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      // Stock-status pre-filter from the /admin/stats page links.
      if (stockFilter !== 'all') {
        const ppb = p.pieces_per_box || 0;
        const backTotal = (backStockMap[p.product_id] || 0) + (backBoxMap[p.product_id] || 0) * ppb;
        const mainTotal = (mainStockMap[p.product_id] || 0) + (mainBoxMap[p.product_id] || 0) * ppb;
        const total = backTotal + mainTotal;
        if (stockFilter === 'in_stock'     && total === 0)        return false;
        if (stockFilter === 'out_of_stock' && total > 0)          return false;
        if (stockFilter === 'back_only'    && backTotal === 0)    return false;
        if (stockFilter === 'main_only'    && mainTotal === 0)    return false;
      }
      if (category !== 'All' && p.type !== category) return false;
      if (q) {
        const hay = [p.product_name, p.brand, p.model, p.stock_keeping_unit, p.type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, category, search, stockFilter, backStockMap, mainStockMap, backBoxMap, mainBoxMap]);

  const outCount = useMemo(
    () => visible.filter(p => {
      const ppb = p.pieces_per_box || 0;
      const qty = sm[p.product_id] || 0;
      const bx  = bm[p.product_id] || 0;
      return (qty + bx * (ppb || 1)) === 0;
    }).length,
    [visible, sm, bm],
  );

  return (
    // Two regions: a non-scrollable filter band on top (location toggle,
    // barcode, search, categories, count) and a scrollable card list
    // below. The parent layout in admin/page.tsx hands us flex-1 +
    // min-h-0 via context so we fill the remaining viewport height.
    <div className="px-4 flex flex-col flex-1 min-h-0">
      <div className="shrink-0">
        <div className="flex gap-2 mb-4">
          {(['main', 'back'] as Location[]).map((loc) => (
            <button
              key={loc}
              onClick={() => setLocation(loc)}
              className={`flex-1 py-2.5 rounded-xl border text-xs font-bold transition-all ${
                location === loc
                  ? 'border-teal bg-teal/10 text-teal'
                  : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}
            >
              {loc === 'main' ? '🏪 Main Store' : '🏭 Back Godown'}
            </button>
          ))}
        </div>

        <div className="relative mb-2">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gold text-sm">📷</span>
          <input
            ref={barcodeRef}
            type="text"
            onKeyDown={handleBarcodeKey}
            placeholder="Scan barcode / type SKU + Enter"
            autoComplete="off"
            inputMode="text"
            className="w-full pl-9 pr-4 py-2.5 bg-gold/5 border border-gold/30 rounded-xl text-sm text-slate-100 placeholder:text-gold/40 outline-none focus:border-gold focus:bg-gold/10 transition-colors font-mono"
          />
        </div>
        {scanMsg && (
          <div className={`mb-2 px-3 py-1.5 rounded-lg text-xs font-semibold ${scanMsg.ok ? 'bg-success/10 text-success border border-success/20' : 'bg-danger/10 text-danger border border-danger/20'}`}>
            {scanMsg.ok ? '✓ ' : '✕ '}{scanMsg.text}
          </div>
        )}

        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search products…"
            className="w-full pl-9 pr-4 py-2.5 bg-surface2 border border-white/8 rounded-xl text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg leading-none"
            >×</button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 mb-3 scrollbar-none">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
                category === cat
                  ? 'border-gold bg-gold/10 text-gold'
                  : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-muted mb-3 font-medium flex items-center flex-wrap gap-2">
          <span>{visible.length} product{visible.length !== 1 ? 's' : ''}</span>
          {outCount > 0 && (
            <span className="text-danger">· {outCount} out of stock</span>
          )}
          {stockFilter !== 'all' && (
            <a
              href="/admin"
              className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gold/10 border border-gold/30 text-gold text-[10px] font-bold hover:bg-gold/20 transition-all"
            >
              Filter: {filterLabel(stockFilter)} ✕
            </a>
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 flex-1 overflow-y-auto min-h-0 pb-6 auto-rows-min">
        <AnimatePresence mode="popLayout">
          {visible.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="text-center py-16 text-muted"
            >
              <p className="text-4xl mb-3">📭</p>
              <p className="text-sm font-medium">No products found</p>
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="mt-2 text-xs text-teal hover:underline"
                >Clear search</button>
              )}
            </motion.div>
          ) : (
            visible.map((p, i) => (
              <AdminProductCard
                key={p.product_id}
                product={p}
                index={i}
                location={location}
                backStockMap={backStockMap}
                mainStockMap={mainStockMap}
                backBoxMap={backBoxMap}
                mainBoxMap={mainBoxMap}
                onAdjust={onAdjust}
                onEdit={onEdit}
              />
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
