'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Purchase, PurchaseItem, Supplier, Product } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';
import { logMovement } from '@/lib/stockActions';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

const GEMINI_URL  = '/api/gemini';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface ScannedItem {
  tempId:      number;
  nameRaw:     string;
  productId:   number | null;
  productName: string;
  qty:         number;
  unitPrice:   number | null;
  totalPrice:  number | null;
  locationId:  number;
  isNew:       boolean;
}

// ── Gemini bill parser ────────────────────────────────────────────────────────

async function callGemini(prompt: string, imageBase64?: string, mimeType?: string): Promise<string> {
  const body: Record<string, string> = { prompt };
  if (imageBase64 && mimeType) { body.imageBase64 = imageBase64; body.mimeType = mimeType; }
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { result?: string; error?: string; detail?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? data.detail ?? `HTTP ${res.status}`);
  return data.result ?? '';
}

function matchProduct(name: string, products: Product[]): Product | null {
  const nl = name.toLowerCase();
  return products.find(p => {
    const pn = p.product_name.toLowerCase();
    const key  = nl.substring(0, Math.min(7, nl.length));
    const pkey = pn.substring(0, Math.min(7, pn.length));
    return pn.includes(key) || nl.includes(pkey);
  }) ?? null;
}

function parseGeminiItems(raw: string, products: Product[]): ScannedItem[] {
  let counter = 0;
  const lines = raw.split('\n').filter(l => l.trim());
  const items: ScannedItem[] = [];
  for (const line of lines) {
    const m = line.match(/^([^|]+)\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const name = m[1].trim();
    const qty  = parseFloat(m[2]);
    const unitP = parseFloat(m[3]);
    const totalP = parseFloat(m[4]);
    const matched = matchProduct(name, products);
    items.push({
      tempId: ++counter,
      nameRaw: name,
      productId:   matched ? matched.product_id   : null,
      productName: matched ? matched.product_name : name,
      qty,
      unitPrice:  isNaN(unitP)  ? null : unitP,
      totalPrice: isNaN(totalP) ? null : totalP,
      locationId: 2,
      isNew: !matched,
    });
  }
  return items;
}

// ── Purchases dashboard ───────────────────────────────────────────────────────

function PurchasesDashboard() {
  const [purchases,  setPurchases]  = useState<Purchase[]>([]);
  const [suppliers,  setSuppliers]  = useState<Supplier[]>([]);
  const [products,   setProducts]   = useState<Product[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [toast,      setToast]      = useState<ToastState | null>(null);
  const [newModal,   setNewModal]   = useState(false);
  const [detailId,   setDetailId]   = useState<number | null>(null);
  const [detailData, setDetailData] = useState<{ purchase: Purchase; items: PurchaseItem[] } | null>(null);
  const toastId = useRef(0);
  const router  = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined' || localStorage.getItem(SESSION_KEY) !== '1') router.replace('/admin');
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: purch, error: purchErr }, { data: sup, error: supErr }, { data: prod, error: prodErr }] = await Promise.all([
      supabase.from('purchases').select('*').order('created_at', { ascending: false }),
      supabase.from('suppliers').select('*').eq('active_status', true).order('supplier_name'),
      supabase.from('products').select('*').eq('active_status', true).order('product_name'),
    ]);
    if (purchErr || supErr || prodErr) {
      setToast({ msg: 'Failed to load purchases: ' + (purchErr ?? supErr ?? prodErr)!.message, type: 'error', id: ++toastId.current });
    } else {
      setPurchases((purch ?? []) as Purchase[]);
      setSuppliers((sup   ?? []) as Supplier[]);
      setProducts( (prod  ?? []) as Product[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openDetail(id: number) {
    setDetailId(id);
    const [{ data: pArr }, { data: items }] = await Promise.all([
      supabase.from('purchases').select('*').eq('purchase_id', id),
      supabase.from('purchase_items').select('*').eq('purchase_id', id),
    ]);
    if (pArr?.[0]) setDetailData({ purchase: pArr[0] as Purchase, items: (items ?? []) as PurchaseItem[] });
  }

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  function supplierName(id: number | null) {
    if (!id) return 'Unknown Supplier';
    return suppliers.find(s => s.supplier_id === id)?.supplier_name ?? 'Unknown';
  }

  function productName(id: number | null, raw: string | null) {
    if (!id) return raw ?? '—';
    return products.find(p => p.product_id === id)?.product_name ?? raw ?? `#${id}`;
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-2xl mx-auto px-4 pb-10">

        <div className="flex items-center justify-between pt-5 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Purchases</h2>
            <p className="text-xs text-muted mt-0.5">{purchases.length} records</p>
          </div>
          <button
            onClick={() => setNewModal(true)}
            className="px-4 py-2 rounded-xl bg-teal/10 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/20 transition-all"
          >
            + New Purchase
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : purchases.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">🧾</div>
            <p className="text-sm">No purchases yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {purchases.map((p, i) => (
              <motion.div
                key={p.purchase_id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
                onClick={() => openDetail(p.purchase_id)}
                className="bg-surface border border-white/8 rounded-xl p-4 cursor-pointer hover:border-teal/20 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-slate-100">{supplierName(p.supplier_id)}</div>
                  <div className="text-sm font-bold text-teal">{p.total_amount ? `Ksh ${Number(p.total_amount).toLocaleString('en-KE')}` : '—'}</div>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <div className="text-xs text-muted">{p.purchase_date ? fmtDate(p.purchase_date) : '—'}{p.notes ? ' · ' + p.notes : ''}</div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${p.status === 'CONFIRMED' ? 'bg-success/10 border-success/20 text-success' : 'bg-gold/10 border-gold/20 text-gold'}`}>
                    {p.status}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      <AnimatePresence>
        {newModal && (
          <NewPurchaseModal
            suppliers={suppliers}
            products={products}
            onClose={() => setNewModal(false)}
            onSaved={() => { setNewModal(false); load(); showToast('Purchase saved ✓', 'success'); }}
            onError={msg => showToast(msg, 'error')}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detailId !== null && detailData && (
          <>
            <motion.div key="dbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => { setDetailId(null); setDetailData(null); }} />
            <motion.div key="dmd" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 220 }}
              className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[90vh] overflow-y-auto"
            >
              <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
              <div className="bg-surface2 rounded-xl p-4 mb-4">
                <div className="font-bold text-slate-100">{supplierName(detailData.purchase.supplier_id)}</div>
                <div className="text-xs text-muted mt-0.5">{detailData.purchase.purchase_date ? fmtDate(detailData.purchase.purchase_date) : '—'}</div>
                {detailData.purchase.notes && <div className="text-xs text-muted/70 mt-1">{detailData.purchase.notes}</div>}
              </div>
              <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">Items ({detailData.items.length})</div>
              {detailData.items.map(item => (
                <div key={item.id} className="flex justify-between py-2.5 border-b border-white/5 text-sm">
                  <div>
                    <div className="font-semibold text-slate-100">{productName(item.product_id, item.product_name_raw)}</div>
                    <div className="text-xs text-muted">Qty: {item.quantity}{item.unit_price ? ` · Ksh ${item.unit_price}/unit` : ''}</div>
                  </div>
                  {item.total_price && <div className="font-bold text-teal">Ksh {Number(item.total_price).toLocaleString('en-KE')}</div>}
                </div>
              ))}
              {detailData.purchase.total_amount && (
                <div className="flex justify-between pt-3 font-bold text-base">
                  <span className="text-slate-100">Total</span>
                  <span className="text-teal">Ksh {Number(detailData.purchase.total_amount).toLocaleString('en-KE')}</span>
                </div>
              )}
              {detailData.purchase.bill_image_url && (
                <div className="mt-4">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">Bill Image</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={detailData.purchase.bill_image_url} alt="Bill" className="w-full rounded-xl border border-white/8" />
                </div>
              )}
              <button
                onClick={() => { setDetailId(null); setDetailData(null); }}
                className="w-full mt-5 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100 transition-colors"
              >
                Close
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ── New Purchase Modal ────────────────────────────────────────────────────────

function NewPurchaseModal({
  suppliers, products, onClose, onSaved, onError,
}: {
  suppliers: Supplier[];
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [step,       setStep]       = useState<1 | 2>(1);
  const [supplierId, setSupplierId] = useState('');
  const [date,       setDate]       = useState(new Date().toISOString().split('T')[0]);
  const [total,      setTotal]      = useState('');
  const [notes,      setNotes]      = useState('');
  const [imageB64,   setImageB64]   = useState<string | null>(null);
  const [imageMime,  setImageMime]  = useState('image/jpeg');
  const [imageThumb, setImageThumb] = useState<string | null>(null);
  const [scanning,   setScanning]   = useState(false);
  const [items,      setItems]      = useState<ScannedItem[]>([]);
  const [saving,     setSaving]     = useState(false);
  const [ocrRaw,     setOcrRaw]     = useState('');
  const [showRaw,    setShowRaw]    = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  let tempCounter = useRef(100);

  function processFile(file: File) {
    if (file.size > 10 * 1024 * 1024) { onError('File too large. Max 10MB'); return; }
    setImageMime(file.type.startsWith('image/') ? 'image/jpeg' : file.type);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      if (file.type.startsWith('image/')) {
        const img = new window.Image();
        img.onload = () => {
          const MAX = 1200;
          let w = img.width, h = img.height;
          if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
          let q = 0.8;
          let du = canvas.toDataURL('image/jpeg', q);
          if (du.split(',')[1].length * 0.75 > 3_000_000) { q = 0.6; du = canvas.toDataURL('image/jpeg', q); }
          setImageB64(du.split(',')[1]);
          setImageThumb(du);
        };
        img.src = dataUrl;
      } else {
        setImageB64(dataUrl.split(',')[1]);
        setImageThumb(null);
      }
    };
    reader.readAsDataURL(file);
  }

  async function scanBill() {
    if (!imageB64) return;
    setScanning(true);
    try {
      const prompt = `You must respond with ONLY a valid JSON object. No markdown, no backticks, no explanation, no preamble.
Start your response directly with { and end with }.
The JSON must have this exact structure:
{
  "supplier_name": "string or null",
  "bill_date": "YYYY-MM-DD or null",
  "total_amount": number or null,
  "items": [
    {
      "product_name": "string",
      "quantity": number,
      "unit_price": number or null,
      "total_price": number or null,
      "is_new": true
    }
  ]
}
Read the purchase bill/invoice image and extract: the supplier/vendor name, bill date, total amount, and all line items (products purchased). Skip header rows, taxes, and discount lines — only include actual product items.`;

      const raw = await callGemini(prompt, imageB64, imageMime);
      setOcrRaw(raw);

      // Strip markdown code fences if present
      let jsonText = raw.trim();
      jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      // Find the first { and last } to extract just the JSON object
      const start = jsonText.indexOf('{');
      const end   = jsonText.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('No JSON object found in AI response');
      jsonText = jsonText.slice(start, end + 1);
      const result = JSON.parse(jsonText) as {
        supplier_name: string | null;
        bill_date:     string | null;
        total_amount:  number | null;
        items: { product_name: string; quantity: number; unit_price: number | null; total_price: number | null }[];
      };

      // Pre-fill supplier if a match is found
      if (result.supplier_name) {
        const sName = result.supplier_name.toLowerCase();
        const matched = suppliers.find(s =>
          s.supplier_name.toLowerCase().includes(sName) || sName.includes(s.supplier_name.toLowerCase())
        );
        if (matched) setSupplierId(String(matched.supplier_id));
      }
      // Pre-fill date and total
      if (result.bill_date)      setDate(result.bill_date);
      if (result.total_amount != null) setTotal(String(result.total_amount));

      // Map items to ScannedItem[]
      let counter = 0;
      const parsed: ScannedItem[] = (result.items ?? []).map(it => {
        const m = matchProduct(it.product_name, products);
        return {
          tempId:      ++counter,
          nameRaw:     it.product_name,
          productId:   m ? m.product_id   : null,
          productName: m ? m.product_name : it.product_name,
          qty:         it.quantity ?? 1,
          unitPrice:   it.unit_price  ?? null,
          totalPrice:  it.total_price ?? null,
          locationId:  2,
          isNew:       !m,
        };
      });

      setItems(parsed.length > 0 ? parsed : [newBlankItem()]);
      setStep(2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      const friendly = (msg.includes('did not match') || msg.toLowerCase().includes('json') || msg.includes('No JSON'))
        ? 'AI could not parse the bill. Please add items manually.'
        : 'AI scan failed: ' + msg;
      onError(friendly);
    } finally {
      setScanning(false);
    }
  }

  function newBlankItem(): ScannedItem {
    return { tempId: ++tempCounter.current, nameRaw: '', productId: null, productName: '', qty: 1, unitPrice: null, totalPrice: null, locationId: 2, isNew: false };
  }

  function updateItem(tempId: number, patch: Partial<ScannedItem>) {
    setItems(items => items.map(it => it.tempId === tempId ? { ...it, ...patch } : it));
  }

  function removeItem(tempId: number) {
    setItems(items => items.filter(it => it.tempId !== tempId));
  }

  async function confirmPurchase() {
    if (items.length === 0) { onError('Add at least one item'); return; }
    setSaving(true);
    try {
      const { data: pArr, error: pErr } = await supabase.from('purchases').insert({
        supplier_id:  supplierId ? parseInt(supplierId) : null,
        purchase_date: date || null,
        total_amount:  total ? parseFloat(total) : null,
        notes:         notes || null,
        status:        'CONFIRMED',
      }).select();
      if (pErr || !pArr?.[0]) throw new Error(pErr?.message ?? 'Failed to save purchase');
      const purchaseId = (pArr[0] as Purchase).purchase_id;

      for (const item of items) {
        const { error: iErr } = await supabase.from('purchase_items').insert({
          purchase_id:      purchaseId,
          product_id:       item.productId,
          product_name_raw: item.nameRaw || null,
          quantity:         item.qty,
          unit_price:       item.unitPrice,
          total_price:      item.totalPrice,
          location_id:      item.locationId,
        });
        if (iErr) throw new Error(iErr.message);

        if (item.productId) {
          const { data: existing } = await supabase.from('stock_by_location')
            .select('id, quantity').eq('product_id', item.productId).eq('location_id', item.locationId).single();
          if (existing) {
            await supabase.from('stock_by_location').update({ quantity: (existing.quantity ?? 0) + item.qty }).eq('id', existing.id);
          } else {
            await supabase.from('stock_by_location').insert({ product_id: item.productId, location_id: item.locationId, quantity: item.qty });
          }
          await logMovement(item.productId, null, item.locationId, item.qty, 'PURCHASE_IN', 'Purchase #' + purchaseId);
        }
      }
      onSaved();
    } catch (e) {
      onError('Error: ' + (e instanceof Error ? e.message : 'Unknown'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <motion.div key="pbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div key="pmd" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[95vh] overflow-y-auto"
      >
        <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
        <h3 className="text-base font-bold text-slate-100 mb-4">
          {step === 1 ? 'New Purchase' : 'Review Items'}
        </h3>

        {step === 1 && (
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Supplier</label>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40">
                <option value="">— Select supplier (optional) —</option>
                {suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Purchase Date</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40" />
            </div>

            <div>
              <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Upload Bill Photo (optional)</label>
              {imageThumb ? (
                <div className="flex items-center gap-3 bg-surface2 border border-white/8 rounded-xl p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageThumb} alt="bill" className="w-14 h-14 object-cover rounded-lg border border-white/8 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-100">Bill uploaded</div>
                    <div className="text-xs text-success mt-0.5">✓ Ready to scan</div>
                  </div>
                  <button onClick={() => { setImageB64(null); setImageThumb(null); }} className="text-muted hover:text-danger text-lg">✕</button>
                </div>
              ) : (
                <div
                  onClick={() => fileRef.current?.click()}
                  className="border-2 border-dashed border-white/15 rounded-xl p-6 text-center cursor-pointer hover:border-teal/30 hover:bg-teal/5 transition-all"
                >
                  <div className="text-3xl mb-2">📷</div>
                  <p className="text-xs text-muted">Tap to take photo or upload bill<br /><b>Max 10MB · JPG, PNG, PDF</b></p>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                onChange={e => e.target.files?.[0] && processFile(e.target.files[0])} />
            </div>

            {scanning && (
              <div className="flex items-center gap-2 text-teal text-sm font-semibold py-2">
                <div className="w-4 h-4 rounded-full border-2 border-teal border-t-transparent animate-spin" />
                AI is reading your bill...
              </div>
            )}

            <div className="flex gap-3 mt-2">
              <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold">Cancel</button>
              {imageB64 && !scanning && (
                <button onClick={scanBill} className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold">🔍 Scan Bill</button>
              )}
              <button onClick={() => { setItems([newBlankItem()]); setStep(2); }}
                className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100">
                {imageB64 ? 'Skip Scan →' : 'Enter Manually →'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-3">
            {ocrRaw && (
              <div>
                <button onClick={() => setShowRaw(v => !v)} className="text-xs text-muted underline mb-1">
                  {showRaw ? 'Hide' : '🔍 View'} what AI read
                </button>
                {showRaw && (
                  <pre className="bg-navy rounded-lg p-3 text-[10px] text-muted/70 font-mono max-h-28 overflow-y-auto whitespace-pre-wrap">{ocrRaw}</pre>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-300">Items ({items.length})</span>
              <button onClick={() => setItems(it => [...it, newBlankItem()])}
                className="text-xs text-teal font-bold px-3 py-1 rounded-lg bg-teal/10 border border-teal/20">+ Add Item</button>
            </div>

            {items.map(item => (
              <ScannedItemRow
                key={item.tempId}
                item={item}
                products={products}
                onChange={patch => updateItem(item.tempId, patch)}
                onRemove={() => removeItem(item.tempId)}
              />
            ))}

            <div>
              <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Total Amount (Ksh)</label>
              <input type="number" value={total} onChange={e => setTotal(e.target.value)} placeholder="0.00"
                className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40" />
            </div>
            <div>
              <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional"
                className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40" />
            </div>

            <div className="flex gap-3 mt-2">
              <button onClick={() => setStep(1)} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold">← Back</button>
              <button onClick={confirmPurchase} disabled={saving}
                className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold disabled:opacity-50">
                {saving ? 'Saving…' : '✓ Save Purchase'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </>
  );
}

function ScannedItemRow({
  item, products, onChange, onRemove,
}: {
  item: ScannedItem;
  products: Product[];
  onChange: (patch: Partial<ScannedItem>) => void;
  onRemove: () => void;
}) {
  const [pSearch,  setPSearch]  = useState(item.productName);
  const [pOpen,    setPOpen]    = useState(false);

  const matches = pSearch.length > 1
    ? products.filter(p => p.product_name.toLowerCase().includes(pSearch.toLowerCase())).slice(0, 6)
    : [];

  return (
    <div className={`rounded-xl border p-3 ${item.isNew ? 'border-gold/30 bg-gold/5' : 'border-white/8 bg-surface2'}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${item.isNew ? 'bg-gold/10 border-gold/20 text-gold' : item.productId ? 'bg-success/10 border-success/20 text-success' : 'bg-danger/10 border-danger/20 text-danger'}`}>
            {item.isNew ? 'New' : item.productId ? 'Matched' : 'Unmatched'}
          </span>
          {item.nameRaw && <span className="text-[10px] text-muted">{item.nameRaw}</span>}
        </div>
        <button onClick={onRemove} className="text-muted hover:text-danger text-sm">✕</button>
      </div>

      <div className="relative mb-2">
        <input
          value={pSearch}
          onChange={e => { setPSearch(e.target.value); setPOpen(true); onChange({ productName: e.target.value, productId: null }); }}
          onFocus={() => setPOpen(true)}
          onBlur={() => setTimeout(() => setPOpen(false), 150)}
          placeholder="Search or type product name..."
          className="w-full px-3 py-2 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40"
        />
        {pOpen && matches.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-50 bg-surface border border-white/10 rounded-lg shadow-xl max-h-36 overflow-y-auto">
            {matches.map(p => (
              <div key={p.product_id} onMouseDown={() => { onChange({ productId: p.product_id, productName: p.product_name, isNew: false }); setPSearch(p.product_name); setPOpen(false); }}
                className="px-3 py-2 text-xs text-slate-300 hover:bg-surface2 cursor-pointer border-b border-white/5 last:border-0">
                {p.product_name}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(['qty', 'unitPrice', 'totalPrice'] as const).map(field => (
          <div key={field}>
            <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">
              {field === 'qty' ? 'Qty' : field === 'unitPrice' ? 'Unit Ksh' : 'Total Ksh'}
            </label>
            <input
              type="number"
              value={item[field] ?? ''}
              onChange={e => onChange({ [field]: e.target.value ? parseFloat(e.target.value) : null } as Partial<ScannedItem>)}
              className="w-full px-2 py-1.5 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40"
            />
          </div>
        ))}
      </div>
      <div className="mt-2">
        <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">Location</label>
        <select value={item.locationId} onChange={e => onChange({ locationId: parseInt(e.target.value) })}
          className="w-full px-2 py-1.5 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40">
          <option value={2}>Back Godown</option>
          <option value={1}>Main Store</option>
        </select>
      </div>
    </div>
  );
}

export default function PurchasesPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <PurchasesDashboard />;
}
