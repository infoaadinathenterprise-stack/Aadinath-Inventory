'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { StockMovement, Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

const SESSION_KEY = 'aad_admin_auth';

const MOVEMENT_TYPES = ['ALL', 'TRANSFER', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'PURCHASE_IN', 'DAMAGED', 'SALE'];

const TYPE_META: Record<string, { label: string; emoji: string; color: string }> = {
  TRANSFER:       { label: 'Transfer',    emoji: '↔️',  color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  ADJUSTMENT_IN:  { label: 'Stock In',    emoji: '➕',  color: 'text-success bg-success/10 border-success/20' },
  ADJUSTMENT_OUT: { label: 'Stock Out',   emoji: '➖',  color: 'text-danger bg-danger/10 border-danger/20' },
  PURCHASE_IN:    { label: 'Purchase',    emoji: '🧾',  color: 'text-teal bg-teal/10 border-teal/20' },
  DAMAGED:        { label: 'Damaged',     emoji: '⚠️',  color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' },
  SALE:           { label: 'Sale',        emoji: '🛒',  color: 'text-gold bg-gold/10 border-gold/20' },
};

const LOC_NAME: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown' };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function HistoryDashboard() {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [search,    setSearch]    = useState('');
  const [toast,     setToast]     = useState<ToastState | null>(null);
  const toastId = useRef(0);
  const router = useRouter();

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY) !== '1') router.replace('/admin');
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: mv }, { data: pr }] = await Promise.all([
      supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('products').select('product_id, product_name').eq('active_status', true),
    ]);
    setMovements((mv ?? []) as StockMovement[]);
    setProducts((pr ?? []) as Product[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function productName(id: number) {
    return products.find(p => p.product_id === id)?.product_name ?? `#${id}`;
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  const filtered = movements.filter(m => {
    if (typeFilter !== 'ALL' && m.movement_type !== typeFilter) return false;
    if (search) {
      const name = productName(m.product_id).toLowerCase();
      if (!name.includes(search.toLowerCase()) && !(m.reason ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-2xl mx-auto px-4 pb-10">

        <div className="pt-5 pb-3">
          <h2 className="text-base font-bold text-slate-100">Stock Movement History</h2>
          <p className="text-xs text-muted mt-0.5">{filtered.length} records</p>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search product or reason..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-surface border border-white/8 text-slate-100 text-sm placeholder:text-muted/50 outline-none focus:border-teal/40"
          />
        </div>

        {/* Type filter chips */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-none">
          {MOVEMENT_TYPES.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                typeFilter === t
                  ? 'bg-teal/10 border-teal/30 text-teal'
                  : 'bg-surface border-white/8 text-muted hover:text-slate-100'
              }`}
            >
              {t === 'ALL' ? 'All' : (TYPE_META[t]?.label ?? t)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">📋</div>
            <p className="text-sm">No movements found</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((m, i) => {
              const meta = TYPE_META[m.movement_type] ?? { label: m.movement_type, emoji: '•', color: 'text-muted bg-surface2 border-white/10' };
              const isIn = m.movement_type === 'ADJUSTMENT_IN' || m.movement_type === 'PURCHASE_IN';
              const isTransfer = m.movement_type === 'TRANSFER';
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.02 }}
                  className="bg-surface border border-white/8 rounded-xl p-3.5 flex items-start gap-3"
                >
                  <div className={`w-9 h-9 rounded-xl border flex items-center justify-center text-base shrink-0 ${meta.color}`}>
                    {meta.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-slate-100 truncate">{productName(m.product_id)}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {isTransfer
                        ? `${LOC_NAME[m.from_location_id ?? 0] ?? '?'} → ${LOC_NAME[m.to_location_id ?? 0] ?? '?'}`
                        : isIn
                          ? `→ ${LOC_NAME[m.to_location_id ?? 0] ?? 'Unknown'}`
                          : `← ${LOC_NAME[m.from_location_id ?? 0] ?? 'Unknown'}`}
                      {m.reason ? ` · ${m.reason}` : ''}
                    </div>
                    <div className="text-[10px] text-muted/60 mt-1">{formatDate(m.created_at)}</div>
                  </div>
                  <div className={`text-lg font-bold shrink-0 ${isIn ? 'text-success' : isTransfer ? 'text-blue-400' : 'text-danger'}`}>
                    {isIn ? '+' : isTransfer ? '↔' : '−'}{m.quantity}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default function HistoryPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok = sessionStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <HistoryDashboard />;
}
