'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import { upsertStock, logMovement, submitPendingRequest } from '@/lib/stockActions';
import type { Product, StockMap, AdjAction, Location, ComponentMap, UserRole } from '@/lib/types';
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
  userRole?:    UserRole;
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
  userRole = 'admin',
  onClose, onSuccess, onError, onDone,
}: Props) {
  const [selectedAction, setSelectedAction] = useState<AdjAction | null>(null);
  const [unit, setUnit] = useState<AdjUnit>('piece');
  const [qty, setQty]   = useState(1);
  const [saving, setSaving] = useState(false);
  // For each choice_group on this product, which component_product_id the user picked.
  const [groupChoices, setGroupChoices] = useState<Record<string, number>>({});

  if (!product || !direction) return null;

  // ── Employee: cannot subtract stock manually ─────────────────────────
  if (userRole === 'employee' && direction === 'minus') {
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
            className="w-full max-w-sm bg-surface border border-white/8 rounded-t-3xl sm:rounded-2xl p-6 pb-8 sm:pb-6 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-5 sm:hidden" />
            <div className="text-4xl mb-3">🔒</div>
            <p className="font-bold text-slate-100 text-base mb-2">Not Authorized</p>
            <p className="text-xs text-muted leading-relaxed mb-6">
              Only admins can reduce inventory.<br />
              Contact your admin to make adjustments.
            </p>
            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold hover:border-white/20 transition-colors"
            >
              Close
            </button>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    );
  }

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

  // Split this product's components into always-deducted and groups of alternatives.
  const productComponents = product ? (componentMap[product.product_id] ?? []) : [];
  const alwaysComps = productComponents.filter(c => !c.choice_group);
  const choiceGroupMap: Record<string, typeof productComponents> = {};
  for (const c of productComponents) {
    if (!c.choice_group) continue;
    (choiceGroupMap[c.choice_group] ??= []).push(c);
  }
  const choiceGroupNames = Object.keys(choiceGroupMap);

  async function confirm() {
    if (!product || !selectedAction || qty < 1) return;
    // Outbound actions must have a pick for every choice group.
    if (['sold', 'to_front', 'to_back'].includes(selectedAction)) {
      for (const g of choiceGroupNames) {
        if (groupChoices[g] == null) {
          onError(`Pick a ${g} before confirming`);
          return;
        }
      }
    }
    const isBoxUnit = unit === 'box';
    const movQty    = isBoxUnit ? qty * ppb : qty;  // always in pieces

    const curPool = curQty + curBox * ppb;
    const othPool = othQty + othBox * ppb;

    const removesFromCur   = ['sold', 'to_front', 'to_back'].includes(selectedAction);
    const removesFromOther = ['from_main', 'from_back'].includes(selectedAction);

    if (removesFromCur && movQty > curPool) {
      onError(`Not enough stock in ${locName}`);
      return;
    }
    if (removesFromOther && movQty > othPool) {
      onError(`Not enough stock in ${othName}`);
      return;
    }

    // Validate component stock for outbound actions before any DB write.
    // For sold: components only come from the current location in the modal
    //           (no auto-pull — manual operations should be explicit).
    // For transfers: components travel with the product so must exist in source.
    if (['sold', 'to_front', 'to_back'].includes(selectedAction)) {
      const pickedCheck = choiceGroupNames
        .map(g => choiceGroupMap[g].find(c => c.component_product_id === groupChoices[g]))
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      for (const comp of [...alwaysComps, ...pickedCheck]) {
        const cid      = comp.component_product_id;
        const cPpb     = allProducts.find(p => p.product_id === cid)?.pieces_per_box ?? 0;
        const srcPcs   = location === 'back' ? (backStockMap[cid] || 0) : (mainStockMap[cid] || 0);
        const srcBx    = location === 'back' ? (backBoxMap[cid]   || 0) : (mainBoxMap[cid]   || 0);
        const srcTotal = srcPcs + srcBx * cPpb;
        const movComp  = movQty * comp.quantity;
        if (srcTotal < movComp) {
          const compName = allProducts.find(p => p.product_id === cid)?.product_name ?? `#${cid}`;
          const othPcs   = location === 'back' ? (mainStockMap[cid] || 0) : (backStockMap[cid] || 0);
          const othBx    = location === 'back' ? (mainBoxMap[cid]   || 0) : (backBoxMap[cid]   || 0);
          const othTotal = othPcs + othBx * cPpb;
          const hint     = othTotal > 0
            ? ` · ${othTotal} available in ${othName} — transfer components first`
            : '';
          onError(`Not enough "${compName}" in ${locName}: need ${movComp}, have ${srcTotal}${hint}`);
          return;
        }
      }
    }

    // Deduct movQty pieces from a location, preferring to consume whole boxes
    // before dipping into loose pieces (box-mode), or loose pieces before
    // breaking boxes (piece-mode).
    function deductFrom(pcs: number, bx: number): { quantity: number; box_quantity: number } {
      if (isBoxUnit) {
        const boxesToDeduct = Math.min(qty, bx);
        const newBox = bx - boxesToDeduct;
        const newQty = pcs - (qty - boxesToDeduct) * ppb;
        return { quantity: newQty, box_quantity: newBox };
      }
      const fromLoose     = Math.min(qty, pcs);
      const fromBoxPieces = qty - fromLoose;
      const boxesToBreak  = ppb > 0 ? Math.ceil(fromBoxPieces / ppb) : 0;
      return {
        quantity:     pcs - fromLoose + boxesToBreak * ppb - fromBoxPieces,
        box_quantity: bx - boxesToBreak,
      };
    }

    function addTo(pcs: number, bx: number): { quantity: number; box_quantity: number } {
      return isBoxUnit
        ? { quantity: pcs, box_quantity: bx + qty }
        : { quantity: pcs + qty, box_quantity: bx };
    }

    setSaving(true);
    try {
      // ── Employee stock-in: submit for admin approval, don't touch stock ──
      if (userRole === 'employee') {
        const locName = location === 'back' ? 'Back Godown' : 'Main Store';
        await submitPendingRequest(
          product.product_id,
          locId,
          movQty,
          `Stock-in request · ${locName}`,
        );
        onSuccess('Submitted for admin approval ✓');
        onClose();
        onDone();
        return;
      }

      // Rule: logMovement ALWAYS runs BEFORE upsertStock.
      // If logMovement throws (e.g. DB constraint), stock is untouched — no partial writes.
      if (selectedAction === 'sold') {
        const newState = deductFrom(curQty, curBox);
        const before = curQty + curBox * ppb;
        const after  = newState.quantity + newState.box_quantity * ppb;
        await logMovement(product.product_id, locId, null, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction], { before, after });
        await upsertStock(product.product_id, locId, newState);

      } else if (selectedAction === 'to_front' || selectedAction === 'to_back') {
        const newCurState = deductFrom(curQty, curBox);
        const newOthState = addTo(othQty, othBox);
        const before = curQty + curBox * ppb;
        const after  = newCurState.quantity + newCurState.box_quantity * ppb;
        await logMovement(product.product_id, locId, otherId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction], { before, after });
        await upsertStock(product.product_id, locId, newCurState);
        await upsertStock(product.product_id, otherId, newOthState);

      } else if (selectedAction === 'from_back' || selectedAction === 'from_main') {
        const newOthState = deductFrom(othQty, othBox);
        const newCurState = addTo(curQty, curBox);
        const before = othQty + othBox * ppb;
        const after  = newOthState.quantity + newOthState.box_quantity * ppb;
        await logMovement(product.product_id, otherId, locId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction], { before, after });
        await upsertStock(product.product_id, otherId, newOthState);
        await upsertStock(product.product_id, locId, newCurState);

      } else if (selectedAction === 'stockin') {
        const newState = addTo(curQty, curBox);
        const before = curQty + curBox * ppb;
        const after  = newState.quantity + newState.box_quantity * ppb;
        await logMovement(product.product_id, null, locId, movQty, TYPE_MAP[selectedAction], NOTE_MAP[selectedAction], { before, after });
        await upsertStock(product.product_id, locId, newState);
      }

      // Apply components for outbound actions.
      // Sold   → deduct from source only (components consumed).
      // to_front / to_back → deduct from source AND add to destination
      //                      (components travel with the product).
      // Box-aware: uses the component's own pieces_per_box so
      // box_quantity is properly decremented when whole boxes break.
      if (['sold', 'to_front', 'to_back'].includes(selectedAction)) {
        const isTransferAction = selectedAction === 'to_front' || selectedAction === 'to_back';
        const pickedFromGroups = choiceGroupNames
          .map(g => choiceGroupMap[g].find(c => c.component_product_id === groupChoices[g]))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        const components = [...alwaysComps, ...pickedFromGroups];

        // Box-aware piece deduction helper (mirrors deductFrom but for an
        // arbitrary piece count and a different ppb than the parent product).
        function deductCompPieces(pcs: number, bx: number, pieces: number, cPpb: number) {
          const fromLoose     = Math.min(pieces, pcs);
          const fromBoxPieces = pieces - fromLoose;
          const boxesToBreak  = cPpb > 0 ? Math.ceil(fromBoxPieces / cPpb) : 0;
          return {
            quantity:     Math.max(0, pcs - fromLoose + boxesToBreak * cPpb - fromBoxPieces),
            box_quantity: Math.max(0, bx - boxesToBreak),
          };
        }

        for (const comp of components) {
          const cid     = comp.component_product_id;
          const cPpb    = allProducts.find(p => p.product_id === cid)?.pieces_per_box ?? 0;
          const movComp = movQty * comp.quantity;   // pieces of this component to handle

          // Source stock
          const srcPcs = location === 'back' ? (backStockMap[cid] || 0) : (mainStockMap[cid] || 0);
          const srcBx  = location === 'back' ? (backBoxMap[cid]   || 0) : (mainBoxMap[cid]   || 0);

          const newSrcState = deductCompPieces(srcPcs, srcBx, movComp, cPpb);
          const cBefore = srcPcs + srcBx * cPpb;
          const cAfter  = newSrcState.quantity + newSrcState.box_quantity * cPpb;

          if (isTransferAction) {
            // Add to destination as loose pieces
            const dstPcs = location === 'back' ? (mainStockMap[cid] || 0) : (backStockMap[cid] || 0);
            const dstBx  = location === 'back' ? (mainBoxMap[cid]   || 0) : (backBoxMap[cid]   || 0);
            await logMovement(cid, locId, otherId, movComp, 'TRANSFER', `Auto: component of ${product.product_name}`, { before: cBefore, after: cAfter });
            await upsertStock(cid, locId, newSrcState);
            await upsertStock(cid, otherId, { quantity: dstPcs + movComp, box_quantity: dstBx });
          } else {
            // Sold — components consumed, not moved.
            await logMovement(cid, locId, null, movComp, 'AUTO_DEDUCT', `Auto: component of ${product.product_name}`, { before: cBefore, after: cAfter });
            await upsertStock(cid, locId, newSrcState);
          }
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

          {selectedAction && ['sold', 'to_front', 'to_back'].includes(selectedAction) && productComponents.length > 0 && (
            <div className="mb-4 flex flex-col gap-2">
              {alwaysComps.length > 0 && (
                <div className="rounded-xl bg-surface2 border border-white/8 px-3 py-2.5">
                  <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5">
                    🔧 Always deducted:
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {alwaysComps.map(c => {
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

              {choiceGroupNames.map(groupName => {
                const members = choiceGroupMap[groupName];
                const picked = groupChoices[groupName];
                return (
                  <div key={groupName} className="rounded-xl bg-gold/5 border border-gold/30 px-3 py-2.5">
                    <p className="text-[10px] font-bold text-gold uppercase tracking-widest mb-2">
                      Pick {groupName} ({members.length} options)
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {members.map(c => {
                        const name = allProducts.find(p => p.product_id === c.component_product_id)?.product_name
                          ?? `#${c.component_product_id}`;
                        const isPicked = picked === c.component_product_id;
                        return (
                          <button
                            key={c.component_product_id}
                            onClick={() => setGroupChoices(prev => ({ ...prev, [groupName]: c.component_product_id }))}
                            className={`text-left px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
                              isPicked
                                ? 'border-gold bg-gold/15 text-gold'
                                : 'border-white/8 bg-surface2 text-slate-300 hover:border-gold/40'
                            }`}
                          >
                            {isPicked && '✓ '}{name} <span className="text-muted font-normal">× {c.quantity}/unit</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
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
              onWheel={e => e.currentTarget.blur()}
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
              {saving ? 'Saving…' : userRole === 'employee' ? 'Submit for Approval' : 'Confirm'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
