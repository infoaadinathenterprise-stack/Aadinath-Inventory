'use client';

import { useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Product } from '@/lib/types';
import ProductCard from './ProductCard';

interface Props {
  products: Product[];
  categories: string[];
}

export default function ProductGrid({ products, categories }: Props) {
  const [activeFilter, setActiveFilter] = useState('All');
  const [query, setQuery]               = useState('');

  const filtered = useMemo(() => {
    let list = products;
    if (activeFilter !== 'All') list = list.filter(p => p.type === activeFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(p =>
        (p.product_name || '').toLowerCase().includes(q) ||
        (p.brand        || '').toLowerCase().includes(q) ||
        (p.model        || '').toLowerCase().includes(q) ||
        (p.stock_keeping_unit || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [products, activeFilter, query]);

  return (
    <div>
      <div className="relative mb-6">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
        <input
          type="text"
          placeholder="Search products, brands, SKUs…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full pl-11 pr-4 py-3.5 rounded-2xl card-lux text-slate-100 placeholder:text-muted/60 text-sm outline-none
                     focus:ring-2 focus:ring-teal/25 transition-all duration-200"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg leading-none"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-8">
        {['All', ...categories].map(cat => (
          <motion.button
            key={cat}
            onClick={() => setActiveFilter(cat)}
            whileTap={{ scale: 0.95 }}
            className={`relative px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 ${
              activeFilter === cat
                ? 'text-white btn-primary'
                : 'text-muted card-lux hover:text-slate-100'
            }`}
          >
            {cat}
          </motion.button>
        ))}
      </div>

      <p className="text-xs text-muted mb-6">
        Showing <span className="text-teal font-semibold">{filtered.length}</span> of {products.length} products
        {activeFilter !== 'All' && <span> in <span className="text-gold">{activeFilter}</span></span>}
      </p>

      <AnimatePresence mode="popLayout">
        {filtered.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="col-span-full text-center py-20 text-muted"
          >
            <div className="text-4xl mb-3">🔍</div>
            <p className="text-sm">No products found for &quot;{query}&quot;</p>
          </motion.div>
        ) : (
          <motion.div
            key="grid"
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5"
          >
            {filtered.map((p, i) => (
              <ProductCard key={p.product_id} product={p} index={i} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
