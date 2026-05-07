'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useProducts } from '@/lib/hooks/useProducts';
import { useProductComponents } from '@/lib/hooks/useProductComponents';
import { formatStock } from '@/lib/formatStock';
import { upsertStock, logMovement } from '@/lib/stockActions';
import AdjustStockModal from '@/app/admin/components/AdjustStockModal';
import BarcodeScanner   from '@/app/admin/components/BarcodeScanner';
import Toast, { type ToastState } from '@/app/admin/components/Toast';
import type { Product, Location } from '@/lib/types';
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

interface CartItem {
  product: Product;
  qty:     number;
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

  function addToCart(product: Product) {
    setCart(prev => {
      const existing = prev.find(c => c.product.product_id === product.product_id);
      if (existing) {
        return prev.map(c =>
          c.product.product_id === product.product_id ? { ...c, qty: c.qty + 1 } : c
        );
      }
      return [...prev, { product, qty: 1 }];
    });
    barcodeRef.current?.focus();
    showToast(`Added: ${product.product_name}`, 'success');
    setCartOpen(true);
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

  async function processCart(action: 'sold' | 'to_main') {
    if (cart.length === 0) return;
    setProcessing(true);
    const locId  = location === 'back' ? 2 : 1;
    const mainId = 1;
    try {
      for (const item of cart) {
        const pid    = item.product.product_id;
        const curQty = (location === 'back' ? backStockMap : mainStockMap)[pid] || 0;
        const deduct = Math.min(item.qty, curQty);
        if (action === 'sold') {
          await upsertStock(pid, locId, 'quantity', Math.max(0, curQty - deduct));
          await logMovement(pid, locId, null, deduct, 'SALE', `Sold from ${location === 'back' ? 'Back Godown' : 'Main Store'}`);
        } else {
          await upsertStock(pid, locId, 'quantity', Math.max(0, curQty - deduct));
          const mainQty = mainStockMap[pid] || 0;
          await upsertStock(pid, mainId, 'quantity', mainQty + deduct);
          await logMovement(pid, locId, mainId, deduct, 'TRANSFER', 'Moved from Back Godown to Main Store');
        }
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
    setProcessing(true);
    const locId  = location === 'back' ? 2 : 1;
    const mainId = 1;
    try {
      const pid    = item.product.product_id;
      const curQty = (location === 'back' ? backStockMap : mainStockMap)[pid] || 0;
      const deduct = Math.min(item.qty, curQty);
      if (action === 'sold') {
        await upsertStock(pid, locId, 'quantity', Math.max(0, curQty - deduct));
        await logMovement(pid, locId, null, deduct, 'SALE', `Sold from ${location === 'back' ? 'Back Godown' : 'Main Store'}`);
      } else {
        await upsertStock(pid, locId, 'quantity', Math.max(0, curQty - deduct));
        const mainQty = mainStockMap[pid] || 0;
        await upsertStock(pid, mainId, 'quantity', mainQty + deduct);
        await logMovement(pid, locId, mainId, deduct, 'TRANSFER', 'Moved from Back Godown to Main Store');
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
                      className="text-xs text-danger hover:underline"
                    >Clear</button>
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
                {cart.map(item => (
                  <div key={item.product.product_id} className="bg-surface2 rounded-xl px-3 py-2.5 border border-white/5">
                    <div className="flex items-start justify-between mb-2">
                      <p className="text-xs font-semibold text-slate-100 truncate flex-1 mr-2">{item.product.product_name}</p>
                      <button
                        onClick={() => setCart(c => c.filter(i => i.product.product_id !== item.product.product_id))}
                        className="text-muted hover:text-danger text-sm shrink-0 transition-colors"
                      >×</button>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <button
                        onClick={() => setCart(c => c.map(i =>
                          i.product.product_id === item.product.product_id
                            ? { ...i, qty: Math.max(1, i.qty - 1) }
                            : i
                        ))}
                        className="w-6 h-6 rounded bg-surface border border-white/10 text-slate-300 text-sm flex items-center justify-center hover:bg-danger/20 hover:text-danger transition-all"
                      >−</button>
                      <span className="text-sm font-bold text-slate-100 w-6 text-center tabular-nums">{item.qty}</span>
                      <button
                        onClick={() => setCart(c => c.map(i =>
                          i.product.product_id === item.product.product_id
                            ? { ...i, qty: i.qty + 1 }
                            : i
                        ))}
                        className="w-6 h-6 rounded bg-surface border border-white/10 text-slate-300 text-sm flex items-center justify-center hover:bg-teal/20 hover:text-teal transition-all"
                      >+</button>
                    </div>
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
                ))}
              </div>

              {cart.length > 0 && (
                <div className="p-3 border-t border-white/8 flex flex-col gap-2 shrink-0">
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
