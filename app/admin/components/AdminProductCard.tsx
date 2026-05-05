'use client';

import { motion } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import type { Product, StockMap, Location } from '@/lib/types';

interface Props {
  product:      Product;
  index:        number;
  location:     Location;
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
  onAdjust:     (product: Product, direction: 'plus' | 'minus', location: Location) => void;
  onEdit?:      (product: Product) => void;
}

export default function AdminProductCard({
  product: p, index, location,
  backStockMap, mainStockMap, backBoxMap, mainBoxMap,
  onAdjust, onEdit,
}: Props) {
  const sm  = location === 'back' ? backStockMap : mainStockMap;
  const bm  = location === 'back' ? backBoxMap   : mainBoxMap;
  const ppb = p.pieces_per_box || 0;
  const qty = sm[p.product_id] || 0;
  const bx  = bm[p.product_id] || 0;
  const total = qty + bx * (ppb || 1);
  const reorder = p.reorder_level || 2;
  const fmt = formatStock(total, p.unit_type, p.unit_of_measure, ppb);

  const stockClass =
    total === 0         ? 'text-danger'  :
    total <= reorder    ? 'text-gold'    :
    /* otherwise */       'text-muted';

  const stockLabel =
    !fmt.inStock        ? 'Out of stock'           :
    total <= reorder    ? `⚠ Low — ${fmt.label}`   :
    fmt.label;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.6), duration: 0.35 }}
      layout
      className="flex items-center gap-3 px-3 py-3 rounded-xl bg-surface border border-white/5 hover:border-teal/20 transition-all duration-200 group"
    >
      {/* Category badge */}
      <span className="shrink-0 self-start mt-0.5 text-[9px] font-bold px-2 py-0.5 rounded-md bg-surface2 border border-white/8 text-muted uppercase tracking-wider whitespace-nowrap">
        {p.type || '—'}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-100 truncate group-hover:text-teal transition-colors duration-200">
          {p.product_name}
        </p>
        <p className="text-xs text-muted truncate mt-0.5">
          {[p.brand, p.model].filter(Boolean).join(' · ') || p.stock_keeping_unit || '—'}
        </p>
        <p className={`text-[10px] font-semibold mt-1 ${stockClass}`}>{stockLabel}</p>
      </div>

      {/* Edit button */}
      {onEdit && (
        <button
          onClick={() => onEdit(p)}
          className="w-8 h-8 rounded-lg bg-surface2 border border-white/8 text-muted hover:text-teal hover:border-teal/30 flex items-center justify-center text-sm transition-all shrink-0"
          title="Edit product"
        >✏️</button>
      )}

      {/* Stock count + adjust buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => onAdjust(p, 'minus', location)}
          className="w-8 h-8 rounded-lg bg-danger/10 border border-danger/30 text-danger text-lg font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all duration-150 active:scale-90"
        >−</button>

        <div className="flex flex-col items-center min-w-[36px]">
          <span className="text-lg font-bold text-slate-200 tabular-nums leading-none">
            {fmt.unitBadge === 'BOX' && ppb > 0
              ? Math.floor(total / ppb)
              : total}
          </span>
          {fmt.unitBadge === 'BOX' && ppb > 0 && (
            <span className="text-[8px] text-muted leading-none mt-0.5">
              {`${Math.floor(total / ppb)}bx+${total % ppb}pc`}
            </span>
          )}
          <span className="text-[8px] font-bold text-muted/60 uppercase tracking-wider leading-none mt-0.5">
            {fmt.unitBadge}
          </span>
        </div>

        <button
          onClick={() => onAdjust(p, 'plus', location)}
          className="w-8 h-8 rounded-lg bg-teal/10 border border-teal/30 text-teal text-lg font-bold flex items-center justify-center hover:bg-teal hover:text-navy transition-all duration-150 active:scale-90"
        >+</button>
      </div>
    </motion.div>
  );
}
