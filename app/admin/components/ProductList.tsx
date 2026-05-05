'use client';

import { useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import AdminProductCard from './AdminProductCard';
import type { Product, StockMap, Location } from '@/lib/types';

interface Props {
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
  onAdjust:     (product: Product, direction: 'plus' | 'minus', location: Location) => void;
}

export default function ProductList({
  products, backStockMap, mainStockMap, backBoxMap, mainBoxMap, onAdjust,
}: Props) {
  const [location, setLocation]   = useState<Location>('main');
  const [category, setCategory]   = useState('All');
  const [search,   setSearch]     = useState('');

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const sm = location === 'back' ? backStockMap : mainStockMap;
  const bm = location === 'back' ? backBoxMap   : mainBoxMap;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (category !== 'All' && p.type !== category) return false;
      if (q) {
        const hay = [p.product_name, p.brand, p.model, p.stock_keeping_unit, p.type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, category, search]);

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
    <div className="px-4 pb-8">
      {/* Location tabs */}
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

      {/* Search bar */}
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

      {/* Category filter chips */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4 scrollbar-none">
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

      {/* Result count */}
      <p className="text-[11px] text-muted mb-3 font-medium">
        {visible.length} product{visible.length !== 1 ? 's' : ''}
        {outCount > 0 && (
          <span className="ml-2 text-danger">· {outCount} out of stock</span>
        )}
      </p>

      {/* Product list */}
      <div className="flex flex-col gap-2">
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
              />
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
