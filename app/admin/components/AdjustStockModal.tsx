'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import { upsertStock, logMovement } from '@/lib/stockActions';
import type { Product, StockMap, AdjAction, Location, ComponentMap } from '@/lib/types';
import { LOC_ID } from '@/lib/types';

interface Props {
  product:      Product | null;
  location:     Location;
  direction:    'plus' | 'minus' | null;
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
  componentMap?: ComponentMap;
  allProducts?:  Product[];
  onClose:      () => void;
  onSuccess:    (msg: string) => void;
  onError:      (msg: string) => void;
  onDone:       () => void;   // refetch after change
}

type AdjUnit = 'piece' | 'box';

function getActions(location: Location, direction: 'plus' | 'minus'): { key: AdjAction; icon: string; label: string }[] {
  if (location === 'main') {
    return direction === 'minus'
      ? [{ key: 'sold',      icon: '💰', label: 'Sold' },
         { key: 'to_back',   icon: '📦', label: 'Moved to Back Store' }]
      : [{ key: 'from_back', icon: '🔄', label: 'Moved from Back Store' },
         { key: 'stockin',   icon: '✅', label: 'Stock Added' }];
  }
  return direction === 'minus'
    ? [{ key: 'sold',        icon: '💰', label: 'Sold' },
       { key: 'to_front',    icon: '🏪', label: 'Moved to Front Store' }]
    : [{ key: 'from_main',   icon: '🔄', label: 'Moved from Main Store' },
       { key: 'stockin',     icon: '✅', label: 'Stock Added' }];
}


export default function AdjustStockModal({
  product, location, direction,
  backStockMap, mainStockMap, backBoxMap, mainBoxMap,
  componentMap = {}, allProducts = [],
  onClose, onSuccess, onError, onDone,
}: Props) {
  const [selectedAction, setSelectedAction] = useState<AdjAction | null>(null);
  const [unit, setUnit] = useState<AdjUnit>('piece');
  const [qty, setQty]   = useState(1);
  const [saving, setSaving] = useState(false);

  if (!product || !direction) return null;

  const ppb       = product.pieces_per_box || 0;
  const backQty   = backStockMap[product.product_id] || 0;
  const mainQty   = mainStockMap[product.product_id] || 0;
  const bxBack    = backBoxMap[product.product_id] || 0;
  const bxMain    = mainBoxMap[product.product_id] || 0;
  const backTotal = backQty + bxBack * (ppb || 1);
  const mainTotal = mainQty + bxMain * (ppb || 1);
  const backFmt   = formatStock(backTotal, product.unit_type, product.unit_of_measure, ppb);
  const mainFmt   = formatStock(mainTotal, product.unit_type, product.unit_of_measure, ppb);
  const isBox     = backFmt.unitBadge === 'BOX' && ppb > 0;

  const locId   = LOC_ID[location];
  const otherId = LOC_ID[location === 'back' ? 'main' : 'back'];
  const curQty  = location === 'back' ? backQty  : mainQty;
  const othQty  = location === 'back' ? mainQty  : backQty;
  const curBox  = location === 'back' ? bxBack   : bxMain;
  const othBox  = location === 'back' ? bxMain   : bxBack;
  const locName = location === 'back' ? 'Back Godown' : 'Main Store';
  const othName = location === 'back' ? 'Main Store'  : 'Back Godown';

  const actions = getActions(location, direction);

  const NOTE_MAP: Record<AdjAction, string> = {
    sold:       `Sold from ${locName}`,
    to_front:   'Moved from Back Godown to Main Store',
    to_back:    'Moved from Main Store to Back Godown',
    from_back:  'Moved from Back Godown to Main Store',
    from_main:  'Moved from Main Store to Back Godown',
    stockin:    `Stock added to ${locName}`,
  };
  const TYPE_MAP: Record<AdjAction, string> = {
    sold: 'SALE', to_front: 'TRANSFER', to_back: 'TRANSFER',
    from_back: 'TRANSFER', from_main: 'TRANSFER', stockin: 'ADJUSTMENT_IN',
  };

  async function confirm() {
    if (!product || !selectedAction || qty < 1) return;
    const isBoxUnit = unit === 'box';
    const movQty    = isBoxUnit ? qty * ppb : qty;
    const removesFromCur   = ['sold', 'to_front', 'to_back'].includes(selectedAction);
    const removesFromOther = ['from_main', 'from_back'].includes(selectedAction);

    if (removesFromCur) {
      if (isBoxUnit && qty > curBox)  { onError(`Only ${curBox} boxes in ${locName}`);  return; }
      if (!isBoxUnit && qty > curQty) { onError(`Only ${curQty} pcs in ${locName}`);    return; }
    }
    if (removesFromOther) {
      if (isBoxUnit && qty > othBox)  { onError(`Only ${othBox} boxes in ${othName}`);  return; }
      if (!isBoxUnit && qty > othQty) { onError(`Only ${othQty} pcs in ${othName}`);    return; }
    }

    setSaving(true);
    try {
      const field: 'quantity' | 'box_quantity' = isBoxUnit ? 'box_quantity' : 'quantity';
      if (selectedAction === 'sold') {
        await upsertStock(product.product_id, locId,   field, Math.max(0, (isBoxUnit ? curBox : curQty) - qty));
        await logMovement(product.product_id, locId, null, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction]);

      } else if (selectedAction === 'to_front' || selectedAction === 'to_back') {
        await upsertStock(product.product_id, locId,   field, Math.max(0, (isBoxUnit ? curBox : curQty) - qty));
        await upsertStock(product.product_id, otherId, field, (isBoxUnit ? othBox : othQty) + qty);
        await logMovement(product.product_id, locId, otherId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction]);

      } else if (selectedAction === 'from_back' || selectedAction === 'from_main') {
        await upsertStock(product.product_id, otherId, field, Math.max(0, (isBoxUnit ? othBox : othQty) - qty));
        await upsertStock(product.product_id, locId,   field, (isBoxUnit ? curBox : curQty) + qty);
        await logMovement(product.product_id, otherId, locId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction]);

      } else if (selectedAction === 'stockin') {
        await upsertStock(product.product_id, locId, field, (isBoxUnit ? curBox : curQty) + qty);
        await logMovement(product.product_id, null, locId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction]);
      }

      // Deduct components for outbound actions
      if (['sold', 'to_front', 'to_back'].includes(selectedAction)) {
        const components = componentMap[product.product_id] ?? [];
        for (const comp of components) {
          const compCurQty = location === 'back'
            ? (backStockMap[comp.component_product_id] || 0)
            : (mainStockMap[comp.component_product_id] || 0);
          const deductQty = movQty * comp.quantity;
          await upsertStock(
            comp.component_product_id,
            locId,
            'quantity',
            Math.max(0, compCurQty - deductQty),
          );
          await logMovement(
            comp.component_product_id,
            locId,
            null,
            deductQty,
            TYPE_MAP[selectedAction],
            'Auto: component of ' + product.product_name,
          );
        }
      }

      const unitLabel = isBoxUnit ? `box${qty !== 1 ? 'es' : ''}` : `unit${qty !== 1 ? 's' : ''}`;
      const actionLabel: Record<AdjAction, string> = {
        sold: 'Sold', to_front: 'Moved to front', to_back: 'Moved to back',
        from_back: 'Moved from back', from_main: 'Moved from main', stockin: 'Stock added',
      };
      onSuccess(`${actionLabel[selectedAction]} — ${qty} ${unitLabel}`);
      onClose();
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-100 flex items-end sm:items-center justify-center bg-black/65 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ opacity: 0, y: 60 }} animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 60 }}
          transition={{ type: 'spring', damping: 20, stiffness: 260 }}
          className="w-full max-w-sm bg-surface border border-white/8 rounded-t-3xl sm:rounded-2xl p-5 pb-8 sm:pb-5 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-4 sm:hidden" />

          <h3 className="font-bold text-slate-100 text-base mb-1 truncate">{product.product_name}</h3>
          <p className="text-xs text-muted font-mono mb-4">
            Back: {backFmt.label} · Main: {mainFmt.label}
          </p>

          {isBox && (
            <div className="flex gap-2 mb-4">
              {(['piece', 'box'] as AdjUnit[]).map((u) => (
                <button
                  key={u}
                  onClick={() => { setUnit(u); setQty(1); }}
                  className={`flex-1 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                    unit === u
                      ? u === 'piece'
                        ? 'border-teal bg-teal/10 text-teal'
                        : 'border-gold bg-gold/10 text-gold'
                      : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                  }`}
                >
                  {u === 'piece' ? '📌 Piece' : `📦 Box (${ppb} pcs)`}
                </button>
              ))}
            </div>
          )}

          <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">
            {direction === 'minus' ? 'What happened?' : 'Where is it from?'}
          </p>

          <div className="flex gap-2 mb-4">
            {actions.map((a) => (
              <button
                key={a.key}
                onClick={() => setSelectedAction(a.key)}
                className={`flex-1 py-3 rounded-xl border text-center text-xs font-semibold transition-all leading-tight ${
                  selectedAction === a.key
                    ? direction === 'minus'
                      ? 'border-danger bg-danger/10 text-danger'
                      : 'border-teal  bg-teal/10  text-teal'
                    : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                }`}
              >
                <span className="block text-2xl mb-1">{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>

          {selectedAction && ['sold', 'to_front', 'to_back'].includes(selectedAction) &&
            (componentMap[product.product_id]?.length ?? 0) > 0 && (
            <div className="mb-4 rounded-xl bg-surface2 border border-white/8 px-3 py-2.5">
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5">
                🔧 Components also deducted:
              </p>
              <ul className="flex flex-col gap-0.5">
                {componentMap[product.product_id].map(c => {
                  const name = allProducts.find(p => p.product_id === c.component_product_id)?.product_name
                    ?? `#${c.component_product_id}`;
                  return (
                    <li key={c.component_product_id} className="text-xs text-slate-300">
                      • {name} × {c.quantity} per unit
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">
            {unit === 'box' ? `Quantity (boxes · 1 box = ${ppb} pcs)` : 'Quantity'}
          </p>

          <div className="flex items-center gap-3 mb-5">
            <button
              onClick={() => setQty(q => Math.max(1, q - 1))}
              className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center hover:border-teal/40 transition-colors"
            >−</button>
            <input
              type="number" min={1} value={qty}
              onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
              className="flex-1 text-center text-2xl font-bold bg-surface2 border border-white/10 rounded-xl py-2.5 text-slate-100 outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            <button
              onClick={() => setQty(q => q + 1)}
              className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center hover:border-teal/40 transition-colors"
            >+</button>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold hover:border-white/20 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={!selectedAction || saving}
              className={`flex-2 basis-2/3 py-3 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                direction === 'minus'
                  ? 'bg-linear-to-r from-danger to-red-600 shadow-[0_4px_14px_rgba(239,68,68,0.35)]'
                  : 'bg-linear-to-r from-teal to-teal/70 shadow-[0_4px_14px_rgba(0,212,255,0.3)]'
              }`}
            >
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
