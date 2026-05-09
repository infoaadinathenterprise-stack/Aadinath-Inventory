'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Product } from '@/lib/types';

interface Props {
  product: Product;
  index:   number;
}

const PLACEHOLDER = '/product-placeholder.svg';

export default function ProductCard({ product: p, index }: Props) {
  // Show only the binary in-stock state to the public — never the actual
  // count or unit (boxes/pieces). Source of truth is total_stock joined
  // server-side; treat any positive number as in stock.
  const inStock = (p.total_stock ?? 0) > 0;

  // Local fallback to the placeholder if the real image_url 404s or fails
  // to load.
  const [src, setSrc] = useState<string>(p.image_url || PLACEHOLDER);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07, duration: 0.5, ease: 'easeOut' as const }}
      layout
      className="relative flex flex-col rounded-2xl bg-surface border border-white/5 cursor-default
                 hover:border-teal/30 hover:shadow-[0_0_20px_rgba(0,212,255,0.12)]
                 transition-all duration-300 group overflow-hidden"
    >
      <div className="absolute inset-0 rounded-2xl bg-teal/0 group-hover:bg-teal/3 transition-all duration-300 pointer-events-none" />

      {/* Image */}
      <div className="relative aspect-square w-full bg-surface2 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={p.product_name}
          loading="lazy"
          onError={() => { if (src !== PLACEHOLDER) setSrc(PLACEHOLDER); }}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        {!inStock && (
          <div className="absolute inset-0 bg-navy/65 backdrop-blur-[1px] flex items-center justify-center">
            <span className="text-[11px] font-bold tracking-widest text-danger uppercase border border-danger/40 bg-navy/80 px-3 py-1.5 rounded-full">
              Out of Stock
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
          <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-surface2 border border-white/8 text-muted uppercase tracking-wider truncate max-w-35">
            {p.type || 'General'}
          </span>
        </div>

        <h3 className="font-bold text-slate-100 text-base leading-snug mb-1 group-hover:text-teal transition-colors duration-200">
          {p.product_name}
        </h3>

        {(p.brand || p.model) && (
          <p className="text-xs text-muted mb-3">
            {[p.brand, p.model].filter(Boolean).join(' · ')}
          </p>
        )}

        {p.stock_keeping_unit && (
          <p className="text-[10px] text-muted/60 font-mono mb-4">
            SKU: {p.stock_keeping_unit}
          </p>
        )}

        <div className="flex-1" />

        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${
            inStock
              ? 'bg-success/10 border-success/30 text-success'
              : 'bg-danger/10  border-danger/30  text-danger'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${inStock ? 'bg-success' : 'bg-danger'}`}
            style={inStock ? { animation: 'pulse-glow 2s ease-in-out infinite' } : {}}
          />
          {inStock ? 'In Stock' : 'Out of Stock'}
        </div>
      </div>
    </motion.div>
  );
}
