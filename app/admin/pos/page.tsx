'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useProducts } from '@/lib/hooks/useProducts';
import { useProductComponents } from '@/lib/hooks/useProductComponents';
import { formatStock } from '@/lib/formatStock';
import { supabase } from '@/lib/supabase';
import { upsertStock, logMovement } from '@/lib/stockActions';
import AdjustStockModal from '@/app/admin/components/AdjustStockModal';
import BarcodeScanner   from '@/app/admin/components/BarcodeScanner';
import Toast, { type ToastState } from '@/app/admin/components/Toast';
import type { Product, LocationInfo } from '@/lib/types';
import { SESSION_KEY, USER_KEY } from '@/lib/types';

// ── Auth guard ─────────────────────────────────────────────────────────────────

export default function PosPage() {
  const router  = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || localStorage.getItem(SESSION_KEY) !== '1') {
      router.replace('/admin');
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return <div className="min-h-screen bg-navy" />;
  return <PosDashboard />;
}

type CartUnit = 'piece' | 'box';

interface CartItem {
  product:         Product;
  qty:             number;
  unit:            CartUnit;
  sellPrice:       number | null;
  groupChoices:    Record<string, number>;
  transferDestId?: number;  // selected destination for → Move action
}

// Does this product have a bulk unit (box/roll/etc.)? Gate on
// pieces_per_box > 0 so it works for any unit_type that has a
// multi-piece bulk concept, not just the literal word "box".
function hasBulkUnit(p: Product): boolean {
  return (p.pieces_per_box ?? 0) > 0;
}

// Human-readable label for either unit on this product. Uses the
// product's own unit_of_measure ("Piece" / "Meter" / "Litre") for the
// small unit and display_unit ("Box" / "Roll" / "Drum") for the bulk.
function unitLabel(p: Product, u: CartUnit): string {
  if (u === 'box') return (p.display_unit?.trim()) || 'Box';
  return (p.unit_of_measure?.trim()) || 'Piece';
}

// Total available at a single location expressed in the chosen unit.
// For 'piece' it's pcs + bx*ppb. For 'box' it's floor((pcs + bx*ppb) / ppb).
function availableAt(pcs: number, bx: number, unit: CartUnit, ppb: number): number {
  const pool = pcs + bx * ppb;
  if (unit === 'box' && ppb > 0) return Math.floor(pool / ppb);
  return pool;
}

// Compute the new (quantity, box_quantity) for a location after
// removing `qty` of `unit` from (pcs, bx). Mirrors the deductFrom
// logic in AdjustStockModal so the box column is touched the same
// way whether the user sells via POS or adjusts via the inventory
// modal. Caller must validate there's enough stock; this function
// will go negative on pcs if asked.
function deductFromLocation(pcs: number, bx: number, qty: number, unit: CartUnit, ppb: number) {
  if (unit === 'box') {
    const boxesFromWhole = Math.min(qty, bx);
    const remainingBoxes = qty - boxesFromWhole;
    return {
      quantity:     pcs - remainingBoxes * ppb,
      box_quantity: bx - boxesFromWhole,
    };
  }
  // piece mode: drain loose first, only break a box if loose isn't enough
  const fromLoose     = Math.min(qty, pcs);
  const fromBoxPieces = qty - fromLoose;
  const boxesToBreak  = ppb > 0 ? Math.ceil(fromBoxPieces / ppb) : 0;
  return {
    quantity:     pcs - fromLoose + boxesToBreak * ppb - fromBoxPieces,
    box_quantity: bx - boxesToBreak,
  };
}

function addToLocation(pcs: number, bx: number, qty: number, unit: CartUnit) {
  if (unit === 'box') return { quantity: pcs, box_quantity: bx + qty };
  return { quantity: pcs + qty, box_quantity: bx };
}

// Kenya VAT 16% — prices in DB are already tax-inclusive.
// Returns the VAT portion and the pre-tax base so we can display the
// breakdown without adding any extra charge.
function splitVAT(totalIncl: number) {
  const vat  = Math.round(totalIncl * 16 / 116);
  const base = totalIncl - vat;
  return { base, vat };
}

interface ModalState {
  product:   Product;
  direction: 'plus' | 'minus';
  location:  number;  // location_id
}

function PosDashboard() {
  const { products, locations, stockByLoc, boxByLoc, loading, error, refresh } = useProducts();
  const componentMap = useProductComponents();

  // locationId: default to first location once loaded
  const [locationId,  setLocationId]  = useState<number>(0);
  const [category,    setCategory]    = useState('All');
  const [search,      setSearch]      = useState('');
  const [modal,       setModal]       = useState<ModalState | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cart,        setCart]        = useState<CartItem[]>([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [processing,        setProcessing]        = useState(false);
  const [toast,             setToast]             = useState<ToastState | null>(null);
  const [restockBannerOpen, setRestockBannerOpen] = useState(true);
  const [restockSaleAlert,  setRestockSaleAlert]  = useState<string[]>([]);
  const toastId    = useRef(0);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Set initial location once locations load
  useEffect(() => {
    if (!locationId && locations.length > 0) setLocationId(locations[0].location_id);
  }, [locations, locationId]);

  useEffect(() => {
    const t = setTimeout(() => barcodeRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    setRestockSaleAlert([]);
    setRestockBannerOpen(true);
  }, [locationId]);

  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      const active = document.activeElement;
      const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (!isInput && barcodeRef.current) barcodeRef.current.focus();
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  const sm = stockByLoc[locationId] ?? {};
  const bm = boxByLoc[locationId]   ?? {};
  const locName = locations.find(l => l.location_id === locationId)?.location_name ?? '';

  // Max across ALL locations combined (overflow logic)
  function maxForProduct(p: Product, unit: CartUnit = 'piece'): number {
    const ppb = p.pieces_per_box ?? 0;
    const totalPcs = locations.reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[p.product_id] ?? 0), 0);
    const totalBx  = locations.reduce((s, l) => s + ((boxByLoc[l.location_id]   ?? {})[p.product_id] ?? 0), 0);
    const pool = totalPcs + totalBx * ppb;
    if (unit === 'box' && ppb > 0) return Math.floor(pool / ppb);
    return pool;
  }

  const inStock = products.filter(p => {
    const ppb = p.pieces_per_box || 0;
    return (sm[p.product_id] || 0) > 0 || (bm[p.product_id] || 0) * (ppb || 1) > 0;
  });

  const categories = useMemo(() => {
    const cats = Array.from(new Set(inStock.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [inStock]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inStock.filter(p => {
      if (category !== 'All' && p.type !== category) return false;
      if (q) {
        const hay = [p.product_name, p.brand, p.model, p.stock_keeping_unit, p.type]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [inStock, category, search]);

  // Products low at current location but available elsewhere
  const restockNeeded = useMemo(() => {
    return products.filter(p => {
      const ppb     = p.pieces_per_box ?? 0;
      const curTot  = (sm[p.product_id] || 0) + (bm[p.product_id] || 0) * ppb;
      const othTot  = locations
        .filter(l => l.location_id !== locationId)
        .reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[p.product_id] ?? 0) + ((boxByLoc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb, 0);
      return curTot <= (p.reorder_level ?? 2) && othTot > 0;
    });
  }, [locationId, products, sm, bm, locations, stockByLoc, boxByLoc]);

  // Pick a default sell price based on the chosen unit. For 'piece'
  // we use products.selling_price; for the bulk unit we use
  // box_selling_price (which is named for boxes but applies to any
  // bulk unit like roll/drum). Either may be null — in that case the
  // user fills it in on the cart row before hitting Sold.
  function defaultSellPrice(p: Product, unit: CartUnit): number | null {
    if (unit === 'box') return p.box_selling_price ?? null;
    return p.selling_price ?? null;
  }

  function addToCart(product: Product) {
    let blocked = false;
    let blockedMax = 0;
    let blockedUnit: CartUnit = 'piece';
    setCart(prev => {
      const existing = prev.find(c => c.product.product_id === product.product_id);
      if (existing) {
        // Use the existing row's unit when bumping the count.
        const max = maxForProduct(product, existing.unit);
        if (existing.qty >= max) {
          blocked = true; blockedMax = max; blockedUnit = existing.unit;
          return prev;
        }
        return prev.map(c =>
          c.product.product_id === product.product_id ? { ...c, qty: c.qty + 1 } : c
        );
      }
      // Default new rows to 'piece' — most quick scans are individual
      // items. User can toggle the unit on the row if they're selling
      // a whole box/roll.
      const max = maxForProduct(product, 'piece');
      if (max < 1) { blocked = true; blockedMax = 0; blockedUnit = 'piece'; return prev; }
      return [...prev, { product, qty: 1, unit: 'piece', sellPrice: defaultSellPrice(product, 'piece'), groupChoices: {} }];
    });
    barcodeRef.current?.focus();
    if (blocked) {
      showToast(`Max ${blockedMax} ${unitLabel(product, blockedUnit).toLowerCase()}${blockedMax === 1 ? '' : 's'} available for ${product.product_name}`, 'error');
    } else {
      showToast(`Added: ${product.product_name}`, 'success');
      setCartOpen(true);
    }
  }

  function handleBarcodeKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const code = e.currentTarget.value.trim();
    e.currentTarget.value = '';
    if (!code) return;
    const match =
      products.find(p => (p.stock_keeping_unit ?? '').toLowerCase() === code.toLowerCase()) ??
      products.find(p => p.product_name.toLowerCase().includes(code.toLowerCase()));
    if (!match) { showToast('No product found: ' + code, 'error'); return; }
    const hasStock = (sm[match.product_id] || 0) > 0 || (bm[match.product_id] || 0) > 0;
    if (!hasStock) { showToast(`Not in ${locName}: ${match.product_name}`, 'error'); return; }
    addToCart(match);
  }

  function handleScan(code: string) {
    const match =
      products.find(p => (p.stock_keeping_unit ?? '').toLowerCase() === code.toLowerCase()) ??
      products.find(p => p.product_name.toLowerCase().includes(code.toLowerCase()));
    if (!match) { showToast('No product found: ' + code, 'error'); return; }
    const hasStock = (sm[match.product_id] || 0) > 0 || (bm[match.product_id] || 0) > 0;
    if (!hasStock) { showToast(`Not in ${locName}: ${match.product_name}`, 'error'); return; }
    addToCart(match);
  }

  function openModal(product: Product, direction: 'plus' | 'minus') {
    // Manual selection (tapping a product card or the − button) used
    // to pop the AdjustStockModal here and commit a sale directly.
    // Route 'minus' to the cart instead so the cashier can still edit
    // qty, unit, and sell price before confirming. The + button stays
    // routed through the modal because that's a stock-IN action and
    // doesn't belong in the cart.
    if (direction === 'minus') {
      addToCart(product);
      return;
    }
    setModal({ product, direction, location: locationId });
  }

  // Sell `qty` of `unit` for product `p`: take from current location
  // first, fall back to the other location for any shortfall. When
  // unit is 'box' and the whole sale fits in the current location,
  // we deduct using box-mode (preferentially uses whole boxes from
  // box_quantity). Cross-location overflow always uses piece mode on
  // the secondary location since we wouldn't expect whole boxes to
  // be split across stores.
  //
  // `sellPrice` is the per-unit price for this specific sale (may
  // differ from the catalog selling_price due to a discount or markup
  // at checkout). It's appended to the movement note so the History
  // page can show what each line actually sold for.
  async function sellOneItem(
    p: Product,
    qty: number,
    unit: CartUnit,
    sellPrice: number | null,
    groupChoices: Record<string, number> = {},
  ) {
    const pid = p.product_id;
    const ppb = p.pieces_per_box ?? 0;
    const isBoxMode = unit === 'box' && ppb > 0;
    const movPieces = isBoxMode ? qty * ppb : qty;

    const locId     = locationId;
    const otherLocs = locations.filter(l => l.location_id !== locId);
    // For overflow we pick the "best" other location = most stock
    const bestOther = otherLocs.reduce<LocationInfo | null>((best, l) => {
      const tot = ((stockByLoc[l.location_id] ?? {})[pid] ?? 0) + ((boxByLoc[l.location_id] ?? {})[pid] ?? 0) * ppb;
      const bestTot = best ? ((stockByLoc[best.location_id] ?? {})[pid] ?? 0) + ((boxByLoc[best.location_id] ?? {})[pid] ?? 0) * ppb : -1;
      return tot > bestTot ? l : best;
    }, null);
    const otherId   = bestOther?.location_id ?? 0;
    const saleLocName  = locName;
    const otherName = bestOther?.location_name ?? 'Other';

    const curPcs   = (stockByLoc[locId]   ?? {})[pid] ?? 0;
    const curBx    = (boxByLoc[locId]     ?? {})[pid] ?? 0;
    const otherPcs = bestOther ? ((stockByLoc[bestOther.location_id] ?? {})[pid] ?? 0) : 0;
    const otherBx  = bestOther ? ((boxByLoc[bestOther.location_id]   ?? {})[pid] ?? 0) : 0;

    const totalCur   = curPcs   + curBx   * ppb;
    const totalOther = otherPcs + otherBx * ppb;
    if (movPieces > totalCur + totalOther) {
      throw new Error(`Only ${totalCur + totalOther} ${unitLabel(p, 'piece').toLowerCase()}s in stock total`);
    }

    const fromCurPieces   = Math.min(movPieces, totalCur);
    const fromOtherPieces = movPieces - fromCurPieces;

    // ── Build active component list (needed for validation + deduction) ──
    const productComps = componentMap[pid] ?? [];
    const alwaysComps = productComps.filter(c => !c.choice_group);
    const cgMap: Record<string, typeof productComps> = {};
    for (const c of productComps) {
      if (c.choice_group) (cgMap[c.choice_group] ??= []).push(c);
    }
    const pickedFromGroups = Object.keys(cgMap)
      .map(g => cgMap[g].find(c => c.component_product_id === groupChoices[g]))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const activeComps = [...alwaysComps, ...pickedFromGroups];

    // ── Pre-validate component stock before ANY DB write ─────────────────
    // If the combined stock (selling location + other location) is still not
    // enough, block the entire sale now — no partial DB writes will happen.
    for (const comp of activeComps) {
      const cid       = comp.component_product_id;
      const cPpb      = products.find(pr => pr.product_id === cid)?.pieces_per_box ?? 0;
      const cCurPcs   = (stockByLoc[locId] ?? {})[cid] ?? 0;
      const cCurBx    = (boxByLoc[locId]   ?? {})[cid] ?? 0;
      const cCurTotal = cCurPcs + cCurBx * cPpb;
      const cOthTotal = locations
        .filter(l => l.location_id !== locId)
        .reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[cid] ?? 0) + ((boxByLoc[l.location_id] ?? {})[cid] ?? 0) * cPpb, 0);
      const movComp  = movPieces * comp.quantity;
      const compName = products.find(pr => pr.product_id === cid)?.product_name ?? `#${cid}`;
      if (cCurTotal + cOthTotal < movComp) {
        throw new Error(
          `Not enough "${compName}": need ${movComp}, ` +
          `only ${cCurTotal + cOthTotal} in stock ` +
          `(${saleLocName}: ${cCurTotal}, other locations: ${cOthTotal})`
        );
      }
    }

    const unitLbl = unitLabel(p, unit).toLowerCase();
    const priceSuffix = sellPrice != null
      ? ` · ${qty} ${unitLbl}${qty === 1 ? '' : 's'} @ Ksh ${sellPrice} = Ksh ${(qty * sellPrice).toLocaleString('en-KE')}`
      : '';

    if (fromCurPieces > 0) {
      let newState: { quantity: number; box_quantity: number };
      if (isBoxMode && fromCurPieces === movPieces) {
        newState = deductFromLocation(curPcs, curBx, qty, 'box', ppb);
      } else {
        newState = deductFromLocation(curPcs, curBx, fromCurPieces, 'piece', ppb);
      }
      const before = curPcs + curBx * ppb;
      const after  = newState.quantity + newState.box_quantity * ppb;
      await logMovement(pid, locId, null, fromCurPieces, 'SALE', `Sold from ${saleLocName}${priceSuffix}`, { before, after });
      await upsertStock(pid, locId, newState);
    }

    if (fromOtherPieces > 0) {
      const newState = deductFromLocation(otherPcs, otherBx, fromOtherPieces, 'piece', ppb);
      const before = otherPcs + otherBx * ppb;
      const after  = newState.quantity + newState.box_quantity * ppb;
      await logMovement(pid, otherId, null, fromOtherPieces, 'SALE', `Sold from ${otherName} (POS overflow)${priceSuffix}`, { before, after });
      await upsertStock(pid, otherId, newState);
    }

    // ── Deduct components — pull shortfall from other location if needed ──
    // Same overflow logic as the main product: drain current location first,
    // then take the remainder from the other location.
    for (const comp of activeComps) {
      const cid      = comp.component_product_id;
      const cPpb     = products.find(pr => pr.product_id === cid)?.pieces_per_box ?? 0;
      const srcPcs   = (stockByLoc[locId]   ?? {})[cid] ?? 0;
      const srcBx    = (boxByLoc[locId]     ?? {})[cid] ?? 0;
      const othPcs   = bestOther ? ((stockByLoc[bestOther.location_id] ?? {})[cid] ?? 0) : 0;
      const othBx    = bestOther ? ((boxByLoc[bestOther.location_id]   ?? {})[cid] ?? 0) : 0;
      const movComp  = movPieces * comp.quantity;
      const srcTotal = srcPcs + srcBx * cPpb;

      const fromSrc   = Math.min(movComp, srcTotal);
      const fromOther = movComp - fromSrc;

      if (fromSrc > 0) {
        const raw    = deductFromLocation(srcPcs, srcBx, fromSrc, 'piece', cPpb);
        const before = srcTotal;
        const after  = raw.quantity + raw.box_quantity * cPpb;
        await logMovement(cid, locId, null, fromSrc, 'AUTO_DEDUCT', `Auto: component of ${p.product_name}`, { before, after });
        await upsertStock(cid, locId, raw);
      }

      if (fromOther > 0) {
        const raw    = deductFromLocation(othPcs, othBx, fromOther, 'piece', cPpb);
        const before = othPcs + othBx * cPpb;
        const after  = raw.quantity + raw.box_quantity * cPpb;
        await logMovement(cid, otherId, null, fromOther, 'AUTO_DEDUCT', `Auto: component of ${p.product_name} (pulled from ${otherName})`, { before, after });
        await upsertStock(cid, otherId, raw);
      }
    }
  }

  // Transfer `qty` of `unit` for `p` from current location to `destLocationId`.
  async function transferOneItem(
    p: Product,
    qty: number,
    unit: CartUnit,
    destLocationId: number,
    groupChoices: Record<string, number> = {},
  ) {
    const pid = p.product_id;
    const ppb = p.pieces_per_box ?? 0;
    const srcId   = locationId;
    const dstId   = destLocationId;
    const srcName = locName;
    const dstName = locations.find(l => l.location_id === dstId)?.location_name ?? 'Destination';

    const srcPcs = (stockByLoc[srcId] ?? {})[pid] ?? 0;
    const srcBx  = (boxByLoc[srcId]   ?? {})[pid] ?? 0;
    const dstPcs = (stockByLoc[dstId] ?? {})[pid] ?? 0;
    const dstBx  = (boxByLoc[dstId]   ?? {})[pid] ?? 0;

    const movPieces = unit === 'box' && ppb > 0 ? qty * ppb : qty;
    const srcTotal  = srcPcs + srcBx * ppb;
    if (movPieces > srcTotal) {
      throw new Error(`${srcName} only has ${srcTotal} ${unitLabel(p, 'piece').toLowerCase()}s of ${p.product_name}`);
    }

    const newSrc = deductFromLocation(srcPcs, srcBx, qty, unit, ppb);
    const newDst = addToLocation(dstPcs, dstBx, qty, unit);
    await logMovement(pid, srcId, dstId, movPieces, 'TRANSFER', `Moved from ${srcName} to ${dstName}`, { before: srcTotal, after: newSrc.quantity + newSrc.box_quantity * ppb });
    await upsertStock(pid, srcId, newSrc);
    await upsertStock(pid, dstId, newDst);

    // Move components with the product
    const productComps = componentMap[pid] ?? [];
    if (productComps.length > 0) {
      const alwaysComps = productComps.filter(c => !c.choice_group);
      const cgMap: Record<string, typeof productComps> = {};
      for (const c of productComps) {
        if (c.choice_group) (cgMap[c.choice_group] ??= []).push(c);
      }
      const pickedFromGroups = Object.keys(cgMap)
        .map(g => cgMap[g].find(c => c.component_product_id === groupChoices[g]))
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      for (const comp of [...alwaysComps, ...pickedFromGroups]) {
        const cid     = comp.component_product_id;
        const cPpb    = products.find(pr => pr.product_id === cid)?.pieces_per_box ?? 0;
        const movComp = movPieces * comp.quantity;
        const cSrcPcs = (stockByLoc[srcId] ?? {})[cid] ?? 0;
        const cSrcBx  = (boxByLoc[srcId]   ?? {})[cid] ?? 0;
        const cDstPcs = (stockByLoc[dstId] ?? {})[cid] ?? 0;
        const cDstBx  = (boxByLoc[dstId]   ?? {})[cid] ?? 0;
        const rawSrc = deductFromLocation(cSrcPcs, cSrcBx, movComp, 'piece', cPpb);
        const newSrcState = { quantity: Math.max(0, rawSrc.quantity), box_quantity: Math.max(0, rawSrc.box_quantity) };
        const cBefore = cSrcPcs + cSrcBx * cPpb;
        const cAfter  = newSrcState.quantity + newSrcState.box_quantity * cPpb;
        await logMovement(cid, srcId, dstId, movComp, 'TRANSFER', `Auto: component of ${p.product_name}`, { before: cBefore, after: cAfter });
        await upsertStock(cid, srcId, newSrcState);
        await upsertStock(cid, dstId, { quantity: cDstPcs + movComp, box_quantity: cDstBx });
      }
    }
  }

  // Writes a single `sales` row + N `sale_items` rows so each
  // POS checkout shows up on the Sales page and can be queried for
  // daily/weekly/monthly totals without parsing movement notes.
  async function recordSale(items: CartItem[]) {
    const total = items.reduce((s, i) => s + (i.sellPrice ?? 0) * i.qty, 0);
    const itemCount = items.reduce((s, i) => s + i.qty, 0);
    const performedBy = (typeof window !== 'undefined' && localStorage.getItem(USER_KEY)) || 'Admin';
    const locId = locationId;

    const { data: saleRow, error: saleErr } = await supabase.from('sales').insert({
      sale_date:    new Date().toISOString().split('T')[0],
      performed_by: performedBy,
      location_id:  locId,
      total_amount: total,
      item_count:   itemCount,
      status:       'COMPLETED',
    }).select('sale_id').single();
    if (saleErr || !saleRow) {
      // Don't fail the whole checkout if the sales-table write fails —
      // the stock + movement already happened. Show a warning instead.
      showToast('Sale recorded for stock but not the Sales journal: ' + (saleErr?.message ?? 'no row returned'), 'error');
      return;
    }
    const saleId = (saleRow as { sale_id: number }).sale_id;

    // Snapshot product names AND cost prices so the Sales page can
    // compute profit-at-time-of-sale correctly even if the product's
    // buying_price is updated later.
    const rows = items.map(i => ({
      sale_id:      saleId,
      product_id:   i.product.product_id,
      product_name: i.product.product_name,
      quantity:     i.qty,
      unit:         unitLabel(i.product, i.unit),
      unit_price:   i.sellPrice ?? null,
      cost_price:   i.product.buying_price ?? null,
      line_total:   i.sellPrice != null ? i.sellPrice * i.qty : null,
    }));
    let { error: itemsErr } = await supabase.from('sale_items').insert(rows);
    // Older deployments don't have the cost_price column yet. Schema
    // cache errors come back as "Could not find the 'cost_price'
    // column of 'sale_items'…" — strip it and retry so line items
    // still land in the DB and the Sales page shows the breakdown.
    if (itemsErr && /cost_price/i.test(itemsErr.message)) {
      const rowsNoCost = rows.map(({ cost_price: _cp, ...rest }) => rest);
      const retry = await supabase.from('sale_items').insert(rowsNoCost);
      itemsErr = retry.error;
      if (!itemsErr) {
        showToast('Line items saved without cost_price. Run the migration to enable profit tracking.', 'error');
      }
    }
    if (itemsErr) {
      showToast('Sale header saved but line items failed: ' + itemsErr.message, 'error');
    }
  }

  function getMissingChoices(item: CartItem): string[] {
    const comps = componentMap[item.product.product_id] ?? [];
    const groups = [...new Set(comps.filter(c => c.choice_group).map(c => c.choice_group!))];
    return groups.filter(g => item.groupChoices[g] == null);
  }

  async function processCart(action: 'sold' | 'move') {
    if (cart.length === 0) return;
    for (const item of cart) {
      const missing = getMissingChoices(item);
      if (missing.length > 0) {
        showToast(`Pick a ${missing[0]} for ${item.product.product_name}`, 'error');
        setCartOpen(true);
        return;
      }
      if (action === 'move' && !item.transferDestId) {
        showToast(`Select a destination location for ${item.product.product_name}`, 'error');
        setCartOpen(true);
        return;
      }
    }
    setProcessing(true);
    try {
      for (const item of cart) {
        if (action === 'sold') {
          await sellOneItem(item.product, item.qty, item.unit, item.sellPrice, item.groupChoices);
        } else {
          await transferOneItem(item.product, item.qty, item.unit, item.transferDestId!, item.groupChoices);
        }
      }
      if (action === 'sold') await recordSale(cart);
      showToast(`${action === 'sold' ? 'Sold' : 'Moved'} ${cart.length} item(s) ✓`, 'success');
      // Restock alert: after a sale, show items available elsewhere
      if (action === 'sold') {
        const names = cart
          .filter(item => {
            const ppb = item.product.pieces_per_box ?? 0;
            return locations
              .filter(l => l.location_id !== locationId)
              .some(l => ((stockByLoc[l.location_id] ?? {})[item.product.product_id] ?? 0) + ((boxByLoc[l.location_id] ?? {})[item.product.product_id] ?? 0) * ppb > 0);
          })
          .map(item => item.product.product_name);
        if (names.length > 0) setRestockSaleAlert(names);
      }
      setCart([]);
      setCartOpen(false);
      refresh();
      setTimeout(() => barcodeRef.current?.focus(), 100);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error processing cart', 'error');
    } finally {
      setProcessing(false);
    }
  }

  async function processItem(item: CartItem, action: 'sold' | 'move') {
    const missing = getMissingChoices(item);
    if (missing.length > 0) {
      showToast(`Pick a ${missing[0]} for ${item.product.product_name}`, 'error');
      return;
    }
    if (action === 'move' && !item.transferDestId) {
      showToast('Select a destination location first', 'error');
      return;
    }
    setProcessing(true);
    try {
      if (action === 'sold') {
        await sellOneItem(item.product, item.qty, item.unit, item.sellPrice, item.groupChoices);
        await recordSale([item]);
      } else {
        await transferOneItem(item.product, item.qty, item.unit, item.transferDestId!, item.groupChoices);
      }
      setCart(c => c.filter(i => i.product.product_id !== item.product.product_id));
      showToast(`${action === 'sold' ? 'Sold' : 'Moved'}: ${item.product.product_name} ✓`, 'success');
      if (action === 'sold') {
        const ppb     = item.product.pieces_per_box ?? 0;
        const othTot  = locations.filter(l => l.location_id !== locationId)
          .reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[item.product.product_id] ?? 0) + ((boxByLoc[l.location_id] ?? {})[item.product.product_id] ?? 0) * ppb, 0);
        if (othTot > 0) setRestockSaleAlert([item.product.product_name]);
      }
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setProcessing(false);
    }
  }


  if (loading) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center px-6">
        <div className="text-center">
          <p className="text-4xl mb-4">⚠️</p>
          <p className="text-danger text-sm">{error}</p>
          <Link href="/admin" className="mt-4 inline-block text-teal text-sm hover:underline">← Back</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-navy flex flex-col overflow-hidden">
      <header className="shrink-0 bg-surface border-b border-white/8 px-3 flex items-center gap-2 h-14">
        <Link href="/admin" className="text-muted hover:text-slate-100 text-sm px-3 py-1.5 rounded-lg bg-surface2 border border-white/8 transition-colors shrink-0">
          ← Back
        </Link>
        <h1 className="text-sm font-bold text-slate-100 shrink-0 truncate">
          🏭 {locName || 'POS'}
        </h1>

        <div className="flex-1 relative min-w-0 max-w-xs">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-teal text-sm pointer-events-none">⌨</span>
          <input
            ref={barcodeRef}
            type="text"
            placeholder="Scan barcode / type SKU + Enter"
            onKeyDown={handleBarcodeKey}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full pl-8 pr-3 py-2 rounded-xl bg-surface2 border border-teal text-sm text-slate-100 placeholder:text-muted/50 font-mono outline-none shadow-[0_0_0_2px_rgba(0,212,255,0.15)] transition-colors"
          />
        </div>

        <button
          onClick={() => setScannerOpen(true)}
          title="Camera scan"
          className="p-2 rounded-xl bg-surface2 border border-white/8 text-muted hover:text-teal hover:border-teal/30 transition-all text-lg shrink-0"
        >
          📷
        </button>

        <button
          onClick={() => setCartOpen(o => !o)}
          className="relative p-2 rounded-xl bg-surface2 border border-white/8 text-muted hover:text-teal hover:border-teal/30 transition-all text-lg shrink-0"
        >
          🛒
          {cart.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-teal text-navy text-[9px] font-black w-4 h-4 rounded-full flex items-center justify-center">
              {cart.length}
            </span>
          )}
        </button>
      </header>

      {/* Dynamic location tabs */}
      <div className="shrink-0 flex gap-2 px-3 pt-2.5 pb-2 border-b border-white/8 bg-surface overflow-x-auto scrollbar-none">
        {locations.map(loc => (
          <button
            key={loc.location_id}
            onClick={() => { setLocationId(loc.location_id); setCategory('All'); }}
            className={`shrink-0 flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${
              locationId === loc.location_id
                ? 'border-teal bg-teal/10 text-teal'
                : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
            }`}
          >
            {loc.location_name}
          </button>
        ))}
      </div>

      {/* ── Restock notification strip ─────────────────────────────────── */}
      <AnimatePresence>
        {restockNeeded.length > 0 && (
          <motion.div
            key="restock-strip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="shrink-0 overflow-hidden bg-surface border-b border-gold/20"
          >
            <div className="px-3 pt-2 pb-2">
              <button
                onClick={() => setRestockBannerOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-gold/10 border border-gold/25 text-gold text-xs font-bold hover:bg-gold/15 active:scale-[0.98] transition-all"
              >
                <span>📦</span>
                <span className="flex-1 text-left">
                  {restockNeeded.length} product{restockNeeded.length > 1 ? 's' : ''} low here — available elsewhere
                </span>
                <span className="w-4 h-4 rounded-full bg-gold/20 border border-gold/40 text-[9px] font-black flex items-center justify-center">
                  {restockBannerOpen ? '▴' : '▾'}
                </span>
              </button>

              <AnimatePresence>
                {restockBannerOpen && (
                  <motion.div
                    key="restock-list"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1.5 bg-gold/5 border border-gold/15 rounded-xl px-3 py-2 max-h-40 overflow-y-auto flex flex-col gap-1.5">
                      {restockNeeded.map(p => {
                        const ppb = p.pieces_per_box ?? 0;
                        return (
                          <div key={p.product_id} className="flex items-center justify-between gap-2">
                            <span className="text-xs text-slate-200 truncate flex-1">{p.product_name}</span>
                            <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono font-bold tabular-nums flex-wrap justify-end">
                              {locations.map(loc => {
                                const tot = ((stockByLoc[loc.location_id] ?? {})[p.product_id] ?? 0) + ((boxByLoc[loc.location_id] ?? {})[p.product_id] ?? 0) * ppb;
                                return (
                                  <span key={loc.location_id} className={`px-1.5 py-0.5 rounded border ${
                                    loc.location_id === locationId
                                      ? tot === 0 ? 'bg-danger/10 border-danger/30 text-danger' : 'bg-gold/10 border-gold/30 text-gold'
                                      : 'bg-success/10 border-success/30 text-success'
                                  }`}>
                                    {tot}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="shrink-0 flex gap-2 px-3 py-2 overflow-x-auto border-b border-white/5 bg-surface">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`shrink-0 px-3 py-1 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
              category === cat
                ? 'bg-teal/10 border-teal/30 text-teal'
                : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="shrink-0 px-3 py-2 border-b border-white/5 bg-surface">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, type, brand…"
            className="w-full pl-9 pr-4 py-2 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg">×</button>
          )}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {visible.length === 0 && (
          <p className="text-center text-muted text-sm py-12">No products at {locName}</p>
        )}
        <AnimatePresence>
          {visible.map((p, i) => (
            <PosProductCard
              key={p.product_id}
              product={p}
              index={i}
              locationId={locationId}
              locations={locations}
              stockByLoc={stockByLoc}
              boxByLoc={boxByLoc}
              onAdjust={openModal}
            />
          ))}
        </AnimatePresence>
      </main>

      {/* ── Cart panel ──────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {cartOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-80 bg-black/60"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => { setCartOpen(false); setTimeout(() => barcodeRef.current?.focus(), 100); }}
            />
            <motion.div
              className="fixed right-0 top-0 bottom-0 w-72 z-90 bg-surface border-l border-white/8 flex flex-col shadow-2xl"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
              <div className="flex items-center justify-between px-4 h-14 border-b border-white/8 shrink-0">
                <h3 className="text-sm font-bold text-slate-100">🛒 Cart ({cart.length})</h3>
                <div className="flex items-center gap-2">
                  {cart.length > 0 && (
                    <button
                      onClick={() => setCart([])}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-danger/40 bg-danger/10 text-danger text-xs font-bold hover:bg-danger hover:text-white active:scale-95 transition-all"
                    >
                      <span className="text-sm leading-none">🗑</span> Clear
                    </button>
                  )}
                  <button
                    onClick={() => { setCartOpen(false); setTimeout(() => barcodeRef.current?.focus(), 100); }}
                    className="w-6 h-6 flex items-center justify-center text-muted hover:text-slate-100 text-lg"
                  >×</button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
                {cart.length === 0 && (
                  <p className="text-center text-muted text-xs py-8">Scan items to add to cart</p>
                )}
                {cart.map(item => {
                  const hasBulk = hasBulkUnit(item.product);
                  const ppb = item.product.pieces_per_box ?? 0;
                  const max = maxForProduct(item.product, item.unit);
                  const atMax = item.qty >= max;
                  const unitLbl = unitLabel(item.product, item.unit);
                  return (
                  <div key={item.product.product_id} className="bg-surface2 rounded-xl px-3 py-2.5 border border-white/5">
                    <div className="flex items-start justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-100 truncate flex-1 mr-2">{item.product.product_name}</p>
                      <button
                        onClick={() => setCart(c => c.filter(i => i.product.product_id !== item.product.product_id))}
                        className="text-muted hover:text-danger text-sm shrink-0 transition-colors"
                      >×</button>
                    </div>

                    {/* Unit toggle — only shown when the product has a bulk
                        unit configured (pieces_per_box > 0). Switching unit
                        clamps qty to the new max in that unit. */}
                    {hasBulk && (
                      <div className="flex gap-1 mb-2">
                        {(['piece', 'box'] as CartUnit[]).map(u => {
                          const isSel = item.unit === u;
                          return (
                            <button
                              key={u}
                              onClick={() => setCart(c => c.map(i => {
                                if (i.product.product_id !== item.product.product_id) return i;
                                const newMax = maxForProduct(i.product, u);
                                const wasDefault = i.sellPrice == null || i.sellPrice === defaultSellPrice(i.product, i.unit);
                                return {
                                  ...i,
                                  unit: u,
                                  qty: Math.max(1, Math.min(i.qty, newMax || 1)),
                                  sellPrice: wasDefault ? defaultSellPrice(i.product, u) : i.sellPrice,
                                };
                              }))}
                              className={`flex-1 py-1.5 rounded flex flex-col items-center text-[10px] font-bold border transition-all ${
                                isSel
                                  ? u === 'piece'
                                    ? 'border-teal/40 bg-teal/10 text-teal'
                                    : 'border-gold/40 bg-gold/10 text-gold'
                                  : 'border-white/10 bg-surface text-muted hover:text-slate-100'
                              }`}
                            >
                              <span>{unitLabel(item.product, u)}</span>
                              <span className="text-[8px] font-normal opacity-70 leading-tight">
                                {u === 'box' ? `×${ppb} pcs` : '×1 pc'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Component deduction info + choice group pickers */}
                    {(() => {
                      const comps = componentMap[item.product.product_id] ?? [];
                      if (comps.length === 0) return null;
                      const always = comps.filter(c => !c.choice_group);
                      const groups: Record<string, typeof comps> = {};
                      for (const c of comps) {
                        if (c.choice_group) (groups[c.choice_group] ??= []).push(c);
                      }
                      const groupNames = Object.keys(groups);
                      return (
                        <div className="mb-2 flex flex-col gap-1.5">
                          {always.length > 0 && (
                            <div className="rounded-lg bg-surface border border-white/8 px-2.5 py-2">
                              <p className="text-[9px] font-bold text-muted uppercase tracking-widest mb-1">🔧 Deducts:</p>
                              <ul className="flex flex-col gap-0.5">
                                {always.map(c => {
                                  const name = products.find(pr => pr.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`;
                                  return (
                                    <li key={c.component_product_id} className="text-[10px] text-slate-300">
                                      • {name} ×{c.quantity * item.qty}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          )}
                          {groupNames.map(groupName => {
                            const members = groups[groupName];
                            const picked  = item.groupChoices[groupName];
                            return (
                              <div key={groupName} className="rounded-lg bg-gold/5 border border-gold/30 px-2.5 py-2">
                                <p className="text-[9px] font-bold text-gold uppercase tracking-widest mb-1.5">
                                  Pick {groupName}
                                </p>
                                <div className="flex flex-col gap-1">
                                  {members.map(c => {
                                    const name     = products.find(pr => pr.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`;
                                    const isPicked = picked === c.component_product_id;
                                    return (
                                      <button
                                        key={c.component_product_id}
                                        onClick={() => setCart(prev => prev.map(i =>
                                          i.product.product_id !== item.product.product_id ? i : {
                                            ...i,
                                            groupChoices: { ...i.groupChoices, [groupName]: c.component_product_id },
                                          }
                                        ))}
                                        className={`text-left px-2 py-1.5 rounded border text-[10px] font-semibold transition-all ${
                                          isPicked
                                            ? 'border-gold bg-gold/15 text-gold'
                                            : 'border-white/8 bg-surface2 text-slate-300 hover:border-gold/40'
                                        }`}
                                      >
                                        {isPicked && '✓ '}{name} <span className="text-muted font-normal">×{c.quantity}/unit</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    <div className="flex items-center gap-2 mb-2">
                      <button
                        onClick={() => setCart(c => c.map(i =>
                          i.product.product_id === item.product.product_id
                            ? { ...i, qty: Math.max(1, i.qty - 1) }
                            : i
                        ))}
                        className="w-7 h-7 rounded bg-surface border border-white/10 text-slate-300 text-sm font-bold flex items-center justify-center hover:bg-danger/20 hover:text-danger transition-all"
                      >−</button>
                      <input
                        type="number"
                        min={1}
                        max={max}
                        value={item.qty}
                        onChange={e => {
                          const raw = parseInt(e.target.value) || 1;
                          const v = Math.max(1, Math.min(raw, max));
                          if (raw > max) showToast(`Max ${max} ${unitLbl.toLowerCase()}${max === 1 ? '' : 's'} of ${item.product.product_name}`, 'error');
                          setCart(c => c.map(i =>
                            i.product.product_id === item.product.product_id ? { ...i, qty: v } : i
                          ));
                        }}
                        onWheel={e => e.currentTarget.blur()}
                        className="w-12 text-center text-sm font-bold tabular-nums bg-surface border border-white/10 rounded-md py-0.5 text-slate-100 outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <button
                        onClick={() => {
                          if (atMax) { showToast(`Max ${max} ${unitLbl.toLowerCase()}${max === 1 ? '' : 's'} of ${item.product.product_name}`, 'error'); return; }
                          setCart(c => c.map(i =>
                            i.product.product_id === item.product.product_id ? { ...i, qty: i.qty + 1 } : i
                          ));
                        }}
                        disabled={atMax}
                        className="w-7 h-7 rounded bg-surface border border-white/10 text-slate-300 text-sm font-bold flex items-center justify-center hover:bg-teal/20 hover:text-teal transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-surface disabled:hover:text-slate-300"
                      >+</button>
                      <span className={`text-[10px] font-mono ml-1 ${atMax ? 'text-gold' : 'text-muted'}`}>
                        {unitLbl.charAt(0).toLowerCase()} / {max}
                      </span>
                    </div>

                    {/* Sell price — pre-filled from product.selling_price
                        (or box_selling_price when unit is bulk). User can
                        override per sale. Live line total shown on the
                        right. */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[9px] font-bold text-muted uppercase tracking-widest shrink-0">@ Ksh</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={item.sellPrice ?? ''}
                        placeholder="0.00"
                        onChange={e => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value);
                          setCart(c => c.map(i => i.product.product_id === item.product.product_id ? { ...i, sellPrice: Number.isNaN(v) ? null : v } : i));
                        }}
                        onWheel={e => e.currentTarget.blur()}
                        className="flex-1 px-2 py-1 rounded-md bg-surface border border-white/10 text-slate-100 text-xs font-bold tabular-nums outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-[10px] text-muted shrink-0">/ {unitLbl}</span>
                    </div>
                    {item.sellPrice != null && item.sellPrice > 0 && (
                      <div className="text-[10px] text-teal text-right mb-2 font-mono">
                        Total: Ksh {(item.qty * item.sellPrice).toLocaleString('en-KE')}
                      </div>
                    )}

                    {(() => {
                      const missing = getMissingChoices(item);
                      return missing.length > 0 ? (
                        <p className="text-[9px] text-gold mb-1.5">⚠ Pick {missing.join(', ')} to sell</p>
                      ) : null;
                    })()}
                    {/* Destination picker for Move action */}
                    {locations.filter(l => l.location_id !== locationId).length > 0 && (
                      <div className="mb-1.5">
                        <p className="text-[9px] text-muted uppercase font-bold tracking-widest mb-1">Move to:</p>
                        <div className="flex gap-1 flex-wrap">
                          {locations.filter(l => l.location_id !== locationId).map(loc => (
                            <button
                              key={loc.location_id}
                              onClick={() => setCart(c => c.map(i =>
                                i.product.product_id === item.product.product_id
                                  ? { ...i, transferDestId: i.transferDestId === loc.location_id ? undefined : loc.location_id }
                                  : i
                              ))}
                              className={`text-[9px] font-bold px-2 py-1 rounded-lg border transition-all ${
                                item.transferDestId === loc.location_id
                                  ? 'border-teal bg-teal/15 text-teal'
                                  : 'border-white/10 bg-surface text-muted hover:border-teal/30'
                              }`}
                            >
                              {item.transferDestId === loc.location_id ? '✓ ' : ''}{loc.location_name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => processItem(item, 'sold')}
                        disabled={processing || getMissingChoices(item).length > 0}
                        className="flex-1 py-1 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[10px] font-bold hover:bg-danger/20 disabled:opacity-50 transition-all"
                      >Sold</button>
                      {item.transferDestId && (
                        <button
                          onClick={() => processItem(item, 'move')}
                          disabled={processing}
                          className="flex-1 py-1 rounded-lg bg-teal/10 border border-teal/20 text-teal text-[10px] font-bold hover:bg-teal/20 disabled:opacity-50 transition-all"
                        >→ Move</button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>

              {cart.length > 0 && (
                <div className="p-3 border-t border-white/8 flex flex-col gap-2 shrink-0">
                  {/* Grand total with Kenya VAT 16% breakdown.
                      Prices are stored tax-inclusive — no extra charge,
                      just split the already-included VAT for display. */}
                  {(() => {
                    const total = cart.reduce((s, i) => s + (i.sellPrice ?? 0) * i.qty, 0);
                    if (total <= 0) return null;
                    const { base, vat } = splitVAT(total);
                    return (
                      <div className="bg-surface2 border border-teal/20 rounded-xl px-3 py-2 flex flex-col gap-0.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted">Excl. VAT</span>
                          <span className="text-[10px] text-muted tabular-nums">Ksh {base.toLocaleString('en-KE')}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted">VAT (16%)</span>
                          <span className="text-[10px] text-muted tabular-nums">Ksh {vat.toLocaleString('en-KE')}</span>
                        </div>
                        <div className="flex items-center justify-between border-t border-white/8 pt-1 mt-0.5">
                          <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Total (incl. VAT)</span>
                          <span className="text-sm font-bold text-teal tabular-nums">Ksh {total.toLocaleString('en-KE')}</span>
                        </div>
                      </div>
                    );
                  })()}
                  <button
                    onClick={() => processCart('sold')}
                    disabled={processing}
                    className="w-full py-2.5 rounded-xl bg-danger/15 border border-danger/30 text-danger text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2 hover:bg-danger/25 transition-all"
                  >
                    {processing && <div className="w-3.5 h-3.5 rounded-full border-2 border-danger border-t-transparent animate-spin" />}
                    ✅ Confirm All Sold
                  </button>
                  {cart.some(i => i.transferDestId) && (
                    <button
                      onClick={() => processCart('move')}
                      disabled={processing}
                      className="w-full py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2 hover:bg-teal/25 transition-all"
                    >
                      {processing && <div className="w-3.5 h-3.5 rounded-full border-2 border-teal border-t-transparent animate-spin" />}
                      📦 Move Selected Items
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {scannerOpen && (
          <BarcodeScanner
            onScan={handleScan}
            onClose={() => setScannerOpen(false)}
            keepOpen
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {modal && (
          <AdjustStockModal
            key="modal"
            product={modal.product}
            locationId={modal.location}
            direction={modal.direction}
            locations={locations}
            stockByLoc={stockByLoc}
            boxByLoc={boxByLoc}
            componentMap={componentMap}
            allProducts={products}
            onClose={() => { setModal(null); setTimeout(() => barcodeRef.current?.focus(), 100); }}
            onSuccess={(msg) => showToast(msg, 'success')}
            onError={(msg) => showToast(msg, 'error')}
            onDone={refresh}
          />
        )}
      </AnimatePresence>

      {/* ── Post-sale restock reminder ──────────────────────────────────
          Floats above the toast; persists until dismissed or location
          switches.  "Go to Back →" shortcut swaps the location so the
          operator can immediately use "→ Main" buttons to move stock. */}
      <AnimatePresence>
        {restockSaleAlert.length > 0 && (
          <motion.div
            key="restock-alert"
            initial={{ y: 80, opacity: 0, scale: 0.95 }}
            animate={{ y: 0,  opacity: 1, scale: 1    }}
            exit={{   y: 80, opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', damping: 22, stiffness: 280 }}
            className="fixed bottom-16 inset-x-0 z-[150] px-4 pointer-events-none"
          >
            <div className="max-w-xs mx-auto pointer-events-auto bg-navy border border-gold/40 rounded-2xl p-3.5 shadow-2xl shadow-black/60">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg leading-none">📦</span>
                  <span className="text-xs font-bold text-gold">Move from Back Godown</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      if (locations.length > 1) setLocationId(locations[0].location_id);
                      setRestockSaleAlert([]);
                      setCartOpen(false);
                      setTimeout(() => barcodeRef.current?.focus(), 100);
                    }}
                    className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-teal/15 border border-teal/30 text-teal hover:bg-teal/25 active:scale-95 transition-all"
                  >
                    Switch Location →
                  </button>
                  <button
                    onClick={() => setRestockSaleAlert([])}
                    className="w-5 h-5 flex items-center justify-center text-muted hover:text-slate-100 text-base transition-colors"
                  >×</button>
                </div>
              </div>
              <ul className="flex flex-col gap-1">
                {restockSaleAlert.map((name, i) => (
                  <li key={i} className="text-[11px] text-slate-200 flex items-center gap-1.5">
                    <span className="text-gold/50 text-base leading-none">•</span>
                    <span className="truncate">{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

interface CardProps {
  product:    Product;
  index:      number;
  locationId: number;
  locations:  LocationInfo[];
  stockByLoc: Record<number, Record<number, number>>;
  boxByLoc:   Record<number, Record<number, number>>;
  onAdjust:   (product: Product, direction: 'plus' | 'minus') => void;
}

function PosProductCard({ product: p, index, locationId, locations, stockByLoc, boxByLoc, onAdjust }: CardProps) {
  const ppb     = p.pieces_per_box || 0;
  const qty     = (stockByLoc[locationId] ?? {})[p.product_id] ?? 0;
  const bx      = (boxByLoc[locationId]   ?? {})[p.product_id] ?? 0;
  const total   = qty + bx * (ppb || 1);
  const fmt     = formatStock(total, p.unit_type, p.unit_of_measure, ppb);
  const reorder = p.reorder_level ?? 2;

  // Stock available at other locations
  const otherTotal = locations
    .filter(l => l.location_id !== locationId)
    .reduce((s, l) => s + ((stockByLoc[l.location_id] ?? {})[p.product_id] ?? 0) + ((boxByLoc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb, 0);

  const showOtherBadge = otherTotal > 0 && total <= reorder;

  const stockCls =
    total === 0      ? 'text-danger' :
    total <= reorder ? 'text-gold'   :
                       'text-muted';

  const stockTxt =
    total === 0      ? 'Out of stock'       :
    total <= reorder ? `⚠ Low — ${fmt.label}` :
                       fmt.label;

  const bigNum = fmt.unitBadge === 'BOX' && ppb > 0 ? Math.floor(total / ppb) : total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.25), duration: 0.25 }}
      onClick={() => onAdjust(p, 'minus')}
      className="flex items-center gap-3 px-3 py-3 rounded-xl bg-surface border border-white/5 hover:border-teal/20 cursor-pointer transition-colors group"
    >
      <span className="shrink-0 self-start mt-0.5 text-[9px] font-bold px-2 py-0.5 rounded-md bg-surface2 border border-white/8 text-muted uppercase tracking-wider whitespace-nowrap">
        {p.type || '—'}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-100 truncate group-hover:text-teal transition-colors">
          {p.product_name}
        </p>
        <p className="text-xs text-muted truncate mt-0.5">
          {[p.brand, p.model].filter(Boolean).join(' · ') || p.stock_keeping_unit || '—'}
        </p>
        <p className={`text-[10px] font-semibold mt-1 ${stockCls}`}>{stockTxt}</p>
        {showOtherBadge && (
          <span className="inline-flex items-center gap-1 mt-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border bg-gold/10 border-gold/30 text-gold leading-none">
            📦 {otherTotal} elsewhere
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onAdjust(p, 'minus')}
          className="w-8 h-8 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xl font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all active:scale-90"
        >−</button>

        <div className="flex flex-col items-center min-w-8.5">
          <span className="text-lg font-bold text-slate-200 tabular-nums leading-none">{bigNum}</span>
          {fmt.unitBadge === 'BOX' && ppb > 0 && total % ppb > 0 && (
            <span className="text-[8px] text-muted leading-none">{`+${total % ppb}pc`}</span>
          )}
          <span className="text-[8px] font-bold text-muted/60 uppercase tracking-wider">{fmt.unitBadge}</span>
        </div>

        <button
          onClick={() => onAdjust(p, 'plus')}
          className="w-8 h-8 rounded-lg bg-teal/10 border border-teal/30 text-teal text-xl font-bold flex items-center justify-center hover:bg-teal hover:text-navy transition-all active:scale-90"
        >+</button>
      </div>
    </motion.div>
  );
}
