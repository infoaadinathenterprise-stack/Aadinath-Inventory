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
  // Public site shows only the binary in-stock state — never counts.
  const inStock = (p.total_stock ?? 0) > 0;
  const [src, setSrc] = useState<string>(p.image_url || PLACEHOLDER);

  const meta = [p.brand, p.model].filter(Boolean).join(' · ');

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.4), duration: 0.4, ease: 'easeOut' as const }}
      layout
      className="relative flex flex-col rounded-2xl bg-surface border border-white/6
                 hover:border-teal/30 hover:shadow-[0_8px_30px_rgba(0,0,0,0.35)]
                 transition-all duration-300 group overflow-hidden"
    >
      {/* Image */}
      <div className="relative aspect-square w-full bg-surface2 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={p.product_name}
          loading="lazy"
          onError={() => { if (src !== PLACEHOLDER) setSrc(PLACEHOLDER); }}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />

        {/* Category chip over the image — saves vertical space on phones */}
        <span className="absolute top-2 left-2 text-[9px] sm:text-[10px] font-bold px-2 py-0.5 rounded-full bg-navy/80 backdrop-blur-sm border border-white/10 text-slate-200 uppercase tracking-wider max-w-[80%] truncate">
          {p.type || 'General'}
        </span>

        {!inStock && (
          <div className="absolute inset-0 bg-navy/70 backdrop-blur-[1px] flex items-center justify-center">
            <span className="text-[10px] sm:text-[11px] font-bold tracking-widest text-danger uppercase border border-danger/40 bg-navy/85 px-2.5 py-1 rounded-full">
              Out of Stock
            </span>
          </div>
        )}
      </div>

      {/* Content — tight on mobile, roomier on desktop */}
      <div className="flex flex-col flex-1 p-3 sm:p-4">
        <h3 className="font-semibold text-slate-100 text-[13px] sm:text-[15px] leading-snug break-words line-clamp-2 mb-1 group-hover:text-teal transition-colors duration-200">
          {p.product_name}
        </h3>

        {meta && (
          <p className="text-[11px] sm:text-xs text-muted truncate mb-1">{meta}</p>
        )}

        <div className="flex-1" />

        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-white/5">
          <span className={`inline-flex items-center gap-1.5 text-[10px] sm:text-[11px] font-semibold ${inStock ? 'text-success' : 'text-danger'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${inStock ? 'bg-success animate-pulse' : 'bg-danger'}`} />
            {inStock ? 'In Stock' : 'Out of Stock'}
          </span>
          {p.stock_keeping_unit && (
            <span className="text-[9px] text-muted/50 font-mono truncate max-w-[45%]">{p.stock_keeping_unit}</span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
