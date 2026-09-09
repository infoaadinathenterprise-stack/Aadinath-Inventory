'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useProducts } from '@/lib/hooks/useProducts';
import { stockTxn, type StockOp } from '@/lib/stockActions';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { SESSION_KEY, ROLE_KEY, DEFAULT_COMPANY_ID } from '@/lib/types';

const LABELS_PER_PAGE = 24;
type SortBy = 'recent' | 'name';

// ── WiFi sticker printer (XB330B) ───────────────────────────────────────────────
// Bridges to a small relay helper (sticker-relay/server.js) running on a PC on
// the same WiFi network, which forwards raw TSPL commands to the printer's IP.
// Browsers can't open raw TCP sockets, and Safari/iOS has no Web Bluetooth, so
// the page reaches the relay via a plain HTTP form POST (a top-level page
// navigation isn't subject to mixed-content blocking the way a fetch() would be).

const STICKER_DPI = 203; // standard resolution for this printer family

const LABEL_PRESETS = [
  { key: '40x30',   label: '40 × 30 mm',   widthMm: 40,  heightMm: 30 },
  { key: '50x30',   label: '50 × 30 mm',   widthMm: 50,  heightMm: 30 },
  { key: '50x25',   label: '50 × 25 mm',   widthMm: 50,  heightMm: 25 },
  { key: '40x20',   label: '40 × 20 mm',   widthMm: 40,  heightMm: 20 },
  { key: '100x150', label: '100 × 150 mm', widthMm: 100, heightMm: 150 },
  { key: 'custom',  label: 'Custom',       widthMm: 0,   heightMm: 0 },
] as const;
type LabelPresetKey = typeof LABEL_PRESETS[number]['key'];

type LabelBitmap = { widthPx: number; heightPx: number; bytesPerRow: number; rasterBase64: string };

function readLS(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

// Product names range from a couple of words to a full descriptive sentence,
// so a single fixed font size either wastes space on short names or
// truncates long ones. Instead we shrink-to-fit per label: try one line at
// shrinking font sizes, and only fall back to wrapping onto two lines (at
// the minimum font) if it still won't fit — so every label reads clearly
// regardless of how long that particular product's name is.
function fitNameLines(
  ctx: CanvasRenderingContext2D,
  name: string,
  maxWidth: number,
  maxFontPx: number,
  minFontPx: number,
): { lines: string[]; fontPx: number } {
  for (let font = maxFontPx; font >= minFontPx; font -= 1) {
    ctx.font = `600 ${font}px sans-serif`;
    if (ctx.measureText(name).width <= maxWidth) return { lines: [name], fontPx: font };
  }

  ctx.font = `600 ${minFontPx}px sans-serif`;
  const words = name.split(' ');
  if (words.length < 2) return { lines: [fitText(ctx, name, maxWidth)], fontPx: minFontPx };

  let best = { line1: words[0], line2: words.slice(1).join(' ') };
  let bestWidth = Infinity;
  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(' ');
    const line2 = words.slice(i).join(' ');
    const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
    if (w < bestWidth) { bestWidth = w; best = { line1, line2 }; }
  }
  return { lines: [fitText(ctx, best.line1, maxWidth), fitText(ctx, best.line2, maxWidth)], fontPx: minFontPx };
}

// Reused by both the actual renderer and the label-size suggestion below, so
// the suggestion reflects exactly what will land on the label.
let measureCanvas: HTMLCanvasElement | null = null;
function measureTextWidthPx(text: string, fontPx: number): number {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d')!;
  ctx.font = `600 ${fontPx}px sans-serif`;
  return ctx.measureText(text).width;
}

// Suggests the smallest roll size (by area) that fits the longest selected
// product name on one line at a comfortably readable font — since a
// thermal roll is one fixed physical size, you pick the size before
// printing rather than per-label.
function suggestLabelSize(items: Product[]): { key: LabelPresetKey; label: string; note: string } | null {
  if (items.length === 0) return null;
  const REF_FONT = 40;
  let longestName = items[0].product_name;
  let longestWidth = measureTextWidthPx(longestName, REF_FONT);
  for (const p of items) {
    const w = measureTextWidthPx(p.product_name, REF_FONT);
    if (w > longestWidth) { longestWidth = w; longestName = p.product_name; }
  }

  const candidates = LABEL_PRESETS
    .filter((p): p is typeof LABEL_PRESETS[number] & { key: Exclude<LabelPresetKey, 'custom'> } => p.key !== 'custom')
    .map(p => ({
      ...p,
      widthPx:  Math.round((p.widthMm / 25.4) * STICKER_DPI),
      heightPx: Math.round((p.heightMm / 25.4) * STICKER_DPI),
    }))
    .sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm);

  for (const c of candidates) {
    const usableWidth  = c.widthPx * 0.94;
    const targetFont   = c.heightPx * 0.13; // matches maxFontPx used when rendering
    const fittingFontAtRefWidth = REF_FONT * (usableWidth / longestWidth);
    if (fittingFontAtRefWidth >= targetFont * 0.8) {
      return { key: c.key, label: c.label, note: `Fits "${longestName}" on one line without shrinking much.` };
    }
  }

  const largest = candidates[candidates.length - 1];
  return {
    key: largest.key,
    label: largest.label,
    note: `"${longestName}" is long — even ${largest.label} will wrap it onto two lines.`,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Renders a label to a monochrome, byte-aligned raster the relay can wrap in
// a TSPL BITMAP command — this keeps the printed output a pixel-for-pixel
// match of what jsbarcode + canvas draw here, instead of re-deriving the
// layout in printer-native font/barcode commands.
async function renderLabelBitmap(product: Product, widthMm: number, heightMm: number): Promise<LabelBitmap> {
  const bytesPerRow = Math.ceil(Math.round((widthMm / 25.4) * STICKER_DPI) / 8);
  const widthPx  = bytesPerRow * 8;
  const heightPx = Math.round((heightMm / 25.4) * STICKER_DPI);

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is not supported in this browser');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';

  if (product.stock_keeping_unit) {
    const barcodeCanvas = document.createElement('canvas');
    try {
      const JsBarcode = (await import('jsbarcode')).default;
      JsBarcode(barcodeCanvas, product.stock_keeping_unit, {
        format:       'CODE128',
        width:        2,
        height:       Math.round(heightPx * 0.4),
        displayValue: true,
        fontSize:     Math.max(10, Math.round(heightPx * 0.09)),
        margin:       0,
        background:   '#ffffff',
        lineColor:    '#000000',
      });
      const scale = Math.min((widthPx * 0.92) / barcodeCanvas.width, 1);
      const bw = barcodeCanvas.width * scale;
      const bh = barcodeCanvas.height * scale;
      ctx.drawImage(barcodeCanvas, (widthPx - bw) / 2, heightPx * 0.04, bw, bh);
    } catch {
      ctx.font = `${Math.round(heightPx * 0.16)}px monospace`;
      ctx.fillText('BAD SKU', widthPx / 2, heightPx * 0.4);
    }
  } else {
    ctx.font = `${Math.round(heightPx * 0.16)}px monospace`;
    ctx.fillText(product.product_name.slice(0, 16), widthPx / 2, heightPx * 0.4);
  }

  const nameMaxWidth = widthPx * 0.94;
  const { lines: nameLines, fontPx: nameFontPx } = fitNameLines(
    ctx, product.product_name, nameMaxWidth,
    Math.round(heightPx * 0.13), Math.max(8, Math.round(heightPx * 0.07)),
  );
  ctx.font = `600 ${nameFontPx}px sans-serif`;
  if (nameLines.length === 1) {
    ctx.fillText(nameLines[0], widthPx / 2, heightPx * 0.80);
  } else {
    ctx.fillText(nameLines[0], widthPx / 2, heightPx * 0.75);
    ctx.fillText(nameLines[1], widthPx / 2, heightPx * 0.75 + nameFontPx * 1.15);
  }

  if (product.selling_price != null) {
    const priceText = `Ksh ${product.selling_price}`;
    let priceFontPx = Math.round(heightPx * 0.14);
    ctx.font = `700 ${priceFontPx}px sans-serif`;
    while (priceFontPx > 8 && ctx.measureText(priceText).width > nameMaxWidth) {
      priceFontPx -= 1;
      ctx.font = `700 ${priceFontPx}px sans-serif`;
    }
    ctx.fillText(priceText, widthPx / 2, heightPx * 0.97);
  }

  const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
  const bytes = new Uint8Array(bytesPerRow * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const i = (y * widthPx + x) * 4;
      const luminance = 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2];
      if (luminance < 140) {
        bytes[y * bytesPerRow + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }

  return { widthPx, heightPx, bytesPerRow, rasterBase64: bytesToBase64(bytes) };
}

// ── Auth guard ─────────────────────────────────────────────────────────────────

export default function LabelsPage() {
  const router  = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') {
      router.replace('/admin');
    } else {
      setReady(true);
    }
  }, [router]);

  if (!ready) return <div className="min-h-screen" />;
  return <LabelsDashboard />;
}

// ── Main dashboard ─────────────────────────────────────────────────────────────

type Selected = Record<number, number>; // productId → copies

function LabelsDashboard() {
  const { products, locations, stockByLoc, loading, error, refresh } = useProducts();
  const [selected, setSelected]   = useState<Selected>({});
  const [search,   setSearch]     = useState('');
  const [locationId, setLocationId] = useState<number>(0);
  const [sortBy,   setSortBy]     = useState<SortBy>('recent');
  const [mobileTab, setMobileTab] = useState<'products' | 'preview'>('products');
  const [viewMode, setViewMode]   = useState<'all' | 'selected'>('all');
  const [toast,    setToast]      = useState<{ msg: string; type: string } | null>(null);
  const [stockModal, setStockModal] = useState<{ mode: 'add' | 'remove'; product: Product } | null>(null);
  const [stockQty,   setStockQty]   = useState(1);
  const [stockSaving, setStockSaving] = useState(false);
  const toastRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // WiFi sticker printer (XB330B via relay helper)
  const [stickerOpen,    setStickerOpen]    = useState(false);
  const [stickerSending, setStickerSending] = useState(false);
  const [labelSize,      setLabelSize]      = useState<LabelPresetKey>(() => readLS('sticker.labelSize', '50x30') as LabelPresetKey);
  const [customWidthMm,  setCustomWidthMm]  = useState<number>(() => Number(readLS('sticker.customWidthMm', '50')));
  const [customHeightMm, setCustomHeightMm] = useState<number>(() => Number(readLS('sticker.customHeightMm', '30')));
  const [relayHost,      setRelayHost]      = useState<string>(() => readLS('sticker.relayHost', ''));
  const [printerIp,      setPrinterIp]      = useState<string>(() => readLS('sticker.printerIp', ''));
  const [printerPort,    setPrinterPort]    = useState<string>(() => readLS('sticker.printerPort', '9100'));

  useEffect(() => { localStorage.setItem('sticker.labelSize', labelSize); }, [labelSize]);
  useEffect(() => { localStorage.setItem('sticker.customWidthMm', String(customWidthMm)); }, [customWidthMm]);
  useEffect(() => { localStorage.setItem('sticker.customHeightMm', String(customHeightMm)); }, [customHeightMm]);
  useEffect(() => { localStorage.setItem('sticker.relayHost', relayHost); }, [relayHost]);
  useEffect(() => { localStorage.setItem('sticker.printerIp', printerIp); }, [printerIp]);
  useEffect(() => { localStorage.setItem('sticker.printerPort', printerPort); }, [printerPort]);

  // Set default location once loaded
  useEffect(() => {
    if (!locationId && locations.length > 0) setLocationId(locations[0].location_id);
  }, [locations, locationId]);

  const stockMap = stockByLoc[locationId] ?? {};
  const locId    = locationId;
  const locName  = locations.find(l => l.location_id === locationId)?.location_name ?? 'Location';

  function showToast(msg: string, type = 'success') {
    setToast({ msg, type });
    clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setToast(null), 2600);
  }

  const inLocStock = products.filter(p => (stockMap[p.product_id] || 0) > 0);

  // Selected view: products currently in the print queue regardless of
  // which location's stock they came from. Lets the user review the
  // queue and pull items out without scrolling the full inventory.
  const selectedPool = viewMode === 'selected'
    ? products.filter(p => selected[p.product_id] != null)
    : inLocStock;

  const filtered = selectedPool
    .filter(p => {
      if (!search) return true;
      const hay = [p.product_name, p.stock_keeping_unit, p.type].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(search.toLowerCase());
    })
    .sort((a, b) => {
      if (sortBy === 'recent') return b.product_id - a.product_id; // newest first
      return a.product_name.localeCompare(b.product_name);
    });

  const selectedCount = Object.keys(selected).length;

  function toggleProduct(id: number) {
    setSelected(sel => {
      const next = { ...sel };
      if (next[id]) { delete next[id]; }
      else { next[id] = Math.max(1, stockMap[id] || 1); }
      return next;
    });
  }

  function setCopies(id: number, val: string) {
    const n = Math.max(1, parseInt(val) || 1);
    setSelected(sel => ({ ...sel, [id]: n }));
  }

  function selectAll() {
    const next: Selected = {};
    inLocStock.forEach(p => { next[p.product_id] = Math.max(1, stockMap[p.product_id] || 1); });
    setSelected(next);
  }

  function clearAll() { setSelected({}); }

  // Build label list respecting selection order
  const labelList: Product[] = [];
  products.forEach(p => {
    const copies = selected[p.product_id];
    if (!copies) return;
    for (let i = 0; i < copies; i++) labelList.push(p);
  });

  const totalLabels = labelList.length;
  const pages: Product[][] = [];
  for (let i = 0; i < labelList.length; i += LABELS_PER_PAGE) {
    pages.push(labelList.slice(i, i + LABELS_PER_PAGE));
  }

  const selectedProducts = useMemo(
    () => products.filter(p => (selected[p.product_id] ?? 0) > 0),
    [products, selected],
  );
  const sizeSuggestion = useMemo(
    () => (typeof window !== 'undefined' ? suggestLabelSize(selectedProducts) : null),
    [selectedProducts],
  );

  function handlePrint() {
    // We allow printing more than the on-hand count (the user can do this
    // intentionally — pre-print spares). Just confirm via toast if any
    // selection exceeds stock so it's not silent.
    const overLimit = inLocStock
      .map(p => ({ p, copies: selected[p.product_id] ?? 0, stock: stockMap[p.product_id] || 0 }))
      .filter(({ copies, stock }) => copies > 0 && copies > stock);

    if (overLimit.length > 0) {
      showToast(`Printing ${overLimit.length} product(s) above ${locName} stock — extras will print anyway.`, 'success');
    }
    window.print();
  }

  async function handlePrintWifi() {
    const relay = relayHost.trim();
    const ip    = printerIp.trim();
    if (!relay) { showToast('Enter the relay address (e.g. 192.168.1.50:8787)', 'error'); return; }
    if (!ip)    { showToast("Enter the printer's IP address", 'error'); return; }

    const preset  = LABEL_PRESETS.find(p => p.key === labelSize);
    const widthMm  = labelSize === 'custom' ? customWidthMm  : preset?.widthMm  ?? 50;
    const heightMm = labelSize === 'custom' ? customHeightMm : preset?.heightMm ?? 30;
    if (widthMm <= 0 || heightMm <= 0) { showToast('Enter a valid label size', 'error'); return; }

    const entries = Object.entries(selected).filter(([, copies]) => copies > 0);
    if (entries.length === 0) { showToast('Select products to print first', 'error'); return; }

    setStickerSending(true);
    try {
      const jobs = [];
      for (const [pid, copies] of entries) {
        const product = products.find(p => p.product_id === Number(pid));
        if (!product) continue;
        const bitmap = await renderLabelBitmap(product, widthMm, heightMm);
        jobs.push({ ...bitmap, widthMm, heightMm, copies });
      }
      if (jobs.length === 0) { showToast('Nothing to print', 'error'); setStickerSending(false); return; }

      // Hand off via a real page navigation (form POST), not fetch — a
      // top-level navigation to an http:// relay from this https:// page is
      // allowed by browsers, whereas a fetch() would be blocked as mixed
      // content the moment the relay lives on a different device.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = `http://${relay}/print`;
      const input = document.createElement('input');
      input.type  = 'hidden';
      input.name  = 'payload';
      input.value = JSON.stringify({ printerIp: ip, printerPort: Number(printerPort) || 9100, jobs });
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to prepare the sticker print job', 'error');
      setStickerSending(false);
    }
  }

  async function handleStockSave() {
    if (!stockModal) return;
    const { mode, product } = stockModal;
    const qty = stockQty;
    if (qty < 1) { showToast('Enter a valid quantity', 'error'); return; }

    const cur = stockMap[product.product_id] || 0;
    if (mode === 'remove' && qty > cur) {
      showToast(`Only ${cur} in ${locName}`, 'error');
      return;
    }

    setStockSaving(true);
    try {
      // Apply through the atomic stock engine (stock change + history in
      // one transaction). Stock is keyed per company: additions go to the
      // default company; removals drain each company's row in turn — the
      // old upsertStock wrote the SAME total onto every company's row.
      if (mode === 'add') {
        await stockTxn([{
          product_id: product.product_id, location_id: locId, company_id: DEFAULT_COMPANY_ID,
          dq: qty, db: 0,
          mov_type: 'ADJUSTMENT_IN', mov_qty: qty, mov_from: null, mov_to: locId,
          reason: `Stock correction via Labels (${locName})`,
        }]);
      } else {
        const { data: rows, error: rErr } = await supabase
          .from('stock_by_location')
          .select('company_id, quantity')
          .eq('product_id', product.product_id)
          .eq('location_id', locId);
        if (rErr) throw new Error(rErr.message);
        const order = [...(rows ?? [])].sort((a, b) =>
          (a.company_id === DEFAULT_COMPANY_ID ? 0 : a.company_id) -
          (b.company_id === DEFAULT_COMPANY_ID ? 0 : b.company_id));
        const ops: StockOp[] = [];
        let remaining = qty;
        for (const r of order) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, r.quantity ?? 0);
          if (take <= 0) continue;
          ops.push({
            product_id: product.product_id, location_id: locId, company_id: r.company_id ?? DEFAULT_COMPANY_ID,
            dq: -take, db: 0,
            mov_type: 'ADJUSTMENT_OUT', mov_qty: take, mov_from: locId, mov_to: null,
            reason: `Stock removed via Labels (${locName})`,
          });
          remaining -= take;
        }
        if (ops.length > 0) await stockTxn(ops);
      }
      refresh();
      showToast(`${mode === 'add' ? 'Added' : 'Removed'} ${qty} units ✓`, 'success');
      setStockModal(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setStockSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <p className="text-4xl mb-4">⚠️</p>
          <p className="text-danger text-sm">{error}</p>
          <Link href="/admin" className="mt-4 inline-block text-teal text-sm hover:underline">← Back</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-navy flex flex-col overflow-hidden">
      <header className="print-hide shrink-0 bg-surface border-b border-white/8 px-4 flex items-center gap-3 h-14">
        <Link href="/admin" className="text-muted hover:text-slate-100 text-sm px-3 py-1.5 rounded-lg bg-surface2 border border-white/8 transition-colors print-hide">
          ← Back
        </Link>
        <h1 className="flex-1 text-sm font-bold text-slate-100">🏷️ Label Printer</h1>
        <span className="text-xs text-muted font-mono whitespace-nowrap hidden sm:block">
          {totalLabels} label{totalLabels !== 1 ? 's' : ''}
        </span>
        <button
          onClick={() => setStickerOpen(true)}
          disabled={totalLabels === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-xs font-bold hover:border-teal/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed print-hide"
          title="Print to WiFi sticker printer"
        >
          📶 Sticker
        </button>
        <button
          onClick={handlePrint}
          disabled={totalLabels === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal text-navy text-xs font-bold shadow-[0_4px_14px_rgba(0,212,255,0.3)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
        >
          🖨️ Print
        </button>
      </header>

      <div className="sm:hidden print-hide shrink-0 flex bg-surface border-b border-white/8">
        {(['products', 'preview'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setMobileTab(tab)}
            className={`flex-1 py-2.5 text-xs font-semibold transition-all border-b-2 ${
              mobileTab === tab
                ? 'text-teal border-teal'
                : 'text-muted border-transparent'
            }`}
          >
            {tab === 'products' ? '🛍️ Products' : (
              <>🏷️ Preview {totalLabels > 0 && <span className="ml-1 bg-teal text-navy text-[10px] font-bold px-1.5 py-0.5 rounded-full">{totalLabels}</span>}</>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className={`${mobileTab === 'preview' ? 'hidden' : 'flex'} sm:flex print-hide w-full sm:w-72 lg:w-80 shrink-0 bg-surface border-r border-white/8 flex-col`}>
          <div className="p-3 border-b border-white/8 shrink-0 flex flex-col gap-2">
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
              {locations.map(loc => (
                <button
                  key={loc.location_id}
                  onClick={() => { setLocationId(loc.location_id); setSelected({}); }}
                  className={`shrink-0 flex-1 py-2 rounded-xl border text-[11px] font-bold transition-all ${
                    locationId === loc.location_id
                      ? 'border-teal bg-teal/10 text-teal'
                      : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                  }`}
                >
                  {loc.location_name}
                </button>
              ))}
            </div>

            <div className="flex gap-1.5">
              {([['recent', '🆕 Recent'], ['name', '🔤 A–Z']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSortBy(key)}
                  className={`flex-1 py-1.5 rounded-lg border text-[10px] font-semibold transition-all ${
                    sortBy === key
                      ? 'border-gold/40 bg-gold/10 text-gold'
                      : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* View toggle: All products vs only what's in the print queue.
                In Selected mode, tapping a card deselects it which both
                removes it from this list and decrements the total label
                count below. */}
            <div className="flex gap-1.5">
              {([['all', `📋 All (${inLocStock.length})`], ['selected', `✅ Selected (${selectedCount})`]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setViewMode(key)}
                  className={`flex-1 py-1.5 rounded-lg border text-[10px] font-semibold transition-all ${
                    viewMode === key
                      ? 'border-teal/40 bg-teal/10 text-teal'
                      : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">🔍</span>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${locName.toLowerCase()}…`}
                className="w-full pl-9 pr-3 py-2 rounded-xl bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 transition-colors"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={selectAll}  className="flex-1 py-1.5 text-[11px] font-semibold rounded-lg border border-white/8 bg-surface2 text-muted hover:text-teal hover:border-teal/30 transition-all">Select All</button>
              <button onClick={clearAll}   className="flex-1 py-1.5 text-[11px] font-semibold rounded-lg border border-white/8 bg-surface2 text-muted hover:text-danger hover:border-danger/30 transition-all">Clear All</button>
              <button onClick={refresh}    className="px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-white/8 bg-surface2 text-muted hover:border-white/20 transition-all" title="Refresh">🔄</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
            {filtered.length === 0 && (
              <div className="text-center text-muted text-xs py-8 px-4">
                {viewMode === 'selected'
                  ? (selectedCount === 0
                      ? <>No labels in your queue. Tap <button onClick={() => setViewMode('all')} className="text-teal font-bold hover:underline">📋 All</button> to pick some.</>
                      : <>No selected products match &quot;{search}&quot;.</>)
                  : <>No products in {locName.toLowerCase()}</>
                }
              </div>
            )}
            {filtered.map(p => {
              const copies   = selected[p.product_id];
              const stock    = stockMap[p.product_id] || 0;
              const isOver   = copies != null && copies > stock;
              const isSel    = copies != null;
              return (
                <div
                  key={p.product_id}
                  onClick={() => toggleProduct(p.product_id)}
                  className={`flex items-start gap-2.5 px-3 py-2 rounded-xl cursor-pointer transition-all border ${
                    isSel ? 'bg-teal/5 border-teal/20' : 'border-transparent hover:bg-surface2'
                  }`}
                >
                  <div className={`w-4 h-4 mt-0.5 rounded shrink-0 flex items-center justify-center border transition-all ${
                    isSel ? 'bg-teal border-teal text-navy' : 'border-white/20'
                  }`}>
                    {isSel && <span className="text-[9px] font-black">✓</span>}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Name wraps to a second line if needed — long product
                        names were getting truncated with "…" before. We
                        cap at 2 lines so the row doesn't grow forever for
                        absurd names. */}
                    <p className="text-xs font-semibold text-slate-100 leading-snug line-clamp-2 break-words">{p.product_name}</p>
                    <p className="text-[10px] text-muted font-mono mt-0.5">{p.stock_keeping_unit || 'No SKU'}</p>
                  </div>

                  {isSel ? (
                    <div className="shrink-0 mt-0.5 flex flex-col items-center gap-0.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="number"
                        value={copies}
                        min={1}
                        onChange={e => setCopies(p.product_id, e.target.value)}
                        onWheel={e => e.currentTarget.blur()}
                        className={`w-10 text-center text-xs font-bold rounded-lg border py-1 bg-surface2 text-slate-100 outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                          isOver ? 'border-danger/50' : 'border-white/10'
                        }`}
                      />
                      <span className={`text-[9px] font-mono ${isOver ? 'text-danger' : 'text-muted'}`}>
                        {isOver ? `⚠ ${stock}` : `/${stock}`}
                      </span>
                    </div>
                  ) : (
                    <div className="shrink-0 mt-0.5 flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => { setStockModal({ mode: 'remove', product: p }); setStockQty(1); }}
                        className="w-5 h-5 rounded border border-danger/35 bg-danger/10 text-danger font-bold flex items-center justify-center text-xs hover:bg-danger hover:text-white transition-all"
                        title="Remove stock"
                      >−</button>
                      <span className="text-[10px] font-mono text-muted px-1.5 py-0.5 rounded bg-surface2 border border-white/8">{stock}</span>
                      <button
                        onClick={() => { setStockModal({ mode: 'add', product: p }); setStockQty(1); }}
                        className="w-5 h-5 rounded border border-teal/35 bg-teal/10 text-teal font-bold flex items-center justify-center text-xs hover:bg-teal hover:text-navy transition-all"
                        title="Add stock"
                      >+</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <main className={`${mobileTab === 'products' ? 'hidden' : 'flex'} sm:flex flex-1 overflow-y-auto p-5 bg-navy/60`}>
          {pages.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 text-center text-muted">
              <p className="text-4xl mb-3">🏷️</p>
              <p className="text-sm">Select products from the sidebar<br />to generate barcode labels.</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5 w-full">
              {pages.map((page, pi) => (
                <div key={pi} className="label-page">
                  {page.map((p, li) => (
                    <BarcodeLabel key={`${pi}-${li}-${p.product_id}`} product={p} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      <AnimatePresence>
        {stockModal && (
          <>
            <motion.div
              className="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setStockModal(null)}
            />
            <motion.div
              className="fixed bottom-0 left-0 right-0 z-110 bg-surface border-t border-white/10 rounded-t-3xl px-5 py-6 max-w-lg mx-auto"
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
              <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-4" />
              <p className="text-2xl text-center mb-1">{stockModal.mode === 'add' ? '➕' : '➖'}</p>
              <h3 className="text-base font-bold text-slate-100 text-center mb-1">
                {stockModal.mode === 'add' ? 'Add Stock' : 'Remove Stock'}
              </h3>
              <p className="text-xs text-muted text-center mb-4">{stockModal.product.product_name}</p>
              <p className="text-xs text-muted text-center mb-4">
                Currently <span className="text-slate-300 font-semibold">{stockMap[stockModal.product.product_id] || 0}</span> in {locName}
              </p>

              <div className="flex items-center gap-3 mb-6">
                <button
                  onClick={() => setStockQty(q => Math.max(1, q - 1))}
                  className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center"
                >−</button>
                <input
                  type="number"
                  min={1}
                  value={stockQty}
                  onChange={e => setStockQty(Math.max(1, parseInt(e.target.value) || 1))}
                  onWheel={e => e.currentTarget.blur()}
                  className="flex-1 text-center text-2xl font-bold bg-surface2 border border-white/10 rounded-xl py-2.5 text-slate-100 outline-none focus:border-teal/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  onClick={() => setStockQty(q => q + 1)}
                  className="w-11 h-11 rounded-xl border border-white/8 bg-surface2 text-slate-100 text-2xl font-bold flex items-center justify-center"
                >+</button>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStockModal(null)}
                  className="flex-1 py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold"
                >Cancel</button>
                <button
                  onClick={handleStockSave}
                  disabled={stockSaving}
                  className={`flex-2 py-3 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50 ${
                    stockModal.mode === 'add'
                      ? 'bg-linear-to-r from-teal to-teal/70 shadow-[0_4px_14px_rgba(0,212,255,0.3)]'
                      : 'bg-linear-to-r from-danger to-red-600 shadow-[0_4px_14px_rgba(239,68,68,0.35)]'
                  }`}
                >
                  {stockSaving ? 'Saving…' : `${stockModal.mode === 'add' ? 'Add' : 'Remove'} Stock ✓`}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {stickerOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-100 bg-black/70 backdrop-blur-sm print-hide"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => !stickerSending && setStickerOpen(false)}
            />
            <motion.div
              className="fixed bottom-0 left-0 right-0 z-110 bg-surface border-t border-white/10 rounded-t-3xl px-5 py-6 max-w-lg mx-auto print-hide max-h-[85vh] overflow-y-auto"
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            >
              <div className="w-9 h-1 bg-white/15 rounded-full mx-auto mb-4" />
              <h3 className="text-base font-bold text-slate-100 text-center mb-1">📶 WiFi Sticker Printer</h3>
              <p className="text-xs text-muted text-center mb-4">
                Sends {totalLabels} label{totalLabels !== 1 ? 's' : ''} to the XB330B over WiFi, via the relay helper running on a PC on your network.
              </p>

              <label className="text-[11px] font-semibold text-muted mb-1 block">Label size</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {LABEL_PRESETS.map(p => (
                  <button
                    key={p.key}
                    onClick={() => setLabelSize(p.key)}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                      labelSize === p.key ? 'border-teal bg-teal/10 text-teal' : 'border-white/8 bg-surface2 text-muted hover:border-white/20'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {sizeSuggestion && sizeSuggestion.key !== labelSize && (
                <button
                  onClick={() => setLabelSize(sizeSuggestion.key)}
                  className="w-full text-left mb-3 px-3 py-2 rounded-lg border border-gold/30 bg-gold/10 text-[11px] text-gold hover:bg-gold/15 transition-colors"
                >
                  💡 Suggested: <b>{sizeSuggestion.label}</b> — {sizeSuggestion.note} <span className="underline">Use this</span>
                </button>
              )}

              {labelSize === 'custom' && (
                <div className="flex gap-2 mb-3">
                  <div className="flex-1">
                    <label className="text-[10px] text-muted block mb-1">Width (mm)</label>
                    <input
                      type="number" min={5} value={customWidthMm}
                      onChange={e => setCustomWidthMm(Math.max(5, parseInt(e.target.value) || 0))}
                      onWheel={e => e.currentTarget.blur()}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-surface2 border border-white/8 text-sm text-slate-100 outline-none focus:border-teal/40"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-muted block mb-1">Height (mm)</label>
                    <input
                      type="number" min={5} value={customHeightMm}
                      onChange={e => setCustomHeightMm(Math.max(5, parseInt(e.target.value) || 0))}
                      onWheel={e => e.currentTarget.blur()}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-surface2 border border-white/8 text-sm text-slate-100 outline-none focus:border-teal/40"
                    />
                  </div>
                </div>
              )}

              <label className="text-[11px] font-semibold text-muted mb-1 block">Relay address (PC running the helper)</label>
              <input
                type="text" value={relayHost} onChange={e => setRelayHost(e.target.value)}
                placeholder="e.g. 192.168.1.50:8787"
                className="w-full mb-3 px-3 py-2 rounded-lg bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 font-mono"
              />

              <div className="flex gap-2 mb-4">
                <div className="flex-2">
                  <label className="text-[11px] font-semibold text-muted mb-1 block">Printer IP</label>
                  <input
                    type="text" value={printerIp} onChange={e => setPrinterIp(e.target.value)}
                    placeholder="e.g. 192.168.1.87"
                    className="w-full px-3 py-2 rounded-lg bg-surface2 border border-white/8 text-sm text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 font-mono"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[11px] font-semibold text-muted mb-1 block">Port</label>
                  <input
                    type="text" value={printerPort} onChange={e => setPrinterPort(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-surface2 border border-white/8 text-sm text-slate-100 outline-none focus:border-teal/40 font-mono"
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStickerOpen(false)}
                  disabled={stickerSending}
                  className="flex-1 py-3 rounded-xl border border-white/8 bg-surface2 text-muted text-sm font-semibold disabled:opacity-50"
                >Cancel</button>
                <button
                  onClick={handlePrintWifi}
                  disabled={stickerSending}
                  className="flex-2 py-3 rounded-xl text-navy text-sm font-bold bg-linear-to-r from-teal to-teal/70 shadow-[0_4px_14px_rgba(0,212,255,0.3)] disabled:opacity-50"
                >
                  {stickerSending ? 'Sending…' : 'Send to Printer 📶'}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-300 print-hide px-5 py-2.5 rounded-xl border text-sm font-semibold shadow-2xl whitespace-nowrap pointer-events-none ${
              toast.type === 'error'
                ? 'bg-danger/15 border-danger/40 text-danger'
                : 'bg-success/15 border-success/40 text-success'
            }`}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Barcode label component ────────────────────────────────────────────────────

function BarcodeLabel({ product }: { product: Product }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !product.stock_keeping_unit) return;
    import('jsbarcode').then(mod => {
      const JsBarcode = mod.default;
      try {
        JsBarcode(svgRef.current!, product.stock_keeping_unit!, {
          format:       'CODE128',
          width:        1.2,
          height:       32,
          displayValue: true,
          fontSize:     7,
          margin:       2,
          background:   '#ffffff',
          lineColor:    '#000000',
          textMargin:   2,
        });
      } catch (_) {
        if (svgRef.current) {
          svgRef.current.parentElement!.innerHTML = '<div class="label-nosku">BAD SKU</div>';
        }
      }
    });
  }, [product.stock_keeping_unit]);

  return (
    <div className="label">
      {product.stock_keeping_unit ? (
        <div style={{ maxWidth: '100%', overflow: 'hidden' }}>
          <svg ref={svgRef} />
        </div>
      ) : (
        <div className="label-nosku">{product.product_name.substring(0, 16)}</div>
      )}
      <div className="label-name">{product.product_name}</div>
      {product.selling_price != null && (
        <div className="label-price">Ksh {product.selling_price}</div>
      )}
    </div>
  );
}
