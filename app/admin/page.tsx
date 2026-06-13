'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Product, UserRole, StockMap } from '@/lib/types';
import { SESSION_KEY, USER_KEY, ROLE_KEY } from '@/lib/types';
import { useProductComponents } from '@/lib/hooks/useProductComponents';
import { useProducts } from '@/lib/hooks/useProducts';
import { logMovement } from '@/lib/stockActions';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import AdminNavbar      from './components/AdminNavbar';
import ProductList      from './components/ProductList';
import AdjustStockModal from './components/AdjustStockModal';
import Toast, { type ToastState } from './components/Toast';

const PASS = process.env.NEXT_PUBLIC_ADMIN_PASSWORD ?? 'admin123';

interface ModalState {
  product:    Product;
  direction:  'plus' | 'minus';
  locationId: number;
}

interface ProductForm {
  product_name:      string;
  type:              string;
  brand:             string;
  model:             string;
  stock_keeping_unit:string;
  unit_of_measure:   string;
  unit_type:         'piece' | 'box';
  pieces_per_box:    string;
  display_unit:      string;
  buying_price:      string;
  selling_price:     string;
  box_selling_price: string;
  reorder_level:     string;
  location:          '' | '1' | '2' | 'both';
  stock_back:        string;
  stock_main:        string;
}

const EMPTY_FORM: ProductForm = {
  product_name: '', type: '', brand: '', model: '',
  stock_keeping_unit: '', unit_of_measure: 'Piece',
  unit_type: 'piece', pieces_per_box: '', display_unit: '',
  buying_price: '', selling_price: '',
  box_selling_price: '', reorder_level: '0',
  location: '', stock_back: '0', stock_main: '0',
};

function generateSKU(type: string, brand: string, existing: Product[], forProductId?: number): string {
  if (!type && !brand) return '';
  // When editing, use the row's actual product_id so the SKU is
  // stable per product and never collides with maxId+1 of another
  // edit-in-progress with the same type/brand. For new products
  // we don't know the id yet, so maxId+1 is the best estimate.
  const id = forProductId ?? (existing.length > 0 ? Math.max(...existing.map(p => p.product_id)) + 1 : 1);
  const clean = (s: string, len: number) => s.replace(/[ -]/g, '').slice(0, len).toUpperCase();
  return String(id).padStart(4, '0') + '-' + clean(type, 3) + clean(brand, 4);
}

// Extract a human-readable message out of whatever the catch block
// caught — JS Errors, PostgrestError-shaped objects from Supabase
// (which have .message, .details, .hint, .code), plain strings, etc.
// String(err) on a Supabase error gives "[object Object]" which is
// what the user kept seeing.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const obj = e as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [obj.message, obj.details, obj.hint, obj.code ? `(${obj.code})` : null].filter(Boolean);
    if (parts.length) return parts.join(' · ');
    try { return JSON.stringify(e); } catch { /* circular, fall through */ }
  }
  return String(e);
}

// loadData() removed — Dashboard now uses useProducts() hook directly.

// ── Login form ────────────────────────────────────────────────────────────────

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [pin,      setPin]      = useState('');
  const [loading,  setLoading]  = useState(false);
  const [shake,    setShake]    = useState(false);
  const [err,      setErr]      = useState('');
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const u = username.trim();
    const p = pin.trim();
    if (!u || !p) { setErr('Enter username and PIN'); return; }

    setLoading(true);
    setErr('');
    try {
      // 1. Check app_users table — match by email or full_name + PIN
      const { data: allUsers } = await supabase
        .from('app_users')
        .select('full_name, role, active_status, email')
        .eq('pin', p)
        .eq('active_status', true);

      const loginId = u.toLowerCase();
      const appUser = (allUsers ?? []).find(
        row => row.email?.toLowerCase() === loginId
            || row.full_name.toLowerCase() === loginId,
      );

      if (appUser) {
        localStorage.setItem(SESSION_KEY, '1');
        localStorage.setItem(USER_KEY,    appUser.full_name);
        localStorage.setItem(ROLE_KEY,    appUser.role);
        onSuccess();
        return;
      }

      // 2. Legacy fallback: env-var admin password (backward compat)
      if (p === PASS) {
        localStorage.setItem(SESSION_KEY, '1');
        localStorage.setItem(USER_KEY,    u || 'Admin');
        localStorage.setItem(ROLE_KEY,    'admin');
        onSuccess();
        return;
      }

      // Wrong credentials
      setErr('Incorrect username or PIN');
      setShake(true);
      setPin('');
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[34rem] h-[34rem] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.08), transparent 65%)' }} />
        <div className="absolute bottom-1/4 left-1/4 w-72 h-72 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(243,185,77,0.06), transparent 65%)' }} />
      </div>
      <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="relative w-full max-w-sm">
        <motion.form
          onSubmit={submit}
          animate={shake ? { x: [0, -8, 8, -8, 8, 0] } : { x: 0 }}
          transition={shake ? { duration: 0.4 } : {}}
          className="card-lux rounded-3xl p-8 shadow-2xl"
        >
          <div className="text-center mb-9">
            <span
              className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center text-white font-extrabold text-lg shadow-[0_8px_24px_rgba(56,189,248,0.35)]"
              style={{ background: 'linear-gradient(135deg, #38bdf8 0%, #2563eb 100%)', fontFamily: 'var(--font-display)' }}
            >
              JA
            </span>
            <p className="font-extrabold text-2xl text-slate-100 tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              Jay Aadinath
            </p>
            <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-gold/12 border border-gold/30 text-gold uppercase tracking-[0.16em] mt-2 inline-block">Staff Panel</span>
          </div>
          <p className="text-xs font-bold text-muted uppercase tracking-widest mb-1.5">Username</p>
          <input
            ref={userRef} type="text" value={username}
            onChange={e => { setUsername(e.target.value); setErr(''); }}
            placeholder="Enter your username"
            autoComplete="username"
            className="w-full px-4 py-3 rounded-xl bg-black/25 border border-white/10 text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/50 focus:ring-2 focus:ring-teal/15 transition-all mb-4 text-sm"
          />
          <p className="text-xs font-bold text-muted uppercase tracking-widest mb-1.5">PIN / Password</p>
          <input
            type="password" value={pin}
            onChange={e => { setPin(e.target.value); setErr(''); }}
            placeholder="Enter your PIN or password"
            autoComplete="current-password"
            className="w-full px-4 py-3 rounded-xl bg-black/25 border border-white/10 text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/50 focus:ring-2 focus:ring-teal/15 transition-all mb-2 text-sm"
          />
          <AnimatePresence>
            {err && (
              <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xs text-danger mb-3">{err}</motion.p>
            )}
          </AnimatePresence>
          <button type="submit" disabled={loading} className="btn-primary w-full py-3.5 mt-3 rounded-xl text-sm font-bold disabled:opacity-60 flex items-center justify-center gap-2">
            {loading && <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />}
            Sign In
          </button>
        </motion.form>
      </motion.div>
    </div>
  );
}

// ── Add/Edit Product Modal ────────────────────────────────────────────────────

function ProductModal({
  editing, products, locations, stockByLoc, boxByLoc,
  onClose, onSaved, onError,
}: {
  editing:      Product | null;
  products:     Product[];
  locations:    LocationInfo[];
  stockByLoc:   StockByLoc;
  boxByLoc:     StockByLoc;
  onClose:  () => void;
  onSaved:  (msg: string) => void;
  onError:  (msg: string) => void;
}) {
  type CompEntry = { component_id: number; component_product_id: number; quantity: number; name: string; choice_group: string | null };

  const [form,   setForm]   = useState<ProductForm>(() => {
    if (!editing) return EMPTY_FORM;
    return {
      product_name:      editing.product_name,
      type:              editing.type        ?? '',
      brand:             editing.brand       ?? '',
      model:             editing.model       ?? '',
      stock_keeping_unit: editing.stock_keeping_unit ?? '',
      unit_of_measure:   editing.unit_of_measure   ?? 'Piece',
      unit_type:         (editing.unit_type === 'box' ? 'box' : 'piece') as 'piece' | 'box',
      pieces_per_box:    editing.pieces_per_box != null ? String(editing.pieces_per_box) : '',
      display_unit:      editing.display_unit ?? '',
      buying_price:      editing.buying_price  != null ? String(editing.buying_price)  : '',
      selling_price:     editing.selling_price != null ? String(editing.selling_price) : '',
      box_selling_price: editing.box_selling_price != null ? String(editing.box_selling_price) : '',
      reorder_level:     String(editing.reorder_level ?? 0),
      location:          '', stock_back: '0', stock_main: '0',  // legacy fields, unused
    };
  });

  // Per-location stock, keyed by real location_id. When EDITING, the
  // value shown is the TOTAL piece count (loose + boxes×ppb) so it
  // matches what the inventory card displays — e.g. 1 box + 27 pcs at
  // ppb 40 shows as 67, not 27. When creating a box product, the input
  // is in boxes (legacy behavior, hint shows the piece conversion).
  const [locStock, setLocStock] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    const editPpb = editing?.pieces_per_box ?? 0;
    for (const loc of locations) {
      const q = editing ? (stockByLoc[loc.location_id]?.[editing.product_id] ?? 0) : 0;
      const b = editing ? (boxByLoc[loc.location_id]?.[editing.product_id]   ?? 0) : 0;
      init[loc.location_id] = String(q + b * (editPpb > 0 ? editPpb : 0));
    }
    return init;
  });
  // Snapshot of how many whole boxes each location held when the modal
  // opened — used to preserve the box/loose split when saving totals.
  const [initBoxes] = useState<Record<number, number>>(() => {
    const m: Record<number, number> = {};
    for (const loc of locations) {
      m[loc.location_id] = editing ? (boxByLoc[loc.location_id]?.[editing.product_id] ?? 0) : 0;
    }
    return m;
  });
  function setLocQty(locId: number, value: string) {
    setLocStock(prev => ({ ...prev, [locId]: value }));
  }

  const [saving,       setSaving]       = useState(false);
  const [compList,     setCompList]     = useState<CompEntry[]>([]);
  const [compSearch,   setCompSearch]   = useState('');
  const [compOpen,     setCompOpen]     = useState(false);
  const [selectedComp, setSelectedComp] = useState<Product | null>(null);
  const [compQty,      setCompQty]      = useState(1);
  const [compGroup,    setCompGroup]    = useState('');
  const [imageUrl,     setImageUrl]     = useState<string | null>(editing?.image_url ?? null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Captures whether the product had a real SKU at the moment the
  // modal opened. We use this — not the live form value — to decide
  // whether to keep the SKU stable or regenerate on each keystroke.
  // Looking at the live value broke after the first keystroke because
  // the freshly-generated partial SKU made the field non-empty and
  // froze further updates.
  const originallyHadSku = useRef<boolean>(!!editing?.stock_keeping_unit?.trim());

  function processImageFile(file: File) {
    if (!file.type.startsWith('image/')) { onError('Please pick an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { onError('Image too large. Max 10MB'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new window.Image();
      img.onload = () => {
        // Product cards render at ~square aspect; 600px max edge gives sharp
        // results at 2x density without bloating the row.
        const MAX = 600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
        let q = 0.75;
        let du = canvas.toDataURL('image/jpeg', q);
        while (du.split(',')[1].length * 0.75 > 250_000 && q > 0.4) {
          q -= 0.1;
          du = canvas.toDataURL('image/jpeg', q);
        }
        setImageUrl(du);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  const isBox = form.unit_type === 'box';
  const ppb   = parseInt(form.pieces_per_box) || 0;

  function autoSKU(f: ProductForm) {
    // Keep an existing SKU stable across edits (so printed barcodes
    // don't break). But if the product had no SKU at all when we
    // opened the modal (e.g. it was auto-created by the bill scan),
    // regenerate live every time type or brand changes — even after
    // the first keystroke produces a partial result. When editing,
    // base the prefix on the row's real product_id so we don't
    // collide with the next-to-be-created product's predicted id.
    if (originallyHadSku.current) return f.stock_keeping_unit;
    return generateSKU(f.type, f.brand, products, editing?.product_id);
  }

  function set(key: keyof ProductForm, value: string) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'type' || key === 'brand') next.stock_keeping_unit = autoSKU({ ...next, [key]: value });
      return next;
    });
  }

  useEffect(() => {
    if (!editing) return;
    supabase
      .from('product_components')
      .select('component_id, component_product_id, quantity, choice_group')
      .eq('product_id', editing.product_id)
      .then(({ data, error }) => {
        if (error) { console.error('components fetch error:', error.message); return; }
        setCompList((data ?? []).map(c => ({
          component_id: c.component_id,
          component_product_id: c.component_product_id,
          quantity: c.quantity,
          name: products.find(p => p.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`,
          choice_group: (c as { choice_group?: string | null }).choice_group ?? null,
        })));
      });
  }, [editing, products]);

  async function refreshComps(productId: number) {
    const { data } = await supabase
      .from('product_components')
      .select('component_id, component_product_id, quantity, choice_group')
      .eq('product_id', productId);
    setCompList((data ?? []).map(c => ({
      component_id: c.component_id,
      component_product_id: c.component_product_id,
      quantity: c.quantity,
      name: products.find(p => p.product_id === c.component_product_id)?.product_name ?? `#${c.component_product_id}`,
      choice_group: (c as { choice_group?: string | null }).choice_group ?? null,
    })));
  }

  async function addComponent() {
    if (!selectedComp || !editing) return;
    const { error } = await supabase.from('product_components').insert({
      product_id: editing.product_id,
      component_product_id: selectedComp.product_id,
      quantity: compQty,
      choice_group: compGroup.trim() || null,
    });
    if (error) { onError('Failed to add component: ' + error.message); return; }
    await refreshComps(editing.product_id);
    setSelectedComp(null);
    setCompSearch('');
    setCompQty(1);
    // keep compGroup so adding several alternatives in a row is fast
  }

  async function deleteComponent(componentId: number) {
    const { error } = await supabase.from('product_components').delete().eq('component_id', componentId);
    if (error) { onError('Failed to remove component: ' + error.message); return; }
    setCompList(prev => prev.filter(c => c.component_id !== componentId));
  }

  async function save() {
    if (!form.product_name.trim()) { onError('Product name is required'); return; }
    setSaving(true);

    const payload: Record<string, unknown> = {
      product_name:       form.product_name.trim(),
      type:               form.type.trim()  || null,
      brand:              form.brand.trim() || null,
      model:              form.model.trim() || null,
      stock_keeping_unit: form.stock_keeping_unit.trim() || null,
      unit_of_measure:    form.unit_of_measure.trim() || 'Piece',
      unit_type:          form.unit_type,
      pieces_per_box:     isBox ? (parseInt(form.pieces_per_box) || 1) : null,
      display_unit:       isBox ? (form.display_unit.trim() || null) : null,
      buying_price:       form.buying_price.trim()  !== '' ? (parseFloat(form.buying_price)  || null) : null,
      selling_price:      form.selling_price.trim() !== '' ? (parseFloat(form.selling_price) || null) : null,
      box_selling_price:  isBox ? (parseFloat(form.box_selling_price) || null) : null,
      reorder_level:      parseInt(form.reorder_level) || 0,
      active_status:      true,
      image_url:          imageUrl,
    };

    try {
      let productId: number;
      if (editing) {
        const { error } = await supabase.from('products').update(payload).eq('product_id', editing.product_id);
        if (error) throw error;
        productId = editing.product_id;
      } else {
        const { data, error } = await supabase.from('products').insert(payload).select('product_id').single();
        if (error || !data) throw error ?? new Error('No product returned');
        productId = (data as { product_id: number }).product_id;
      }

      // Write stock for every location. The form value is the TOTAL
      // piece count when editing (boxes input when creating a box
      // product). We compare totals against totals — the old code
      // compared against loose `quantity` only, which double-counted
      // box stock (e.g. 1 box + 27 pcs at ppb 40 showed as 27, and
      // typing 67 would have created 67 loose + 1 box = 107).
      const formPpb = isBox ? (parseInt(form.pieces_per_box) || 0) : 0;
      // The DB's existing box counts were stored under the product's
      // PREVIOUS ppb — use that for reading old totals.
      const oldPpb = editing?.pieces_per_box ?? formPpb;

      for (const loc of locations) {
        const locId = loc.location_id;
        const input = parseInt(locStock[locId] ?? '0') || 0;
        // New box product: input is boxes → convert. Otherwise: total pieces.
        const newTotal = (!editing && formPpb > 0) ? input * formPpb : input;

        const { data: ex } = await supabase
          .from('stock_by_location').select('id, quantity, box_quantity')
          .eq('product_id', productId).eq('location_id', locId).maybeSingle();
        const oldLoose = ex?.quantity     ?? 0;
        const oldBoxes = ex?.box_quantity ?? 0;
        const oldTotal = oldLoose + oldBoxes * (oldPpb > 0 ? oldPpb : 0);

        if (!ex && newTotal === 0) continue;          // nothing to create
        if (editing && ex && newTotal === oldTotal) continue;  // unchanged

        // Decompose the total back into boxes + loose pieces. Keep as
        // many existing whole boxes as still fit so the box/loose
        // split survives an edit; new products pack into whole boxes.
        let newBoxes = 0, newLoose = newTotal;
        if (formPpb > 0) {
          newBoxes = editing
            ? Math.min(oldBoxes, Math.floor(newTotal / formPpb))
            : Math.floor(newTotal / formPpb);
          newLoose = newTotal - newBoxes * formPpb;
        }

        // logMovement FIRST — if it throws, stock is untouched (no partial writes).
        if (editing) {
          const delta = newTotal - oldTotal;
          if (delta > 0) await logMovement(productId, null, locId,  delta, 'ADJUSTMENT_IN',  'Stock adjusted via product form', { before: oldTotal, after: newTotal });
          if (delta < 0) await logMovement(productId, locId, null, -delta, 'ADJUSTMENT_OUT', 'Stock adjusted via product form', { before: oldTotal, after: newTotal });
        } else if (newTotal > 0) {
          await logMovement(productId, null, locId, newTotal, 'ADJUSTMENT_IN', 'Initial stock', { before: 0, after: newTotal });
        }

        if (ex) {
          await supabase.from('stock_by_location')
            .update({ quantity: newLoose, box_quantity: newBoxes })
            .eq('id', ex.id);
        } else {
          await supabase.from('stock_by_location')
            .insert({ product_id: productId, location_id: locId, quantity: newLoose, box_quantity: newBoxes });
        }
      }

      onSaved(editing ? 'Product updated ✓' : 'Product added ✓');
    } catch (e) {
      onError('Error: ' + errMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const acTypes  = [...new Set(products.map(p => p.type).filter(Boolean))].sort() as string[];
  const acBrands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort() as string[];
  const acUnits  = [...new Set(products.map(p => p.unit_of_measure).filter(Boolean))].sort() as string[];
  const acNames  = [...new Set(products.map(p => p.product_name).filter(Boolean))].sort() as string[];
  const acModels = [...new Set(products.map(p => p.model).filter(Boolean))].sort() as string[];

  // Detect a possible duplicate as the user types a new product name.
  // Exact (case-insensitive) match → almost certainly a duplicate.
  // Close match (one name contains the other) → likely a variant/typo.
  const nameQuery = form.product_name.trim().toLowerCase();
  const exactDup = !editing && nameQuery.length > 0
    ? products.find(p => p.product_name.trim().toLowerCase() === nameQuery)
    : undefined;
  const similarNames = !editing && nameQuery.length >= 2 && !exactDup
    ? products
        .filter(p => {
          const n = p.product_name.trim().toLowerCase();
          return n.includes(nameQuery) || nameQuery.includes(n);
        })
        .slice(0, 4)
    : [];

  return (
    <>
      <motion.div key="pbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div key="pmd" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto card-lux rounded-t-3xl p-5 pb-8 max-h-[95vh] overflow-y-auto"
      >
        <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
        <h3 className="text-base font-bold text-slate-100 mb-4">{editing ? 'Edit Product' : 'Add Product'}</h3>

        <div className="flex flex-col gap-3">
          {/* Image uploader */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Product Image (optional)</label>
            {imageUrl ? (
              <div className="flex items-center gap-3 bg-surface2 border border-white/8 rounded-xl p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl} alt="product" className="w-20 h-20 object-cover rounded-lg border border-white/10 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-100 mb-2">Image set</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => imageInputRef.current?.click()}
                      className="px-3 py-1.5 rounded-lg bg-teal/10 border border-teal/30 text-teal text-[11px] font-bold hover:bg-teal/20 transition-colors"
                    >Replace</button>
                    <button
                      type="button"
                      onClick={() => setImageUrl(null)}
                      className="px-3 py-1.5 rounded-lg bg-surface border border-white/10 text-muted text-[11px] font-bold hover:text-danger hover:border-danger/30 transition-colors"
                    >Remove</button>
                  </div>
                </div>
              </div>
            ) : (
              <div
                onClick={() => imageInputRef.current?.click()}
                className="border-2 border-dashed border-white/15 rounded-xl p-5 text-center cursor-pointer hover:border-teal/30 hover:bg-teal/5 transition-all"
              >
                <div className="text-2xl mb-1">🖼️</div>
                <p className="text-xs text-muted">Tap to upload product photo<br /><b>Max 10MB · auto-compressed</b></p>
              </div>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                if (e.target.files?.[0]) processImageFile(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Product Name *">
              <input value={form.product_name} onChange={e => set('product_name', e.target.value)} list="ac-names"
                autoComplete="off"
                placeholder="e.g. Generator 4000" className={inputCls} />
              <datalist id="ac-names">{acNames.map(n => <option key={n} value={n} />)}</datalist>
            </FormField>
            <FormField label="Type / Category *">
              <input value={form.type} onChange={e => set('type', e.target.value)} list="ac-types"
                autoComplete="off"
                placeholder="e.g. Generator" className={inputCls} />
              <datalist id="ac-types">{acTypes.map(t => <option key={t} value={t} />)}</datalist>
            </FormField>
          </div>

          {/* Duplicate / similar-name guard — only when adding a NEW product */}
          {exactDup && (
            <div className="px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-xs text-danger leading-relaxed">
              ⚠ <b>&ldquo;{exactDup.product_name}&rdquo;</b> already exists
              {exactDup.type ? ` (${exactDup.type})` : ''}. Don&rsquo;t create a duplicate —
              close this and use <b>+ / −</b> on the existing product to change its stock.
            </div>
          )}
          {similarNames.length > 0 && (
            <div className="px-3 py-2 rounded-xl bg-gold/5 border border-gold/25 text-xs text-gold/90 leading-relaxed">
              <p className="font-bold mb-1">🔎 Similar products already exist — did you mean one of these?</p>
              <div className="flex flex-col gap-1">
                {similarNames.map(p => (
                  <button
                    key={p.product_id}
                    type="button"
                    onClick={() => set('product_name', p.product_name)}
                    className="text-left px-2 py-1 rounded-lg bg-surface2 border border-white/8 text-slate-200 hover:border-gold/40 transition-colors"
                  >
                    {p.product_name}{p.brand ? ` · ${p.brand}` : ''}{p.model ? ` · ${p.model}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Brand">
              <input value={form.brand} onChange={e => set('brand', e.target.value)} list="ac-brands"
                autoComplete="off"
                placeholder="e.g. Sigma UK" className={inputCls} />
              <datalist id="ac-brands">{acBrands.map(b => <option key={b} value={b} />)}</datalist>
            </FormField>
            <FormField label="Model">
              <input value={form.model} onChange={e => set('model', e.target.value)} list="ac-models"
                autoComplete="off"
                placeholder="e.g. 4000AE" className={inputCls} />
              <datalist id="ac-models">{acModels.map(m => <option key={m} value={m} />)}</datalist>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="SKU (auto)">
              <input value={form.stock_keeping_unit} onChange={e => set('stock_keeping_unit', e.target.value)}
                placeholder="Auto from type & brand" className={`${inputCls} ${!editing ? 'opacity-60' : ''}`} readOnly={!editing} />
            </FormField>
            <FormField label="Unit of Measure">
              <input value={form.unit_of_measure} onChange={e => set('unit_of_measure', e.target.value)} list="ac-units"
                placeholder="Piece / Set / Litre" className={inputCls} />
              <datalist id="ac-units">{acUnits.map(u => <option key={u} value={u} />)}</datalist>
            </FormField>
          </div>

          <FormField label="Unit Type">
            <select value={form.unit_type} onChange={e => set('unit_type', e.target.value as 'piece' | 'box')} className={inputCls}>
              <option value="piece">Piece (individual items)</option>
              <option value="box">Box (contains multiple pieces)</option>
            </select>
          </FormField>

          {isBox && (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Pieces per Box">
                <input type="number" value={form.pieces_per_box} onChange={e => set('pieces_per_box', e.target.value)} onWheel={e => e.currentTarget.blur()} placeholder="e.g. 12" min="1" className={inputCls} />
              </FormField>
              <FormField label="Box Selling Price (Ksh)">
                <input type="number" value={form.box_selling_price} onChange={e => set('box_selling_price', e.target.value)} onWheel={e => e.currentTarget.blur()} placeholder="e.g. 480" min="0" className={inputCls} />
              </FormField>
            </div>
          )}

          {/* Pricing — per unit. Sell price is the default the POS
              will pre-fill when this product is sold; user can still
              override per sale. */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Buying Price (Ksh / unit)">
              <input type="number" value={form.buying_price} onChange={e => set('buying_price', e.target.value)} onWheel={e => e.currentTarget.blur()} placeholder="e.g. 120" min="0" step="0.01" className={inputCls} />
            </FormField>
            <FormField label="Selling Price (Ksh / unit)">
              <input type="number" value={form.selling_price} onChange={e => set('selling_price', e.target.value)} onWheel={e => e.currentTarget.blur()} placeholder="e.g. 180" min="0" step="0.01" className={inputCls} />
            </FormField>
          </div>

          <FormField label="Reorder Level">
            <input type="number" value={form.reorder_level} onChange={e => set('reorder_level', e.target.value)} onWheel={e => e.currentTarget.blur()} placeholder="0" min="0" className={inputCls} />
          </FormField>

          {/* Stock per location — one input per real location from the DB */}
          <div>
            <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-2">
              Stock by Location{isBox && ppb > 0 ? (editing ? ' (total pieces)' : ' (boxes)') : ''}
            </label>
            <div className="flex flex-col gap-2.5">
              {locations.map(loc => {
                const val = locStock[loc.location_id] ?? '0';
                const num = parseInt(val) || 0;
                // Live preview of the box/loose split that will be saved
                // (keeps existing whole boxes, breaks them only if the
                // total drops below box capacity).
                let hint: string | null = null;
                if (isBox && ppb > 0 && num > 0) {
                  if (editing) {
                    const kb = Math.min(initBoxes[loc.location_id] ?? 0, Math.floor(num / ppb));
                    const lo = num - kb * ppb;
                    hint = kb > 0
                      ? `= ${kb} box${kb === 1 ? '' : 'es'}${lo > 0 ? ` + ${lo} pcs` : ''}`
                      : `= ${lo} loose pcs`;
                  } else {
                    hint = `= ${num * ppb} pieces`;
                  }
                }
                return (
                  <div key={loc.location_id}>
                    <p className="text-xs font-semibold text-slate-300 mb-1">{loc.location_name}</p>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setLocQty(loc.location_id, String(Math.max(0, (parseInt(val) || 0) - 1)))}
                        className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">−</button>
                      <input type="number" value={val} onChange={e => setLocQty(loc.location_id, e.target.value)} onWheel={e => e.currentTarget.blur()} min="0"
                        className={`${inputCls} text-center text-lg font-bold`} />
                      <button type="button" onClick={() => setLocQty(loc.location_id, String((parseInt(val) || 0) + 1))}
                        className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">+</button>
                    </div>
                    {hint && <p className="text-xs text-teal/80 mt-1">{hint}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          {editing && (
            <div className="border-t border-white/8 pt-4">
              <p className="text-[10px] font-bold text-muted uppercase tracking-widest mb-2">🔧 Machine Components</p>
              {compList.length > 0 && (() => {
                // Render always-deducted comps first, then each choice group together.
                const always = compList.filter(c => !c.choice_group);
                const groups = new Map<string, CompEntry[]>();
                for (const c of compList) {
                  if (!c.choice_group) continue;
                  const g = c.choice_group;
                  if (!groups.has(g)) groups.set(g, []);
                  groups.get(g)!.push(c);
                }
                return (
                  <div className="flex flex-col gap-2 mb-3">
                    {always.length > 0 && (
                      <div className="flex flex-col gap-0.5 rounded-xl bg-surface2 border border-white/8 px-3 py-2">
                        {always.map(c => (
                          <div key={c.component_id} className="flex items-center justify-between py-1">
                            <span className="text-xs text-slate-300">{c.name} <span className="text-muted">× {c.quantity}/unit</span></span>
                            <button onClick={() => deleteComponent(c.component_id)} className="text-danger text-xs hover:opacity-70 ml-2 shrink-0">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {[...groups.entries()].map(([groupName, members]) => (
                      <div key={groupName} className="rounded-xl bg-gold/5 border border-gold/20 px-3 py-2">
                        <div className="text-[10px] font-bold text-gold uppercase tracking-widest mb-1">
                          Choose 1 of {members.length} · {groupName}
                        </div>
                        {members.map(c => (
                          <div key={c.component_id} className="flex items-center justify-between py-1">
                            <span className="text-xs text-slate-300">{c.name} <span className="text-muted">× {c.quantity}/unit</span></span>
                            <button onClick={() => deleteComponent(c.component_id)} className="text-danger text-xs hover:opacity-70 ml-2 shrink-0">✕</button>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })()}
              <div className="relative">
                <input
                  value={compSearch}
                  onChange={e => { setCompSearch(e.target.value); setCompOpen(true); setSelectedComp(null); }}
                  onFocus={() => setCompOpen(true)}
                  onBlur={() => setTimeout(() => setCompOpen(false), 150)}
                  placeholder="Search product to add as component..."
                  className={inputCls}
                />
                {compOpen && compSearch.length > 1 && (
                  <div className="absolute z-50 top-full left-0 right-0 bg-surface border border-white/10 rounded-xl shadow-xl max-h-40 overflow-y-auto mt-1">
                    {products
                      .filter(p => p.product_name.toLowerCase().includes(compSearch.toLowerCase()) && p.product_id !== editing.product_id)
                      .slice(0, 8)
                      .map(p => (
                        <div
                          key={p.product_id}
                          onMouseDown={() => { setSelectedComp(p); setCompSearch(p.product_name); setCompOpen(false); }}
                          className="px-3 py-2 text-xs text-slate-300 hover:bg-surface2 cursor-pointer border-b border-white/5 last:border-0"
                        >
                          {p.product_name}
                        </div>
                      ))}
                  </div>
                )}
              </div>
              {selectedComp && (
                <div className="flex flex-col gap-2 mt-2">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setCompQty(q => Math.max(1, q - 1))} className="w-8 h-8 rounded-lg bg-surface2 border border-white/10 text-slate-100 font-bold text-sm flex items-center justify-center">−</button>
                      <input
                        type="number" min={1} value={compQty}
                        onChange={e => setCompQty(Math.max(1, parseInt(e.target.value) || 1))}
                        onWheel={e => e.currentTarget.blur()}
                        className="w-14 text-center px-1 py-1.5 rounded-lg bg-surface2 border border-white/8 text-slate-100 text-sm outline-none focus:border-teal/40"
                      />
                      <button onClick={() => setCompQty(q => q + 1)} className="w-8 h-8 rounded-lg bg-surface2 border border-white/10 text-slate-100 font-bold text-sm flex items-center justify-center">+</button>
                    </div>
                    <input
                      value={compGroup}
                      onChange={e => setCompGroup(e.target.value)}
                      placeholder="Group (optional, e.g. Engine)"
                      className="flex-1 px-2 py-1.5 rounded-lg bg-surface2 border border-white/8 text-slate-100 text-xs outline-none focus:border-gold/40"
                    />
                  </div>
                  <button
                    onClick={addComponent}
                    className="w-full py-2 rounded-xl bg-teal/15 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/25 transition-colors"
                  >
                    + Add Component {compGroup.trim() ? `to "${compGroup.trim()}"` : ''}
                  </button>
                  <p className="text-[10px] text-muted/70 leading-relaxed">
                    Leave Group blank for components that are <b>always</b> deducted.
                    Use the same group name on multiple components to make them <b>alternatives</b> — at sale time the user picks one.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 mt-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100 transition-colors">Cancel</button>
            <button onClick={save} disabled={saving || !!exactDup} className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {saving ? 'Saving…' : exactDup ? 'Already exists' : editing ? 'Update Product' : 'Add Product'}
            </button>
          </div>

          {editing && (
            <div className="mt-4 pt-4 border-t border-white/8">
              <button
                onClick={() => deleteProduct(editing)}
                disabled={saving}
                className="w-full py-2.5 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs font-bold hover:bg-danger/20 transition-colors disabled:opacity-50"
              >
                🗑 Delete this product
              </button>
              <p className="text-[10px] text-muted/70 text-center mt-2 leading-relaxed">
                Hides the product from inventory and clears its stock rows. Past purchases and movement history are kept for reporting.
              </p>
            </div>
          )}
        </div>
      </motion.div>
    </>
  );

  async function deleteProduct(p: Product) {
    if (!window.confirm(`Delete "${p.product_name}"?\n\nThe product will be hidden from inventory and its stock rows will be cleared. Past purchases and history are kept. This cannot be undone.`)) return;
    setSaving(true);
    try {
      // Soft-delete the product so historical purchase_items and
      // stock movements still resolve their product_id. Then clear
      // its stock rows so totals don't bleed into the dashboard.
      const { error: upErr } = await supabase
        .from('products')
        .update({ active_status: false })
        .eq('product_id', p.product_id);
      if (upErr) throw new Error(upErr.message);
      const { error: stErr } = await supabase
        .from('stock_by_location')
        .delete()
        .eq('product_id', p.product_id);
      if (stErr) throw new Error(stErr.message);
      // Also drop product_components rows (the configuration), so if
      // the user re-adds the product later they're not stuck with
      // stale component links.
      await supabase.from('product_components').delete().eq('product_id', p.product_id);
      await supabase.from('product_components').delete().eq('component_product_id', p.product_id);
      onSaved('Product deleted ✓');
    } catch (e) {
      onError('Could not delete: ' + errMessage(e));
    } finally {
      setSaving(false);
    }
  }
}

const inputCls = 'w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm placeholder:text-muted/40 outline-none focus:border-teal/40 transition-colors';

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard({ role }: { role: UserRole }) {
  const { products, locations, stockByLoc, boxByLoc, loading, error, refresh } = useProducts();
  const [modal,        setModal]        = useState<ModalState | null>(null);
  const [productModal, setProductModal] = useState<{ editing: Product | null } | null>(null);
  const [toast,        setToast]        = useState<ToastState | null>(null);
  const toastId      = useRef(0);
  const componentMap = useProductComponents();

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  useEffect(() => {
    if (error) showToast('Failed to load inventory: ' + error, 'error');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  function handleAdjust(product: Product, direction: 'plus' | 'minus', locationId: number) {
    setModal({ product, direction, locationId });
  }

  const isAdmin = role === 'admin';

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ROLE_KEY);
    window.location.reload();
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    // Lock the page to a single viewport-height column. The Navbar +
    // StatsBar + title row + ProductList's filter bar all live in the
    // non-scrollable region; only the product card list inside
    // ProductList scrolls (configured below in that component).
    <div className="h-dvh landscape:h-auto flex flex-col overflow-hidden landscape:overflow-y-auto">
      <AdminNavbar onLogout={handleLogout} />

      <main className="pt-14 max-w-7xl mx-auto w-full flex-1 flex flex-col min-h-0">
        <div className="shrink-0">
          <div className="px-4 pt-5 pb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-extrabold text-slate-100 tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>Inventory</h2>
              <p className="text-xs text-muted mt-0.5">{products.length} active products</p>
            </div>
            {isAdmin && (
              <button
                onClick={() => setProductModal({ editing: null })}
                className="btn-primary px-4 py-2 rounded-xl text-xs font-bold"
              >
                + Add Product
              </button>
            )}
          </div>
        </div>

        <Suspense fallback={null}>
          <InventoryListWithFilter
            products={products}
            locations={locations}
            stockByLoc={stockByLoc}
            boxByLoc={boxByLoc}
            onAdjust={handleAdjust}
            onEdit={isAdmin ? (product => setProductModal({ editing: product })) : undefined}
          />
        </Suspense>
      </main>

      <AnimatePresence>
        {modal && (
          <AdjustStockModal
            key="modal"
            product={modal.product}
            locationId={modal.locationId}
            direction={modal.direction}
            locations={locations}
            stockByLoc={stockByLoc}
            boxByLoc={boxByLoc}
            componentMap={componentMap}
            allProducts={products}
            userRole={role}
            onClose={() => setModal(null)}
            onSuccess={msg => showToast(msg, 'success')}
            onError={msg   => showToast(msg, 'error')}
            onDone={refresh}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {productModal && (
          <ProductModal
            key="prod-modal"
            editing={productModal.editing}
            products={products}
            locations={locations}
            stockByLoc={stockByLoc}
            boxByLoc={boxByLoc}
            onClose={() => setProductModal(null)}
            onSaved={msg => { setProductModal(null); showToast(msg, 'success'); refresh(); }}
            onError={msg => showToast(msg, 'error')}
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
  const [role,   setRole]   = useState<UserRole>('admin');

  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    setAuthed(ok);
    if (ok) setRole((localStorage.getItem(ROLE_KEY) as UserRole) || 'admin');
  }, []);

  function onLoginSuccess() {
    setRole((localStorage.getItem(ROLE_KEY) as UserRole) || 'admin');
    setAuthed(true);
  }

  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return authed ? <Dashboard role={role} /> : <LoginForm onSuccess={onLoginSuccess} />;
}

// ── Inventory list wrapper that picks up ?filter= from the URL ───────────────
// Lives in its own component so it can call useSearchParams (which Next
// requires be inside a Suspense boundary in static export mode).

import type { StockByLoc, LocationInfo } from '@/lib/types';
import type { StockFilter } from './components/ProductList';

function InventoryListWithFilter(props: {
  products:    Product[];
  locations:   LocationInfo[];
  stockByLoc:  StockByLoc;
  boxByLoc:    StockByLoc;
  onAdjust:    (product: Product, direction: 'plus' | 'minus', locationId: number) => void;
  onEdit?:     (product: Product) => void;
}) {
  const params = useSearchParams();
  const raw = (params?.get('filter') ?? 'all') as StockFilter;
  const stockFilter: StockFilter = (['all', 'in_stock', 'out_of_stock'] as StockFilter[]).includes(raw) ? raw : 'all';
  return <ProductList {...props} stockFilter={stockFilter} />;
}
