'use client';

import { motion } from 'framer-motion';
import type { Product } from '@/lib/formatStock';
import { formatStock } from '@/lib/formatStock';

interface Props {
  product: Product;
  index:   number;
}

export default function ProductCard({ product: p, index }: Props) {
  const stock = formatStock(p.total_stock ?? 0, p.unit_type, p.unit_of_measure, p.pieces_per_box);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07, duration: 0.5, ease: 'easeOut' as const }}
      layout
      className="relative flex flex-col p-5 rounded-2xl bg-surface border border-white/5 cursor-default
                 hover:border-teal/30 hover:shadow-[0_0_20px_rgba(0,212,255,0.12)]
                 transition-all duration-300 group overflow-hidden"
    >
      {/* Background glow on hover */}
      <div className="absolute inset-0 rounded-2xl bg-teal/0 group-hover:bg-teal/3 transition-all duration-300 pointer-events-none" />

      {/* Top row — category badge + unit badge */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-surface2 border border-white/8 text-muted uppercase tracking-wider truncate max-w-35">
          {p.type || 'General'}
        </span>
        <span
          className={`shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider border ${
            stock.unitBadge === 'BOX'
              ? 'bg-gold/10 border-gold/30 text-gold'
              : 'bg-teal/10 border-teal/30 text-teal'
          }`}
        >
          {stock.unitBadge}
        </span>
      </div>

      {/* Product name */}
      <h3 className="font-bold text-slate-100 text-base leading-snug mb-1 group-hover:text-teal transition-colors duration-200">
        {p.product_name}
      </h3>

      {/* Brand / Model */}
      {(p.brand || p.model) && (
        <p className="text-xs text-muted mb-3">
          {[p.brand, p.model].filter(Boolean).join(' · ')}
        </p>
      )}

      {/* SKU */}
      {p.stock_keeping_unit && (
        <p className="text-[10px] text-muted/60 font-mono mb-4">
          SKU: {p.stock_keeping_unit}
        </p>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Stock status */}
      <div
        className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold ${
          stock.inStock
            ? 'bg-success/10 border-success/30 text-success'
            : 'bg-danger/10  border-danger/30  text-danger'
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${stock.inStock ? 'bg-success' : 'bg-danger'}`}
          style={stock.inStock ? { animation: 'pulse-glow 2s ease-in-out infinite' } : {}}
        />
        {stock.label}
      </div>
    </motion.div>
  );
}
