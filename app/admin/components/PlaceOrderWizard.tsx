'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Supplier } from '@/lib/types';
import type { OrderLine, SavedOrder } from '@/lib/orderPdf';
import { lineName, openOrderPdf, qtyWithUnit } from '@/lib/orderPdf';
import { buildOrderFile, canShareFile, downloadFile, shareFile, type OrderFileKind } from '@/lib/orderExport';

type ChosenSupplier = { id: number; name: string } | null;

interface Props {
  // Order lines for a supplier — the supplier's product names depend on
  // who the order goes to.
  linesFor:          (supplier: ChosenSupplier) => OrderLine[];
  suppliers:         Supplier[];
  initialSupplierId: number | '';
  // Saves the order; returns it, or an error message.
  onPlace:           (supplier: ChosenSupplier) => Promise<SavedOrder | string>;
  onSupplierAdded:   (s: Supplier) => void;
  onClose:           () => void;
}

function ksh(n: number) { return 'Ksh ' + n.toLocaleString('en-KE'); }

// Place Order, step by step: pick (or add) the supplier → review and
// confirm (this saves the order) → get the order as PDF or Excel, to
// share or download.
export default function PlaceOrderWizard({ linesFor, suppliers, initialSupplierId, onPlace, onSupplierAdded, onClose }: Props) {
  const [step, setStep] = useState<'supplier' | 'review' | 'done'>('supplier');
  const [picked, setPicked] = useState<number | 'none' | ''>(initialSupplierId === '' ? '' : initialSupplierId);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [newSup, setNewSup] = useState({ name: '', phone: '' });
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [order,  setOrder]  = useState<SavedOrder | null>(null);
  const [files,  setFiles]  = useState<Partial<Record<OrderFileKind, File>>>({});
  const [info,   setInfo]   = useState<string | null>(null);

  const chosen: ChosenSupplier = typeof picked === 'number'
    ? { id: picked, name: suppliers.find(s => s.supplier_id === picked)?.supplier_name ?? `Supplier #${picked}` }
    : null;
  const lines = order?.items ?? linesFor(chosen);
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

  const q = search.trim().toLowerCase();
  const list = useMemo(
    () => suppliers.filter(s => !q || s.supplier_name.toLowerCase().includes(q) || (s.phone ?? '').includes(q)),
    [suppliers, q],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Build both files as soon as the order is saved, so Share runs straight
  // from the click (browsers only allow sharing right after a gesture).
  useEffect(() => {
    if (!order) return;
    let cancelled = false;
    Promise.all([buildOrderFile(order, 'pdf'), buildOrderFile(order, 'xlsx')])
      .then(([pdf, xlsx]) => { if (!cancelled) setFiles({ pdf, xlsx }); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [order]);

  async function saveNewSupplier() {
    const name = newSup.name.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const dup = suppliers.find(s => s.supplier_name.trim().toLowerCase() === name.toLowerCase());
    if (dup) { setPicked(dup.supplier_id); setAdding(false); setInfo(`"${dup.supplier_name}" is already saved — picked it.`); return; }
    setBusy(true); setError(null);
    const { data, error } = await supabase.from('suppliers')
      .insert({ supplier_name: name, phone: newSup.phone.trim() || null, address: null, notes: null, active_status: true })
      .select('supplier_id, supplier_name, phone, address, notes, active_status').single();
    setBusy(false);
    if (error || !data) { setError(`Couldn't add the supplier: ${error?.message ?? 'no row returned'}`); return; }
    const s = data as Supplier;
    onSupplierAdded(s);
    setPicked(s.supplier_id);
    setAdding(false);
    setNewSup({ name: '', phone: '' });
    setInfo(`Added "${s.supplier_name}".`);
  }

  async function confirm() {
    setBusy(true); setError(null);
    const res = await onPlace(chosen);
    setBusy(false);
    if (typeof res === 'string') { setError(res); return; }
    setOrder(res);
    setStep('done');
  }

  async function share(kind: OrderFileKind) {
    const file = files[kind];
    if (!file || !order) return;
    setInfo(null);
    if (!canShareFile(file)) {
      downloadFile(file);
      setInfo('This browser can’t share files directly, so it was downloaded instead — attach it from your Downloads.');
      return;
    }
    try { await shareFile(file, order); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const btn = 'px-4 py-2.5 rounded-xl text-xs font-bold transition-all disabled:opacity-40';

  return (
    <div className="print-hide fixed inset-0 z-150 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={() => !busy && step !== 'done' && onClose()}>
      <div role="dialog" aria-label="Place order" onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[90vh] flex flex-col bg-surface border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl">

        {/* Header + progress */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-slate-100">
              {step === 'supplier' ? '1 · Choose supplier' : step === 'review' ? '2 · Review order' : '✅ Order placed'}
            </h3>
            {step !== 'done' && (
              <button onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-lg bg-surface2 border border-white/10 text-slate-300 text-xs font-bold hover:border-white/25">Close</button>
            )}
          </div>
          <div className="flex gap-1.5 mt-3">
            {(['supplier', 'review', 'done'] as const).map((s, i) => (
              <span key={s} className={`h-1 flex-1 rounded-full ${['supplier', 'review', 'done'].indexOf(step) >= i ? 'bg-teal' : 'bg-white/10'}`} />
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2">{lines.length} item{lines.length === 1 ? '' : 's'} · {ksh(total)}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {error && <p className="mb-3 text-xs text-danger">{error}</p>}
          {info && <p className="mb-3 text-xs text-success">{info}</p>}

          {step === 'supplier' && (
            <>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search saved suppliers…" aria-label="Search suppliers"
                className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40" />
              <ul className="mt-2 rounded-2xl border border-white/8 divide-y divide-white/5 max-h-64 overflow-y-auto">
                {list.map(s => (
                  <li key={s.supplier_id}>
                    <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/[0.03]">
                      <input type="radio" name="supplier" checked={picked === s.supplier_id} onChange={() => setPicked(s.supplier_id)} className="accent-teal w-4 h-4" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-slate-100 truncate">{s.supplier_name}</span>
                        {s.phone && <span className="block text-[10px] text-muted">{s.phone}</span>}
                      </span>
                    </label>
                  </li>
                ))}
                {list.length === 0 && <li className="px-3 py-4 text-center text-xs text-muted">No saved supplier matches “{search.trim()}”.</li>}
                <li>
                  <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/[0.03]">
                    <input type="radio" name="supplier" checked={picked === 'none'} onChange={() => setPicked('none')} className="accent-teal w-4 h-4" />
                    <span className="text-sm text-muted">No supplier</span>
                  </label>
                </li>
              </ul>

              {adding ? (
                <form onSubmit={e => { e.preventDefault(); saveNewSupplier(); }} className="mt-3 p-3 rounded-2xl border border-teal/30 bg-teal/5 space-y-2">
                  <input autoFocus value={newSup.name} onChange={e => setNewSup(v => ({ ...v, name: e.target.value }))} placeholder="Supplier name" aria-label="New supplier name"
                    className="w-full px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40" />
                  <input value={newSup.phone} onChange={e => setNewSup(v => ({ ...v, phone: e.target.value }))} placeholder="Phone (optional)" aria-label="New supplier phone" inputMode="tel"
                    className="w-full px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAdding(false)} className={`${btn} flex-1 bg-surface2 border border-white/10 text-slate-300`}>Cancel</button>
                    <button type="submit" disabled={!newSup.name.trim() || busy} className={`${btn} flex-1 btn-primary`}>{busy ? 'Saving…' : 'Save supplier'}</button>
                  </div>
                </form>
              ) : (
                <button onClick={() => { setAdding(true); setNewSup({ name: search.trim(), phone: '' }); setInfo(null); }}
                  className="mt-3 w-full py-2.5 rounded-xl border border-dashed border-teal/40 text-teal text-xs font-bold hover:bg-teal/5">
                  ➕ Add a new supplier
                </button>
              )}
            </>
          )}

          {step === 'review' && (
            <>
              <p className="text-sm text-slate-200">To: <span className="font-bold">{chosen?.name ?? 'No supplier'}</span></p>
              <ul className="mt-3 rounded-2xl border border-white/8 divide-y divide-white/5 text-sm">
                {lines.map((l, i) => (
                  <li key={`${l.product_id}-${i}`} className="px-3 py-2 flex items-start gap-3">
                    <span className="flex-1 min-w-0 break-words">
                      <span className="block text-slate-200">{lineName(l)}</span>
                      {lineName(l) !== l.product_name && <span className="block text-[10px] text-muted">ours: {l.product_name}</span>}
                    </span>
                    <span className="shrink-0 text-right text-[11px] text-muted tabular-nums">
                      {qtyWithUnit(l)} × {ksh(l.price)}
                      <span className="block text-slate-100 font-semibold text-xs">{ksh(l.price * l.qty)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-right text-sm font-bold text-gold tabular-nums">Total {ksh(total)}</p>
              {lines.some(l => l.qty === 0 || l.price === 0) && (
                <p className="mt-1 text-[11px] text-orange-500">Some lines have no price or quantity — they’ll show as 0.</p>
              )}
            </>
          )}

          {step === 'done' && order && (
            <>
              <p className="text-sm text-slate-200">
                Order <span className="font-bold tabular-nums">{order.order_no}</span> saved{order.supplier_name ? <> for <span className="font-bold">{order.supplier_name}</span></> : ''}.
              </p>
              <p className="text-[11px] text-muted mt-0.5">Get it as a file to send:</p>
              {(['pdf', 'xlsx'] as const).map(kind => (
                <div key={kind} className="mt-3 p-3 rounded-2xl border border-white/8 bg-surface2">
                  <p className="text-xs font-bold text-slate-100">{kind === 'pdf' ? '📄 PDF' : '📊 Excel'}</p>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => share(kind)} disabled={!files[kind]} className={`${btn} flex-1 btn-primary`}>📤 Share</button>
                    {kind === 'pdf' ? (
                      <button onClick={() => openOrderPdf(order)} className={`${btn} flex-1 bg-surface border border-white/10 text-slate-200`}>Open</button>
                    ) : null}
                    <button onClick={() => { const f = files[kind]; if (f) downloadFile(f); }} disabled={!files[kind]} className={`${btn} flex-1 bg-surface border border-white/10 text-slate-200`}>⬇ Download</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 pt-3 pb-5 flex gap-2">
          {step === 'supplier' && (
            <button onClick={() => { setError(null); setInfo(null); setStep('review'); }} disabled={picked === '' || adding}
              className={`${btn} flex-1 btn-primary`}>
              {picked === '' ? 'Pick a supplier' : 'Next →'}
            </button>
          )}
          {step === 'review' && (
            <>
              <button onClick={() => setStep('supplier')} disabled={busy} className={`${btn} bg-surface2 border border-white/10 text-slate-300`}>← Back</button>
              <button onClick={confirm} disabled={busy} className={`${btn} flex-1 btn-primary`}>{busy ? 'Saving…' : '📦 Confirm & place order'}</button>
            </>
          )}
          {step === 'done' && (
            <button onClick={onClose} className={`${btn} flex-1 bg-surface2 border border-white/10 text-slate-200`}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
