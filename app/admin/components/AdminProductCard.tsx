'use client';

import { motion } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import ProductThumb from '@/app/components/ProductThumb';
import type { Product, StockByLoc, LocationInfo } from '@/lib/types';

// Stock at this location over a chosen period, rebuilt from the movement
// history (see ProductList). All figures in pieces.
export interface StockHistory {
  opening:   number;   // at the start of the From day
  closing:   number;   // at the end of the To day
  inQty:     number;
  outQty:    number;
  fromLabel: string;
  toLabel:   string;
}

interface Props {
  history?:   StockHistory;
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
  product: p, index, locationId, locations, stockByLoc, boxByLoc, onAdjust, onEdit, history,
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

  // Red = out of stock, orange = low (at or below the reorder level),
  // green = enough.
  const level = total === 0 ? 'out' : total <= reorder ? 'low' : 'ok';
  const tone = {
    out: { text: 'text-danger',     bar: 'bg-danger',     card: 'border-danger/40 bg-danger/[0.04]',         row: 'bg-danger/10' },
    low: { text: 'text-orange-500', bar: 'bg-orange-500', card: 'border-orange-500/40 bg-orange-500/[0.04]', row: 'bg-orange-500/10' },
    ok:  { text: 'text-success',    bar: 'bg-success',    card: 'border-success/30',                         row: 'bg-success/[0.06]' },
  }[level];
  const stockClass = tone.text;

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
      className={`relative flex flex-col rounded-2xl card-lux ${tone.card} hover:border-teal/30 transition-colors duration-200 overflow-hidden`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${tone.bar}`} />
      {/* ── Picture + name block: long names wrap, never clip ── */}
      <div className="px-4 pt-3.5 pb-2.5 flex items-start gap-3">
        <ProductThumb product={p} className="w-16 h-16 shrink-0 rounded-xl border border-white/10" />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-semibold text-slate-100 leading-snug break-words line-clamp-2" style={{ fontFamily: 'var(--font-display)' }}>
            {p.product_name}
          </p>
          <p className="text-[11px] text-muted mt-1.5 flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-teal/90 bg-teal/10 border border-teal/20 rounded-md px-1.5 py-0.5">
              {p.type || '—'}
            </span>
            {meta && <span className="truncate">{meta}</span>}
          </p>
          {p.selling_price != null && (
            <p className="text-[12px] font-bold text-gold mt-1.5">Ksh {p.selling_price.toLocaleString('en-KE')}</p>
          )}
        </div>
        {onEdit && (
          <button
            onClick={() => onEdit(p)}
            className="w-9 h-9 -mr-1.5 -mt-1 rounded-lg text-muted/70 hover:text-teal hover:bg-teal/10 flex items-center justify-center text-sm transition-colors shrink-0"
            title="Edit product"
            aria-label="Edit product"
          >✏️</button>
        )}
      </div>

      {/* ── Stock + controls row ── */}
      {history && (() => {
        const drift = history.closing !== total;
        const suspect = history.opening < 0 || history.closing < 0;
        return (
          <div className="px-4 py-2 border-t border-white/6 text-[11px] leading-relaxed">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
              <span className="text-muted">{history.fromLabel} start</span>
              <span className="font-bold text-slate-100">{history.opening}</span>
              {history.inQty > 0 && <span className="text-success font-semibold">+{history.inQty} in</span>}
              {history.outQty > 0 && <span className="text-danger font-semibold">−{history.outQty} out</span>}
              <span className="text-muted">→ {history.toLabel} end</span>
              <span className="font-bold text-slate-100">{history.closing}</span>
              {drift && <span className="text-muted">· now {total}</span>}
            </div>
            {suspect && <p className="text-orange-500 text-[10px] mt-0.5">⚠ Below zero — history before this period is incomplete for this item.</p>}
          </div>
        );
      })()}

      <div className={`px-4 py-2.5 border-t border-white/6 ${tone.row} flex items-center justify-between gap-3`}>
        <div className="min-w-0">
          <p className={`text-xs font-semibold ${stockClass}`}>
            {total <= reorder && total > 0 && '⚠ '}{stockLabel}
          </p>
          {total <= reorder && otherTotal > 0 && (
            <p className={`text-[10px] ${tone.text} opacity-75 mt-0.5`}>{otherTotal} available elsewhere</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onAdjust(p, 'minus', locationId)}
            aria-label="Reduce stock"
            className="w-10 h-10 rounded-xl bg-danger/10 border border-danger/25 text-danger text-xl font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all duration-150 active:scale-90"
          >−</button>

          <div className="flex flex-col items-center min-w-10">
            <span className="text-[22px] font-extrabold text-slate-100 tabular-nums leading-none" style={{ fontFamily: 'var(--font-display)' }}>
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
            className="w-10 h-10 rounded-xl btn-primary text-xl font-bold flex items-center justify-center"
          >+</button>
        </div>
      </div>
    </motion.div>
  );
}
