'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { SESSION_KEY, ROLE_KEY, USER_KEY, type UserRole } from '@/lib/types';
import type { Product } from '@/lib/types';
import { stockTxn, type StockOp } from '@/lib/stockActions';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocationInfo {
  location_id:   number;
  location_name: string;
}

// Aadinath (1) and Jay Aadinath (2) — see lib/types.ts DEFAULT_COMPANY_ID and
// supabase/06_companies.sql. Hardcoded here the same way useProducts()'s
// fallback company list does, since the audit page only needs the ids.
const COMPANY_IDS = [1, 2];

interface CompanyStock { quantity: number; box_quantity: number }

interface AuditRow {
  product:      Product;
  quantity:     number;   // loose pieces, SUMMED across Aadinath + Jay Aadinath
  box_quantity: number;   // whole boxes,  SUMMED across Aadinath + Jay Aadinath
  perCompany:   Record<number, CompanyStock>; // company_id → this location's stock, for edit-time deltas
}

interface AuditCheck {
  checked_at: string;
  checked_by: string | null;
  edited:     boolean;
}

interface Movement {
  id:               number;
  created_at:       string;
  movement_type:    string;
  quantity:         number;
  from_location_id: number | null;
  to_location_id:   number | null;
  reason:           string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateLong(d: Date) {
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
}

function currentUser(): string {
  if (typeof window === 'undefined') return 'System';
  return localStorage.getItem(USER_KEY) || 'Admin';
}

// Human-readable stock string for an audit row
function stockLabel(row: { product: Product; quantity: number; box_quantity: number }): string {
  const ppb = row.product.pieces_per_box ?? 0;
  const bx  = row.box_quantity;
  const pc  = row.quantity;
  const tot = pc + bx * ppb;

  if (ppb > 0) {
    if (bx > 0 && pc > 0) return `${bx} box${bx > 1 ? 'es' : ''} + ${pc} pc${pc > 1 ? 's' : ''}`;
    if (bx > 0)            return `${bx} box${bx > 1 ? 'es' : ''}`;
  }
  const unit = row.product.unit_of_measure?.toLowerCase() ?? 'pc';
  return `${tot} ${unit}${tot !== 1 ? 's' : ''}`;
}

// Total as a simple piece count for print table
function stockPrint(row: AuditRow): string {
  const ppb = row.product.pieces_per_box ?? 0;
  const bx  = row.box_quantity;
  const pc  = row.quantity;
  if (ppb > 0 && bx > 0) {
    if (pc > 0) return `${bx}bx + ${pc}pc`;
    return `${bx}bx`;
  }
  return String(pc + bx * (ppb || 1));
}

// Split/merge a company's (loose, box) pair by a flat piece amount — taking
// loose pieces first and breaking boxes only when it runs out (mirrors the
// same convention used in AdjustStockModal / the product edit form).
function applyPieceDelta(pcs: number, bx: number, ppb: number, amount: number, isAdd: boolean) {
  if (isAdd) return { quantity: pcs + amount, box_quantity: bx };
  const fromLoose     = Math.min(amount, pcs);
  const fromBoxPieces = amount - fromLoose;
  const boxesToBreak  = ppb > 0 ? Math.ceil(fromBoxPieces / ppb) : 0;
  return { quantity: pcs - fromLoose + boxesToBreak * ppb - fromBoxPieces, box_quantity: bx - boxesToBreak };
}

const MOVEMENT_META: Record<string, { label: string; emoji: string; color: string }> = {
  SALE:           { label: 'Sale',       emoji: '💰', color: 'text-danger'  },
  TRANSFER:       { label: 'Transfer',   emoji: '🔄', color: 'text-teal'   },
  ADJUSTMENT_IN:  { label: 'Adj In',     emoji: '➕', color: 'text-success' },
  ADJUSTMENT_OUT: { label: 'Adj Out',    emoji: '➖', color: 'text-gold'   },
  PURCHASE_IN:    { label: 'Purchase',   emoji: '📦', color: 'text-blue-400'},
  AUTO_DEDUCT:    { label: 'Component',  emoji: '🔧', color: 'text-muted'  },
  DAMAGED:        { label: 'Damaged',    emoji: '💔', color: 'text-danger'  },
};

// ─── Auth gate ────────────────────────────────────────────────────────────────

export default function InventoryAuditPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);

  if (authed === null) return <div className="min-h-screen" />;
  return <InventoryAuditDashboard />;
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

function InventoryAuditDashboard() {
  const [locations,   setLocations]   = useState<LocationInfo[]>([]);
  const [locationId,  setLocationId]  = useState<number>(0);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [auditRows,   setAuditRows]   = useState<AuditRow[]>([]);
  const [checks,      setChecks]      = useState<Record<number, AuditCheck>>({});
  const [loading,     setLoading]     = useState(false);
  const [search,      setSearch]      = useState('');
  const [selected,    setSelected]    = useState<AuditRow | null>(null);
  const [history,     setHistory]     = useState<Movement[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [toast,       setToast]       = useState<ToastState | null>(null);
  const toastId = useRef(0);

  const [role,       setRole]       = useState<UserRole>('admin');
  const [editingId,  setEditingId]  = useState<number | null>(null);
  const [editValue,  setEditValue]  = useState('');
  const [savingId,   setSavingId]   = useState<number | null>(null);

  useEffect(() => {
    setRole((localStorage.getItem(ROLE_KEY) as UserRole) || 'admin');
  }, []);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  // ── Load locations + products once ───────────────────────────────────────
  useEffect(() => {
    Promise.all([
      supabase.from('products').select('*').eq('active_status', true).order('product_name'),
      supabase.from('locations').select('location_id, location_name').eq('active_status', true).order('location_id'),
    ]).then(([{ data: prods }, { data: locs }]) => {
      setAllProducts((prods ?? []) as Product[]);
      const locList = (locs ?? []) as LocationInfo[];
      setLocations(locList);
      if (locList.length > 0 && !locationId) setLocationId(locList[0].location_id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load audit rows + checklist state whenever location or product list changes ──
  const loadAuditRows = useCallback(async () => {
    if (allProducts.length === 0) return;
    setLoading(true);
    setSelected(null);
    setEditingId(null);

    const locId = locationId;
    if (!locId) return;

    try {
      // 1. All stock rows for this location (any qty, including 0), one row
      //    per company. 2. Products ever transferred involving this location.
      //    3. The saved checklist state for this location.
      const [
        { data: stockData,    error: stockErr },
        { data: transferData, error: txErr },
        { data: checkData,    error: checkErr },
      ] = await Promise.all([
        supabase.from('stock_by_location').select('product_id, quantity, box_quantity, company_id').eq('location_id', locId),
        supabase.from('stock_requests').select('product_id').eq('request_type', 'TRANSFER')
          .or(`from_location_id.eq.${locId},to_location_id.eq.${locId}`),
        supabase.from('inventory_audit_checks').select('product_id, checked_at, checked_by, edited').eq('location_id', locId),
      ]);
      if (stockErr) throw new Error(stockErr.message);
      if (txErr)    throw new Error(txErr.message);
      if (checkErr) throw new Error(checkErr.message);

      // Stock is keyed by (product, location, company) — Aadinath and Jay
      // Aadinath each get their own row. SUM them (never overwrite) so the
      // audit total reflects stock across both firms combined.
      const stockMap:   Record<number, CompanyStock> = {};
      const perCompany: Record<number, Record<number, CompanyStock>> = {};
      for (const row of stockData ?? []) {
        const pid = row.product_id as number;
        const cid = (row.company_id as number) ?? 1;
        const q = row.quantity     ?? 0;
        const b = row.box_quantity ?? 0;
        if (!stockMap[pid]) stockMap[pid] = { quantity: 0, box_quantity: 0 };
        stockMap[pid].quantity     += q;
        stockMap[pid].box_quantity += b;
        if (!perCompany[pid]) perCompany[pid] = {};
        perCompany[pid][cid] = { quantity: q, box_quantity: b };
      }

      // Union of product IDs that qualify for this location:
      //   a) currently has stock > 0 at this location (either firm)
      //   b) has been part of a transfer involving this location
      const qualifiedIds = new Set<number>();
      for (const [pid, sm] of Object.entries(stockMap)) {
        if (sm.quantity > 0 || sm.box_quantity > 0) qualifiedIds.add(Number(pid));
      }
      for (const row of transferData ?? []) {
        if (row.product_id) qualifiedIds.add(row.product_id);
      }

      // Build sorted audit rows
      const rows: AuditRow[] = [];
      for (const pid of qualifiedIds) {
        const product = allProducts.find(p => p.product_id === pid);
        if (!product) continue;
        const stock = stockMap[pid] ?? { quantity: 0, box_quantity: 0 };
        rows.push({ product, quantity: stock.quantity, box_quantity: stock.box_quantity, perCompany: perCompany[pid] ?? {} });
      }

      // Sort by category then name
      rows.sort((a, b) => {
        const tc = (a.product.type ?? '').localeCompare(b.product.type ?? '');
        return tc !== 0 ? tc : a.product.product_name.localeCompare(b.product.product_name);
      });

      const nextChecks: Record<number, AuditCheck> = {};
      for (const c of checkData ?? []) {
        nextChecks[c.product_id as number] = {
          checked_at: c.checked_at as string,
          checked_by: (c.checked_by as string | null) ?? null,
          edited:     !!c.edited,
        };
      }

      setAuditRows(rows);
      setChecks(nextChecks);
    } catch (e) {
      showToast('Failed to load audit data: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, allProducts]);

  useEffect(() => { loadAuditRows(); }, [loadAuditRows]);

  // ── Checklist actions ─────────────────────────────────────────────────────

  // Mark a row checked (optimistic — no full reload needed since stock
  // itself didn't change for a plain "Done").
  async function markChecked(row: AuditRow, edited: boolean) {
    const pid = row.product.product_id;
    setSavingId(pid);
    const nowIso = new Date().toISOString();
    const by = currentUser();
    try {
      const { error } = await supabase.from('inventory_audit_checks').upsert(
        { location_id: locationId, product_id: pid, checked_at: nowIso, checked_by: by, edited },
        { onConflict: 'location_id,product_id' },
      );
      if (error) throw new Error(error.message);
      setChecks(prev => ({ ...prev, [pid]: { checked_at: nowIso, checked_by: by, edited } }));
      showToast(edited ? 'Stock corrected & checked ✓' : 'Marked as checked ✓', 'success');
    } catch (e) {
      showToast('Could not save: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    } finally {
      setSavingId(null);
    }
  }

  function startEdit(row: AuditRow) {
    const ppb = row.product.pieces_per_box ?? 0;
    setEditingId(row.product.product_id);
    setEditValue(String(row.quantity + row.box_quantity * ppb));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue('');
  }

  // Build the stock_txn ops for a corrected total. The combined total is
  // one number, but stock is stored per-company — so an increase lands on
  // whichever firm already holds more of this product here (defaults to
  // Aadinath when tied or absent), and a decrease drains that firm first,
  // spilling into the other firm only if it alone doesn't have enough.
  function buildEditOps(row: AuditRow, delta: number, ppb: number): StockOp[] {
    const co = (cid: number): CompanyStock => row.perCompany[cid] ?? { quantity: 0, box_quantity: 0 };
    const totals = COMPANY_IDS.map(cid => ({ cid, ...co(cid), total: co(cid).quantity + co(cid).box_quantity * ppb }));
    const primary = [...totals].sort((a, b) => b.total - a.total)[0];
    const order = [primary, ...totals.filter(t => t.cid !== primary.cid)];

    if (delta > 0) {
      const cur = co(primary.cid);
      const next = applyPieceDelta(cur.quantity, cur.box_quantity, ppb, delta, true);
      return [{
        product_id: row.product.product_id, location_id: locationId, company_id: primary.cid,
        dq: next.quantity - cur.quantity, db: next.box_quantity - cur.box_quantity,
        mov_type: 'ADJUSTMENT_IN', mov_qty: delta, mov_from: null, mov_to: locationId,
        reason: 'Modified from Audit page',
      }];
    }

    let remaining = -delta;
    const ops: StockOp[] = [];
    for (const t of order) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, t.total);
      if (take <= 0) continue;
      const cur = co(t.cid);
      const next = applyPieceDelta(cur.quantity, cur.box_quantity, ppb, take, false);
      ops.push({
        product_id: row.product.product_id, location_id: locationId, company_id: t.cid,
        dq: next.quantity - cur.quantity, db: next.box_quantity - cur.box_quantity,
        mov_type: 'ADJUSTMENT_OUT', mov_qty: take, mov_from: locationId, mov_to: null,
        reason: 'Modified from Audit page',
      });
      remaining -= take;
    }
    return ops;
  }

  async function saveEdit(row: AuditRow) {
    const pid = row.product.product_id;
    const ppb = row.product.pieces_per_box ?? 0;
    const oldTotal = row.quantity + row.box_quantity * ppb;
    const newTotal = Math.max(0, parseInt(editValue, 10) || 0);
    const delta = newTotal - oldTotal;

    if (delta === 0) { setEditingId(null); await markChecked(row, false); return; }

    if (role === 'staff' && delta < 0) {
      showToast('Only admins can reduce inventory. Ask your admin to correct this count.', 'error');
      return;
    }

    setSavingId(pid);
    try {
      const ops = buildEditOps(row, delta, ppb);
      await stockTxn(ops);
      setEditingId(null);
      await markChecked(row, true);
      await loadAuditRows();
    } catch (e) {
      showToast('Could not update stock: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    } finally {
      setSavingId(null);
    }
  }

  async function resetAudit() {
    if (!window.confirm(
      `Start a new audit for ${locName}?\n\nThis clears the checklist — every item goes back to "to check". Stock levels are not affected.`,
    )) return;
    try {
      const { error } = await supabase.from('inventory_audit_checks').delete().eq('location_id', locationId);
      if (error) throw new Error(error.message);
      setChecks({});
      showToast('Audit checklist reset ✓', 'success');
    } catch (e) {
      showToast('Could not reset: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    }
  }

  // ── Open product history drawer ───────────────────────────────────────────
  async function openProduct(row: AuditRow) {
    setSelected(row);
    setHistLoading(true);
    setHistory([]);
    const locId = locationId;
    const { data, error } = await supabase
      .from('stock_requests')
      .select('request_id, request_type, quantity, from_location_id, to_location_id, notes, requested_at')
      .eq('product_id', row.product.product_id)
      .or(`from_location_id.eq.${locId},to_location_id.eq.${locId}`)
      .order('requested_at', { ascending: false })
      .limit(200);
    if (error) showToast('Could not load history: ' + error.message, 'error');
    // Normalise stock_requests columns → Movement interface
    const movements: Movement[] = (data ?? []).map((r) => ({
      id:               (r as Record<string,unknown>).request_id as number,
      created_at:       (r as Record<string,unknown>).requested_at as string,
      movement_type:    (r as Record<string,unknown>).request_type as string,
      quantity:         (r as Record<string,unknown>).quantity as number,
      from_location_id: (r as Record<string,unknown>).from_location_id as number | null,
      to_location_id:   (r as Record<string,unknown>).to_location_id as number | null,
      reason:           (r as Record<string,unknown>).notes as string | null,
    }));
    setHistory(movements);
    setHistLoading(false);
  }

  // ── Search filter ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return auditRows;
    return auditRows.filter(r =>
      r.product.product_name.toLowerCase().includes(q) ||
      (r.product.type  ?? '').toLowerCase().includes(q) ||
      (r.product.brand ?? '').toLowerCase().includes(q) ||
      (r.product.stock_keeping_unit ?? '').toLowerCase().includes(q)
    );
  }, [auditRows, search]);

  // ── Split into "to check" vs "checked", per the saved checklist ──────────
  const pending = useMemo(
    () => filtered.filter(r => !checks[r.product.product_id]),
    [filtered, checks],
  );
  const checkedList = useMemo(() => {
    return filtered
      .filter(r => checks[r.product.product_id])
      .sort((a, b) => {
        const ca = checks[a.product.product_id]?.checked_at ?? '';
        const cb = checks[b.product.product_id]?.checked_at ?? '';
        return cb.localeCompare(ca);
      });
  }, [filtered, checks]);

  // ── Group "to check" rows by category for the grid ───────────────────────
  const groups = useMemo(() => {
    const map = new Map<string, AuditRow[]>();
    for (const row of pending) {
      const cat = row.product.type ?? 'Uncategorised';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(row);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pending]);

  const locName = locations.find(l => l.location_id === locationId)?.location_name ?? 'Location';
  const today   = fmtDateLong(new Date());

  return (
    <div className="min-h-screen">

      {/* ═══════════════════════════════════════════════════════════════════
          PRINT-ONLY AUDIT SHEET
          Hidden on screen; shows when the user hits Print / Save as PDF
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="hidden print:block">
        <style>{`
          @page { size: A4; margin: 18mm 15mm; }
          body   { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        `}</style>

        {/* Header */}
        <div style={{ fontFamily: 'Arial, sans-serif', fontSize: '12px', color: '#111' }}>
          <div style={{ textAlign: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '12px' }}>
            <p style={{ fontSize: '18px', fontWeight: 'bold', margin: 0 }}>Jay Aadinath Enterprises LTD</p>
            <p style={{ fontSize: '13px', margin: '3px 0 0' }}>Inventory Count Sheet — {locName}</p>
            <p style={{ fontSize: '11px', color: '#555', margin: '4px 0 0' }}>Date: {today}</p>
          </div>

          {/* Sign-off row */}
          <div style={{ display: 'flex', gap: '40px', marginBottom: '14px', fontSize: '11px' }}>
            <span>Counted by: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '160px' }}>&nbsp;</span></span>
            <span>Verified by: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '160px' }}>&nbsp;</span></span>
            <span>Signature: <span style={{ borderBottom: '1px solid #333', display: 'inline-block', width: '120px' }}>&nbsp;</span></span>
          </div>

          {/* Table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px' }}>
            <thead>
              <tr style={{ backgroundColor: '#e8e8e8' }}>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '28px'  }}>#</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left'                  }}>Product Name</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '100px' }}>Category</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'center',width: '100px' }}>Physical Count</th>
                <th style={{ border: '1px solid #bbb', padding: '5px 6px', textAlign: 'left',  width: '140px' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr key={row.product.product_id}
                  style={{ backgroundColor: i % 2 === 0 ? '#fff' : '#f8f8f8', pageBreakInside: 'avoid' }}>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px', color: '#666' }}>{i + 1}</td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>
                    <span style={{ fontWeight: 600 }}>{row.product.product_name}</span>
                    {row.product.brand
                      ? <span style={{ color: '#777', fontSize: '9.5px' }}> · {row.product.brand}</span>
                      : null}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px', color: '#555' }}>
                    {row.product.type ?? '—'}
                  </td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>&nbsp;</td>
                  <td style={{ border: '1px solid #ccc', padding: '4px 6px' }}>&nbsp;</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <p style={{ marginTop: '10px', fontSize: '10px', color: '#888' }}>
            Generated: {new Date().toLocaleString('en-KE')} &nbsp;·&nbsp;
            Location: {locName} &nbsp;·&nbsp;
            Total products: {filtered.length}
          </p>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SCREEN UI
      ═══════════════════════════════════════════════════════════════════ */}
      <div className="print:hidden">
        <AdminNavbar onLogout={handleLogout} />

        <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-12">

          {/* ── Page header ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between gap-3 flex-wrap pt-5 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-100">🗂️ Inventory Audit</h2>
              <p className="text-xs text-muted mt-0.5">
                {loading ? 'Loading…' : `${pending.length} to check · ${checkedList.length} checked · ${locName}`}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={loadAuditRows}
                disabled={loading}
                className="px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-muted text-xs font-bold hover:border-teal/30 hover:text-teal transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                🔄 Refresh
              </button>
              <button
                onClick={resetAudit}
                className="px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs font-bold hover:bg-danger/20 transition-all flex items-center gap-1.5"
              >
                ↺ Start New Audit
              </button>
              <button
                onClick={() => window.print()}
                className="px-4 py-2 rounded-xl bg-gold/10 border border-gold/30 text-gold text-xs font-bold hover:bg-gold/20 transition-all flex items-center gap-2"
              >
                🖨️ Generate PDF
              </button>
            </div>
          </div>

          {/* ── Location toggle (dynamic) ────────────────────────────── */}
          <div className="flex gap-2 mb-4 overflow-x-auto scrollbar-none">
            {locations.map(loc => (
              <button
                key={loc.location_id}
                onClick={() => { setLocationId(loc.location_id); setSearch(''); }}
                className={`shrink-0 flex-1 py-2.5 rounded-xl border text-sm font-bold transition-all ${
                  locationId === loc.location_id
                    ? 'border-teal bg-teal/10 text-teal'
                    : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                }`}
              >
                {loc.location_name}
              </button>
            ))}
          </div>

          {/* ── Search ──────────────────────────────────────────────────── */}
          <div className="relative mb-4">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, category, brand, SKU…"
              className="w-full pl-9 pr-4 py-2 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-slate-100 text-lg"
              >×</button>
            )}
          </div>

          {/* ── Content ─────────────────────────────────────────────────── */}
          {loading ? (
            <div className="flex justify-center py-20">
              <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-muted">
              <div className="text-4xl mb-3">📭</div>
              <p className="text-sm">No products found for {locName}</p>
              {search && <p className="text-xs mt-1 text-muted/60">Try clearing the search filter</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {groups.length === 0 && checkedList.length > 0 && (
                <div className="text-center py-10 text-muted">
                  <div className="text-3xl mb-2">🎉</div>
                  <p className="text-sm">Everything here has been checked</p>
                </div>
              )}

              {groups.map(([cat, rows]) => (
                <div key={cat}>
                  {/* Category divider */}
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[10px] font-bold text-muted uppercase tracking-widest whitespace-nowrap">{cat}</span>
                    <div className="flex-1 h-px bg-white/6" />
                    <span className="text-[10px] text-muted/60">{rows.length}</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {rows.map((row, i) => {
                      const pid   = row.product.product_id;
                      const ppb   = row.product.pieces_per_box ?? 0;
                      const tot   = row.quantity + row.box_quantity * ppb;
                      const reorder = row.product.reorder_level ?? 2;
                      const stockCls =
                        tot === 0           ? 'text-danger' :
                        tot <= reorder      ? 'text-gold'   :
                                              'text-success';
                      const borderCls =
                        tot === 0           ? 'border-danger/15 hover:border-danger/30' :
                        tot <= reorder      ? 'border-gold/15 hover:border-gold/30'     :
                                              'border-white/8 hover:border-teal/20';
                      const isEditing = editingId === pid;
                      const isSaving  = savingId === pid;

                      return (
                        <motion.div
                          key={pid}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: Math.min(i * 0.02, 0.4) }}
                          className={`bg-surface border rounded-xl p-4 transition-all ${borderCls}`}
                        >
                          <div className="cursor-pointer" onClick={() => openProduct(row)}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-sm text-slate-100 leading-snug break-words line-clamp-2">
                                  {row.product.product_name}
                                </p>
                                <p className="text-[11px] text-muted mt-0.5 truncate">
                                  {[row.product.brand, row.product.model].filter(Boolean).join(' · ')
                                    || row.product.stock_keeping_unit
                                    || '—'}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className={`text-sm font-bold tabular-nums ${stockCls}`}>
                                  {stockLabel(row)}
                                </p>
                                {ppb > 0 && row.box_quantity > 0 && (
                                  <p className="text-[9px] text-muted/60 tabular-nums">
                                    = {tot} pc{tot !== 1 ? 's' : ''}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center justify-between mt-2">
                              <span className="text-[9px] text-muted/50 font-mono">
                                {row.product.stock_keeping_unit || ''}
                              </span>
                              <span className="text-[9px] text-muted/50 flex items-center gap-1">
                                View history →
                              </span>
                            </div>
                          </div>

                          {/* ── Done / Edit actions ─────────────────────── */}
                          {isEditing ? (
                            <div className="mt-3 pt-3 border-t border-white/8" onClick={e => e.stopPropagation()}>
                              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5">
                                Correct total (pieces) at {locName}
                              </p>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  autoFocus
                                  value={editValue}
                                  onFocus={e => e.currentTarget.select()}
                                  onChange={e => setEditValue(e.target.value)}
                                  onWheel={e => e.currentTarget.blur()}
                                  className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-sm font-bold outline-none focus:border-teal/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                />
                                <button
                                  onClick={() => saveEdit(row)}
                                  disabled={isSaving}
                                  className="px-3 py-2 rounded-lg bg-teal/15 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/25 transition-colors disabled:opacity-40"
                                >
                                  {isSaving ? '…' : 'Save'}
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  disabled={isSaving}
                                  className="px-3 py-2 rounded-lg bg-surface2 border border-white/10 text-muted text-xs font-bold hover:text-slate-100 transition-colors disabled:opacity-40"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-2 mt-3 pt-3 border-t border-white/8">
                              <button
                                onClick={(e) => { e.stopPropagation(); markChecked(row, false); }}
                                disabled={isSaving}
                                className="flex-1 py-2 rounded-lg bg-success/10 border border-success/30 text-success text-xs font-bold hover:bg-success/20 transition-colors disabled:opacity-40"
                              >
                                {isSaving ? '…' : '✓ Done'}
                              </button>
                              {role === 'admin' && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); startEdit(row); }}
                                  disabled={isSaving}
                                  className="flex-1 py-2 rounded-lg bg-gold/10 border border-gold/30 text-gold text-xs font-bold hover:bg-gold/20 transition-colors disabled:opacity-40"
                                >
                                  ✎ Edit
                                </button>
                              )}
                            </div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* ── Checked list ────────────────────────────────────────── */}
              {checkedList.length > 0 && (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[10px] font-bold text-success uppercase tracking-widest whitespace-nowrap">✅ Checked</span>
                    <div className="flex-1 h-px bg-white/6" />
                    <span className="text-[10px] text-muted/60">{checkedList.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {checkedList.map(row => {
                      const pid = row.product.product_id;
                      const c = checks[pid];
                      return (
                        <div
                          key={pid}
                          onClick={() => openProduct(row)}
                          className="bg-surface2/60 border border-success/15 rounded-xl p-3 cursor-pointer opacity-80 hover:opacity-100 transition-opacity"
                        >
                          <p className="text-xs font-semibold text-slate-300 truncate">{row.product.product_name}</p>
                          <div className="flex items-center justify-between mt-1 gap-2">
                            <span className="text-[10px] text-muted truncate">
                              {stockLabel(row)}{c?.edited ? ' · corrected' : ''}
                            </span>
                            <span className="text-[9px] text-muted/60 shrink-0">
                              {c ? fmtDateTime(c.checked_at) : ''}{c?.checked_by ? ` · ${c.checked_by}` : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>

        {/* ── Product history drawer ───────────────────────────────────── */}
        <AnimatePresence>
          {selected && (
            <>
              <motion.div
                key="hist-bd"
                className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setSelected(null)}
              />
              <motion.div
                key="hist-panel"
                className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[88vh] overflow-y-auto"
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 28, stiffness: 220 }}
              >
                <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />

                {/* Drawer header */}
                <div className="flex items-start justify-between mb-1">
                  <div className="flex-1 min-w-0 mr-3">
                    <h3 className="font-bold text-slate-100 text-sm leading-snug">
                      {selected.product.product_name}
                    </h3>
                    <p className="text-[11px] text-muted mt-0.5">
                      {selected.product.type ?? '—'}
                      {selected.product.brand ? ` · ${selected.product.brand}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="text-muted hover:text-slate-100 text-xl shrink-0 transition-colors"
                  >×</button>
                </div>

                {/* Current stock summary card */}
                <div className="bg-surface2 rounded-xl px-4 py-3 mb-4 flex items-center justify-between border border-white/8">
                  <div>
                    <p className="text-[10px] font-bold text-muted uppercase tracking-widest">{locName} · Current Stock</p>
                    <p className={`text-lg font-bold tabular-nums mt-0.5 ${
                      (selected.quantity + selected.box_quantity * (selected.product.pieces_per_box ?? 0)) === 0
                        ? 'text-danger' : 'text-teal'
                    }`}>
                      {stockLabel(selected)}
                    </p>
                  </div>
                  {selected.product.pieces_per_box && selected.product.pieces_per_box > 0 && selected.box_quantity > 0 && (
                    <div className="text-right">
                      <p className="text-[10px] text-muted">Boxes</p>
                      <p className="text-base font-bold text-gold tabular-nums">{selected.box_quantity}</p>
                      <p className="text-[10px] text-muted">Loose</p>
                      <p className="text-base font-bold text-slate-300 tabular-nums">{selected.quantity}</p>
                    </div>
                  )}
                </div>

                {/* History list */}
                <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-3">
                  Movement History at {locName}
                </div>

                {histLoading ? (
                  <div className="flex justify-center py-10">
                    <div className="w-6 h-6 rounded-full border-2 border-teal border-t-transparent animate-spin" />
                  </div>
                ) : history.length === 0 ? (
                  <div className="text-center py-10">
                    <p className="text-muted text-sm">No movements found for this location</p>
                    <p className="text-muted/60 text-xs mt-1">This product may have been added directly to stock without a movement record</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {history.map(mov => {
                      const meta = MOVEMENT_META[mov.movement_type] ?? {
                        label: mov.movement_type, emoji: '📝', color: 'text-muted',
                      };
                      // Direction label relative to the current location
                      const isIn  = mov.to_location_id   === locationId;
                      const isOut = mov.from_location_id === locationId;
                      const dirLabel =
                        isIn && isOut  ? '↔ Both'  :
                        isIn           ? '↓ In'    :
                        isOut          ? '↑ Out'   : '';
                      const dirColor =
                        isIn && isOut  ? 'text-muted'   :
                        isIn           ? 'text-success' :
                                         'text-danger';
                      return (
                        <div key={mov.id}
                          className="bg-surface2 rounded-xl px-3 py-2.5 border border-white/5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-base">{meta.emoji}</span>
                              <div>
                                <span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span>
                                {dirLabel && (
                                  <span className={`text-[10px] font-bold ml-2 ${dirColor}`}>{dirLabel}</span>
                                )}
                              </div>
                            </div>
                            <span className="text-sm font-bold text-slate-200 tabular-nums">
                              {mov.quantity}
                            </span>
                          </div>
                          {mov.reason && (
                            <p className="text-[10px] text-muted mt-1 line-clamp-2">{mov.reason}</p>
                          )}
                          <p className="text-[10px] text-muted/50 mt-0.5">
                            {fmtDateTime(mov.created_at)}
                          </p>
                        </div>
                      );
                    })}

                    {history.length >= 200 && (
                      <p className="text-[10px] text-muted/60 text-center py-2">
                        Showing last 200 movements
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </div>
    </div>
  );
}
