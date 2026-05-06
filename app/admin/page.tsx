'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Product, StockMap, Location } from '@/lib/types';
import { SESSION_KEY } from '@/lib/types';
import AdminNavbar      from './components/AdminNavbar';
import StatsBar         from './components/StatsBar';
import ProductList      from './components/ProductList';
import AdjustStockModal from './components/AdjustStockModal';
import Toast, { type ToastState } from './components/Toast';

const PASS = process.env.NEXT_PUBLIC_ADMIN_PASSWORD ?? 'admin123';

interface ModalState {
  product:   Product;
  direction: 'plus' | 'minus';
  location:  Location;
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
  box_selling_price: '', reorder_level: '0',
  location: '', stock_back: '0', stock_main: '0',
};

function generateSKU(type: string, brand: string, existing: Product[]): string {
  if (!type && !brand) return '';
  const maxId = existing.length > 0 ? Math.max(...existing.map(p => p.product_id)) + 1 : 1;
  const clean = (s: string, len: number) => s.replace(/[ -]/g, '').slice(0, len).toUpperCase();
  return String(maxId).padStart(4, '0') + '-' + clean(type, 3) + clean(brand, 4);
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadData(): Promise<{
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  backBoxMap:   StockMap;
  mainBoxMap:   StockMap;
}> {
  const [{ data: prods, error: pErr }, { data: stock, error: sErr }] = await Promise.all([
    supabase.from('products').select('*').eq('active_status', true).order('product_name'),
    supabase.from('stock_by_location').select('product_id, quantity, box_quantity, location_id'),
  ]);

  if (pErr || sErr) throw new Error((pErr ?? sErr)!.message);

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
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-teal/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/4 w-64 h-64 bg-gold/5 rounded-full blur-3xl" />
      </div>
      <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="relative w-full max-w-sm">
        <motion.form
          onSubmit={submit}
          animate={shake ? { x: [0, -8, 8, -8, 8, 0] } : { x: 0 }}
          transition={shake ? { duration: 0.4 } : {}}
          className="bg-surface border border-white/8 rounded-2xl p-8 shadow-2xl"
        >
          <div className="text-center mb-8">
            <p className="font-bold text-2xl text-teal tracking-tight">Aadinath<span className="text-gold">·</span></p>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gold/15 border border-gold/30 text-gold uppercase tracking-widest mt-1 inline-block">Admin Panel</span>
          </div>
          <p className="text-sm font-semibold text-slate-300 mb-1">Password</p>
          <input
            ref={inputRef} type="password" value={pw}
            onChange={e => { setPw(e.target.value); setErr(''); }}
            placeholder="Enter admin password"
            className="w-full px-4 py-3 rounded-xl bg-surface2 border border-white/10 text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/50 transition-colors mb-2 text-sm"
          />
          <AnimatePresence>
            {err && (
              <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xs text-danger mb-3">{err}</motion.p>
            )}
          </AnimatePresence>
          <button type="submit" className="w-full py-3 mt-2 rounded-xl bg-linear-to-r from-teal to-teal/70 text-navy text-sm font-bold shadow-[0_4px_14px_rgba(0,212,255,0.3)] hover:opacity-90 transition-opacity">
            Sign In
          </button>
        </motion.form>
      </motion.div>
    </div>
  );
}

// ── Add/Edit Product Modal ────────────────────────────────────────────────────

function ProductModal({
  editing, products, backStockMap, mainStockMap,
  onClose, onSaved, onError,
}: {
  editing:      Product | null;
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
  onClose:  () => void;
  onSaved:  (msg: string) => void;
  onError:  (msg: string) => void;
}) {
  const [form,   setForm]   = useState<ProductForm>(() => {
    if (!editing) return EMPTY_FORM;
    const backQ = backStockMap[editing.product_id] ?? 0;
    const mainQ = mainStockMap[editing.product_id] ?? 0;
    const hasBack = backStockMap[editing.product_id] !== undefined;
    const hasMain = mainStockMap[editing.product_id] !== undefined;
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
      box_selling_price: editing.box_selling_price != null ? String(editing.box_selling_price) : '',
      reorder_level:     String(editing.reorder_level ?? 0),
      location:          hasBack && hasMain ? 'both' : hasBack ? '2' : hasMain ? '1' : '',
      stock_back:        String(backQ),
      stock_main:        String(mainQ),
    };
  });
  const [saving, setSaving] = useState(false);

  const isBox = form.unit_type === 'box';
  const ppb   = parseInt(form.pieces_per_box) || 0;

  function autoSKU(f: ProductForm) {
    if (editing) return f.stock_keeping_unit;
    return generateSKU(f.type, f.brand, products);
  }

  function set(key: keyof ProductForm, value: string) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'type' || key === 'brand') next.stock_keeping_unit = autoSKU({ ...next, [key]: value });
      return next;
    });
  }

  async function save() {
    if (!form.product_name.trim()) { onError('Product name is required'); return; }
    if (!form.location)            { onError('Please select a location'); return; }
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
      box_selling_price:  isBox ? (parseFloat(form.box_selling_price) || null) : null,
      reorder_level:      parseInt(form.reorder_level) || 0,
      active_status:      true,
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

      const backQty = parseInt(form.stock_back) || 0;
      const mainQty = parseInt(form.stock_main) || 0;
      const locs: { locId: number; qty: number }[] = [];
      if (form.location === '2' || form.location === 'both') locs.push({ locId: 2, qty: backQty });
      if (form.location === '1' || form.location === 'both') locs.push({ locId: 1, qty: mainQty });

      for (const { locId, qty } of locs) {
        const { data: ex } = await supabase.from('stock_by_location').select('id, quantity').eq('product_id', productId).eq('location_id', locId).single();
        if (ex) {
          await supabase.from('stock_by_location').update({ quantity: qty }).eq('id', ex.id);
        } else {
          await supabase.from('stock_by_location').insert({ product_id: productId, location_id: locId, quantity: qty });
        }
        if (!editing && qty > 0) {
          await supabase.from('stock_movements').insert({ product_id: productId, to_location_id: locId, quantity: qty, movement_type: 'ADJUSTMENT_IN', reason: 'Initial stock' });
        }
      }

      onSaved(editing ? 'Product updated ✓' : 'Product added ✓');
    } catch (e) {
      onError('Error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  const acTypes  = [...new Set(products.map(p => p.type).filter(Boolean))].sort() as string[];
  const acBrands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort() as string[];
  const acUnits  = [...new Set(products.map(p => p.unit_of_measure).filter(Boolean))].sort() as string[];

  return (
    <>
      <motion.div key="pbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div key="pmd" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 220 }}
        className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8 max-h-[95vh] overflow-y-auto"
      >
        <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
        <h3 className="text-base font-bold text-slate-100 mb-4">{editing ? 'Edit Product' : 'Add Product'}</h3>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Product Name *">
              <input value={form.product_name} onChange={e => set('product_name', e.target.value)}
                placeholder="e.g. Generator 4000" className={inputCls} />
            </FormField>
            <FormField label="Type / Category *">
              <input value={form.type} onChange={e => set('type', e.target.value)} list="ac-types"
                placeholder="e.g. Generator" className={inputCls} />
              <datalist id="ac-types">{acTypes.map(t => <option key={t} value={t} />)}</datalist>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Brand">
              <input value={form.brand} onChange={e => set('brand', e.target.value)} list="ac-brands"
                placeholder="e.g. Sigma UK" className={inputCls} />
              <datalist id="ac-brands">{acBrands.map(b => <option key={b} value={b} />)}</datalist>
            </FormField>
            <FormField label="Model">
              <input value={form.model} onChange={e => set('model', e.target.value)} placeholder="e.g. 4000AE" className={inputCls} />
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
                <input type="number" value={form.pieces_per_box} onChange={e => set('pieces_per_box', e.target.value)} placeholder="e.g. 12" min="1" className={inputCls} />
              </FormField>
              <FormField label="Box Selling Price (₹)">
                <input type="number" value={form.box_selling_price} onChange={e => set('box_selling_price', e.target.value)} placeholder="e.g. 480" min="0" className={inputCls} />
              </FormField>
            </div>
          )}

          <FormField label="Reorder Level">
            <input type="number" value={form.reorder_level} onChange={e => set('reorder_level', e.target.value)} placeholder="0" min="0" className={inputCls} />
          </FormField>

          <FormField label="Location *">
            <select value={form.location} onChange={e => set('location', e.target.value as ProductForm['location'])} className={inputCls}>
              <option value="">— Select location —</option>
              <option value="2">Back Godown only</option>
              <option value="1">Main Store only</option>
              <option value="both">Both locations</option>
            </select>
          </FormField>

          {(form.location === '2' || form.location === 'both') && (
            <FormField label={`Back Godown Stock${isBox && ppb > 0 && !editing ? ' (boxes)' : ''}`}>
              <div className="flex items-center gap-2">
                <button onClick={() => set('stock_back', String(Math.max(0, parseInt(form.stock_back) - 1)))}
                  className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">−</button>
                <input type="number" value={form.stock_back} onChange={e => set('stock_back', e.target.value)} min="0"
                  className={`${inputCls} text-center text-lg font-bold`} />
                <button onClick={() => set('stock_back', String((parseInt(form.stock_back) || 0) + 1))}
                  className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">+</button>
              </div>
              {isBox && ppb > 0 && !editing && parseInt(form.stock_back) > 0 && (
                <p className="text-xs text-blue-400 mt-1">= {parseInt(form.stock_back) * ppb} pieces</p>
              )}
            </FormField>
          )}

          {(form.location === '1' || form.location === 'both') && (
            <FormField label={`Main Store Stock${isBox && ppb > 0 && !editing ? ' (boxes)' : ''}`}>
              <div className="flex items-center gap-2">
                <button onClick={() => set('stock_main', String(Math.max(0, parseInt(form.stock_main) - 1)))}
                  className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">−</button>
                <input type="number" value={form.stock_main} onChange={e => set('stock_main', e.target.value)} min="0"
                  className={`${inputCls} text-center text-lg font-bold`} />
                <button onClick={() => set('stock_main', String((parseInt(form.stock_main) || 0) + 1))}
                  className="w-9 h-9 rounded-lg bg-surface2 border border-white/10 text-slate-100 text-lg font-bold flex items-center justify-center shrink-0">+</button>
              </div>
              {isBox && ppb > 0 && !editing && parseInt(form.stock_main) > 0 && (
                <p className="text-xs text-blue-400 mt-1">= {parseInt(form.stock_main) * ppb} pieces</p>
              )}
            </FormField>
          )}

          <div className="flex gap-3 mt-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100 transition-colors">Cancel</button>
            <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/25 transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Update Product' : 'Add Product'}
            </button>
          </div>
        </div>
      </motion.div>
    </>
  );
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

function Dashboard() {
  const [products,     setProducts]     = useState<Product[]>([]);
  const [backStockMap, setBackStockMap] = useState<StockMap>({});
  const [mainStockMap, setMainStockMap] = useState<StockMap>({});
  const [backBoxMap,   setBackBoxMap]   = useState<StockMap>({});
  const [mainBoxMap,   setMainBoxMap]   = useState<StockMap>({});
  const [loading,      setLoading]      = useState(true);
  const [modal,        setModal]        = useState<ModalState | null>(null);
  const [productModal, setProductModal] = useState<{ editing: Product | null } | null>(null);
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
    } catch (e) {
      setToast({ msg: 'Failed to load inventory: ' + (e instanceof Error ? e.message : 'Network error'), type: 'error', id: ++toastId.current });
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
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />

      <main className="pt-14 max-w-2xl mx-auto">
        <StatsBar products={products} backStockMap={backStockMap} mainStockMap={mainStockMap} />

        <div className="px-4 pt-5 pb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-100">Inventory</h2>
            <p className="text-xs text-muted mt-0.5">{products.length} active products</p>
          </div>
          <button
            onClick={() => setProductModal({ editing: null })}
            className="px-4 py-2 rounded-xl bg-teal/10 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/20 transition-all"
          >
            + Add Product
          </button>
        </div>

        <ProductList
          products={products}
          backStockMap={backStockMap}
          mainStockMap={mainStockMap}
          backBoxMap={backBoxMap}
          mainBoxMap={mainBoxMap}
          onAdjust={handleAdjust}
          onEdit={product => setProductModal({ editing: product })}
        />
      </main>

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
            backStockMap={backStockMap}
            mainStockMap={mainStockMap}
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

  useEffect(() => {
    setAuthed(sessionStorage.getItem(SESSION_KEY) === '1');
  }, []);

  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return authed ? <Dashboard /> : <LoginForm onSuccess={() => setAuthed(true)} />;
}
