'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import type { Product, StockMap } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';

const PRICING_SKIPPED_KEY = 'aad_pricing_skipped';

// ── Auth guard wrapper ─────────────────────────────────────────────────────────

export default function PricingPage() {
  const router  = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY) !== '1') {
      router.replace('/admin');
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return <div className="min-h-screen bg-navy" />;
  return <PricingDashboard />;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface SaveEntry {
  product:   Product;
  prevSell:  number | null;
  prevBuy:   number | null;
}

// ── Main dashboard ─────────────────────────────────────────────────────────────

function PricingDashboard() {
  const { products, backStockMap, mainStockMap, loading, error } = useProducts();
  const [queue,       setQueue]       = useState<Product[]>([]);
  const [skipped,     setSkipped]     = useState<Product[]>([]);
  const [saveHistory, setSaveHistory] = useState<SaveEntry[]>([]);
  const [localProds,  setLocalProds]  = useState<Product[]>([]);
  const [searchOpen,  setSearchOpen]  = useState(false);
  const [searchQ,     setSearchQ]     = useState('');
  const [toast,       setToast]       = useState<{ msg: string; type: string } | null>(null);
  const toastRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!products.length) return;
    setLocalProds(products);

    const savedSkipped: number[] = JSON.parse(
      sessionStorage.getItem(PRICING_SKIPPED_KEY) ?? '[]'
    );
    const skippedSet = new Set(savedSkipped);

    const q = products.filter(p => p.selling_price == null && !skippedSet.has(p.product_id));
    const s = products.filter(p => skippedSet.has(p.product_id));
    setQueue(q);
    setSkipped(s);
  }, [products]);

  useEffect(() => {
    sessionStorage.setItem(
      PRICING_SKIPPED_KEY,
      JSON.stringify(skipped.map(p => p.product_id)),
    );
  }, [skipped]);

  function showToast(msg: string, type = '') {
    setToast({ msg, type });
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 2600);
  }

  const total  = localProds.length;
  const priced = localProds.filter(p => p.selling_price != null).length;
  const pct    = total ? (priced / total) * 100 : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full"
        />
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
      <header className="print-hide shrink-0 bg-surface border-b border-white/8 px-4 flex items-center gap-3 h-14">
        <Link
          href="/admin"
          className="text-muted hover:text-slate-100 text-sm px-3 py-1.5 rounded-lg bg-surface2 border border-white/8 transition-colors"
        >
          ← Back
        </Link>
        <h1 className="flex-1 text-sm font-bold text-slate-100">💰 Price Setter</h1>
        <span className="text-xs text-muted font-mono whitespace-nowrap">
          {queue.length} left
        </span>
        {(queue.length > 0 || skipped.length > 0) && (
          <button
            onClick={() => { setSearchQ(''); setSearchOpen(true); }}
            className="text-muted hover:text-teal px-2 py-1.5 rounded-lg bg-surface2 border border-white/8 transition-colors text-base"
          >
            🔍
          </button>
        )}
      </header>

      <div className="shrink-0 h-0.5 bg-surface2">
        <motion.div
          className="h-full bg-teal"
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5 }}
        />
      </div>

      <main className="flex-1 overflow-hidden flex flex-col items-center justify-center px-4 py-6">
        <AnimatePresence mode="wait">
          {queue.length === 0 ? (
            <EndScreen
              key="end"
              skipped={skipped}
              allProds={localProds}
              onReviewSkipped={() => { setQueue([...skipped]); setSkipped([]); }}
              onPickSkipped={(id) => {
                const idx = skipped.findIndex(p => p.product_id === id);
                if (idx < 0) return;
                const [p] = skipped.splice(idx, 1);
                setSkipped([...skipped]);
                setQueue([p]);
              }}
            />
          ) : (
            <PricingDeck
              key="deck"
              queue={queue}
              backStockMap={backStockMap}
              mainStockMap={mainStockMap}
              saveHistory={saveHistory}
              onSave={async (sell, buy) => {
                const p = queue[0];
                const { error } = await supabase
                  .from('products')
                  .update({ selling_price: sell, buying_price: buy })
                  .eq('product_id', p.product_id);
                if (error) { showToast('Save failed: ' + error.message, 'error'); return false; }
                setSaveHistory(h => [...h, { product: p, prevSell: p.selling_price, prevBuy: p.buying_price }]);
                setLocalProds(lp =>
                  lp.map(x => x.product_id === p.product_id
                    ? { ...x, selling_price: sell, buying_price: buy }
                    : x
                  )
                );
                setQueue(q => q.slice(1));
                return true;
              }}
              onSkip={() => {
                const p = queue[0];
                setSkipped(s => [...s, p]);
                setQueue(q => q.slice(1));
              }}
              onUndo={async () => {
                if (!saveHistory.length) { showToast('Nothing to undo', 'error'); return; }
                const last = saveHistory[saveHistory.length - 1];
                const { error } = await supabase
                  .from('products')
                  .update({ selling_price: last.prevSell, buying_price: last.prevBuy })
                  .eq('product_id', last.product.product_id);
                if (error) { showToast('Undo failed', 'error'); return; }
                setLocalProds(lp =>
                  lp.map(x => x.product_id === last.product.product_id
                    ? { ...x, selling_price: last.prevSell, buying_price: last.prevBuy }
                    : x
                  )
                );
                setSaveHistory(h => h.slice(0, -1));
                setQueue(q => [last.product, ...q]);
                showToast('↩ Undone — price restored', 'info');
              }}
              onJumpTo={(id) => {
                setQueue(q => {
                  const idx = q.findIndex(p => p.product_id === id);
                  if (idx === 0) return q;
                  if (idx > 0) {
                    const next = [...q];
                    const [p] = next.splice(idx, 1);
                    return [p, ...next];
                  }
                  const fromSkipped = skipped.find(p => p.product_id === id);
                  if (fromSkipped) {
                    setSkipped(s => s.filter(p => p.product_id !== id));
                    return [fromSkipped, ...q];
                  }
                  return q;
                });
                setSearchOpen(false);
              }}
            />
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {searchOpen && (
          <SearchOverlay
            products={localProds}
            queue={queue}
            skipped={skipped}
            backStockMap={backStockMap}
            mainStockMap={mainStockMap}
            searchQ={searchQ}
            onSearchQ={setSearchQ}
            onJump={(id) => {
              setQueue(q => {
                const idx = q.findIndex(p => p.product_id === id);
                if (idx === 0) return q;
                if (idx > 0) {
                  const next = [...q];
                  const [p] = next.splice(idx, 1);
                  return [p, ...next];
                }
                const fromSkipped = skipped.find(p => p.product_id === id);
                if (fromSkipped) {
                  setSkipped(s => s.filter(p => p.product_id !== id));
                  return [fromSkipped, ...q];
                }
                return q;
              });
              setSearchOpen(false);
            }}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-300 px-5 py-2.5 rounded-xl border text-sm font-semibold shadow-2xl whitespace-nowrap pointer-events-none ${
              toast.type === 'error' ? 'bg-danger/15 border-danger/40 text-danger'
              : toast.type === 'info' ? 'bg-teal/15 border-teal/40 text-teal'
              : 'bg-success/15 border-success/40 text-success'
            }`}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Pricing Deck ───────────────────────────────────────────────────────────────

interface DeckProps {
  queue:        Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  saveHistory:  SaveEntry[];
  onSave:       (sell: number | null, buy: number | null) => Promise<boolean>;
  onSkip:       () => void;
  onUndo:       () => void;
  onJumpTo:     (id: number) => void;
}

function PricingDeck({ queue, backStockMap, mainStockMap, saveHistory, onSave, onSkip, onUndo }: DeckProps) {
  const p    = queue[0];
  const next = queue[1];
  const x    = useMotionValue(0);
  const rot  = useTransform(x, [-150, 150], [-15, 15]);
  const saveOpacity = useTransform(x, [20,  80], [0, 1]);
  const skipOpacity = useTransform(x, [-80, -20], [1, 0]);

  const sellRef = useRef<HTMLInputElement>(null);
  const buyRef  = useRef<HTMLInputElement>(null);
  const saving  = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowRight') triggerSave();
      if (e.key === 'ArrowLeft')  onSkip();
      if (e.key === 'z' || e.key === 'Z') onUndo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function triggerSave() {
    if (saving.current) return;
    saving.current = true;
    const sell = parseFloat(sellRef.current?.value ?? '') || null;
    const buy  = parseFloat(buyRef.current?.value  ?? '') || null;
    await animate(x, 300, { duration: 0.3, ease: 'easeIn' });
    const ok = await onSave(sell, buy);
    if (!ok) { animate(x, 0, { duration: 0.2 }); }
    else x.set(0);
    saving.current = false;
  }

  async function triggerSkip() {
    await animate(x, -300, { duration: 0.3, ease: 'easeIn' });
    onSkip();
    x.set(0);
  }

  const ppb   = p.pieces_per_box || 0;
  const mainQ = mainStockMap[p.product_id] || 0;
  const backQ = backStockMap[p.product_id] || 0;
  const isBox = (p.unit_type?.toLowerCase() === 'box') && ppb > 0;

  return (
    <div className="w-full max-w-sm flex flex-col items-center gap-6">
      <div className="relative w-full h-105 sm:h-110">
        {next && (
          <div className="absolute inset-0 bg-surface border border-white/8 rounded-2xl scale-95 opacity-50 translate-y-2 pointer-events-none" />
        )}

        <motion.div
          key={p.product_id}
          style={{ x, rotate: rot }}
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.7}
          onDragEnd={(_, info) => {
            if (info.offset.x >  80) triggerSave();
            else if (info.offset.x < -80) triggerSkip();
            else animate(x, 0, { type: 'spring', stiffness: 300, damping: 25 });
          }}
          className="absolute inset-0 bg-surface border border-white/10 rounded-2xl p-5 shadow-2xl cursor-grab active:cursor-grabbing overflow-hidden select-none"
        >
          <motion.div
            style={{ opacity: saveOpacity }}
            className="absolute top-5 left-5 text-teal border-2 border-teal rounded-lg px-2.5 py-1 text-xs font-black tracking-widest -rotate-12 pointer-events-none"
          >
            SAVE
          </motion.div>
          <motion.div
            style={{ opacity: skipOpacity }}
            className="absolute top-5 right-5 text-danger border-2 border-danger rounded-lg px-2.5 py-1 text-xs font-black tracking-widest rotate-12 pointer-events-none"
          >
            SKIP
          </motion.div>

          <div className="text-[9px] font-bold tracking-widest text-muted uppercase bg-surface2 border border-white/8 rounded px-2 py-0.5 inline-block mb-3">
            {[p.type, p.brand].filter(Boolean).join(' · ') || 'Product'}
          </div>

          <h2 className="text-lg font-bold text-slate-100 mb-1 leading-snug">{p.product_name}</h2>
          <p className="font-mono text-[10px] text-teal/70 mb-4">{p.stock_keeping_unit || 'No SKU'}</p>

          {isBox && (
            <div className="inline-flex items-center gap-1.5 bg-teal/10 border border-teal/20 text-teal text-[10px] font-bold px-2.5 py-1 rounded-md mb-3">
              📦 1 box = {ppb} pieces · prices per piece
            </div>
          )}

          <div className="flex gap-2 mb-4">
            <StockChip color="teal" label={isBox ? `Main (${Math.floor(mainQ / ppb)}bx)` : 'Main'} value={mainQ} />
            <StockChip color="gold" label={isBox ? `Back (${Math.floor(backQ / ppb)}bx)` : 'Back'} value={backQ} />
          </div>

          {(p.selling_price != null || p.buying_price != null) && (
            <div className="flex gap-2 mb-4 flex-wrap">
              {p.selling_price != null && (
                <span className="text-[11px] bg-surface2 border border-white/8 rounded px-2.5 py-1 text-muted">
                  Sell: <b className="text-slate-300">Ksh {p.selling_price}</b>
                </span>
              )}
              {p.buying_price != null && (
                <span className="text-[11px] bg-surface2 border border-white/8 rounded px-2.5 py-1 text-muted">
                  Buy: <b className="text-slate-300">Ksh {p.buying_price}</b>
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3" onClick={e => e.stopPropagation()}>
            <PriceField
              label={isBox ? 'Selling Ksh/pc' : 'Selling Price Ksh'}
              defaultValue={p.selling_price ?? undefined}
              ref={sellRef}
            />
            <PriceField
              label={isBox ? 'Buying Ksh/pc' : 'Buying Price Ksh'}
              defaultValue={p.buying_price ?? undefined}
              ref={buyRef}
            />
          </div>
        </motion.div>
      </div>

      <div className="flex items-center gap-6">
        <ActionBtn onClick={triggerSkip} color="danger" size="lg" title="Skip (←)">✕</ActionBtn>
        <ActionBtn onClick={onUndo} color="muted" size="sm" title="Undo (Z)" disabled={saveHistory.length === 0}>↩</ActionBtn>
        <ActionBtn onClick={triggerSave} color="teal" size="lg" title="Save (→)">✓</ActionBtn>
      </div>

      <p className="hidden sm:block text-[10px] text-muted/50 text-center font-mono">
        ← Skip · → Save · Z Undo
      </p>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function StockChip({ color, label, value }: { color: string; label: string; value: number }) {
  const cls =
    color === 'teal'   ? 'bg-teal/10   border-teal/20   text-teal'   :
    color === 'gold'   ? 'bg-gold/10   border-gold/20   text-gold'   :
                         'bg-purple-500/10 border-purple-500/20 text-purple-400';
  return (
    <div className={`flex flex-col items-center px-3 py-1.5 rounded-lg border min-w-13.5 ${cls}`}>
      <span className="text-lg font-bold leading-none tabular-nums">{value}</span>
      <span className="text-[8px] font-bold mt-0.5 uppercase tracking-wide">{label}</span>
    </div>
  );
}

const PriceField = function PriceField(
  { label, defaultValue, ref }: { label: string; defaultValue?: number; ref: React.Ref<HTMLInputElement> }
) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-widest text-muted mb-1">{label}</label>
      <input
        ref={ref}
        type="number"
        defaultValue={defaultValue}
        placeholder="0.00"
        min={0}
        step={0.01}
        inputMode="decimal"
        className="w-full bg-surface2 border border-white/10 rounded-xl text-slate-100 text-lg font-bold px-3 py-2 outline-none focus:border-teal/50 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
    </div>
  );
};

function ActionBtn({
  children, onClick, color, size, title, disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  color: string;
  size: 'lg' | 'sm';
  title?: string;
  disabled?: boolean;
}) {
  const dim = size === 'lg' ? 'w-14 h-14 text-2xl' : 'w-11 h-11 text-lg';
  const cls =
    color === 'danger' ? 'bg-danger/10 border-danger/30 text-danger hover:bg-danger hover:text-white hover:border-transparent' :
    color === 'teal'   ? 'bg-teal/10   border-teal/30   text-teal   hover:bg-teal   hover:text-navy  hover:border-transparent' :
                         'bg-surface2  border-white/10  text-muted  hover:border-white/30';
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${dim} rounded-full border flex items-center justify-center font-bold transition-all active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed ${cls}`}
    >
      {children}
    </button>
  );
}

// ── End Screen ─────────────────────────────────────────────────────────────────

function EndScreen({
  skipped, allProds, onReviewSkipped, onPickSkipped,
}: {
  skipped: Product[];
  allProds: Product[];
  onReviewSkipped: () => void;
  onPickSkipped: (id: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const priced = allProds.filter(p => p.selling_price != null).length;

  if (!skipped.length) {
    return (
      <motion.div
        key="done"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="text-center px-4"
      >
        <p className="text-5xl mb-4">🎉</p>
        <h2 className="text-xl font-bold text-slate-100 mb-2">All done!</h2>
        <p className="text-sm text-muted mb-6">
          Prices set for {priced} of {allProds.length} products.
        </p>
        <Link href="/admin" className="px-6 py-3 rounded-xl bg-teal text-navy font-bold text-sm hover:opacity-90 transition-opacity inline-block">
          ← Back to Inventory
        </Link>
      </motion.div>
    );
  }

  const filtered = skipped.filter(p =>
    !filter || p.product_name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <motion.div
      key="skipped"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md flex flex-col gap-3"
    >
      <div>
        <p className="text-2xl mb-1">📋</p>
        <h2 className="text-lg font-bold text-slate-100">Skipped Products</h2>
        <p className="text-xs text-muted">{skipped.length} skipped — tap to set price</p>
      </div>

      <input
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="Search skipped…"
        className="w-full px-4 py-2.5 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
      />

      <div className="flex flex-col gap-2 overflow-y-auto max-h-64">
        {filtered.map(p => (
          <button
            key={p.product_id}
            onClick={() => onPickSkipped(p.product_id)}
            className="flex items-center gap-3 px-4 py-3 rounded-xl bg-surface border border-white/8 hover:border-teal/30 transition-all text-left group"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-100 truncate group-hover:text-teal transition-colors">{p.product_name}</p>
              <p className="text-xs text-muted font-mono mt-0.5">{p.stock_keeping_unit || 'No SKU'}</p>
            </div>
            <span className="text-teal text-base">→</span>
          </button>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onReviewSkipped}
          className="flex-1 py-3 rounded-xl bg-teal text-navy font-bold text-sm hover:opacity-90 transition-opacity"
        >
          Go through all →
        </button>
        <Link href="/admin" className="px-5 py-3 rounded-xl border border-white/10 bg-surface2 text-muted text-sm font-semibold hover:border-white/20 transition-colors">
          ← Inventory
        </Link>
      </div>
    </motion.div>
  );
}

// ── Search overlay ─────────────────────────────────────────────────────────────

function SearchOverlay({
  products, queue, skipped, backStockMap, mainStockMap,
  searchQ, onSearchQ, onJump, onClose,
}: {
  products:     Product[];
  queue:        Product[];
  skipped:      Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  searchQ:      string;
  onSearchQ:    (q: string) => void;
  onJump:       (id: number) => void;
  onClose:      () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 80); }, []);

  const results = products
    .filter(p =>
      !searchQ ||
      p.product_name.toLowerCase().includes(searchQ.toLowerCase()) ||
      (p.stock_keeping_unit ?? '').toLowerCase().includes(searchQ.toLowerCase())
    )
    .slice(0, 40);

  const qSet = new Set(queue.map(p => p.product_id));
  const sSet = new Set(skipped.map(p => p.product_id));

  return (
    <>
      <motion.div
        className="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="fixed bottom-0 left-0 right-0 z-110 flex flex-col bg-surface border-t border-white/10 rounded-t-3xl max-h-[85vh] max-w-xl mx-auto"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      >
        <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mt-3 mb-1 shrink-0" />
        <div className="px-5 py-3 shrink-0">
          <h3 className="text-base font-bold text-slate-100 mb-3">Search Product</h3>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
            <input
              ref={inputRef}
              type="text"
              value={searchQ}
              onChange={e => onSearchQ(e.target.value)}
              placeholder="Type product name…"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
            />
          </div>
        </div>
        <div className="overflow-y-auto flex-1 px-3 pb-8">
          {results.length === 0 ? (
            <p className="text-center text-muted text-sm py-8">No products found</p>
          ) : results.map(p => {
            const stock = (backStockMap[p.product_id] || 0) + (mainStockMap[p.product_id] || 0);
            let badge = '';
            let badgeCls = '';
            if (qSet.has(p.product_id))      { badge = 'In Queue'; badgeCls = 'bg-teal/10 border-teal/20 text-teal'; }
            else if (sSet.has(p.product_id)) { badge = 'Skipped';  badgeCls = 'bg-gold/10 border-gold/20 text-gold'; }
            else if (p.selling_price != null){ badge = `Ksh ${p.selling_price}`; badgeCls = 'bg-success/10 border-success/20 text-success'; }
            else                             { badge = 'No price'; badgeCls = 'bg-danger/10 border-danger/20 text-danger'; }

            return (
              <button
                key={p.product_id}
                onClick={() => onJump(p.product_id)}
                className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl hover:bg-surface2 transition-colors text-left mb-1"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-100 truncate">{p.product_name}</p>
                  <p className="text-xs text-muted mt-0.5">{[p.type, p.brand].filter(Boolean).join(' · ') || `Stock: ${stock}`}</p>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded border whitespace-nowrap ${badgeCls}`}>{badge}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
    </>
  );
}
