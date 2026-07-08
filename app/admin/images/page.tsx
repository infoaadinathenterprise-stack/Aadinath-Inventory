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
  const { products, loading, error, refresh } = useProducts();
  const [category, setCategory] = useState('All');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastId = useRef(0);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }
  function handleLogout() { apiLogout(); window.location.href = '/admin'; }

  const categories = useMemo(() => {
    const cats = Array.from(new Set(products.map(p => p.type).filter(Boolean))) as string[];
    return ['All', ...cats.sort()];
  }, [products]);

  const visible = useMemo(() =>
    products
      .filter(p => category === 'All' || p.type === category)
      .sort((a, b) => a.product_name.localeCompare(b.product_name)),
  [products, category]);

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

        {/* Category filter */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
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
          Preview{category !== 'All' ? ` · ${category}` : ''} — showing {Math.min(visible.length, PREVIEW_LIMIT)} of {visible.length}
        </p>

        {/* Preview grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {visible.slice(0, PREVIEW_LIMIT).map(p => (
            <div key={p.product_id} className="rounded-xl overflow-hidden card-lux">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={productImageDataUrl(p)} alt={p.product_name} className="w-full aspect-square object-cover" loading="lazy" />
              <p className="px-2.5 py-2 text-[11px] text-slate-300 truncate">{p.product_name}</p>
            </div>
          ))}
        </div>
        {visible.length === 0 && <p className="text-center text-sm text-muted py-12">No products in this category.</p>}
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
