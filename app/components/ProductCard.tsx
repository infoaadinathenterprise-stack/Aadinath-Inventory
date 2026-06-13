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
      className="relative flex flex-col rounded-2xl card-lux overflow-hidden group
                 transition-all duration-300 hover:-translate-y-1
                 hover:shadow-[0_20px_44px_-16px_rgba(0,0,0,0.65),0_0_0_1px_rgba(56,189,248,0.22)]"
    >
      {/* Image */}
      <div className="relative aspect-square w-full bg-surface2 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={p.product_name}
          loading="lazy"
          onError={() => { if (src !== PLACEHOLDER) setSrc(PLACEHOLDER); }}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.05]"
        />
        {/* Bottom gradient so the image melts into the card */}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0d1524] to-transparent pointer-events-none" />

        {/* Category chip */}
        <span className="absolute top-2.5 left-2.5 text-[9px] sm:text-[10px] font-bold px-2.5 py-1 rounded-full glass border text-slate-200 uppercase tracking-wider max-w-[80%] truncate">
          {p.type || 'General'}
        </span>

        {!inStock && (
          <div className="absolute inset-0 bg-navy/70 backdrop-blur-[2px] flex items-center justify-center">
            <span className="text-[10px] sm:text-[11px] font-bold tracking-widest text-danger uppercase border border-danger/40 bg-navy/85 px-3 py-1.5 rounded-full">
              Out of Stock
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 p-3 sm:p-4">
        <h3 className="font-semibold text-slate-100 text-[13px] sm:text-[15px] leading-snug break-words line-clamp-2 mb-1 group-hover:text-teal transition-colors duration-200">
          {p.product_name}
        </h3>

        {meta && (
          <p className="text-[11px] sm:text-xs text-muted truncate mb-1">{meta}</p>
        )}

        <div className="flex-1" />

        <div className="flex items-center justify-between gap-2 mt-2 pt-2.5 border-t border-white/6">
          <span className={`inline-flex items-center gap-1.5 text-[10px] sm:text-[11px] font-semibold ${inStock ? 'text-success' : 'text-danger'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${inStock ? 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-danger'}`} />
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
