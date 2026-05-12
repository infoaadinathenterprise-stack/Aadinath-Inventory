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
import type { Product, Location } from '@/lib/types';
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
  product:   Product;
  qty:       number;
  unit:      CartUnit;        // 'box' means bulk unit (could be box/roll/drum — labeled via display_unit)
  sellPrice: number | null;   // per-unit sell price for THIS sale; null = give-away / not recorded
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

interface ModalState {
  product:   Product;
  direction: 'plus' | 'minus';
  location:  Location;
}

function PosDashboard() {
  const {
    products, backStockMap, mainStockMap, backBoxMap, mainBoxMap,
    loading, error, refresh,
  } = useProducts();
  const componentMap = useProductComponents();

  const [location,    setLocation]    = useState<Location>('back');
  const [category,    setCategory]    = useState('All');
  const [search,      setSearch]      = useState('');
  const [modal,       setModal]       = useState<ModalState | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cart,        setCart]        = useState<CartItem[]>([]);
  const [cartOpen,    setCartOpen]    = useState(false);
  const [processing,  setProcessing]  = useState(false);
  const [toast,       setToast]       = useState<ToastState | null>(null);
  const toastId    = useRef(0);
  const barcodeRef = useRef<HTMLInputElement>(null);

  // Auto-focus barcode input on page load (delayed to survive loading state transition)
  useEffect(() => {
    const t = setTimeout(() => barcodeRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

  // Global keydown redirect — USB scanner types then sends Enter; if focus
  // has drifted to a non-input element, snap it back to the barcode field
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      const active = document.activeElement;
      const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (!isInput && barcodeRef.current) {
        barcodeRef.current.focus();
      }
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  const sm = location === 'back' ? backStockMap : mainStockMap;
  const bm = location === 'back' ? backBoxMap   : mainBoxMap;

  // Max quantity we can put in the cart for this product in the
  // chosen unit. Treats both locations as one piece pool (overflow
  // pulls from the other location when current runs out) and
  // converts to the chosen unit if needed.
  function maxForProduct(p: Product, unit: CartUnit = 'piece'): number {
    const ppb = p.pieces_per_box ?? 0;
    const totalPcs = (backStockMap[p.product_id] || 0) + (mainStockMap[p.product_id] || 0);
    const totalBx  = (backBoxMap[p.product_id]   || 0) + (mainBoxMap[p.product_id]   || 0);
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
      return [...prev, { product, qty: 1, unit: 'piece', sellPrice: defaultSellPrice(product, 'piece') }];
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
    if (!hasStock) { showToast(`Not in ${location === 'back' ? 'Back Godown' : 'Main Store'}: ${match.product_name}`, 'error'); return; }
    addToCart(match);
  }

  function handleScan(code: string) {
    const match =
      products.find(p => (p.stock_keeping_unit ?? '').toLowerCase() === code.toLowerCase()) ??
      products.find(p => p.product_name.toLowerCase().includes(code.toLowerCase()));
    if (!match) { showToast('No product found: ' + code, 'error'); return; }
    const hasStock = (sm[match.product_id] || 0) > 0 || (bm[match.product_id] || 0) > 0;
    if (!hasStock) { showToast(`Not in ${location === 'back' ? 'Back Godown' : 'Main Store'}: ${match.product_name}`, 'error'); return; }
    addToCart(match);
  }

  function openModal(product: Product, direction: 'plus' | 'minus') {
    setModal({ product, direction, location });
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
  async function sellOneItem(p: Product, qty: number, unit: CartUnit, sellPrice: number | null) {
    const pid = p.product_id;
    const ppb = p.pieces_per_box ?? 0;
    const isBoxMode = unit === 'box' && ppb > 0;
    const movPieces = isBoxMode ? qty * ppb : qty;

    const locId    = location === 'back' ? 2 : 1;
    const otherId  = location === 'back' ? 1 : 2;
    const locName  = location === 'back' ? 'Back Godown' : 'Main Store';
    const otherName = location === 'back' ? 'Main Store' : 'Back Godown';

    const curPcs = (location === 'back' ? backStockMap : mainStockMap)[pid] || 0;
    const curBx  = (location === 'back' ? backBoxMap   : mainBoxMap  )[pid] || 0;
    const otherPcs = (location === 'back' ? mainStockMap : backStockMap)[pid] || 0;
    const otherBx  = (location === 'back' ? mainBoxMap   : backBoxMap )[pid] || 0;

    const totalCur   = curPcs   + curBx   * ppb;
    const totalOther = otherPcs + otherBx * ppb;
    if (movPieces > totalCur + totalOther) {
      throw new Error(`Only ${totalCur + totalOther} ${unitLabel(p, 'piece').toLowerCase()}s in stock total`);
    }

    const fromCurPieces   = Math.min(movPieces, totalCur);
    const fromOtherPieces = movPieces - fromCurPieces;

    // Build the price suffix once — appended to every movement note
    // for this sale so each line in History carries the price the
    // item actually sold for.
    const unitLbl = unitLabel(p, unit).toLowerCase();
    const priceSuffix = sellPrice != null
      ? ` · ${qty} ${unitLbl}${qty === 1 ? '' : 's'} @ Ksh ${sellPrice} = Ksh ${(qty * sellPrice).toLocaleString('en-KE')}`
      : '';

    if (fromCurPieces > 0) {
      let newState: { quantity: number; box_quantity: number };
      if (isBoxMode && fromCurPieces === movPieces) {
        // Whole sale fits in current location and user wanted boxes:
        // use box-mode deduction so we draw from box_quantity first.
        newState = deductFromLocation(curPcs, curBx, qty, 'box', ppb);
      } else {
        // Piece mode (drains loose first, breaks boxes only if needed).
        newState = deductFromLocation(curPcs, curBx, fromCurPieces, 'piece', ppb);
      }
      await upsertStock(pid, locId, newState);
      await logMovement(pid, locId, null, fromCurPieces, 'SALE', `Sold from ${locName}${priceSuffix}`);
    }

    if (fromOtherPieces > 0) {
      // Overflow path — always treat the other location's stock as a
      // piece pool. Breaks boxes if needed.
      const newState = deductFromLocation(otherPcs, otherBx, fromOtherPieces, 'piece', ppb);
      await upsertStock(pid, otherId, newState);
      await logMovement(pid, otherId, null, fromOtherPieces, 'SALE', `Sold from ${otherName} (POS overflow)${priceSuffix}`);
    }
  }

  // Transfer `qty` of `unit` for `p` from back godown to main store.
  // Mirrors AdjustStockModal's transfer logic so box columns move
  // cleanly between locations.
  async function transferOneItem(p: Product, qty: number, unit: CartUnit) {
    const pid = p.product_id;
    const ppb = p.pieces_per_box ?? 0;
    const backId = 2, mainId = 1;
    const backPcs = backStockMap[pid] || 0;
    const backBx  = backBoxMap[pid]   || 0;
    const mainPcs = mainStockMap[pid] || 0;
    const mainBx  = mainBoxMap[pid]   || 0;

    const movPieces = unit === 'box' && ppb > 0 ? qty * ppb : qty;
    const backTotal = backPcs + backBx * ppb;
    if (movPieces > backTotal) {
      throw new Error(`Back Godown only has ${backTotal} ${unitLabel(p, 'piece').toLowerCase()}s of ${p.product_name}`);
    }

    const newBack = deductFromLocation(backPcs, backBx, qty, unit, ppb);
    const newMain = addToLocation(mainPcs, mainBx, qty, unit);
    await upsertStock(pid, backId, newBack);
    await upsertStock(pid, mainId, newMain);
    await logMovement(pid, backId, mainId, movPieces, 'TRANSFER', 'Moved from Back Godown to Main Store');
  }

  // Writes a single `sales` row + N `sale_items` rows so each
  // POS checkout shows up on the Sales page and can be queried for
  // daily/weekly/monthly totals without parsing movement notes.
  async function recordSale(items: CartItem[]) {
    const total = items.reduce((s, i) => s + (i.sellPrice ?? 0) * i.qty, 0);
    const itemCount = items.reduce((s, i) => s + i.qty, 0);
    const performedBy = (typeof window !== 'undefined' && localStorage.getItem(USER_KEY)) || 'Admin';
    const locId = location === 'back' ? 2 : 1;

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
    const { error: itemsErr } = await supabase.from('sale_items').insert(rows);
    if (itemsErr) {
      showToast('Sale header saved but line items failed: ' + itemsErr.message, 'error');
    }
  }

  async function processCart(action: 'sold' | 'to_main') {
    if (cart.length === 0) return;
    if (action === 'to_main') {
      // to_main only moves from Back Godown — validate every cart row
      // has enough back-godown stock for its qty in its chosen unit.
      const overflows = cart.filter(it => {
        const ppb = it.product.pieces_per_box ?? 0;
        const movPieces = it.unit === 'box' && ppb > 0 ? it.qty * ppb : it.qty;
        const backTotal = (backStockMap[it.product.product_id] || 0) + (backBoxMap[it.product.product_id] || 0) * ppb;
        return movPieces > backTotal;
      });
      if (overflows.length > 0) {
        showToast(`Cannot move more than Back Godown has: ${overflows.map(o => o.product.product_name).join(', ')}`, 'error');
        return;
      }
    }
    setProcessing(true);
    try {
      for (const item of cart) {
        if (action === 'sold') {
          await sellOneItem(item.product, item.qty, item.unit, item.sellPrice);
        } else {
          await transferOneItem(item.product, item.qty, item.unit);
        }
      }
      // After all stock + movement writes succeed, snapshot the cart
      // to the sales journal so the new /admin/sales page can show
      // daily totals + per-product breakdowns.
      if (action === 'sold') {
        await recordSale(cart);
      }
      showToast(`${action === 'sold' ? 'Sold' : 'Moved'} ${cart.length} item(s) ✓`, 'success');
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

  async function processItem(item: CartItem, action: 'sold' | 'to_main') {
    if (action === 'to_main') {
      const ppb = item.product.pieces_per_box ?? 0;
      const movPieces = item.unit === 'box' && ppb > 0 ? item.qty * ppb : item.qty;
      const backTotal = (backStockMap[item.product.product_id] || 0) + (backBoxMap[item.product.product_id] || 0) * ppb;
      if (movPieces > backTotal) {
        showToast(`Back Godown only has ${backTotal} ${unitLabel(item.product, 'piece').toLowerCase()}s for ${item.product.product_name}`, 'error');
        return;
      }
    }
    setProcessing(true);
    try {
      if (action === 'sold') {
        await sellOneItem(item.product, item.qty, item.unit, item.sellPrice);
        await recordSale([item]);
      } else {
        await transferOneItem(item.product, item.qty, item.unit);
      }
      setCart(c => c.filter(i => i.product.product_id !== item.product.product_id));
      showToast(`${action === 'sold' ? 'Sold' : 'Moved'}: ${item.product.product_name} ✓`, 'success');
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setProcessing(false);
    }
  }

  const [showVersionFlash, setShowVersionFlash] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShowVersionFlash(false), 2500);
    return () => clearTimeout(t);
  }, []);

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
      {showVersionFlash && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-999 bg-teal text-navy text-xs font-black px-4 py-2 rounded-full shadow-lg animate-bounce">
          ✓ POS v2 — Barcode Cart Mode Active
        </div>
      )}
      <header className="shrink-0 bg-surface border-b border-white/8 px-3 flex items-center gap-2 h-14">
        <Link href="/admin" className="text-muted hover:text-slate-100 text-sm px-3 py-1.5 rounded-lg bg-surface2 border border-white/8 transition-colors shrink-0">
          ← Back
        </Link>
        <h1 className="text-sm font-bold text-slate-100 shrink-0">
          {location === 'back' ? '📦 Back Godown' : '🏪 Main Store'}
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

      <div className="shrink-0 flex gap-2 px-3 pt-2.5 pb-2 border-b border-white/8 bg-surface">
        {(['back', 'main'] as Location[]).map(loc => (
          <button
            key={loc}
            onClick={() => { setLocation(loc); setCategory('All'); }}
            className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${
              location === loc
                ? 'border-teal bg-teal/10 text-teal'
                : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
            }`}
          >
            {loc === 'back' ? '📦 Back Godown' : '🏪 Main Store'}
          </button>
        ))}
      </div>

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
          <p className="text-center text-muted text-sm py-12">No products with {location} stock</p>
        )}
        <AnimatePresence mode="popLayout">
          {visible.map((p, i) => (
            <PosProductCard
              key={p.product_id}
              product={p}
              index={i}
              location={location}
              stockMap={sm}
              boxMap={bm}
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
                                // Keep a custom price if the user already
                                // overrode it; otherwise pick up the
                                // catalog default for the new unit.
                                const wasDefault = i.sellPrice == null || i.sellPrice === defaultSellPrice(i.product, i.unit);
                                return {
                                  ...i,
                                  unit: u,
                                  qty: Math.max(1, Math.min(i.qty, newMax || 1)),
                                  sellPrice: wasDefault ? defaultSellPrice(i.product, u) : i.sellPrice,
                                };
                              }))}
                              className={`flex-1 py-1 rounded text-[10px] font-bold border transition-all ${
                                isSel
                                  ? u === 'piece'
                                    ? 'border-teal/40 bg-teal/10 text-teal'
                                    : 'border-gold/40 bg-gold/10 text-gold'
                                  : 'border-white/10 bg-surface text-muted hover:text-slate-100'
                              }`}
                            >
                              {unitLabel(item.product, u)}
                              {u === 'box' && ppb > 0 ? ` (${ppb}/ea)` : ''}
                            </button>
                          );
                        })}
                      </div>
                    )}

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

                    <div className="flex gap-1.5">
                      <button
                        onClick={() => processItem(item, 'sold')}
                        disabled={processing}
                        className="flex-1 py-1 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[10px] font-bold hover:bg-danger/20 disabled:opacity-50 transition-all"
                      >Sold</button>
                      {location === 'back' && (
                        <button
                          onClick={() => processItem(item, 'to_main')}
                          disabled={processing}
                          className="flex-1 py-1 rounded-lg bg-teal/10 border border-teal/20 text-teal text-[10px] font-bold hover:bg-teal/20 disabled:opacity-50 transition-all"
                        >→ Main</button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>

              {cart.length > 0 && (
                <div className="p-3 border-t border-white/8 flex flex-col gap-2 shrink-0">
                  {/* Grand total — sum of qty*sellPrice across rows
                      that have a price set. Useful as a quick
                      bill-total sanity check before tapping Sold. */}
                  {(() => {
                    const total = cart.reduce((s, i) => s + (i.sellPrice ?? 0) * i.qty, 0);
                    if (total <= 0) return null;
                    return (
                      <div className="flex items-center justify-between bg-surface2 border border-teal/20 rounded-xl px-3 py-2">
                        <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Total</span>
                        <span className="text-sm font-bold text-teal tabular-nums">Ksh {total.toLocaleString('en-KE')}</span>
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
                  {location === 'back' && (
                    <button
                      onClick={() => processCart('to_main')}
                      disabled={processing}
                      className="w-full py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2 hover:bg-teal/25 transition-all"
                    >
                      {processing && <div className="w-3.5 h-3.5 rounded-full border-2 border-teal border-t-transparent animate-spin" />}
                      📦 Move All to Main Store
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
            location={modal.location}
            direction={modal.direction}
            backStockMap={backStockMap}
            mainStockMap={mainStockMap}
            backBoxMap={backBoxMap}
            mainBoxMap={mainBoxMap}
            componentMap={componentMap}
            allProducts={products}
            onClose={() => { setModal(null); setTimeout(() => barcodeRef.current?.focus(), 100); }}
            onSuccess={(msg) => showToast(msg, 'success')}
            onError={(msg) => showToast(msg, 'error')}
            onDone={refresh}
          />
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

interface CardProps {
  product:  Product;
  index:    number;
  location: Location;
  stockMap: Record<number, number>;
  boxMap:   Record<number, number>;
  onAdjust: (product: Product, direction: 'plus' | 'minus') => void;
}

function PosProductCard({ product: p, index, location, stockMap, boxMap, onAdjust }: CardProps) {
  const ppb   = p.pieces_per_box || 0;
  const qty   = stockMap[p.product_id] || 0;
  const bx    = boxMap[p.product_id]   || 0;
  const total = qty + bx * (ppb || 1);
  const fmt   = formatStock(total, p.unit_type, p.unit_of_measure, ppb);
  const reorder = p.reorder_level ?? 2;

  const stockCls =
    total === 0      ? 'text-danger' :
    total <= reorder ? 'text-gold'   :
                       'text-muted';

  const stockTxt =
    total === 0        ? 'Out of stock' :
    total <= reorder   ? `⚠ Low — ${fmt.label}` :
    `${fmt.label} in ${location === 'back' ? 'back' : 'main'}`;

  const bigNum = fmt.unitBadge === 'BOX' && ppb > 0 ? Math.floor(total / ppb) : total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5), duration: 0.3 }}
      layout
      onClick={() => onAdjust(p, 'minus')}
      className="flex items-center gap-3 px-3 py-3 rounded-xl bg-surface border border-white/5 hover:border-teal/20 cursor-pointer transition-all group"
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
      </div>

      <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onAdjust(p, 'minus')}
          className="w-8 h-8 rounded-lg bg-danger/10 border border-danger/30 text-danger text-xl font-bold flex items-center justify-center hover:bg-danger hover:text-white transition-all active:scale-90"
        >−</button>

        <div className="flex flex-col items-center min-w-8.5">
          <span className="text-lg font-bold text-slate-200 tabular-nums leading-none">{bigNum}</span>
          {fmt.unitBadge === 'BOX' && ppb > 0 && (
            <span className="text-[8px] text-muted leading-none">{`${bigNum}bx+${total % ppb}pc`}</span>
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
