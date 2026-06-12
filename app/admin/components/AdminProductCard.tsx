'use client';

import { motion } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import type { Product, StockByLoc, LocationInfo } from '@/lib/types';

interface Props {
  product:    Product;
  index:      number;
  locationId: number;
  locations:  LocationInfo[];
  stockByLoc: StockByLoc;
  boxByLoc:   StockByLoc;
  onAdjust:   (product: Product, direction: 'plus' | 'minus', locationId: number) => void;
  onEdit?:    (product: Product) => void;
}

export default function AdminProductCard({
  product: p, index, locationId, locations, stockByLoc, boxByLoc, onAdjust, onEdit,
}: Props) {
  const ppb     = p.pieces_per_box || 0;
  const qty     = (stockByLoc[locationId] ?? {})[p.product_id] ?? 0;
  const bx      = (boxByLoc[locationId]   ?? {})[p.product_id] ?? 0;
  const total   = qty + bx * (ppb || 1);
  const reorder = p.reorder_level || 2;
  const fmt     = formatStock(total, p.unit_type, p.unit_of_measure, ppb);

  const otherTotal = locations
    .filter(l => l.location_id !== locationId)
    .reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[p.product_id] ?? 0) + ((boxByLoc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb, 0);

  const stockClass =
    total === 0      ? 'text-danger' :
    total <= reorder ? 'text-gold'   :
                       'text-success/80';

  const stockLabel =
    !fmt.inStock        ? 'Out of stock'         :
    total <= reorder    ? `Low · ${fmt.label}`   :
    fmt.label;

  const meta = [p.brand, p.model].filter(Boolean).join(' · ') || p.stock_keeping_unit;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.25), duration: 0.25 }}
      className="flex flex-col rounded-2xl bg-surface border border-white/6 hover:border-teal/25 transition-colors duration-200 overflow-hidden"
    >
      {/* ── Name block: full card width so long names wrap, never clip ── */}
      <div className="px-3.5 pt-3 pb-2.5 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-semibold text-slate-100 leading-snug break-words line-clamp-2">
            {p.product_name}
          </p>
          <p className="text-[11px] text-muted mt-1 flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-teal/80 bg-teal/8 border border-teal/15 rounded px-1.5 py-px">
              {p.type || '—'}
            </span>
            {meta && <span className="truncate">{meta}</span>}
          </p>
        </div>
        {onEdit && (
          <button
            onClick={() => onEdit(p)}
            className="w-9 h-9 -mr-1 -mt-0.5 rounded-lg text-muted/70 hover:text-teal hover:bg-teal/10 flex items-center justify-center text-sm transition-colors shrink-0"
            title="Edit product"
            aria-label="Edit product"
          >✏️</button>
        )}
      </div>

      {/* ── Stock + controls row ── */}
      <div className="px-3.5 py-2.5 border-t border-white/5 bg-white/[0.015] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-xs font-semibold ${stockClass}`}>
            {total <= reorder && total > 0 && '⚠ '}{stockLabel}
          </p>
          {total <= reorder && otherTotal > 0 && (
            <p className="text-[10px] text-gold/70 mt-0.5">{otherTotal} available elsewhere</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onAdjust(p, 'minus', locationId)}
            aria-label="Reduce stock"
            className="w-10 h-10 rounded-xl bg-danger/10 border border-danger/25 text-danger text-xl font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all duration-150 active:scale-90"
          >−</button>

          <div className="flex flex-col items-center min-w-10">
            <span className="text-xl font-bold text-slate-100 tabular-nums leading-none">
              {fmt.unitBadge === 'BOX' && ppb > 0 ? Math.floor(total / ppb) : total}
            </span>
            {fmt.unitBadge === 'BOX' && ppb > 0 && total % ppb > 0 && (
              <span className="text-[9px] text-muted leading-none mt-0.5">+{total % ppb}pc</span>
            )}
            <span className="text-[8px] font-bold text-muted/50 uppercase tracking-widest leading-none mt-0.5">{fmt.unitBadge}</span>
          </div>

          <button
            onClick={() => onAdjust(p, 'plus', locationId)}
            aria-label="Add stock"
            className="w-10 h-10 rounded-xl bg-teal/10 border border-teal/25 text-teal text-xl font-bold flex items-center justify-center hover:bg-teal hover:text-navy transition-all duration-150 active:scale-90"
          >+</button>
        </div>
      </div>
    </motion.div>
  );
}
