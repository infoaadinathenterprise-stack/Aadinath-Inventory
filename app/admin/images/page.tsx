'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useProducts } from '@/lib/hooks/useProducts';
import { productImageDataUrl } from '@/lib/productImage';
import { logout as apiLogout, isAuthenticated } from '@/lib/auth';
import { ROLE_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

export default function ImagesPage() {
  const router = useRouter();
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    const ok   = isAuthenticated();
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') { router.replace('/admin'); return; }
    setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <ImagesDashboard />;
}

const PREVIEW_LIMIT = 60;

function ImagesDashboard() {
  const { products, locations, stockByLoc, boxByLoc, loading, error, refresh } = useProducts();
  const [category, setCategory] = useState('All');
  const [locationId, setLocationId] = useState<number | 'all'>('all');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastId = useRef(0);

  // Per-card photo upload: a picked file lands here as a compressed data
  // URL (button shows "Save") until it's written to the row.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [pending,  setPending]  = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }
  function handleLogout() { apiLogout(); window.location.href = '/admin'; }

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const visible = useMemo(() => {
    let list = products.filter(p => category === 'All' || p.type === category);
    if (locationId !== 'all') {
      list = list.filter(p =>
        ((stockByLoc[locationId] ?? {})[p.product_id] ?? 0) > 0 ||
        ((boxByLoc[locationId]   ?? {})[p.product_id] ?? 0) > 0
      );
    }
    return list.sort((a, b) => a.product_name.localeCompare(b.product_name));
  }, [products, category, locationId, stockByLoc, boxByLoc]);

  function pickImage(productId: number) {
    setActiveId(productId);
    fileInputRef.current?.click();
  }

  function processCardFile(file: File, productId: number) {
    if (!file.type.startsWith('image/')) { showToast('Please pick an image file', 'error'); return; }
    if (file.size > 10 * 1024 * 1024) { showToast('Image too large. Max 10MB', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new window.Image();
      img.onload = () => {
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
        setPending(prev => ({ ...prev, [productId]: du }));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  async function saveCardImage(productId: number) {
    const url = pending[productId];
    if (!url) return;
    setSavingId(productId);
    const { error: e } = await supabase.from('products').update({ image_url: url }).eq('product_id', productId);
    setSavingId(null);
    if (e) { showToast('Failed to save image — check permissions/connection', 'error'); return; }
    setPending(prev => { const next = { ...prev }; delete next[productId]; return next; });
    showToast('Image saved ✓', 'success');
    refresh();
  }

  // Which products the "Generate" action will actually write to.
  const targets = useMemo(
    () => (onlyMissing ? products.filter(p => !p.image_url) : products),
    [products, onlyMissing],
  );

  async function generateAll() {
    if (targets.length === 0) { showToast('Nothing to generate', 'error'); return; }
    setBusy(true); setProgress(0);
    const CHUNK = 12;
    let done = 0, failed = 0;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async p => {
        const url = productImageDataUrl(p);
        const { error: e } = await supabase.from('products').update({ image_url: url }).eq('product_id', p.product_id);
        if (e) failed++;
      }));
      done += chunk.length;
      setProgress(Math.round((done / targets.length) * 100));
    }
    setBusy(false);
    if (failed > 0) showToast(`Generated ${done - failed}, ${failed} failed — check permissions/connection`, 'error');
    else showToast(`Generated images for ${done} product${done === 1 ? '' : 's'} ✓`, 'success');
    refresh();
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-5xl mx-auto px-4 pb-28">
        <div className="pt-5 pb-2">
          <h2 className="text-base font-bold text-slate-100">🖼️ Product Images</h2>
          <p className="text-xs text-muted mt-0.5">
            Generate a clean, on-theme image for every product — a category icon + the name on your brand background.
          </p>
        </div>

        {error && <div className="mb-3 px-3 py-2 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs">{error}</div>}

        <div className="mb-3 px-3 py-2.5 rounded-xl bg-gold/5 border border-gold/20 text-[11px] text-gold/80 leading-relaxed">
          These are generated graphics (icon + name), always correct and consistent. They <b>replace</b> existing images
          unless you tick “only products without an image”.
        </div>

        {/* Location filter */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
          <button
            onClick={() => setLocationId('all')}
            className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
              locationId === 'all' ? 'bg-gold/10 border-gold/30 text-gold' : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
            }`}
          >All Locations</button>
          {locations.map(loc => (
            <button
              key={loc.location_id}
              onClick={() => setLocationId(loc.location_id)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
                locationId === loc.location_id ? 'bg-gold/10 border-gold/30 text-gold' : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}
            >{loc.location_name}</button>
          ))}
        </div>

        {/* Category filter */}
        <div className="flex gap-2 overflow-x-auto py-2 scrollbar-none">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all whitespace-nowrap ${
                category === cat ? 'bg-teal/10 border-teal/30 text-teal' : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
              }`}
            >{cat}</button>
          ))}
        </div>

        <p className="text-[11px] text-muted my-3">
          Preview{category !== 'All' ? ` · ${category}` : ''}{locationId !== 'all' ? ` · ${locations.find(l => l.location_id === locationId)?.location_name}` : ''} — showing {Math.min(visible.length, PREVIEW_LIMIT)} of {visible.length}
        </p>

        {/* Preview grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {visible.slice(0, PREVIEW_LIMIT).map(p => {
            const isPending = !!pending[p.product_id];
            const isSaving  = savingId === p.product_id;
            const src = pending[p.product_id] ?? productImageDataUrl(p);
            return (
              <div key={p.product_id} className="rounded-xl overflow-hidden card-lux">
                <div className="relative w-full aspect-square">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={p.product_name} className="w-full h-full object-cover" loading="lazy" />
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => (isPending ? saveCardImage(p.product_id) : pickImage(p.product_id))}
                    className={`absolute bottom-1.5 right-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold shadow-lg transition-colors disabled:opacity-60 ${
                      isPending ? 'bg-success text-navy' : 'bg-navy/80 border border-teal/40 text-teal backdrop-blur hover:bg-navy/95'
                    }`}
                  >
                    {isSaving ? '…' : isPending ? 'Save' : '+ Add'}
                  </button>
                </div>
                <p className="px-2.5 py-2 text-[11px] text-slate-300 truncate">{p.product_name}</p>
              </div>
            );
          })}
        </div>
        {visible.length === 0 && <p className="text-center text-sm text-muted py-12">No products match this filter.</p>}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file && activeId != null) processCardFile(file, activeId);
            e.target.value = '';
          }}
        />
      </main>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-surface/95 backdrop-blur px-4 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} className="accent-teal w-4 h-4" />
            Only products without an image
          </label>
          <div className="flex items-center gap-3">
            {busy && (
              <div className="flex items-center gap-2 min-w-40">
                <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full bg-teal transition-all" style={{ width: `${progress}%` }} />
                </div>
                <span className="text-[11px] text-muted tabular-nums">{progress}%</span>
              </div>
            )}
            <button
              onClick={generateAll}
              disabled={busy}
              className="btn-primary px-5 py-2.5 rounded-xl text-xs font-bold disabled:opacity-60 flex items-center gap-2"
            >
              {busy ? 'Generating…' : `Generate & save (${targets.length})`}
            </button>
          </div>
        </div>
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
