'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useProducts } from '@/lib/hooks/useProducts';
import { useProductComponents } from '@/lib/hooks/useProductComponents';
import { supabase } from '@/lib/supabase';
import { formatStock } from '@/lib/formatStock';
import { stockTxn, type StockOp, type SalePayload } from '@/lib/stockActions';
import AdjustStockModal from '@/app/admin/components/AdjustStockModal';
import BarcodeScanner   from '@/app/admin/components/BarcodeScanner';
import Toast, { type ToastState } from '@/app/admin/components/Toast';
import type { Product, LocationInfo } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';

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
  companyId:       number;  // which company's stock this line sells from
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
  const { products, locations, companies, stockByLoc, boxByLoc, stockByCompany, boxByCompany, loading, error, refresh } = useProducts();
  const { map: componentMap, refresh: refreshComponents } = useProductComponents();

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

  // Total pieces a product has in one company across all locations.
  function companyTotalPieces(p: Product, companyId: number): number {
    const ppb = p.pieces_per_box ?? 0;
    const sc = stockByCompany[companyId] ?? {};
    const bc = boxByCompany[companyId]   ?? {};
    return locations.reduce((s, l) => s + ((sc[l.location_id] ?? {})[p.product_id] ?? 0) + ((bc[l.location_id] ?? {})[p.product_id] ?? 0) * ppb, 0);
  }

  // Default company for a new cart line: the one with stock (Aadinath first).
  function defaultCompanyFor(p: Product): number {
    const withStock = companies
      .map(c => c.company_id)
      .filter(cid => companyTotalPieces(p, cid) > 0)
      .sort((a, b) => a - b);
    return withStock[0] ?? (companies[0]?.company_id ?? 1);
  }

  // Max sellable of a product. The two companies are just billing labels over
  // ONE shared physical stock, so the max is the COMBINED total across every
  // company and location — the company only decides which bill it goes on.
  // (companyId is accepted for call-site compatibility but no longer limits
  // the amount.)
  function maxForProduct(p: Product, unit: CartUnit = 'piece', _companyId = 1): number {
    const ppb = p.pieces_per_box ?? 0;
    const pool = companies.reduce((s, c) => s + companyTotalPieces(p, c.company_id), 0);
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
    if (unit === 'box') {
      // Prefer an explicit box price. If none is set but the per-piece
      // price is, derive the box price as piece price × pieces_per_box
      // so selling a box doesn't force the user to re-type a price.
      if (p.box_selling_price != null) return p.box_selling_price;
      const ppb = p.pieces_per_box ?? 0;
      if (p.selling_price != null && ppb > 0) return p.selling_price * ppb;
      return null;
    }
    return p.selling_price ?? null;
  }

  // Choice-group options can each carry their own sell price (e.g. the same
  // product "with motor A" vs "with motor B" costs differently). When such an
  // option is picked, its saved price becomes the line's sell price. Returns
  // null when no picked option has a price, so the caller keeps the base
  // price. Applies to the piece unit (box uses box_selling_price).
  function choiceSellPrice(p: Product, groupChoices: Record<string, number>, unit: CartUnit): number | null {
    if (unit === 'box') return null;
    const comps = componentMap[p.product_id] ?? [];
    const pricedPicked = comps.filter(c =>
      c.choice_group != null && groupChoices[c.choice_group] === c.component_product_id && c.price != null,
    );
    if (pricedPicked.length === 0) return null;
    return pricedPicked.reduce((s, c) => s + (c.price ?? 0), 0);
  }

  // After a sale, persist the price actually charged back onto the picked
  // choice option, so next time it pre-fills. Only the unambiguous single
  // picked-option case is written (avoids guessing across multiple groups).
  async function rememberChoicePrices(items: CartItem[]) {
    let wrote = false;
    for (const it of items) {
      if (it.sellPrice == null || it.unit === 'box') continue;
      const comps = componentMap[it.product.product_id] ?? [];
      const picked = comps.filter(c => c.choice_group != null && it.groupChoices[c.choice_group!] === c.component_product_id);
      if (picked.length !== 1) continue;               // ambiguous → skip
      const chosen = picked[0];
      if (chosen.price === it.sellPrice) continue;      // unchanged
      const { error } = await supabase
        .from('product_components')
        .update({ price: it.sellPrice })
        .eq('product_id', it.product.product_id)
        .eq('component_product_id', chosen.component_product_id)
        .eq('choice_group', chosen.choice_group!);
      if (!error) wrote = true;
      // A missing `price` column just means the migration hasn't run; ignore.
    }
    if (wrote) refreshComponents();
  }

  // After a sale, if a product had NO catalog price and the cashier typed
  // one, save it onto the product (selling_price for pieces, box_selling_price
  // for the bulk unit) so it pre-fills next time. We only fill a BLANK price —
  // never overwrite an existing catalog price, so a one-off discount can't
  // corrupt it. Products priced via a choice option are handled above.
  async function rememberProductPrices(items: CartItem[]) {
    let wrote = false;
    const done = new Set<number>();
    for (const it of items) {
      const p   = it.product;
      const pid = p.product_id;
      if (it.sellPrice == null || it.sellPrice <= 0 || done.has(pid)) continue;
      // If a priced choice option drove the price, that's saved on the option.
      if (choiceSellPrice(p, it.groupChoices, it.unit) != null) continue;

      const patch: Record<string, number> = {};
      if (it.unit === 'box') {
        if (p.box_selling_price == null) patch.box_selling_price = it.sellPrice;
      } else if (p.selling_price == null) {
        patch.selling_price = it.sellPrice;
      }
      if (Object.keys(patch).length === 0) continue;   // already had a price

      const { error } = await supabase.from('products').update(patch).eq('product_id', pid);
      if (!error) { wrote = true; done.add(pid); }
      // Staff lack UPDATE rights on products (RLS) — best-effort, ignore.
    }
    if (wrote) refresh();
  }

  function addToCart(product: Product) {
    let blocked = false;
    let blockedMax = 0;
    let blockedUnit: CartUnit = 'piece';
    setCart(prev => {
      const existing = prev.find(c => c.product.product_id === product.product_id);
      if (existing) {
        // Use the existing row's unit + company when bumping the count.
        const max = maxForProduct(product, existing.unit, existing.companyId);
        if (existing.qty >= max) {
          blocked = true; blockedMax = max; blockedUnit = existing.unit;
          return prev;
        }
        return prev.map(c =>
          c.product.product_id === product.product_id ? { ...c, qty: c.qty + 1 } : c
        );
      }
      // Default new rows to 'piece' and to the company that has stock.
      const companyId = defaultCompanyFor(product);
      const max = maxForProduct(product, 'piece', companyId);
      if (max < 1) { blocked = true; blockedMax = 0; blockedUnit = 'piece'; return prev; }
      return [...prev, { product, qty: 1, unit: 'piece', sellPrice: defaultSellPrice(product, 'piece'), groupChoices: {}, companyId }];
    });
    barcodeRef.current?.focus();
    if (blocked) {
      showToast(`Max ${blockedMax} ${unitLabel(product, blockedUnit).toLowerCase()}${blockedMax === 1 ? '' : 's'} available for ${product.product_name}`, 'error');
    } else {
      showToast(`Added: ${product.product_name}`, 'success');
      setCartOpen(true);
    }
  }

  // Match a scanned / typed barcode EXACTLY: SKU first, then exact product
  // name. No fuzzy "name contains code" fallback — that could silently grab
  // and sell the wrong product. If more than one product matches, we refuse
  // rather than guess.
  function findByCode(code: string): { match: Product | null; ambiguous: boolean } {
    const c = code.trim().toLowerCase();
    if (!c) return { match: null, ambiguous: false };
    const bySku = products.filter(p => (p.stock_keeping_unit ?? '').trim().toLowerCase() === c);
    if (bySku.length === 1) return { match: bySku[0], ambiguous: false };
    if (bySku.length > 1)   return { match: null, ambiguous: true };
    const byName = products.filter(p => p.product_name.trim().toLowerCase() === c);
    if (byName.length === 1) return { match: byName[0], ambiguous: false };
    if (byName.length > 1)   return { match: null, ambiguous: true };
    return { match: null, ambiguous: false };
  }

  function resolveScan(code: string): Product | null {
    const { match, ambiguous } = findByCode(code);
    if (ambiguous) { showToast(`More than one product matches "${code}" — use search instead`, 'error'); return null; }
    if (!match) { showToast('No product found: ' + code, 'error'); return null; }
    const hasStock = (sm[match.product_id] || 0) > 0 || (bm[match.product_id] || 0) > 0;
    if (!hasStock) { showToast(`Not in ${locName}: ${match.product_name}`, 'error'); return null; }
    return match;
  }

  function handleBarcodeKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const code = e.currentTarget.value.trim();
    e.currentTarget.value = '';
    if (!code) return;
    const match = resolveScan(code);
    if (match) addToCart(match);
  }

  function handleScan(code: string) {
    const match = resolveScan(code);
    if (match) addToCart(match);
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
  // Build the atomic stock operations for selling one cart line. Pure
  // computation from the current cache — no DB writes here. The ops are a
  // set of deltas the database applies atomically (see stockTxn). Throws
  // early if there clearly isn't enough stock, so the user sees a clean
  // message before anything is attempted.
  function buildSellOps(
    p: Product,
    qty: number,
    unit: CartUnit,
    sellPrice: number | null,
    groupChoices: Record<string, number> = {},
    companyId = 1,
  ): StockOp[] {
    // The two companies are just billing labels over ONE shared physical
    // stock, sold from the same locations. So BOTH the product and its
    // components deduct from whichever company's stock actually has them —
    // the chosen company only decides which company the SALE/bill is
    // attributed to (see buildSalePayload). Search the chosen company first,
    // then the other; within each, the sale location first, then the rest.
    const ops: StockOp[] = [];
    const pid = p.product_id;
    const ppb = p.pieces_per_box ?? 0;
    const isBoxMode = unit === 'box' && ppb > 0;
    const movPieces = isBoxMode ? qty * ppb : qty;

    const locId       = locationId;
    const saleLocName = locName;
    const locNameOf   = (id: number) => locations.find(l => l.location_id === id)?.location_name ?? 'Other';

    const companyOrder = [companyId, ...companies.map(c => c.company_id).filter(cid => cid !== companyId)];
    const companyShort = (cid: number) => (companies.find(c => c.company_id === cid)?.company_name ?? '').replace(/\s*Enterprise$/i, '');

    // Total of a product across ALL companies and ALL locations.
    const totalAllCompanies = (prodId: number, prodPpb: number): number =>
      companyOrder.reduce((sum, cid) => {
        const sc = stockByCompany[cid] ?? {}; const bc = boxByCompany[cid] ?? {};
        return sum + locations.reduce((s, l) =>
          s + ((sc[l.location_id] ?? {})[prodId] ?? 0)
            + ((bc[l.location_id] ?? {})[prodId] ?? 0) * prodPpb, 0);
      }, 0);

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

    // ── Validate the main product across ALL companies + locations ──
    const grandTotal = totalAllCompanies(pid, ppb);
    if (movPieces > grandTotal) {
      throw new Error(`Only ${grandTotal} ${unitLabel(p, 'piece').toLowerCase()}s of ${p.product_name} in stock total`);
    }

    // ── Pre-validate component stock across ALL companies + locations ──
    for (const comp of activeComps) {
      const cid      = comp.component_product_id;
      const cPpb     = products.find(pr => pr.product_id === cid)?.pieces_per_box ?? 0;
      const movComp  = movPieces * comp.quantity;
      const cHave    = totalAllCompanies(cid, cPpb);
      const compName = products.find(pr => pr.product_id === cid)?.product_name ?? `#${cid}`;
      if (cHave < movComp) {
        throw new Error(`Not enough "${compName}": need ${movComp}, only ${cHave} in stock across all locations`);
      }
    }

    const unitLbl = unitLabel(p, unit).toLowerCase();
    const priceSuffix = sellPrice != null
      ? ` · ${qty} ${unitLbl}${qty === 1 ? '' : 's'} @ Ksh ${sellPrice} = Ksh ${(qty * sellPrice).toLocaleString('en-KE')}`
      : '';

    // Drain `needPieces` of `prodId` across companies + locations, pushing a
    // stock op for each spot it pulls from. `onOp` shapes the movement fields.
    const drainProduct = (
      prodId: number,
      prodPpb: number,
      needPieces: number,
      allowWholeBox: boolean,
      onOp: (fields: { lId: number; coId: number; take: number; dq: number; db: number; sameSpot: boolean; from: string }) => StockOp,
    ) => {
      let need = needPieces;
      for (const coId of companyOrder) {
        if (need <= 0) break;
        const sc = stockByCompany[coId] ?? {};
        const bc = boxByCompany[coId]   ?? {};
        const others = locations
          .filter(l => l.location_id !== locId)
          .map(l => ({ id: l.location_id, tot: ((sc[l.location_id] ?? {})[prodId] ?? 0) + ((bc[l.location_id] ?? {})[prodId] ?? 0) * prodPpb }))
          .filter(l => l.tot > 0)
          .sort((a, b) => b.tot - a.tot)
          .map(l => l.id);
        for (const lId of [locId, ...others]) {
          if (need <= 0) break;
          const pcs = (sc[lId] ?? {})[prodId] ?? 0;
          const bx  = (bc[lId] ?? {})[prodId] ?? 0;
          const locTotal = pcs + bx * prodPpb;
          if (locTotal <= 0) continue;
          const take = Math.min(need, locTotal);
          // Whole-box deduction only when the ENTIRE box sale fits one spot's boxes.
          const asWholeBoxes = allowWholeBox && isBoxMode && take === needPieces && bx * prodPpb >= take;
          const newState = asWholeBoxes
            ? deductFromLocation(pcs, bx, qty, 'box', prodPpb)
            : deductFromLocation(pcs, bx, take, 'piece', prodPpb);
          const sameSpot = lId === locId && coId === companyId;
          const from = `${locNameOf(lId)}${coId !== companyId ? ' · ' + companyShort(coId) : ''}`;
          ops.push(onOp({ lId, coId, take, dq: newState.quantity - pcs, db: newState.box_quantity - bx, sameSpot, from }));
          need -= take;
        }
      }
    };

    // ── Deduct the main product across companies + locations ──
    drainProduct(pid, ppb, movPieces, true, ({ lId, coId, take, dq, db, sameSpot, from }) => ({
      product_id: pid, location_id: lId, company_id: coId,
      dq, db, mov_type: 'SALE', mov_qty: take, mov_from: lId, mov_to: null,
      reason: sameSpot
        ? `Sold from ${saleLocName}${priceSuffix}`
        : `Sold from ${from} (POS overflow)${priceSuffix}`,
    }));

    // ── Deduct each component across companies + locations (same helper) ──
    for (const comp of activeComps) {
      const cid  = comp.component_product_id;
      const cPpb = products.find(pr => pr.product_id === cid)?.pieces_per_box ?? 0;
      // Components are always deducted by pieces (never as whole boxes).
      drainProduct(cid, cPpb, movPieces * comp.quantity, false, ({ lId, coId, take, dq, db, sameSpot, from }) => ({
        product_id: cid, location_id: lId, company_id: coId,
        dq, db, mov_type: 'AUTO_DEDUCT', mov_qty: take, mov_from: lId, mov_to: null,
        reason: sameSpot
          ? `Auto: component of ${p.product_name}`
          : `Auto: component of ${p.product_name} (pulled from ${from})`,
      }));
    }
    return ops;
  }

  // Build the atomic stock operations for transferring one cart line from
  // the current location to `destLocationId`. Pure computation, no writes.
  function buildTransferOps(
    p: Product,
    qty: number,
    unit: CartUnit,
    destLocationId: number,
    groupChoices: Record<string, number> = {},
    companyId = 1,
  ): StockOp[] {
    // Transfer within the chosen company's stock.
    const stockByLoc = stockByCompany[companyId] ?? {};
    const boxByLoc   = boxByCompany[companyId]   ?? {};
    const ops: StockOp[] = [];
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
    ops.push({
      product_id: pid, location_id: srcId, company_id: companyId,
      dq: newSrc.quantity - srcPcs, db: newSrc.box_quantity - srcBx,
      mov_type: 'TRANSFER', mov_qty: movPieces, mov_from: srcId, mov_to: dstId,
      reason: `Moved from ${srcName} to ${dstName}`,
    });
    ops.push({
      product_id: pid, location_id: dstId, company_id: companyId,
      dq: newDst.quantity - dstPcs, db: newDst.box_quantity - dstBx,
    });

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
        const rawSrc = deductFromLocation(cSrcPcs, cSrcBx, movComp, 'piece', cPpb);
        const newSrcQ = Math.max(0, rawSrc.quantity);
        const newSrcB = Math.max(0, rawSrc.box_quantity);
        ops.push({
          product_id: cid, location_id: srcId, company_id: companyId,
          dq: newSrcQ - cSrcPcs, db: newSrcB - cSrcBx,
          mov_type: 'TRANSFER', mov_qty: movComp, mov_from: srcId, mov_to: dstId,
          reason: `Auto: component of ${p.product_name}`,
        });
        ops.push({
          product_id: cid, location_id: dstId, company_id: companyId,
          dq: movComp, db: 0,   // add loose pieces to destination (matches prior behavior)
        });
      }
    }
    return ops;
  }

  // Build the sales header + line items payload for a checkout. The actual
  // insert happens inside stockTxn so it's atomic with the stock changes.
  function buildSalePayload(items: CartItem[]): SalePayload {
    return {
      sale_date:    new Date().toISOString().split('T')[0],
      location_id:  locationId,
      total_amount: items.reduce((s, i) => s + (i.sellPrice ?? 0) * i.qty, 0),
      item_count:   items.reduce((s, i) => s + i.qty, 0),
      items: items.map(i => ({
        product_id:   i.product.product_id,
        product_name: i.product.product_name,
        quantity:     i.qty,
        unit:         unitLabel(i.product, i.unit),
        unit_price:   i.sellPrice ?? null,
        cost_price:   i.product.buying_price ?? null,
        line_total:   i.sellPrice != null ? i.sellPrice * i.qty : null,
        company_id:   i.companyId,
      })),
    };
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
      // Build every stock change for the whole cart, then apply them in ONE
      // atomic transaction (with the sale). Nothing is half-written.
      const ops: StockOp[] = [];
      for (const item of cart) {
        ops.push(...(action === 'sold'
          ? buildSellOps(item.product, item.qty, item.unit, item.sellPrice, item.groupChoices, item.companyId)
          : buildTransferOps(item.product, item.qty, item.unit, item.transferDestId!, item.groupChoices, item.companyId)));
      }
      await stockTxn(ops, action === 'sold' ? buildSalePayload(cart) : null);
      if (action === 'sold') { await rememberChoicePrices(cart); await rememberProductPrices(cart); }
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
      refresh();  // re-sync stock so a retry uses fresh numbers (nothing was written)
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
      const ops = action === 'sold'
        ? buildSellOps(item.product, item.qty, item.unit, item.sellPrice, item.groupChoices, item.companyId)
        : buildTransferOps(item.product, item.qty, item.unit, item.transferDestId!, item.groupChoices, item.companyId);
      await stockTxn(ops, action === 'sold' ? buildSalePayload([item]) : null);
      if (action === 'sold') { await rememberChoicePrices([item]); await rememberProductPrices([item]); }
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
      refresh();  // re-sync stock so a retry uses fresh numbers (nothing was written)
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
      <header className="shrink-0 glass border-b px-3 flex items-center gap-2 h-14">
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

      {/* Dynamic location tabs — segmented control */}
      <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-white/5 bg-surface/60">
        <div className="flex gap-1 p-1 rounded-2xl card-lux overflow-x-auto scrollbar-none">
          {locations.map(loc => (
            <button
              key={loc.location_id}
              onClick={() => { setLocationId(loc.location_id); setCategory('All'); }}
              className={`shrink-0 flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
                locationId === loc.location_id
                  ? 'btn-primary'
                  : 'text-muted hover:text-slate-100 hover:bg-white/5'
              }`}
            >
              {loc.location_name}
            </button>
          ))}
        </div>
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

      <main className="flex-1 overflow-y-auto px-3 py-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 auto-rows-min">
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
              className="fixed right-0 top-0 bottom-0 w-[88vw] max-w-sm z-90 glass border-l flex flex-col shadow-2xl"
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
                  const max = maxForProduct(item.product, item.unit, item.companyId);
                  const atMax = item.qty >= max;
                  const unitLbl = unitLabel(item.product, item.unit);
                  return (
                  <div key={item.product.product_id} className="card-lux rounded-xl px-3 py-2.5">
                    <div className="flex items-start justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-100 leading-snug break-words line-clamp-2 flex-1 mr-2">{item.product.product_name}</p>
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
                                const newMax = maxForProduct(i.product, u, i.companyId);
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

                    {/* Company toggle — which company's stock this line sells
                        from. Disabled for a company with none of this product. */}
                    {companies.length > 1 && (
                      <div className="flex gap-1 mb-2">
                        {companies.map(co => {
                          const avail = maxForProduct(item.product, item.unit, co.company_id);
                          const isSel = item.companyId === co.company_id;
                          const disabled = avail <= 0;
                          return (
                            <button
                              key={co.company_id}
                              disabled={disabled}
                              onClick={() => setCart(c => c.map(i => {
                                if (i.product.product_id !== item.product.product_id) return i;
                                const newMax = maxForProduct(i.product, i.unit, co.company_id);
                                return { ...i, companyId: co.company_id, qty: Math.max(1, Math.min(i.qty, newMax || 1)) };
                              }))}
                              className={`flex-1 py-1.5 rounded flex flex-col items-center text-[10px] font-bold border transition-all ${
                                isSel
                                  ? 'border-teal/50 bg-teal/15 text-teal'
                                  : disabled
                                    ? 'border-white/5 bg-surface text-muted/40 cursor-not-allowed'
                                    : 'border-white/10 bg-surface text-muted hover:text-slate-100'
                              }`}
                            >
                              <span className="truncate max-w-full">{co.company_name.replace(/\s*Enterprise$/i, '')}</span>
                              <span className="text-[8px] font-normal opacity-70 leading-tight">{avail} avail</span>
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
                                        onClick={() => setCart(prev => prev.map(i => {
                                          if (i.product.product_id !== item.product.product_id) return i;
                                          const newChoices = { ...i.groupChoices, [groupName]: c.component_product_id };
                                          // Pull the sell price for the newly picked option (if it has one).
                                          const cp = choiceSellPrice(i.product, newChoices, i.unit);
                                          return { ...i, groupChoices: newChoices, sellPrice: cp != null ? cp : i.sellPrice };
                                        }))}
                                        className={`text-left px-2 py-1.5 rounded border text-[10px] font-semibold transition-all ${
                                          isPicked
                                            ? 'border-gold bg-gold/15 text-gold'
                                            : 'border-white/8 bg-surface2 text-slate-300 hover:border-gold/40'
                                        }`}
                                      >
                                        {isPicked && '✓ '}{name} <span className="text-muted font-normal">×{c.quantity}/unit</span>
                                        {c.price != null && <span className="float-right font-bold text-gold">Ksh {c.price.toLocaleString('en-KE')}</span>}
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
                        type="text"
                        inputMode="numeric"
                        value={item.qty}
                        onFocus={e => e.currentTarget.select()}
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
                        type="text"
                        inputMode="decimal"
                        value={item.sellPrice ?? ''}
                        placeholder="0.00"
                        onFocus={e => e.currentTarget.select()}
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
                      <div className="card-lux rounded-xl px-3.5 py-2.5 flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted">Excl. VAT</span>
                          <span className="text-[10px] text-muted tabular-nums">Ksh {base.toLocaleString('en-KE')}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted">VAT (16%)</span>
                          <span className="text-[10px] text-muted tabular-nums">Ksh {vat.toLocaleString('en-KE')}</span>
                        </div>
                        <div className="flex items-center justify-between border-t border-white/8 pt-1.5 mt-0.5">
                          <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Total (incl. VAT)</span>
                          <span className="text-base font-extrabold text-gradient tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>
                            Ksh {total.toLocaleString('en-KE')}
                          </span>
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
  const meta   = [p.brand, p.model].filter(Boolean).join(' · ') || p.stock_keeping_unit;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.25), duration: 0.25 }}
      onClick={() => onAdjust(p, 'minus')}
      className="flex flex-col rounded-2xl card-lux hover:border-teal/30 cursor-pointer transition-colors duration-200 overflow-hidden active:bg-surface2/60"
    >
      {/* Name block — full width so long names wrap instead of clipping */}
      <div className="px-4 pt-3.5 pb-2">
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

      {/* Stock status + tap controls */}
      <div className="px-4 py-2 border-t border-white/6 bg-black/15 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-xs font-semibold ${stockCls}`}>{stockTxt}</p>
          {showOtherBadge && (
            <p className="text-[10px] text-gold/75 mt-0.5">📦 {otherTotal} elsewhere</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => onAdjust(p, 'minus')}
            aria-label="Sell / remove"
            className="w-10 h-10 rounded-xl bg-danger/10 border border-danger/25 text-danger text-xl font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all active:scale-90"
          >−</button>

          <div className="flex flex-col items-center min-w-9">
            <span className="text-[22px] font-extrabold text-slate-100 tabular-nums leading-none" style={{ fontFamily: 'var(--font-display)' }}>{bigNum}</span>
            {fmt.unitBadge === 'BOX' && ppb > 0 && total % ppb > 0 && (
              <span className="text-[9px] text-muted leading-none mt-0.5">{`+${total % ppb}pc`}</span>
            )}
            <span className="text-[8px] font-bold text-muted/50 uppercase tracking-widest leading-none mt-0.5">{fmt.unitBadge}</span>
          </div>

          <button
            onClick={() => onAdjust(p, 'plus')}
            aria-label="Add stock"
            className="w-10 h-10 rounded-xl btn-primary text-xl font-bold flex items-center justify-center"
          >+</button>
        </div>
      </div>
    </motion.div>
  );
}
