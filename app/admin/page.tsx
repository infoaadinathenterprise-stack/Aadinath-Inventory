'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Product, StockMap, Location } from '@/lib/types';
import AdminNavbar      from './components/AdminNavbar';
import StatsBar         from './components/StatsBar';
import ProductList      from './components/ProductList';
import AdjustStockModal from './components/AdjustStockModal';
import Toast, { type ToastState } from './components/Toast';

const PASS = process.env.NEXT_PUBLIC_ADMIN_PASSWORD ?? 'admin123';
const SESSION_KEY = 'aad_admin_auth';

interface ModalState {
  product:   Product;
  direction: 'plus' | 'minus';
  location:  Location;
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadData(): Promise<{
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
}> {
  const [{ data: prods }, { data: stock }] = await Promise.all([
    supabase.from('products').select('*').eq('active_status', true).order('product_name'),
    supabase.from('stock_by_location').select('product_id, quantity, box_quantity, location_id'),
  ]);

  const products: Product[] = prods ?? [];
  const backStockMap: StockMap = {};
  const mainStockMap: StockMap = {};
  const backBoxMap:   StockMap = {};
  const mainBoxMap:   StockMap = {};

  for (const row of stock ?? []) {
    if (row.location_id === 2) {
      backStockMap[row.product_id] = row.quantity   ?? 0;
      backBoxMap[row.product_id]   = row.box_quantity ?? 0;
    } else {
      mainStockMap[row.product_id] = row.quantity   ?? 0;
      mainBoxMap[row.product_id]   = row.box_quantity ?? 0;
    }
  }

  return { products, backStockMap, mainStockMap, backBoxMap, mainBoxMap };
}

// ── Login form ────────────────────────────────────────────────────────────────

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [pw,    setPw]    = useState('');
  const [shake, setShake] = useState(false);
  const [err,   setErr]   = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw === PASS) {
      sessionStorage.setItem(SESSION_KEY, '1');
      onSuccess();
    } else {
      setErr('Incorrect password');
      setShake(true);
      setPw('');
      setTimeout(() => setShake(false), 500);
    }
  }

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center px-4">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-teal/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/4 w-64 h-64 bg-gold/5 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative w-full max-w-sm"
      >
        {/* Card */}
        <motion.form
          onSubmit={submit}
          animate={shake ? { x: [0, -8, 8, -8, 8, 0] } : { x: 0 }}
          transition={shake ? { duration: 0.4 } : {}}
          className="bg-surface border border-white/8 rounded-2xl p-8 shadow-2xl"
        >
          {/* Logo */}
          <div className="text-center mb-8">
            <p className="font-bold text-2xl text-teal tracking-tight">
              Aadinath<span className="text-gold">·</span>
            </p>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gold/15 border border-gold/30 text-gold uppercase tracking-widest mt-1 inline-block">
              Admin Panel
            </span>
          </div>

          <p className="text-sm font-semibold text-slate-300 mb-1">Password</p>
          <input
            ref={inputRef}
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setErr(''); }}
            placeholder="Enter admin password"
            className="w-full px-4 py-3 rounded-xl bg-surface2 border border-white/10 text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/50 transition-colors mb-2 text-sm"
          />

          <AnimatePresence>
            {err && (
              <motion.p
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="text-xs text-danger mb-3"
              >
                {err}
              </motion.p>
            )}
          </AnimatePresence>

          <button
            type="submit"
            className="w-full py-3 mt-2 rounded-xl bg-linear-to-r from-teal to-teal/70 text-navy text-sm font-bold shadow-[0_4px_14px_rgba(0,212,255,0.3)] hover:opacity-90 transition-opacity"
          >
            Sign In
          </button>
        </motion.form>
      </motion.div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard() {
  const [products,     setProducts]     = useState<Product[]>([]);
  const [backStockMap, setBackStockMap] = useState<StockMap>({});
  const [mainStockMap, setMainStockMap] = useState<StockMap>({});
  const [backBoxMap,   setBackBoxMap]   = useState<StockMap>({});
  const [mainBoxMap,   setMainBoxMap]   = useState<StockMap>({});
  const [loading,      setLoading]      = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast,        setToast]        = useState<ToastState | null>(null);
  const toastId = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const d = await loadData();
      setProducts(d.products);
      setBackStockMap(d.backStockMap);
      setMainStockMap(d.mainStockMap);
      setBackBoxMap(d.backBoxMap);
      setMainBoxMap(d.mainBoxMap);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function handleAdjust(product: Product, direction: 'plus' | 'minus', location: Location) {
    setModal({ product, direction, location });
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.reload();
  }

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

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />

      <main className="pt-14 max-w-2xl mx-auto">
        <StatsBar
          products={products}
          backStockMap={backStockMap}
          mainStockMap={mainStockMap}
        />

        {/* Section header */}
        <div className="px-4 pt-5 pb-3">
          <h2 className="text-base font-bold text-slate-100">Inventory</h2>
          <p className="text-xs text-muted mt-0.5">{products.length} active products</p>
        </div>

        <ProductList
          products={products}
          backStockMap={backStockMap}
          mainStockMap={mainStockMap}
          backBoxMap={backBoxMap}
          mainBoxMap={mainBoxMap}
          onAdjust={handleAdjust}
        />
      </main>

      {/* Adjust modal */}
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
            onClose={() => setModal(null)}
            onSuccess={(msg) => showToast(msg, 'success')}
            onError={(msg)   => showToast(msg, 'error')}
            onDone={refresh}
          />
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(SESSION_KEY) === '1');
  }, []);

  // Avoid flash before sessionStorage read
  if (authed === null) {
    return <div className="min-h-screen bg-navy" />;
  }

  return authed
    ? <Dashboard />
    : <LoginForm onSuccess={() => setAuthed(true)} />;
}
