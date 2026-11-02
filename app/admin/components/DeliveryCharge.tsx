'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { receiptLink, removeReceipt, uploadReceipt } from '@/lib/deliveryReceipt';

interface Props {
  purchaseId:  number;
  charge:      number | null;
  receiptPath: string | null;
  billTotal:   number | null;
  onSaved:     (charge: number | null, receiptPath: string | null) => void;
}

function ksh(n: number) { return 'Ksh ' + n.toLocaleString('en-KE'); }

// "Delivery charges" on a purchase: the amount paid to get the goods here,
// plus a photo of its receipt. Add, change or remove either.
export default function DeliveryCharge({ purchaseId, charge, receiptPath, billTotal, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [amount,  setAmount]  = useState(charge != null ? String(charge) : '');
  const [file,    setFile]    = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);   // picked, not yet saved
  const [dropReceipt, setDropReceipt] = useState(false);
  const [link,    setLink]    = useState<string | null>(null);   // saved receipt
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (receiptPath) receiptLink(receiptPath).then(u => { if (!cancelled) setLink(u); });
    else setLink(null);
    return () => { cancelled = true; };
  }, [receiptPath]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function startEdit() {
    setAmount(charge != null ? String(charge) : '');
    setFile(null); setPreview(null); setDropReceipt(false); setError(null);
    setEditing(true);
  }

  function pick(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setDropReceipt(false);
  }

  async function save() {
    const n = amount.trim() === '' ? null : Number(amount);
    if (n != null && (!Number.isFinite(n) || n < 0)) { setError('Enter a valid amount'); return; }
    setSaving(true); setError(null);
    try {
      let path = receiptPath;
      if (file) path = await uploadReceipt(purchaseId, file);
      else if (dropReceipt) path = null;
      const { error: e } = await supabase.from('purchases')
        .update({ delivery_charge: n, delivery_receipt_path: path })
        .eq('purchase_id', purchaseId);
      if (e) throw new Error(e.message);
      // The replaced / removed photo is no longer needed.
      if (receiptPath && path !== receiptPath) removeReceipt(receiptPath).catch(() => {});
      onSaved(n, path);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const has = charge != null || !!receiptPath;

  return (
    <div className="mt-3 rounded-xl bg-surface2 border border-white/8 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold text-muted uppercase tracking-widest">🚚 Delivery charges</span>
        {!editing && (
          <button onClick={startEdit} className="text-[11px] font-bold text-teal px-2.5 py-1 rounded-lg bg-teal/10 border border-teal/20 hover:bg-teal/20">
            {has ? '✏️ Edit' : '+ Add'}
          </button>
        )}
      </div>

      {!editing && (has ? (
        <div className="mt-2">
          <p className="text-sm font-bold text-slate-100 tabular-nums">{charge != null ? ksh(charge) : 'Amount not entered'}</p>
          {charge != null && billTotal != null && (
            <p className="text-[11px] text-muted tabular-nums">Bill + delivery: <b className="text-slate-200">{ksh(billTotal + charge)}</b></p>
          )}
          {receiptPath && (link
            ? <a href={link} target="_blank" rel="noreferrer" className="block mt-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={link} alt="Delivery receipt" className="w-full max-h-80 object-contain rounded-lg border border-white/8 bg-black/20" />
              </a>
            : <p className="text-[11px] text-muted mt-1">Loading receipt…</p>)}
        </div>
      ) : (
        <p className="mt-1 text-[11px] text-muted">None recorded for this bill.</p>
      ))}

      {editing && (
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="text-[10px] text-muted block mb-1">Amount (Ksh)</span>
            <input type="number" inputMode="decimal" min="0" value={amount} autoFocus
              onChange={e => setAmount(e.target.value)} onWheel={e => e.currentTarget.blur()}
              placeholder="e.g. 1500" aria-label="Delivery charge"
              className="w-full px-3 py-2 rounded-lg bg-surface border border-white/10 text-sm text-slate-100 tabular-nums outline-none focus:border-teal/40" />
          </label>

          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {preview || (receiptPath && !dropReceipt && link) ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview ?? link!} alt="Delivery receipt" className="w-full max-h-64 object-contain rounded-lg border border-white/8 bg-black/20" />
              <div className="flex gap-2 mt-1.5">
                <button type="button" onClick={() => fileRef.current?.click()} className="text-[11px] font-bold text-teal">Replace photo</button>
                <button type="button" onClick={() => { setFile(null); setPreview(null); setDropReceipt(true); }} className="text-[11px] font-bold text-danger">Remove photo</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()}
              className="w-full py-3 rounded-lg border border-dashed border-white/15 text-[11px] text-muted hover:border-teal/40 hover:text-teal">
              📷 Attach receipt photo
            </button>
          )}

          {error && <p className="text-[11px] text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(false)} disabled={saving}
              className="flex-1 py-2 rounded-lg bg-surface border border-white/10 text-xs font-bold text-slate-300">Cancel</button>
            <button type="button" onClick={save} disabled={saving}
              className="flex-1 py-2 rounded-lg btn-primary text-xs font-bold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
