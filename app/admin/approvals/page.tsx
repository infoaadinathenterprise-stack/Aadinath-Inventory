'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { upsertStock } from '@/lib/stockActions';
import { SESSION_KEY, ROLE_KEY } from '@/lib/types';
import type { Product } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

interface PendingRequest {
  request_id:    number;
  product_id:    number;
  quantity:      number;
  to_location_id: number | null;
  notes:         string | null;
  requested_at:  string;
}

let LOC_NAME: Record<number, string> = { 1: 'Main Store', 2: 'Back Godown', 3: 'Main Store First Floor' };

function parseUser(notes: string | null): string {
  if (!notes) return 'Unknown';
  const m = notes.match(/^\[([^\]]+)\]/);
  return m ? m[1] : 'Unknown';
}

export default function ApprovalsPage() {
  const router = useRouter();
  const [requests,  setRequests]  = useState<PendingRequest[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [acting,    setActing]    = useState<number | null>(null);
  const [toast,     setToast]     = useState<ToastState | null>(null);
  let toastId = 0;

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  const load = useCallback(async () => {
    setLoading(true);
    const [reqRes, prodRes, locRes] = await Promise.all([
      supabase
        .from('stock_requests')
        .select('request_id, product_id, quantity, to_location_id, notes, requested_at')
        .eq('status', 'PENDING')
        .order('requested_at', { ascending: true }),
      supabase.from('products').select('product_id, product_name, type, unit_of_measure, pieces_per_box'),
      supabase.from('locations').select('location_id, location_name'),
    ]);
    for (const loc of locRes.data ?? []) {
      LOC_NAME[loc.location_id as number] = loc.location_name as string;
    }
    setRequests((reqRes.data ?? []) as PendingRequest[]);
    setProducts((prodRes.data ?? []) as Product[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') { router.replace('/admin'); return; }
    load();
  }, [router, load]);

  async function approve(req: PendingRequest) {
    setActing(req.request_id);
    try {
      const locId = req.to_location_id ?? 1;
      // Read current stock first
      const { data: stockRow } = await supabase
        .from('stock_by_location')
        .select('quantity, box_quantity')
        .eq('product_id', req.product_id)
        .eq('location_id', locId)
        .single();
      const curQty = (stockRow as { quantity: number; box_quantity: number } | null)?.quantity ?? 0;
      // Add as loose pieces
      await upsertStock(req.product_id, locId, { quantity: curQty + req.quantity });
      // Mark approved
      await supabase
        .from('stock_requests')
        .update({ status: 'APPROVED', approved_at: new Date().toISOString() })
        .eq('request_id', req.request_id);
      showToast('Approved ✓ — stock updated', 'success');
      setRequests(r => r.filter(x => x.request_id !== req.request_id));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Approve failed', 'error');
    } finally {
      setActing(null);
    }
  }

  async function reject(req: PendingRequest) {
    setActing(req.request_id);
    try {
      await supabase
        .from('stock_requests')
        .update({ status: 'REJECTED', approved_at: new Date().toISOString() })
        .eq('request_id', req.request_id);
      showToast('Request rejected', 'success');
      setRequests(r => r.filter(x => x.request_id !== req.request_id));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Reject failed', 'error');
    } finally {
      setActing(null);
    }
  }

  function productName(id: number) {
    return products.find(p => p.product_id === id)?.product_name ?? `#${id}`;
  }
  function productUnit(id: number) {
    return products.find(p => p.product_id === id)?.unit_of_measure ?? 'unit';
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-4xl mx-auto px-4 pb-10">
        <div className="pt-5 pb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-100">✅ Pending Approvals</h2>
            <p className="text-xs text-muted mt-0.5">
              {loading ? 'Loading…' : `${requests.length} request${requests.length !== 1 ? 's' : ''} awaiting approval`}
            </p>
          </div>
          <button onClick={load} className="text-xs text-teal hover:underline">Refresh</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : requests.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">🎉</div>
            <p className="text-sm font-medium">All caught up — no pending requests</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {requests.map(req => {
                const isActing = acting === req.request_id;
                const locName  = req.to_location_id ? (LOC_NAME[req.to_location_id] ?? `Loc #${req.to_location_id}`) : 'Unknown';
                const submittedBy = parseUser(req.notes);
                const ts = new Date(req.requested_at).toLocaleString('en-KE', {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                });
                return (
                  <motion.div
                    key={req.request_id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 60 }}
                    className="bg-surface border border-white/8 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-slate-100 truncate">{productName(req.product_id)}</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                        <span className="text-xs text-success font-bold">+{req.quantity} {productUnit(req.product_id).toLowerCase()}{req.quantity !== 1 ? 's' : ''}</span>
                        <span className="text-xs text-muted">→ {locName}</span>
                        <span className="text-xs text-muted">by {submittedBy}</span>
                        <span className="text-xs text-muted/60">{ts}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => reject(req)}
                        disabled={isActing}
                        className="flex-1 sm:flex-none px-4 py-2 rounded-xl border border-danger/30 bg-danger/10 text-danger text-xs font-bold hover:bg-danger/20 disabled:opacity-40 transition-all"
                      >
                        ✕ Reject
                      </button>
                      <button
                        onClick={() => approve(req)}
                        disabled={isActing}
                        className="flex-1 sm:flex-none px-4 py-2 rounded-xl border border-success/30 bg-success/10 text-success text-xs font-bold hover:bg-success/20 disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
                      >
                        {isActing && <div className="w-3 h-3 rounded-full border-2 border-success border-t-transparent animate-spin" />}
                        ✓ Approve
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
