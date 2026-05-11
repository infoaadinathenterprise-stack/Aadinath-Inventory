'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Purchase, PurchaseItem, Supplier, Product } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';
import { logMovement } from '@/lib/stockActions';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtKsh(n: number | null | undefined) {
  if (n == null) return '—';
  return 'Ksh ' + Number(n).toLocaleString('en-KE');
}

// bill_image_url stores either a JSON-stringified array (new) or a single URL
// (old). Parse defensively so old purchases still display.
function parseBillUrls(s: string | null): string[] {
  if (!s) return [];
  const t = s.trim();
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string' && u.length > 0) : [s];
    } catch { return [s]; }
  }
  return [s];
}

// ─── Auth gate ────────────────────────────────────────────────────────────────

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

// ─── Dashboard ────────────────────────────────────────────────────────────────

function PurchasesDashboard() {
  const [purchases,  setPurchases]  = useState<Purchase[]>([]);
  const [suppliers,  setSuppliers]  = useState<Supplier[]>([]);
  const [products,   setProducts]   = useState<Product[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [toast,      setToast]      = useState<ToastState | null>(null);
  const [newOpen,    setNewOpen]    = useState(false);
  const [detail,     setDetail]     = useState<{ purchase: Purchase; items: PurchaseItem[] } | null>(null);
  const [deleting,   setDeleting]   = useState(false);
  const toastId = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const [pr, sr, prd] = await Promise.all([
      supabase.from('purchases').select('*').order('created_at', { ascending: false }),
      supabase.from('suppliers').select('*').eq('active_status', true).order('supplier_name'),
      supabase.from('products').select('*').eq('active_status', true).order('product_name'),
    ]);
    if (pr.error || sr.error || prd.error) {
      const msg = (pr.error ?? sr.error ?? prd.error)!.message;
      setToast({ msg: 'Failed to load: ' + msg, type: 'error', id: ++toastId.current });
    } else {
      setPurchases((pr.data ?? []) as Purchase[]);
      setSuppliers((sr.data ?? []) as Supplier[]);
      setProducts((prd.data ?? []) as Product[]);
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

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

  async function openDetail(id: number) {
    const [pArr, items] = await Promise.all([
      supabase.from('purchases').select('*').eq('purchase_id', id),
      supabase.from('purchase_items').select('*').eq('purchase_id', id),
    ]);
    if (pArr.data?.[0]) {
      setDetail({ purchase: pArr.data[0] as Purchase, items: (items.data ?? []) as PurchaseItem[] });
    }
  }

  async function deletePurchase(data: { purchase: Purchase; items: PurchaseItem[] }) {
    const supplierLabel = supplierName(data.purchase.supplier_id);
    const totalLabel = data.purchase.total_amount != null ? `· ${fmtKsh(data.purchase.total_amount)}` : '';
    if (!window.confirm(
      `Delete this purchase?\n\n${supplierLabel} ${totalLabel}\n${data.items.length} item(s)\n\nStock added by this purchase will be subtracted back. Any products that were created by this purchase (and aren't used anywhere else) will also be removed from inventory.\n\nThis cannot be undone.`,
    )) return;

    setDeleting(true);
    try {
      // Track products that should be cleaned up after we reverse
      // stock — anything ONLY referenced by this purchase (i.e. it
      // was auto-created at save time or hasn't been re-purchased)
      // gets soft-deleted from inventory so it doesn't linger as a
      // ghost row.
      const productsToRetire: number[] = [];

      // Reverse stock for every item that hit stock_by_location at
      // save time. product_name_raw rows had no stock impact, so skip
      // those. We can't perfectly know which location was used (we
      // dropped that column earlier), so subtract from wherever the
      // item currently has at least row.qty available, preferring
      // back godown first then main store.
      for (const it of data.items) {
        if (!it.product_id || !it.quantity) continue;
        const qty = it.quantity;
        for (const locId of [2, 1] as const) {
          const { data: row } = await supabase
            .from('stock_by_location')
            .select('id, quantity')
            .eq('product_id', it.product_id)
            .eq('location_id', locId)
            .maybeSingle();
          if (!row) continue;
          const current = row.quantity ?? 0;
          if (current >= qty) {
            await supabase.from('stock_by_location').update({ quantity: current - qty }).eq('id', row.id);
            break;
          }
          // Partial — drain this row and continue with the remainder
          // on the other location.
          if (current > 0) {
            await supabase.from('stock_by_location').update({ quantity: 0 }).eq('id', row.id);
            // (Remainder of qty stays uncovered if no location has
            // enough stock; we don't go negative.)
          }
        }

        // Does this product exist OUTSIDE of this purchase? Look for
        // any purchase_items row pointing at it that isn't in this
        // purchase. If we find none, the product was effectively
        // created (or kept alive) only because of this purchase, so
        // retire it.
        const { data: otherRefs } = await supabase
          .from('purchase_items')
          .select('id')
          .eq('product_id', it.product_id)
          .neq('purchase_id', data.purchase.purchase_id)
          .limit(1);
        if (!otherRefs || otherRefs.length === 0) {
          productsToRetire.push(it.product_id);
        }
      }
      // Delete child rows first to respect FK constraints. Chain
      // .select() so Supabase returns the deleted rows — if RLS
      // silently blocks the delete, error is null but data is empty,
      // which is the most common reason a "successful" delete leaves
      // the row in the table.
      const { data: delItems, error: iErr } = await supabase
        .from('purchase_items')
        .delete()
        .eq('purchase_id', data.purchase.purchase_id)
        .select();
      if (iErr) throw new Error(iErr.message);

      const { data: delPurchase, error: pErr } = await supabase
        .from('purchases')
        .delete()
        .eq('purchase_id', data.purchase.purchase_id)
        .select();
      if (pErr) throw new Error(pErr.message);

      if (!delPurchase || delPurchase.length === 0) {
        // Most common cause: no DELETE RLS policy for anon on these
        // tables. Surface the exact SQL the user can paste into
        // Supabase to fix it.
        throw new Error(
          `Delete returned success but 0 rows were affected — Row-Level Security is blocking DELETE on 'purchases' (and probably 'purchase_items', which removed ${delItems?.length ?? 0} rows). Run this once in Supabase SQL editor:\n\n` +
          `CREATE POLICY "Allow public delete" ON purchases FOR DELETE TO anon USING (true);\n` +
          `CREATE POLICY "Allow public delete" ON purchase_items FOR DELETE TO anon USING (true);`
        );
      }

      // Retire products that only existed because of this purchase.
      // Use UPDATE active_status = false (same pattern as the
      // Inventory delete) so we don't need a DELETE policy on the
      // products table — the row drops out of every list that filters
      // by active_status. Also clear stock_by_location for these so
      // dashboard totals don't show phantom counts.
      let retired = 0;
      for (const pid of productsToRetire) {
        const { data: upd, error: upErr } = await supabase
          .from('products')
          .update({ active_status: false })
          .eq('product_id', pid)
          .select('product_id');
        if (upErr) continue; // best-effort cleanup, don't block the delete
        if (upd && upd.length > 0) {
          retired++;
          await supabase.from('stock_by_location').delete().eq('product_id', pid);
        }
      }

      setDetail(null);
      load();
      const itemsLabel = `${delItems?.length ?? 0} item${delItems?.length === 1 ? '' : 's'}`;
      const retiredLabel = retired > 0 ? ` · ${retired} product${retired === 1 ? '' : 's'} removed from inventory` : '';
      showToast(`Purchase deleted ✓ (${itemsLabel}${retiredLabel})`, 'success');
    } catch (e) {
      showToast('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown'), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="flex items-center justify-between pt-5 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Purchases</h2>
            <p className="text-xs text-muted mt-0.5">{purchases.length} records</p>
          </div>
          <button
            onClick={() => setNewOpen(true)}
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {purchases.map((p, i) => (
              <motion.div
                key={p.purchase_id}
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.02 }}
                onClick={() => openDetail(p.purchase_id)}
                className="bg-surface border border-white/8 rounded-xl p-4 cursor-pointer hover:border-teal/20 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-slate-100">{supplierName(p.supplier_id)}</div>
                  <div className="text-sm font-bold text-teal">{fmtKsh(p.total_amount)}</div>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <div className="text-xs text-muted">
                    {p.purchase_date ? fmtDate(p.purchase_date) : '—'}
                    {p.notes ? ' · ' + p.notes : ''}
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                    p.status === 'CONFIRMED'
                      ? 'bg-success/10 border-success/20 text-success'
                      : 'bg-gold/10 border-gold/20 text-gold'
                  }`}>{p.status}</span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      <AnimatePresence>
        {newOpen && (
          <NewPurchaseModal
            suppliers={suppliers}
            products={products}
            onClose={() => setNewOpen(false)}
            onSaved={() => { setNewOpen(false); load(); showToast('Purchase saved ✓', 'success'); }}
            onError={msg => showToast(msg, 'error')}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detail && (
          <DetailDrawer
            data={detail}
            supplierName={supplierName}
            productName={productName}
            onClose={() => setDetail(null)}
            onDelete={() => deletePurchase(detail)}
            deleting={deleting}
          />
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ─── Detail drawer ────────────────────────────────────────────────────────────

function DetailDrawer({
  data, supplierName, productName, onClose, onDelete, deleting,
}: {
  data: { purchase: Purchase; items: PurchaseItem[] };
  supplierName: (id: number | null) => string;
  productName:  (id: number | null, raw: string | null) => string;
  onClose:  () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const urls = parseBillUrls(data.purchase.bill_image_url);
  return (
    <>
      <motion.div key="dbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div key="dmd" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[90vh] overflow-y-auto"
      >
        <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
        <div className="bg-surface2 rounded-xl p-4 mb-4">
          <div className="font-bold text-slate-100">{supplierName(data.purchase.supplier_id)}</div>
          <div className="text-xs text-muted mt-0.5">{data.purchase.purchase_date ? fmtDate(data.purchase.purchase_date) : '—'}</div>
          {data.purchase.notes && <div className="text-xs text-muted/70 mt-1">{data.purchase.notes}</div>}
        </div>

        <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">Items ({data.items.length})</div>
        {data.items.map(item => (
          <div key={item.id} className="flex justify-between py-2.5 border-b border-white/5 text-sm">
            <div>
              <div className="font-semibold text-slate-100">{productName(item.product_id, item.product_name_raw)}</div>
              <div className="text-xs text-muted">
                Qty: {item.quantity}{item.unit_price ? ` · ${fmtKsh(item.unit_price)}/unit` : ''}
              </div>
            </div>
            {item.total_price && <div className="font-bold text-teal">{fmtKsh(item.total_price)}</div>}
          </div>
        ))}

        {data.purchase.total_amount != null && (
          <div className="flex justify-between pt-3 font-bold text-base">
            <span className="text-slate-100">Total</span>
            <span className="text-teal">{fmtKsh(data.purchase.total_amount)}</span>
          </div>
        )}

        {urls.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">
              Bill Image{urls.length > 1 ? `s (${urls.length})` : ''}
            </div>
            <div className="flex flex-col gap-2">
              {urls.map((url, i) => (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img key={i} src={url} alt={`Bill ${i + 1}`} className="w-full rounded-xl border border-white/8" />
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            disabled={deleting}
            className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100 transition-colors disabled:opacity-50"
          >Close</button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="px-4 py-2.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-sm font-bold hover:bg-danger/20 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {deleting && <span className="w-3.5 h-3.5 rounded-full border-2 border-danger border-t-transparent animate-spin" />}
            🗑 Delete
          </button>
        </div>
        <p className="text-[10px] text-muted/70 text-center mt-2 leading-relaxed">
          Deleting reverses the stock that this purchase added.
        </p>
      </motion.div>
    </>
  );
}

// ─── New purchase modal ───────────────────────────────────────────────────────

interface BillImage { thumb: string; b64: string; mime: string }
interface ItemRow {
  rowId:       number;
  productId:   number | null;
  productName: string;       // free-text fallback when productId is null
  qty:         number;
  unitPrice:   number | null;
  locationId:  number;       // 1 = main, 2 = back
}

// OCR.space free-tier API key — same one the previous Aadinath-Inventory
// project used. Free tier: 25k requests/month, 1MB max image. The browser
// hits this directly so Cloudflare is never in the OCR path. If you want
// to swap keys, get a new one at https://ocr.space/ocrapi/freekey.
const OCR_SPACE_KEY = 'K89615870288957';
// Use the standalone Cloudflare Worker from the previous
// Aadinath-Inventory project — it has been running in production for
// months and has CORS configured for jayaadinathenterprises.com.
// Every attempt to host the Gemini proxy as a Pages Function in this
// project (/api/gemini and /api/scan, multiple worker versions) hit
// Cloudflare-side failures we couldn't fix from code. Side-stepping
// the Pages-Function path entirely fixes the scan reliably.
const GEMINI_PROXY_URL = 'https://aadinath-proxy.info-aadinathenterprise.workers.dev/api/gemini';

function NewPurchaseModal({
  suppliers, products, onClose, onSaved, onError,
}: {
  suppliers: Supplier[];
  products:  Product[];
  onClose:   () => void;
  onSaved:   () => void;
  onError:   (msg: string) => void;
}) {
  // rowCounter must be declared BEFORE the useState that initialises
  // items — its initializer calls blankRow(), which reads
  // rowCounter.current. Otherwise we hit a TDZ ReferenceError on
  // mount and the whole page fails to load.
  const rowCounter = useRef(1);
  const fileRef = useRef<HTMLInputElement>(null);

  function blankRow(): ItemRow {
    return { rowId: rowCounter.current++, productId: null, productName: '', qty: 1, unitPrice: null, locationId: 2 };
  }

  const [supplierId, setSupplierId] = useState('');
  const [date,       setDate]       = useState(new Date().toISOString().split('T')[0]);
  const [notes,      setNotes]      = useState('');
  const [images,     setImages]     = useState<BillImage[]>([]);
  const [items,      setItems]      = useState<ItemRow[]>(() => [blankRow()]);
  const [saving,     setSaving]     = useState(false);
  const [scanning,   setScanning]   = useState(false);
  const [scanInfo,   setScanInfo]   = useState<{ msg: string; ok: boolean } | null>(null);
  // Captured per-step traces from the last scan attempt — surfaced in
  // a copyable textarea so failures are easy to share.
  const [scanLog,    setScanLog]    = useState<string>('');
  const [showLog,    setShowLog]    = useState(false);
  const [logCopied,  setLogCopied]  = useState(false);

  // Auto-computed total — always reflects current rows so the user
  // doesn't have to keep a separate field in sync.
  const computedTotal = useMemo(() => {
    let sum = 0;
    for (const r of items) {
      if (r.qty > 0 && r.unitPrice != null) sum += r.qty * r.unitPrice;
    }
    return sum;
  }, [items]);

  function processImageFile(file: File) {
    if (!file.type.startsWith('image/')) { onError('Please pick an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { onError('Image too large. Max 10MB'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new window.Image();
      img.onload = () => {
        // 900px / q=0.6 keeps a sharp thumbnail at ~250-400KB so the
        // detail page stays snappy.
        const MAX = 900;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d')?.drawImage(img, 0, 0, w, h);
        let q = 0.7;
        let du = c.toDataURL('image/jpeg', q);
        // OCR.space free tier caps at 1MB. Stay under to be safe.
        while (du.split(',')[1].length * 0.75 > 700_000 && q > 0.4) {
          q -= 0.1; du = c.toDataURL('image/jpeg', q);
        }
        setImages(prev => [...prev, { thumb: du, b64: du.split(',')[1], mime: 'image/jpeg' }]);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function updateRow(rowId: number, patch: Partial<ItemRow>) {
    setItems(rows => rows.map(r => r.rowId === rowId ? { ...r, ...patch } : r));
  }

  // Two-step scan: OCR.space (browser → their API directly) for image
  // → text, then our /api/gemini proxy (tiny text body only) for
  // text → structured JSON. Cloudflare never sees the image, so the
  // 10ms CPU budget on Pages free tier is not a concern.
  async function scanFirstBill() {
    if (images.length === 0) { onError('Upload a bill image first'); return; }
    const img = images[0];
    setScanning(true);
    setScanInfo(null);
    setLogCopied(false);

    // Per-step trace lines. Whatever happens (success or any failure),
    // this string ends up in the copyable textarea so the user can
    // share the exact wire activity.
    const traceLines: string[] = [];
    const startedAt = Date.now();
    function log(line: string) {
      traceLines.push(`[+${((Date.now() - startedAt) / 1000).toFixed(2)}s] ${line}`);
    }
    function dumpLog() {
      setScanLog(traceLines.join('\n'));
    }

    log(`User-Agent: ${navigator.userAgent}`);
    log(`Image: ${img.mime}, ~${Math.round(img.b64.length * 0.75 / 1024)}KB`);

    // Read a response as JSON, but if it's not JSON (e.g. an HTML
    // error page) surface a clear message that tells us which step
    // failed and what the body actually was. Also log the raw
    // response body so the textarea has every byte the server sent.
    async function readJsonOrFail<T>(res: Response, stepLabel: string): Promise<T> {
      const txt = await res.text();
      log(`${stepLabel} HTTP ${res.status} · X-Worker-Version=${res.headers.get('X-Worker-Version') ?? '(none)'}`);
      log(`${stepLabel} body (first 1000 chars):\n${txt.slice(0, 1000)}`);
      const head = txt.trimStart();
      if (head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
        throw new Error(`${stepLabel} returned an HTML error page (HTTP ${res.status}) instead of JSON. First 200 chars: ${head.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      try { return JSON.parse(txt) as T; }
      catch { throw new Error(`${stepLabel} returned non-JSON (HTTP ${res.status}): ${txt.slice(0, 200)}`); }
    }

    try {
      // ── Step 1: OCR ──
      const form = new FormData();
      form.append('base64Image', `data:${img.mime};base64,${img.b64}`);
      form.append('apikey', OCR_SPACE_KEY);
      form.append('language', 'eng');
      form.append('isOverlayRequired', 'false');
      form.append('detectOrientation', 'true');
      form.append('scale', 'true');
      form.append('OCREngine', '2');

      log('Calling OCR.space…');
      const ocrRes = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
      if (!ocrRes.ok && ocrRes.status >= 500) throw new Error(`OCR.space HTTP ${ocrRes.status}`);
      const ocrData = await readJsonOrFail<{
        IsErroredOnProcessing?: boolean;
        ErrorMessage?: string | string[];
        ParsedResults?: { ParsedText?: string }[];
      }>(ocrRes, 'OCR.space');
      if (ocrData.IsErroredOnProcessing) {
        const m = Array.isArray(ocrData.ErrorMessage) ? ocrData.ErrorMessage.join(' ') : ocrData.ErrorMessage;
        throw new Error('OCR error: ' + (m ?? 'unknown'));
      }
      const rawText = ocrData.ParsedResults?.[0]?.ParsedText?.trim() ?? '';
      log(`OCR extracted ${rawText.length} chars of text`);
      log(`OCR text:\n${rawText.slice(0, 1500)}`);
      if (!rawText) throw new Error('OCR returned no text — try a sharper, well-lit photo');

      // ── Step 2: Gemini parse (text-only, tiny payload) ──
      const productList = products
        .map(p => `${p.product_id}:${p.product_name}`)
        .join(', ')
        .substring(0, 3000);
      const prompt = `You are extracting line items from a hardware/equipment shop purchase invoice (Kenya, Ksh).
For EVERY product line on the bill return:
- product_name (exact text from bill)
- quantity (integer, default 1 if missing)
- unit_price (number, no currency, default 0 if missing)
- total_price (number, no currency, default qty * unit_price)
- matched_product_id: integer ID from the list below if there is a CLEAR match, otherwise null

Also extract:
- supplier_name
- bill_total (number)
- bill_date (YYYY-MM-DD if visible)

Return ONLY a JSON object, no markdown, no commentary:
{"supplier_name":"...","bill_total":0,"bill_date":"YYYY-MM-DD","items":[{"product_name":"...","quantity":1,"unit_price":0,"total_price":0,"matched_product_id":null}]}

Existing products: ${productList}

BILL TEXT:
${rawText}`;

      log(`Calling proxy ${GEMINI_PROXY_URL} with ${prompt.length} char prompt…`);
      const aiRes = await fetch(GEMINI_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const aiData = await readJsonOrFail<{
        result?: string;
        error?: string;
        detail?: string;
        workerVersion?: string;
      }>(aiRes, 'Gemini proxy');
      if (!aiRes.ok || !aiData.result) {
        const detail = aiData.detail ? `: ${aiData.detail}` : '';
        const v = aiData.workerVersion ? ` [worker ${aiData.workerVersion}]` : '';
        throw new Error((aiData.error ?? `HTTP ${aiRes.status}`) + detail + v);
      }
      const cleaned = aiData.result.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        supplier_name?: string | null;
        bill_total?:    number | null;
        bill_date?:     string | null;
        items?: { product_name: string; quantity: number; unit_price: number | null; total_price: number | null; matched_product_id: number | null }[];
      };

      // ── Apply to form ──
      if (parsed.bill_date) setDate(parsed.bill_date);
      if (parsed.supplier_name) {
        const needle = parsed.supplier_name.toLowerCase();
        const supMatch = suppliers.find(s =>
          s.supplier_name.toLowerCase().includes(needle.substring(0, 5)) ||
          needle.includes(s.supplier_name.toLowerCase().substring(0, 5)),
        );
        if (supMatch) setSupplierId(String(supMatch.supplier_id));
      }
      const newRows: ItemRow[] = (parsed.items ?? []).map(it => ({
        rowId:       rowCounter.current++,
        productId:   it.matched_product_id ?? null,
        productName: it.matched_product_id
          ? (products.find(p => p.product_id === it.matched_product_id)?.product_name ?? it.product_name)
          : it.product_name,
        qty:         Math.max(1, Math.round(it.quantity || 1)),
        unitPrice:   it.unit_price ?? null,
        locationId:  2,
      }));
      log(`Parsed ${newRows.length} item(s) from Gemini`);
      if (newRows.length === 0) {
        setScanInfo({ msg: 'AI returned 0 items — check the OCR result and add rows manually.', ok: false });
      } else {
        setItems(newRows);
        // Replace any prior banner (including stale red ones from
        // earlier failed attempts) with a fresh success message.
        setScanInfo({ msg: `Added ${newRows.length} line item${newRows.length > 1 ? 's' : ''} from bill — review before saving.`, ok: true });
      }
      dumpLog();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      log(`ERROR: ${msg}`);
      setScanInfo({ msg, ok: false });
      setShowLog(true); // auto-open the trace on failure
      dumpLog();
      onError('Scan failed: ' + msg);
    } finally {
      setScanning(false);
    }
  }

  async function copyScanLog() {
    try {
      await navigator.clipboard.writeText(scanLog);
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 2000);
    } catch {
      onError('Could not copy — long-press the textarea and copy manually.');
    }
  }

  // Sends a tiny prompt to the Gemini proxy so we can confirm the
  // end-to-end pipeline (CORS, worker, Gemini, response shape) works
  // before burning OCR quota or interpreting bill text.
  async function pingWorker() {
    setScanning(true);
    setScanInfo(null);
    setLogCopied(false);
    const lines: string[] = [];
    const t0 = Date.now();
    const log = (s: string) => lines.push(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`);
    try {
      const tinyPrompt = 'Reply with the exact JSON string {"ok":true,"echo":"ping"}';
      log(`POST ${GEMINI_PROXY_URL}`);
      log(`Body: { prompt: ${JSON.stringify(tinyPrompt)} }`);
      const res = await fetch(GEMINI_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: tinyPrompt }),
      });
      const txt = await res.text();
      log(`HTTP ${res.status}`);
      log(`Body: ${txt.slice(0, 500)}`);
      if (txt.trimStart().startsWith('<')) {
        setScanInfo({ msg: `Worker UNREACHABLE — got HTML page (HTTP ${res.status}). Either the proxy URL is wrong or CORS is blocking it.`, ok: false });
      } else {
        try {
          const data = JSON.parse(txt) as { result?: string; error?: string; detail?: string };
          if (res.ok && data.result) {
            setScanInfo({ msg: `Proxy + Gemini are alive. Gemini said: ${data.result.slice(0, 100)}`, ok: true });
          } else {
            setScanInfo({ msg: data.error ? `${data.error}${data.detail ? ': ' + data.detail : ''}` : `Unexpected payload: ${txt.slice(0, 200)}`, ok: false });
          }
        } catch {
          setScanInfo({ msg: `Worker non-JSON: ${txt.slice(0, 200)}`, ok: false });
        }
      }
    } catch (e) {
      log(`ERROR ${e instanceof Error ? e.message : String(e)}`);
      setScanInfo({ msg: 'Network error pinging worker (CORS or DNS): ' + (e instanceof Error ? e.message : 'unknown'), ok: false });
    } finally {
      setScanLog(lines.join('\n'));
      setShowLog(true);
      setScanning(false);
    }
  }

  async function save() {
    const validRows = items.filter(r => (r.productId || r.productName.trim()) && r.qty > 0);
    if (validRows.length === 0) { onError('Add at least one item with quantity'); return; }
    setSaving(true);
    try {
      const billField = images.length > 0 ? JSON.stringify(images.map(i => i.thumb)) : null;
      const { data: pArr, error: pErr } = await supabase.from('purchases').insert({
        supplier_id:    supplierId ? parseInt(supplierId) : null,
        purchase_date:  date || null,
        total_amount:   computedTotal > 0 ? computedTotal : null,
        notes:          notes.trim() || null,
        status:         'CONFIRMED',
        bill_image_url: billField,
      }).select();
      if (pErr || !pArr?.[0]) throw new Error(pErr?.message ?? 'Failed to save purchase');
      const purchaseId = (pArr[0] as Purchase).purchase_id;

      let createdProducts = 0;
      let stockedRows     = 0;

      for (const row of validRows) {
        // ── Auto-create a product for unmatched rows ──────────────
        // Previously rows with no productId were saved to
        // purchase_items as text-only (product_name_raw) and the
        // entire stock + movement block below was skipped, so the
        // purchase visibly existed but nothing landed in inventory.
        // Now we create a minimal products row first and use its id
        // for the rest of the loop. The user can edit/enrich the new
        // product later from the Inventory page.
        let productId = row.productId;
        if (!productId && row.productName.trim()) {
          const { data: newProd, error: createErr } = await supabase
            .from('products')
            .insert({
              product_name:    row.productName.trim(),
              type:            'Bill Import',
              unit_of_measure: 'Piece',
              unit_type:       'piece',
              buying_price:    row.unitPrice,
              reorder_level:   0,
              active_status:   true,
            })
            .select('product_id')
            .single();
          if (createErr || !newProd) {
            throw new Error(`Could not create product "${row.productName.trim()}": ${createErr?.message ?? 'no row returned'}`);
          }
          productId = (newProd as { product_id: number }).product_id;
          createdProducts++;
        }

        const totalPrice = row.unitPrice != null ? row.qty * row.unitPrice : null;
        const { error: iErr } = await supabase.from('purchase_items').insert({
          purchase_id:      purchaseId,
          product_id:       productId,
          product_name_raw: productId ? null : row.productName.trim(),
          quantity:         row.qty,
          unit_price:       row.unitPrice,
          total_price:      totalPrice,
        });
        if (iErr) throw new Error(iErr.message);

        if (productId) {
          const { data: existing } = await supabase
            .from('stock_by_location').select('id, quantity')
            .eq('product_id', productId).eq('location_id', row.locationId).maybeSingle();
          if (existing) {
            await supabase.from('stock_by_location').update({ quantity: (existing.quantity ?? 0) + row.qty }).eq('id', existing.id);
          } else {
            await supabase.from('stock_by_location').insert({ product_id: productId, location_id: row.locationId, quantity: row.qty });
          }
          await logMovement(productId, null, row.locationId, row.qty, 'PURCHASE_IN', `Purchase #${purchaseId}`);
          stockedRows++;
        }
      }

      const summary =
        `Saved purchase #${purchaseId}` +
        (createdProducts > 0 ? ` · ${createdProducts} new product${createdProducts === 1 ? '' : 's'} created` : '') +
        ` · ${stockedRows} stock entry${stockedRows === 1 ? '' : 'ies'} updated`;
      console.log(summary);
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
        <h3 className="text-base font-bold text-slate-100 mb-4">New Purchase</h3>

        <div className="flex flex-col gap-3">
          {/* Supplier */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Supplier</label>
            <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40">
              <option value="">— Select supplier (optional) —</option>
              {suppliers.map(s => <option key={s.supplier_id} value={s.supplier_id}>{s.supplier_name}</option>)}
            </select>
          </div>

          {/* Date */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Purchase Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40" />
          </div>

          {/* Bill images (optional, no AI scan) */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">
              Bill Photos (optional) {images.length > 0 ? `· ${images.length}` : ''}
            </label>
            {images.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-2">
                {images.map((img, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-white/8 bg-surface2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.thumb} alt={`bill ${i + 1}`} className="w-full h-full object-cover" />
                    <button
                      onClick={() => setImages(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs font-bold flex items-center justify-center hover:bg-danger"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
            <div
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-white/15 rounded-xl p-4 text-center cursor-pointer hover:border-teal/30 hover:bg-teal/5 transition-all"
            >
              <div className="text-2xl mb-1">{images.length > 0 ? '➕' : '📷'}</div>
              <p className="text-xs text-muted">
                {images.length > 0 ? 'Add another photo' : 'Tap to attach a bill photo'}
                <br /><b>Stored only · Max 10MB · JPG, PNG</b>
              </p>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { if (e.target.files?.[0]) processImageFile(e.target.files[0]); e.target.value = ''; }} />

            <div className="mt-2 flex gap-2">
              {images.length > 0 && (
                <button
                  onClick={scanFirstBill}
                  disabled={scanning}
                  className="flex-1 py-2.5 rounded-xl bg-gold/10 border border-gold/30 text-gold text-xs font-bold hover:bg-gold/20 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {scanning ? (
                    <>
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-gold border-t-transparent animate-spin" />
                      Reading bill…
                    </>
                  ) : (
                    <>🤖 Auto-fill from first photo</>
                  )}
                </button>
              )}
              <button
                onClick={pingWorker}
                disabled={scanning}
                className="px-3 py-2.5 rounded-xl bg-surface2 border border-white/10 text-muted text-xs font-bold hover:text-slate-100 hover:border-teal/30 transition-all disabled:opacity-50"
                title="Ping the worker without using Gemini"
              >
                🩺 Test
              </button>
            </div>

            {scanInfo && (
              <div className={`mt-2 px-3 py-2 rounded-lg text-xs font-semibold border ${
                scanInfo.ok
                  ? 'bg-success/10 border-success/30 text-success'
                  : 'bg-danger/10 border-danger/30 text-danger break-words'
              }`}>
                {scanInfo.ok ? '✓ ' : '✕ '}{scanInfo.msg}
              </div>
            )}

            {scanLog && (
              <div className="mt-2 rounded-lg bg-surface2 border border-white/8 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/8">
                  <button
                    onClick={() => setShowLog(s => !s)}
                    className="text-[11px] font-bold text-muted hover:text-slate-100 transition-colors"
                  >
                    {showLog ? '▾' : '▸'} Scan trace ({scanLog.length} chars)
                  </button>
                  <button
                    onClick={copyScanLog}
                    className={`text-[11px] font-bold px-3 py-1 rounded-md border transition-all ${
                      logCopied
                        ? 'bg-success/10 border-success/30 text-success'
                        : 'bg-teal/10 border-teal/30 text-teal hover:bg-teal/20'
                    }`}
                  >
                    {logCopied ? '✓ Copied' : '📋 Copy all'}
                  </button>
                </div>
                {showLog && (
                  <textarea
                    readOnly
                    value={scanLog}
                    onClick={e => (e.target as HTMLTextAreaElement).select()}
                    className="w-full h-64 px-3 py-2 bg-navy text-[10px] font-mono text-slate-300 outline-none resize-y"
                  />
                )}
              </div>
            )}
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-muted uppercase tracking-widest">Items</span>
              <button
                onClick={() => setItems(r => [...r, blankRow()])}
                className="text-[11px] font-bold text-teal px-3 py-1 rounded-lg bg-teal/10 border border-teal/20 hover:bg-teal/20 transition-colors"
              >+ Add Item</button>
            </div>
            <div className="flex flex-col gap-2">
              {items.map((row, idx) => (
                <ItemRowEditor
                  key={row.rowId}
                  row={row}
                  index={idx}
                  products={products}
                  onChange={patch => updateRow(row.rowId, patch)}
                  onRemove={items.length > 1 ? () => setItems(rs => rs.filter(r => r.rowId !== row.rowId)) : undefined}
                />
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional"
              className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40" />
          </div>

          {/* Computed total */}
          <div className="flex items-center justify-between bg-surface2 border border-white/8 rounded-xl px-4 py-3">
            <span className="text-xs font-bold text-muted uppercase tracking-widest">Total</span>
            <span className="text-base font-bold text-teal tabular-nums">{fmtKsh(computedTotal)}</span>
          </div>

          {/* Actions */}
          <div className="flex gap-3 mt-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100">Cancel</button>
            <button onClick={save} disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold disabled:opacity-50">
              {saving ? 'Saving…' : '✓ Save Purchase'}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
}

// ─── Item row editor ──────────────────────────────────────────────────────────

function ItemRowEditor({
  row, index, products, onChange, onRemove,
}: {
  row:      ItemRow;
  index:    number;
  products: Product[];
  onChange: (patch: Partial<ItemRow>) => void;
  onRemove: (() => void) | undefined;
}) {
  const [search, setSearch] = useState(row.productName);
  const [open,   setOpen]   = useState(false);

  // Keep local search box in sync if parent overwrites the row (e.g.
  // after picking a product elsewhere).
  useEffect(() => { setSearch(row.productName); }, [row.productName]);

  const matches = useMemo(() => {
    if (search.trim().length < 1) return [];
    const q = search.toLowerCase();
    return products.filter(p =>
      p.product_name.toLowerCase().includes(q) ||
      (p.stock_keeping_unit ?? '').toLowerCase().includes(q),
    ).slice(0, 6);
  }, [search, products]);

  const lineTotal = row.unitPrice != null ? row.qty * row.unitPrice : null;
  const matched = row.productId != null;

  return (
    <div className={`rounded-xl border p-3 ${matched ? 'border-success/20 bg-success/5' : 'border-white/8 bg-surface2'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold text-muted uppercase tracking-widest">
          #{index + 1} {matched ? '· Matched' : (row.productName.trim() ? '· New product' : '')}
        </span>
        {onRemove && (
          <button onClick={onRemove} className="text-muted hover:text-danger text-sm transition-colors">✕</button>
        )}
      </div>

      {/* Product autocomplete */}
      <div className="relative mb-2">
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setOpen(true); onChange({ productId: null, productName: e.target.value }); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Product name or SKU…"
          className="w-full px-3 py-2 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40"
        />
        {open && matches.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-surface border border-white/10 rounded-lg shadow-xl max-h-40 overflow-y-auto">
            {matches.map(p => (
              <div
                key={p.product_id}
                onMouseDown={() => {
                  setSearch(p.product_name);
                  setOpen(false);
                  onChange({
                    productId:   p.product_id,
                    productName: p.product_name,
                    unitPrice:   row.unitPrice ?? p.buying_price ?? null,
                  });
                }}
                className="px-3 py-2 text-xs text-slate-300 hover:bg-surface2 cursor-pointer border-b border-white/5 last:border-0"
              >
                <div className="font-semibold text-slate-100">{p.product_name}</div>
                <div className="text-[10px] text-muted">
                  {p.stock_keeping_unit || 'No SKU'}{p.buying_price ? ` · last buy ${fmtKsh(p.buying_price)}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* qty / unit / total */}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div>
          <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">Qty</label>
          <input
            type="number" min={1} value={row.qty}
            onChange={e => onChange({ qty: Math.max(1, parseInt(e.target.value) || 1) })}
            className="w-full px-2 py-1.5 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40"
          />
        </div>
        <div>
          <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">Unit Price (Ksh)</label>
          <input
            type="number" min={0} step="0.01" value={row.unitPrice ?? ''}
            placeholder="0.00"
            onChange={e => onChange({ unitPrice: e.target.value ? parseFloat(e.target.value) : null })}
            className="w-full px-2 py-1.5 rounded-lg bg-surface border border-white/8 text-slate-100 text-xs outline-none focus:border-teal/40"
          />
        </div>
        <div>
          <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">Line</label>
          <div className="px-2 py-1.5 rounded-lg bg-surface border border-white/8 text-teal text-xs font-bold tabular-nums min-w-20 text-right">
            {lineTotal != null ? Number(lineTotal).toLocaleString('en-KE') : '—'}
          </div>
        </div>
      </div>

      {/* Location */}
      <div className="mt-2">
        <label className="text-[9px] font-bold text-muted uppercase block mb-0.5">Goes to</label>
        <div className="flex gap-1.5">
          {([[2, '🏭 Back Godown'], [1, '🏪 Main Store']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => onChange({ locationId: id })}
              className={`flex-1 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${
                row.locationId === id
                  ? 'border-teal bg-teal/10 text-teal'
                  : 'border-white/8 bg-surface text-muted hover:border-white/20'
              }`}
            >{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
