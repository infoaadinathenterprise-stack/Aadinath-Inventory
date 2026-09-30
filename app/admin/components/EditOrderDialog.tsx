'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Supplier } from '@/lib/types';
import { ORDER_UNITS, unitLabel, type OrderLine, type OrderUnit, type SavedOrder } from '@/lib/orderPdf';

interface Props {
  order:     SavedOrder;
  suppliers: Supplier[];
  onSaved:   (order: SavedOrder) => void;
  onClose:   () => void;
}

// A line as edited: numbers kept as typed text until saving.
interface Draft { line: OrderLine; name: string; price: string; qty: string; unit: OrderUnit }

function num(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Edit a placed order — supplier, and each line's supplier product name,
// price, quantity and unit, or remove a line — then save it. The order
// keeps its number; its PDF / Excel are rebuilt from the saved data.
export default function EditOrderDialog({ order, suppliers, onSaved, onClose }: Props) {
  const [supplierId, setSupplierId] = useState<number | ''>(order.supplier_id ?? '');
  const [drafts, setDrafts] = useState<Draft[]>(() => order.items.map(l => ({
    line:  l,
    name:  l.supplier_product_name ?? '',
    price: l.price > 0 ? String(l.price) : '',
    qty:   l.qty > 0 ? String(l.qty) : '',
    unit:  l.unit ?? 'pc',
  })));
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !saving) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  function update(i: number, patch: Partial<Draft>) {
    setDrafts(prev => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  const lines: OrderLine[] = drafts.map(d => ({
    ...d.line,
    supplier_product_name: d.name.trim() || null,
    price: num(d.price),
    qty:   num(d.qty),
    unit:  d.unit,
  }));
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

  async function save() {
    if (lines.length === 0) { setError('An order needs at least one line.'); return; }
    setSaving(true); setError(null);
    // Keep the supplier's name as it was if the supplier wasn't changed
    // (it may have been renamed or deactivated since).
    const sup = supplierId === '' ? null : suppliers.find(s => s.supplier_id === supplierId);
    const supplier_name = supplierId === '' ? null
      : supplierId === order.supplier_id ? (order.supplier_name ?? sup?.supplier_name ?? null)
      : (sup?.supplier_name ?? null);
    const { data, error } = await supabase.from('purchase_orders').update({
      supplier_id:  supplierId === '' ? null : supplierId,
      supplier_name,
      items:        lines,
      total_amount: total,
      updated_at:   new Date().toISOString(),
    }).eq('order_id', order.order_id).select('*').single();
    setSaving(false);
    if (error || !data) { setError(`Couldn't save: ${error?.message ?? 'no row returned'}`); return; }
    onSaved(data as SavedOrder);
  }

  const cell = 'px-2 py-1.5 rounded-lg bg-surface2 border border-white/10 text-sm text-slate-100 outline-none focus:border-teal/40';

  return (
    <div className="print-hide fixed inset-0 z-160 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center" onClick={() => !saving && onClose()}>
      <div role="dialog" aria-label={`Edit order ${order.order_no}`} onClick={e => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] flex flex-col bg-surface border border-white/10 rounded-t-3xl sm:rounded-3xl shadow-2xl">
        <div className="px-5 pt-5 pb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-100">✏️ Edit {order.order_no}</h3>
            <p className="text-[11px] text-muted">Placed {order.order_date}{order.updated_at ? ` · last edited ${new Date(order.updated_at).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}</p>
          </div>
          <select value={supplierId} onChange={e => setSupplierId(e.target.value ? Number(e.target.value) : '')}
            aria-label="Supplier" className={`${cell} min-w-48 py-2`}>
            <option value="">No supplier</option>
            {order.supplier_id != null && !suppliers.some(s => s.supplier_id === order.supplier_id) && (
              <option value={order.supplier_id}>{order.supplier_name ?? `Supplier #${order.supplier_id}`}</option>
            )}
            {suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>)}
          </select>
        </div>

        <div className="flex-1 overflow-auto px-5">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}
          <table className="w-full min-w-[680px] text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-muted border-b border-white/8">
                <th className="py-2 pr-2">Product</th>
                <th className="py-2 pr-2">Supplier product name</th>
                <th className="py-2 pr-2 text-right">Price</th>
                <th className="py-2 pr-2 text-right">Quantity</th>
                <th className="py-2 pr-2">Unit</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => {
                return (
                  <tr key={`${d.line.product_id}-${i}`} className="border-t border-white/5">
                    <td className="py-2 pr-2 text-slate-200">{d.line.product_name}</td>
                    <td className="py-2 pr-2">
                      <input value={d.name} onChange={e => update(i, { name: e.target.value })} placeholder="Same as ours"
                        aria-label={`Supplier's name for ${d.line.product_name}`} className={`${cell} w-full min-w-40`} />
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <input type="number" inputMode="decimal" min="0" placeholder="0" value={d.price}
                        onChange={e => update(i, { price: e.target.value })} onWheel={e => e.currentTarget.blur()}
                        aria-label={`Price for ${d.line.product_name}`} className={`${cell} w-24 text-right tabular-nums`} />
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <input type="number" inputMode="numeric" min="0" placeholder="0" value={d.qty}
                        onChange={e => update(i, { qty: e.target.value })} onWheel={e => e.currentTarget.blur()}
                        aria-label={`Quantity for ${d.line.product_name}`} className={`${cell} w-20 text-right tabular-nums`} />
                    </td>
                    <td className="py-2 pr-2">
                      <select value={d.unit} onChange={e => update(i, { unit: e.target.value as OrderUnit })}
                        aria-label={`Unit for ${d.line.product_name}`} className={`${cell} w-24`}>
                        {ORDER_UNITS.map(u => <option key={u} value={u}>{unitLabel(u)}</option>)}
                      </select>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => setDrafts(prev => prev.filter((_, j) => j !== i))} aria-label={`Remove ${d.line.product_name}`}
                        className="w-8 h-8 rounded-lg text-danger hover:bg-danger/10" title="Remove this line">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {drafts.length === 0 && <p className="py-6 text-center text-xs text-muted">No lines left — add at least one before saving.</p>}
        </div>

        <div className="px-5 pt-3 pb-5 flex flex-wrap items-center gap-2 border-t border-white/8 mt-2">
          <span className="mr-auto text-sm font-bold text-gold tabular-nums">Total Ksh {total.toLocaleString('en-KE')}</span>
          <button onClick={onClose} disabled={saving} className="px-4 py-2.5 rounded-xl bg-surface2 border border-white/10 text-slate-300 text-xs font-bold">Cancel</button>
          <button onClick={save} disabled={saving || drafts.length === 0} className="px-4 py-2.5 rounded-xl btn-primary text-xs font-bold disabled:opacity-40">
            {saving ? 'Saving…' : '💾 Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
