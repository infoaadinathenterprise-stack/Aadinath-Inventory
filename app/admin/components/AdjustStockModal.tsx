'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatStock } from '@/lib/formatStock';
import { upsertStock, logMovement, submitPendingRequest } from '@/lib/stockActions';
import type { Product, StockByLoc, AdjAction, LocationInfo, ComponentMap, UserRole } from '@/lib/types';

interface Props {
  product:      Product | null;
  locationId:   number;                 // which location we're adjusting
  direction:    'plus' | 'minus' | null;
  locations:    LocationInfo[];         // all active locations
  stockByLoc:   StockByLoc;
  boxByLoc:     StockByLoc;
  componentMap?: ComponentMap;
  allProducts?:  Product[];
  userRole?:    UserRole;
  onClose:      () => void;
  onSuccess:    (msg: string) => void;
  onError:      (msg: string) => void;
  onDone:       () => void;
}

type AdjUnit = 'piece' | 'box';

function getActions(direction: 'plus' | 'minus'): { key: AdjAction; icon: string; label: string }[] {
  if (direction === 'minus') return [
    { key: 'sold',     icon: '💰', label: 'Sold' },
    { key: 'transfer', icon: '📦', label: 'Transfer to…' },
  ];
  return [
    { key: 'receive',  icon: '🔄', label: 'Receive from…' },
    { key: 'stockin',  icon: '✅', label: 'Stock Added' },
  ];
}

export default function AdjustStockModal({
  product, locationId, direction,
  locations, stockByLoc, boxByLoc,
  componentMap = {}, allProducts = [],
  userRole = 'admin',
  onClose, onSuccess, onError, onDone,
}: Props) {
  const [selectedAction, setSelectedAction] = useState<AdjAction | null>(null);
  const [transferLocId,  setTransferLocId]  = useState<number | null>(null);
  const [unit,           setUnit]           = useState<AdjUnit>('piece');
  const [qty,            setQty]            = useState(1);
  const [saving,         setSaving]         = useState(false);
  const [groupChoices,   setGroupChoices]   = useState<Record<string, number>>({});

  if (!product || !direction) return null;

  // ── Employee: cannot subtract stock manually ────────────────────────
  if (userRole === 'staff' && direction === 'minus') {
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
            className="w-full max-w-sm card-lux rounded-t-3xl sm:rounded-2xl p-6 pb-8 sm:pb-6 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-5 sm:hidden" />
            <div className="text-4xl mb-3">🔒</div>
            <p className="font-bold text-slate-100 text-base mb-2">Not Authorized</p>
            <p className="text-xs text-muted leading-relaxed mb-6">
              Only admins can reduce inventory.<br />Contact your admin to make adjustments.
            </p>
            <button onClick={onClose} className="w-full py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold hover:border-white/20 transition-colors">
              Close
            </button>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    );
  }

  const ppb     = product.pieces_per_box || 0;
  const isBox   = ppb > 0;
  const isBoxUnit = unit === 'box';
  const movQty  = isBoxUnit ? qty * ppb : qty;

  const locName = locations.find(l => l.location_id === locationId)?.location_name ?? `Location #${locationId}`;
  const otherLocs = locations.filter(l => l.location_id !== locationId);

  // Stock at current location
  const curPcs  = (stockByLoc[locationId]  ?? {})[product.product_id] ?? 0;
  const curBox  = (boxByLoc[locationId]    ?? {})[product.product_id] ?? 0;
  const curPool = curPcs + curBox * ppb;

  // Stock at transfer/receive partner location
  const tPcs  = transferLocId ? ((stockByLoc[transferLocId] ?? {})[product.product_id] ?? 0) : 0;
  const tBox  = transferLocId ? ((boxByLoc[transferLocId]   ?? {})[product.product_id] ?? 0) : 0;
  const tPool = tPcs + tBox * ppb;

  const needsPartner = selectedAction === 'transfer' || selectedAction === 'receive';

  const actions = getActions(direction);

  // Components
  const productComponents = componentMap[product.product_id] ?? [];
  const alwaysComps = productComponents.filter(c => !c.choice_group);
  const choiceGroupMap: Record<string, typeof productComponents> = {};
  for (const c of productComponents) {
    if (!c.choice_group) continue;
    (choiceGroupMap[c.choice_group] ??= []).push(c);
  }
  const choiceGroupNames = Object.keys(choiceGroupMap);

  function deductFrom(pcs: number, bx: number): { quantity: number; box_quantity: number } {
    if (isBoxUnit) {
      const boxesToDeduct = Math.min(qty, bx);
      return { quantity: pcs - (qty - boxesToDeduct) * ppb, box_quantity: bx - boxesToDeduct };
    }
    const fromLoose     = Math.min(qty, pcs);
    const fromBoxPieces = qty - fromLoose;
    const boxesToBreak  = ppb > 0 ? Math.ceil(fromBoxPieces / ppb) : 0;
    return { quantity: pcs - fromLoose + boxesToBreak * ppb - fromBoxPieces, box_quantity: bx - boxesToBreak };
  }

  function addTo(pcs: number, bx: number): { quantity: number; box_quantity: number } {
    return isBoxUnit ? { quantity: pcs, box_quantity: bx + qty } : { quantity: pcs + qty, box_quantity: bx };
  }

  async function confirm() {
    if (!product || !selectedAction || qty < 1) return;
    if (needsPartner && !transferLocId) { onError('Select a destination location'); return; }

    // Validate component choice groups
    if (selectedAction === 'sold' || selectedAction === 'transfer') {
      for (const g of choiceGroupNames) {
        if (groupChoices[g] == null) { onError(`Pick a ${g} before confirming`); return; }
      }
    }

    // Stock sufficiency checks
    if ((selectedAction === 'sold' || selectedAction === 'transfer') && movQty > curPool) {
      onError(`Not enough stock at ${locName}`); return;
    }
    if (selectedAction === 'receive' && movQty > tPool) {
      const partnerName = locations.find(l => l.location_id === transferLocId)?.location_name ?? 'source';
      onError(`Not enough stock at ${partnerName}`); return;
    }

    // Component validation for outbound actions
    if (selectedAction === 'sold' || selectedAction === 'transfer') {
      const pickedCheck = choiceGroupNames
        .map(g => choiceGroupMap[g].find(c => c.component_product_id === groupChoices[g]))
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      for (const comp of [...alwaysComps, ...pickedCheck]) {
        const cid      = comp.component_product_id;
        const cPpb     = allProducts.find(p => p.product_id === cid)?.pieces_per_box ?? 0;
        const srcPcs   = (stockByLoc[locationId] ?? {})[cid] ?? 0;
        const srcBx    = (boxByLoc[locationId]   ?? {})[cid] ?? 0;
        const srcTotal = srcPcs + srcBx * cPpb;
        const movComp  = movQty * comp.quantity;
        if (srcTotal < movComp) {
          const compName = allProducts.find(p => p.product_id === cid)?.product_name ?? `#${cid}`;
          const othTotal = otherLocs.reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[cid] ?? 0) + ((boxByLoc[l.location_id] ?? {})[cid] ?? 0) * cPpb, 0);
          const hint = othTotal > 0 ? ` · ${othTotal} available elsewhere` : '';
          onError(`Not enough "${compName}" at ${locName}: need ${movComp}, have ${srcTotal}${hint}`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      // ── Employee stock-in → PENDING approval ──
      if (userRole === 'staff') {
        await submitPendingRequest(product.product_id, locationId, movQty, `Stock-in request · ${locName}`);
        onSuccess('Submitted for admin approval ✓');
        onClose(); onDone(); return;
      }

      const partnerName = transferLocId ? (locations.find(l => l.location_id === transferLocId)?.location_name ?? '') : '';

      if (selectedAction === 'sold') {
        const newState = deductFrom(curPcs, curBox);
        const before = curPool;
        const after  = newState.quantity + newState.box_quantity * ppb;
        await logMovement(product.product_id, locationId, null, movQty, 'SALE', `Sold from ${locName}`, { before, after });
        await upsertStock(product.product_id, locationId, newState);

      } else if (selectedAction === 'transfer') {
        const newCur = deductFrom(curPcs, curBox);
        const newDst = addTo(tPcs, tBox);
        const before = curPool;
        const after  = newCur.quantity + newCur.box_quantity * ppb;
        await logMovement(product.product_id, locationId, transferLocId!, movQty, 'TRANSFER', `Transferred from ${locName} to ${partnerName}`, { before, after });
        await upsertStock(product.product_id, locationId,    newCur);
        await upsertStock(product.product_id, transferLocId!, newDst);

      } else if (selectedAction === 'receive') {
        const newSrc = deductFrom(tPcs, tBox);
        const newCur = addTo(curPcs, curBox);
        const before = tPool;
        const after  = newSrc.quantity + newSrc.box_quantity * ppb;
        await logMovement(product.product_id, transferLocId!, locationId, movQty, 'TRANSFER', `Transferred from ${partnerName} to ${locName}`, { before, after });
        await upsertStock(product.product_id, transferLocId!, newSrc);
        await upsertStock(product.product_id, locationId,     newCur);

      } else if (selectedAction === 'stockin') {
        const newState = addTo(curPcs, curBox);
        const before = curPool;
        const after  = newState.quantity + newState.box_quantity * ppb;
        await logMovement(product.product_id, null, locationId, movQty, 'ADJUSTMENT_IN', `Stock added to ${locName}`, { before, after });
        await upsertStock(product.product_id, locationId, newState);
      }

      // Components for sold / transfer
      if (selectedAction === 'sold' || selectedAction === 'transfer') {
        const isTransfer = selectedAction === 'transfer';
        const pickedFromGroups = choiceGroupNames
          .map(g => choiceGroupMap[g].find(c => c.component_product_id === groupChoices[g]))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));

        function deductCompPieces(pcs: number, bx: number, pieces: number, cPpb: number) {
          const fromLoose = Math.min(pieces, pcs);
          const fromBoxPieces = pieces - fromLoose;
          const boxesToBreak  = cPpb > 0 ? Math.ceil(fromBoxPieces / cPpb) : 0;
          return {
            quantity:     Math.max(0, pcs - fromLoose + boxesToBreak * cPpb - fromBoxPieces),
            box_quantity: Math.max(0, bx - boxesToBreak),
          };
        }

        for (const comp of [...alwaysComps, ...pickedFromGroups]) {
          const cid     = comp.component_product_id;
          const cPpb    = allProducts.find(p => p.product_id === cid)?.pieces_per_box ?? 0;
          const movComp = movQty * comp.quantity;
          const srcPcs  = (stockByLoc[locationId] ?? {})[cid] ?? 0;
          const srcBx   = (boxByLoc[locationId]   ?? {})[cid] ?? 0;
          const newSrc  = deductCompPieces(srcPcs, srcBx, movComp, cPpb);
          const cBefore = srcPcs + srcBx * cPpb;
          const cAfter  = newSrc.quantity + newSrc.box_quantity * cPpb;

          if (isTransfer) {
            const dPcs = (stockByLoc[transferLocId!] ?? {})[cid] ?? 0;
            const dBx  = (boxByLoc[transferLocId!]   ?? {})[cid] ?? 0;
            await logMovement(cid, locationId, transferLocId!, movComp, 'TRANSFER', `Auto: component of ${product.product_name}`, { before: cBefore, after: cAfter });
            await upsertStock(cid, locationId,    newSrc);
            await upsertStock(cid, transferLocId!, { quantity: dPcs + movComp, box_quantity: dBx });
          } else {
            await logMovement(cid, locationId, null, movComp, 'AUTO_DEDUCT', `Auto: component of ${product.product_name}`, { before: cBefore, after: cAfter });
            await upsertStock(cid, locationId, newSrc);
          }
        }
      }

      const unitLabel = isBoxUnit ? `box${qty !== 1 ? 'es' : ''}` : `unit${qty !== 1 ? 's' : ''}`;
      const actionLabel: Record<AdjAction, string> = {
        sold: 'Sold', transfer: 'Transferred', receive: 'Received', stockin: 'Stock added',
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

  // Stock summary for all locations
  const locationStockLines = locations.map(loc => {
    const pcs = (stockByLoc[loc.location_id] ?? {})[product.product_id] ?? 0;
    const bx  = (boxByLoc[loc.location_id]   ?? {})[product.product_id] ?? 0;
    const fmt = formatStock(pcs + bx * ppb, product.unit_type, product.unit_of_measure, ppb);
    return { loc, fmt, isCurrent: loc.location_id === locationId };
  });

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
          className="w-full max-w-sm card-lux rounded-t-3xl sm:rounded-2xl p-5 pb-8 sm:pb-5 shadow-2xl max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-4 sm:hidden" />

          <h3 className="font-bold text-slate-100 text-base mb-1 leading-snug break-words">{product.product_name}</h3>

          {/* Per-location stock summary */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {locationStockLines.map(({ loc, fmt, isCurrent }) => (
              <span key={loc.location_id} className={`text-[10px] font-mono px-2 py-0.5 rounded-md border ${
                isCurrent ? 'border-teal/40 bg-teal/10 text-teal' : 'border-white/10 bg-surface2 text-muted'
              }`}>
                {loc.location_name}: {fmt.label}
              </span>
            ))}
          </div>

          {isBox && (
            <div className="flex gap-2 mb-4">
              {(['piece', 'box'] as AdjUnit[]).map(u => (
                <button key={u} onClick={() => { setUnit(u); setQty(1); }}
                  className={`flex-1 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                    unit === u
                      ? u === 'piece' ? 'border-teal bg-teal/10 text-teal' : 'border-gold bg-gold/10 text-gold'
                      : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                  }`}>
                  {u === 'piece' ? '📌 Piece' : `📦 Box (${ppb} pcs)`}
                </button>
              ))}
            </div>
          )}

          <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">
            {direction === 'minus' ? 'What happened?' : 'Where is it from?'}
          </p>

          <div className="flex gap-2 mb-3">
            {actions.map(a => (
              <button key={a.key} onClick={() => { setSelectedAction(a.key); setTransferLocId(null); }}
                className={`flex-1 py-3 rounded-xl border text-center text-xs font-semibold transition-all leading-tight ${
                  selectedAction === a.key
                    ? direction === 'minus' ? 'border-danger bg-danger/10 text-danger' : 'border-teal bg-teal/10 text-teal'
                    : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                }`}>
                <span className="block text-2xl mb-1">{a.icon}</span>{a.label}
              </button>
            ))}
          </div>

          {/* Location picker for transfer / receive */}
          {needsPartner && otherLocs.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">
                {selectedAction === 'transfer' ? 'Transfer to:' : 'Receive from:'}
              </p>
              <div className="flex flex-col gap-1.5">
                {otherLocs.map(loc => {
                  const pcs  = (stockByLoc[loc.location_id] ?? {})[product.product_id] ?? 0;
                  const bx   = (boxByLoc[loc.location_id]   ?? {})[product.product_id] ?? 0;
                  const fmt  = formatStock(pcs + bx * ppb, product.unit_type, product.unit_of_measure, ppb);
                  const sel  = transferLocId === loc.location_id;
                  return (
                    <button key={loc.location_id} onClick={() => setTransferLocId(loc.location_id)}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl border text-sm font-semibold transition-all ${
                        sel ? 'border-teal bg-teal/10 text-teal' : 'border-white/8 bg-surface2 text-slate-300 hover:border-teal/30'
                      }`}>
                      <span>{sel ? '✓ ' : ''}{loc.location_name}</span>
                      <span className="text-[10px] font-mono text-muted">{fmt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Component pickers */}
          {selectedAction && (selectedAction === 'sold' || selectedAction === 'transfer') && productComponents.length > 0 && (
            <div className="mb-4 flex flex-col gap-2">
              {alwaysComps.length > 0 && (
                <div className="rounded-xl bg-surface2 border border-white/8 px-3 py-2.5">
                  <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5">🔧 Always deducted:</p>
                  <ul className="flex flex-col gap-0.5">
                    {alwaysComps.map(c => {
                      const name = allProducts.find(p => p.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`;
                      return <li key={c.component_product_id} className="text-xs text-slate-300">• {name} × {c.quantity} per unit</li>;
                    })}
                  </ul>
                </div>
              )}
              {choiceGroupNames.map(groupName => {
                const members = choiceGroupMap[groupName];
                const picked  = groupChoices[groupName];
                return (
                  <div key={groupName} className="rounded-xl bg-gold/5 border border-gold/30 px-3 py-2.5">
                    <p className="text-[10px] font-bold text-gold uppercase tracking-widest mb-2">Pick {groupName}</p>
                    <div className="flex flex-col gap-1.5">
                      {members.map(c => {
                        const name = allProducts.find(p => p.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`;
                        const isPicked = picked === c.component_product_id;
                        return (
                          <button key={c.component_product_id}
                            onClick={() => setGroupChoices(prev => ({ ...prev, [groupName]: c.component_product_id }))}
                            className={`text-left px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
                              isPicked ? 'border-gold bg-gold/15 text-gold' : 'border-white/8 bg-surface2 text-slate-300 hover:border-gold/40'
                            }`}>
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
            <button onClick={() => setQty(q => Math.max(1, q - 1))}
              className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center hover:border-teal/40 transition-colors">−</button>
            <input type="number" min={1} value={qty}
              onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
              onWheel={e => e.currentTarget.blur()}
              className="flex-1 text-center text-2xl font-bold bg-surface2 border border-white/10 rounded-xl py-2.5 text-slate-100 outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
            <button onClick={() => setQty(q => q + 1)}
              className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center hover:border-teal/40 transition-colors">+</button>
          </div>

          <div className="flex gap-3">
            <button onClick={onClose}
              className="flex-1 py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold hover:border-white/20 transition-colors">
              Cancel
            </button>
            <button onClick={confirm} disabled={!selectedAction || (needsPartner && !transferLocId) || saving}
              className={`flex-2 basis-2/3 py-3 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                direction === 'minus'
                  ? 'bg-gradient-to-r from-danger to-red-600 shadow-[0_8px_24px_-8px_rgba(240,82,82,0.5)] hover:brightness-110 active:scale-[0.98]'
                  : 'btn-primary'
              }`}>
              {saving ? 'Saving…' : userRole === 'staff' ? 'Submit for Approval' : 'Confirm'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
