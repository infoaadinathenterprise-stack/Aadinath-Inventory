'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { logout as apiLogout } from '@/lib/auth';
import AdminNavbar from '@/app/admin/components/AdminNavbar';
import BluetoothPrinterTest from '@/app/admin/components/BluetoothPrinterTest';
import { useProducts } from '@/lib/hooks/useProducts';
import { stockTxn, type StockOp } from '@/lib/stockActions';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import { SESSION_KEY, ROLE_KEY, USER_KEY, DEFAULT_COMPANY_ID } from '@/lib/types';
import { savedBoxBarcode } from '@/lib/boxBarcode';

type SortBy = 'recent' | 'name';

// ── WiFi sticker printer (XB330B) ───────────────────────────────────────────────
// Bridges to a small relay helper (sticker-relay/server.js) running on a PC on
// the same WiFi network, which forwards raw TSPL commands to the printer's IP.
// Browsers can't open raw TCP sockets, and Safari/iOS has no Web Bluetooth, so
// the page reaches the relay via a plain HTTP form POST (a top-level page
// navigation isn't subject to mixed-content blocking the way a fetch() would be).

const STICKER_DPI = 203; // standard resolution for this printer family
// The XP-330B can't print the leftmost ~2.75 mm of a 40 mm label (see
// sticker-relay/relay-config.json); keep the barcode and text clear of it.
const LEFT_UNPRINTABLE_MM = 3;

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

// Follows a print job until the printer PC reports done/failed (up to a
// minute). null = no reply yet.
async function waitForPrintJob(jobId: number): Promise<{ status: string; message: string | null } | null> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    await new Promise(r => setTimeout(r, 1500));
    const { data: st } = await supabase.from('print_jobs').select('status, message').eq('job_id', jobId).single();
    if (st && (st.status === 'done' || st.status === 'failed')) return st as { status: string; message: string | null };
  }
  return null;
}

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
async function renderLabelBitmap(
  product: Product,
  widthMm: number,
  heightMm: number,
  variant: 'piece' | 'box' = 'piece',
  opts: { boxPcs?: number; boxId?: number; note?: string } = {},
): Promise<LabelBitmap> {
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

  // Printable area. The sticker printer can't reach the leftmost ~3 mm of the
  // label (the helper shifts everything left to centre it, and what falls off
  // the edge is lost), so nothing is drawn there. That strip is still white
  // paper, so it doubles as the barcode's left quiet zone.
  const safeLeft  = Math.round((LEFT_UNPRINTABLE_MM / 25.4) * STICKER_DPI);
  const safeRight = widthPx - Math.round((0.5 / 25.4) * STICKER_DPI);
  const centerX   = Math.round((safeLeft + safeRight) / 2);
  const maxTextW  = safeRight - safeLeft - 4;
  ctx.textAlign = 'center';

  // Shrinks a font until the text fits the printable width.
  function fitFont(text: string, weight: string, startPx: number, minPx: number, family = 'sans-serif'): number {
    let px = startPx;
    ctx!.font = `${weight} ${px}px ${family}`;
    while (px > minPx && ctx!.measureText(text).width > maxTextW) { px -= 1; ctx!.font = `${weight} ${px}px ${family}`; }
    return px;
  }

  let y = Math.round(heightPx * 0.04);
  if (product.stock_keeping_unit) {
    const sku         = product.stock_keeping_unit;
    // The barcode encodes EXACTLY the product's SKU (what the POS and stock
    // pages look up). A box sticker's barcode is its saved box number
    // (BX<id>); the POS looks the box up and sells all its pieces.
    const barcodeData = variant === 'box' && opts.boxId ? savedBoxBarcode(opts.boxId) : sku;
    const barcodeText = variant === 'box' && opts.boxId ? `${sku} · BOX #${opts.boxId}` : sku;
    try {
      // DataMatrix instead of a 1D barcode: it reads instantly on the shop's
      // 2D imager (Syble XB-6221RB), packs a long SKU into a small square
      // rather than the hair-thin 1D bars that overflowed a 40 mm label, and
      // decodes to the exact same text (the SKU, or BX<id> for a box) so the
      // POS lookup is unchanged.
      const bwip = (await import('bwip-js/browser')).default;
      // Render at a whole number of printer dots per module (never scaled) so
      // the squares stay crisp on the thermal head. Use the largest module
      // (scale 4→2 ≈ 1.0→0.5 mm) whose symbol still fits about half the label.
      const maxDim = Math.round(heightPx * 0.5);
      let dm: HTMLCanvasElement | null = null;
      for (const sc of [4, 3, 2]) {
        const c = document.createElement('canvas');
        bwip.toCanvas(c, { bcid: 'datamatrix', text: barcodeData, scale: sc, backgroundcolor: 'ffffff', barcolor: '000000' });
        if (c.width <= maxDim || sc === 2) { dm = c; break; }
      }
      const d = dm!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(d, Math.round(centerX - d.width / 2), y);
      y += d.height + 6;
      // The code in plain text under the square.
      const skuPx = fitFont(barcodeText, '600', Math.round(heightPx * 0.10), 9, 'monospace');
      ctx.font = `600 ${skuPx}px monospace`;
      ctx.textBaseline = 'top';
      ctx.fillText(barcodeText, centerX, y);
      y += skuPx + 6;
    } catch {
      ctx.textBaseline = 'top';
      ctx.font = `${Math.round(heightPx * 0.16)}px monospace`;
      ctx.fillText('BAD SKU', centerX, y);
      y += Math.round(heightPx * 0.2);
    }
  } else {
    ctx.textBaseline = 'top';
    ctx.font = `${Math.round(heightPx * 0.16)}px monospace`;
    ctx.fillText(product.product_name.slice(0, 16), centerX, y);
    y += Math.round(heightPx * 0.2);
  }

  // Unit tag — bold and large so staff can tell a BOX sticker from a loose
  // PCS sticker at a glance ("BOX #12 · 80 PCS" or "PCS").
  if (opts.note) {
    const notePx = fitFont(opts.note, '800', Math.max(11, Math.round(heightPx * 0.125)), 10);
    ctx.font = `800 ${notePx}px sans-serif`;
    ctx.fillText(opts.note, centerX, y);
    y += notePx + 5;
  }

  // Product name (no price on stickers): up to two lines in the space left.
  const room = heightPx - y - 4;
  const { lines: nameLines, fontPx: nameFontPx } = fitNameLines(
    ctx, product.product_name, maxTextW,
    Math.min(Math.round(heightPx * 0.12), Math.floor(room / 2.3)), Math.max(8, Math.round(heightPx * 0.06)),
  );
  ctx.font = `700 ${nameFontPx}px sans-serif`;
  const block = nameLines.length === 1 ? nameFontPx : nameFontPx * 2.15;
  let ny = y + Math.max(0, (room - block) / 2);
  for (const line of nameLines.slice(0, 2)) {
    ctx.fillText(line, centerX, ny);
    ny += nameFontPx * 1.15;
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
  const [viewMode, setViewMode]   = useState<'all' | 'selected'>('all');
  const [toast,    setToast]      = useState<{ msg: string; type: string } | null>(null);
  const [stockModal, setStockModal] = useState<{ mode: 'add' | 'remove'; product: Product } | null>(null);
  const [stockQty,   setStockQty]   = useState(1);
  const [stockSaving, setStockSaving] = useState(false);
  const toastRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // WiFi sticker printer (XB330B via relay helper)
  const [stickerOpen,    setStickerOpen]    = useState(false);
  const [stickerSending, setStickerSending] = useState(false);
  const [labelSize,      setLabelSize]      = useState<LabelPresetKey>(() => readLS('sticker.labelSize', '40x30') as LabelPresetKey);
  const [customWidthMm,  setCustomWidthMm]  = useState<number>(() => Number(readLS('sticker.customWidthMm', '40')));
  const [customHeightMm, setCustomHeightMm] = useState<number>(() => Number(readLS('sticker.customHeightMm', '30')));
  // Per product: print PIECE stickers (plain SKU, `copies` of them) or BOX
  // stickers (one per physical box, scans as a box at the POS).
  const [units,          setUnits]          = useState<Record<number, 'pcs' | 'box'>>({});
  // Box mode: pcs in each box, comma-separated — "80, 75" = two boxes of 80
  // and 75. Blank = one box of the product's pieces_per_box.
  const [boxSizes,       setBoxSizes]       = useState<Record<number, string>>({});
  // Saved, still-sealed boxes (product_boxes), and which products should
  // reprint theirs in this batch.
  type SavedBox = { box_id: number; product_id: number; location_id: number | null; pcs: number };
  const [savedBoxes,     setSavedBoxes]     = useState<SavedBox[]>([]);
  const [reprint,        setReprint]        = useState<Record<number, boolean>>({});
  const loadSavedBoxes = useCallback(async () => {
    const { data } = await supabase.from('product_boxes')
      .select('box_id, product_id, location_id, pcs').eq('status', 'sealed').order('box_id');
    setSavedBoxes((data ?? []) as SavedBox[]);
  }, []);
  useEffect(() => {
    let cancelled = false;
    supabase.from('product_boxes').select('box_id, product_id, location_id, pcs').eq('status', 'sealed').order('box_id')
      .then(({ data }) => { if (!cancelled) setSavedBoxes((data ?? []) as SavedBox[]); });
    return () => { cancelled = true; };
  }, []);
  // Products already printed this batch. Shared in the database
  // (labels_printed) so a label printed from the phone shows "✓ Printed" on
  // the PC too. Re-printing one asks for confirmation first.
  const [printed,        setPrinted]        = useState<Record<number, boolean>>({});
  const loadPrinted = useCallback(async (): Promise<Record<number, boolean> | null> => {
    const { data, error } = await supabase.from('labels_printed').select('product_id');
    if (error) return null;   // couldn't read: keep what's on screen
    const next: Record<number, boolean> = {};
    for (const r of (data ?? []) as { product_id: number }[]) next[r.product_id] = true;
    setPrinted(next);
    return next;
  }, []);
  // Pick up marks made on other devices: on open, every 5 s while visible, and on return to the tab.
  useEffect(() => {
    try { localStorage.removeItem('sticker.printed'); } catch { /* old per-browser copy */ }
    const first = setTimeout(loadPrinted, 0);
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadPrinted(); }, 5000);
    const onShow = () => { if (document.visibilityState === 'visible') loadPrinted(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow); };
  }, [loadPrinted]);
  async function markPrinted(ids: number[]) {
    setPrinted(prev => { const next = { ...prev }; for (const id of ids) next[id] = true; return next; });
    const by = (() => { try { return localStorage.getItem(USER_KEY); } catch { return null; } })();
    const { error } = await supabase.from('labels_printed').upsert(
      ids.map(product_id => ({ product_id, printed_by: by, printed_at: new Date().toISOString() })),
    );
    if (error) showToast('Printed, but the ✓ mark could not be saved for other devices: ' + error.message, 'error');
  }
  const [relayHost,      setRelayHost]      = useState<string>(() => readLS('sticker.relayHost', ''));
  const [printerIp,      setPrinterIp]      = useState<string>(() => readLS('sticker.printerIp', ''));
  const [printerPort,    setPrinterPort]    = useState<string>(() => readLS('sticker.printerPort', '9100'));

  useEffect(() => { localStorage.setItem('sticker.labelSize', labelSize); }, [labelSize]);
  useEffect(() => { localStorage.setItem('sticker.customWidthMm', String(customWidthMm)); }, [customWidthMm]);
  useEffect(() => { localStorage.setItem('sticker.customHeightMm', String(customHeightMm)); }, [customHeightMm]);
  useEffect(() => { localStorage.setItem('sticker.relayHost', relayHost); }, [relayHost]);
  useEffect(() => { localStorage.setItem('sticker.printerIp', printerIp); }, [printerIp]);
  useEffect(() => { localStorage.setItem('sticker.printerPort', printerPort); }, [printerPort]);

  // How the job reaches the printer:
  //  online = through the database to the helper on the printer PC (any device)
  //  direct = the old form post straight to a helper address on this network
  const [sendVia, setSendVia] = useState<'online' | 'direct'>(() => (readLS('sticker.sendVia', 'online') === 'direct' ? 'direct' : 'online'));
  useEffect(() => { localStorage.setItem('sticker.sendVia', sendVia); }, [sendVia]);

  // Printer settings are shared: saved once in the database (print_settings)
  // and filled in on every device, phone included. This browser's copy above
  // only covers the moment before the shared settings arrive.
  const settingsLoaded = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('print_settings').select('settings').eq('id', 1).maybeSingle();
      if (cancelled || error) return; // couldn't read: don't overwrite the shared copy either
      const s = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
      if (typeof s.labelSize === 'string' && LABEL_PRESETS.some(p => p.key === s.labelSize)) setLabelSize(s.labelSize as LabelPresetKey);
      if (Number(s.customWidthMm) > 0)  setCustomWidthMm(Number(s.customWidthMm));
      if (Number(s.customHeightMm) > 0) setCustomHeightMm(Number(s.customHeightMm));
      if (s.sendVia === 'online' || s.sendVia === 'direct') setSendVia(s.sendVia);
      if (typeof s.printerIp === 'string')   setPrinterIp(s.printerIp);
      if (typeof s.printerPort === 'string') setPrinterPort(s.printerPort);
      if (typeof s.relayHost === 'string')   setRelayHost(s.relayHost);
      settingsLoaded.current = true;
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const t = setTimeout(() => {
      supabase.from('print_settings').upsert({
        id: 1,
        settings: { labelSize, customWidthMm, customHeightMm, sendVia, printerIp, printerPort, relayHost },
        updated_at: new Date().toISOString(),
      }).then(() => { /* best effort; next change retries */ });
    }, 800);
    return () => clearTimeout(t);
  }, [labelSize, customWidthMm, customHeightMm, sendVia, printerIp, printerPort, relayHost]);

  // Printer laptop online? (its helper checks in every 2 s while running) and
  // is the sticker printer plugged into it? (reported every 15 s)
  const [relaySeen, setRelaySeen] = useState<{
    checked: boolean; online: boolean; ago: number | null;
    printerConnected: boolean | null; queueFound: boolean | null;
  }>({ checked: false, online: false, ago: null, printerConnected: null, queueFound: null });
  useEffect(() => {
    if (!stickerOpen || sendVia !== 'online') return;
    let cancelled = false;
    async function check() {
      const { data, error } = await supabase.rpc('print_relay_status');
      if (cancelled) return;
      const d    = (!error && data ? data : {}) as { last_seen?: string | null; info?: { printerConnected?: boolean; queueFound?: boolean } | null };
      const last = d.last_seen;
      const ago  = last ? Math.max(0, Math.round((Date.now() - new Date(last).getTime()) / 1000)) : null;
      setRelaySeen({
        checked: true, online: ago != null && ago < 20, ago,
        // Older helpers don't report the printer: unknown, not "unplugged".
        printerConnected: typeof d.info?.printerConnected === 'boolean' ? d.info.printerConnected : null,
        queueFound:       typeof d.info?.queueFound === 'boolean' ? d.info.queueFound : null,
      });
    }
    check();
    const t = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [stickerOpen, sendVia]);

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

  // Normal number field: clearing it means 0 (the product stays ticked but
  // prints nothing until a number is typed).
  function setCopies(id: number, val: string) {
    const n = Math.max(0, parseInt(val, 10) || 0);
    setSelected(sel => ({ ...sel, [id]: n }));
  }

  function selectAll() {
    const next: Selected = {};
    inLocStock.forEach(p => { next[p.product_id] = Math.max(1, stockMap[p.product_id] || 1); });
    setSelected(next);
  }

  function clearAll() {
    setSelected({});
    setUnits({});
    setBoxSizes({});
    setPrinted({});
    // Clear the shared marks too, so every device starts a fresh batch.
    supabase.from('labels_printed').delete().gte('product_id', 0)
      .then(({ error }) => { if (error) { showToast('Could not clear printed marks: ' + error.message, 'error'); loadPrinted(); } });
  }

  const selectedProducts = useMemo(
    () => products.filter(p => selected[p.product_id] != null),
    [products, selected],
  );
  const sizeSuggestion = useMemo(
    () => (typeof window !== 'undefined' ? suggestLabelSize(selectedProducts) : null),
    [selectedProducts],
  );

  // Box mode: the boxes to print for a product — one entry (its piece count)
  // per physical box. Comes ONLY from the sizes typed for it, never from the
  // piece stock; blank = a single box of pieces_per_box. Empty = can't tell.
  // NEW boxes to make and print. Blank = one box of pieces_per_box, unless
  // this batch only reprints the product's saved boxes.
  function boxesFor(p: Product): number[] {
    const raw = (boxSizes[p.product_id] ?? '').trim();
    const sized = raw ? raw.split(/[,\s]+/).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0) : [];
    if (sized.length) return sized;
    if (reprint[p.product_id]) return [];
    const ppb = p.pieces_per_box ?? 0;
    return ppb > 0 ? [ppb] : [];
  }
  // This product's sealed boxes at the current location.
  const savedFor = (p: Product) => savedBoxes.filter(b => b.product_id === p.product_id && b.location_id === locationId);
  const reprintFor = (p: Product) => (reprint[p.product_id] ? savedFor(p) : []);
  const unitOf = (id: number) => units[id] ?? 'pcs';

  // Stickers that will come out: piece copies, or one per box.
  const totalLabels = selectedProducts.reduce(
    (n, p) => n + (unitOf(p.product_id) === 'box' ? boxesFor(p).length + reprintFor(p).length : (selected[p.product_id] ?? 0)),
    0,
  );

  async function handlePrintWifi() {
    const relay = relayHost.trim();
    const ip    = sendVia === 'online' ? (printerIp.trim() || 'usb') : printerIp.trim();
    if (sendVia === 'direct') {
      if (!relay) { showToast('Enter the relay address (e.g. 192.168.1.50:8787)', 'error'); return; }
      if (!ip)    { showToast("Enter the printer's IP address", 'error'); return; }
    }

    const preset  = LABEL_PRESETS.find(p => p.key === labelSize);
    const widthMm  = labelSize === 'custom' ? customWidthMm  : preset?.widthMm  ?? 50;
    const heightMm = labelSize === 'custom' ? customHeightMm : preset?.heightMm ?? 30;
    if (widthMm <= 0 || heightMm <= 0) { showToast('Enter a valid label size', 'error'); return; }

    // Pcs products print their copies (0 = skip); box products print boxes.
    const entries = Object.entries(selected).filter(([pid, copies]) => unitOf(Number(pid)) === 'box' || copies > 0);
    if (entries.length === 0) { showToast('Select products to print first', 'error'); return; }

    // Guard against accidental double-printing: if any selected product was
    // already printed this batch, ask before printing it again.
    // Fresh from the database, so a label just printed on another device counts.
    const printedNow = (await loadPrinted()) ?? printed;
    const already = entries.map(([pid]) => Number(pid)).filter(id => printedNow[id]);
    if (already.length > 0) {
      const names = already.map(id => products.find(p => p.product_id === id)?.product_name).filter(Boolean) as string[];
      if (!window.confirm(`Already printed: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}\n\nPrint these again?`)) return;
    }

    setStickerSending(true);
    try {
      const jobs = [];
      const needInfo: string[] = [];
      for (const [pid, copies] of entries) {
        const product = products.find(p => p.product_id === Number(pid));
        if (!product) continue;

        if (unitOf(product.product_id) === 'pcs') {
          const bm = await renderLabelBitmap(product, widthMm, heightMm, 'piece', { note: 'PCS' });
          jobs.push({ ...bm, widthMm, heightMm, copies });
          continue;
        }

        // Box: save each NEW box (its own number + pcs), then one sticker per
        // box — new ones plus any saved boxes being reprinted.
        const sizes = boxesFor(product);
        const again = reprintFor(product);
        if (sizes.length === 0 && again.length === 0) { needInfo.push(product.product_name); continue; }
        let made: SavedBox[] = [];
        if (sizes.length) {
          const { data: rows, error: boxErr } = await supabase.from('product_boxes')
            .insert(sizes.map(pcs => ({ product_id: product.product_id, location_id: locationId, pcs })))
            .select('box_id, product_id, location_id, pcs');
          if (boxErr || !rows) throw new Error(`Could not save the boxes for ${product.product_name}: ${boxErr?.message ?? 'no reply'}`);
          made = rows as SavedBox[];
        }
        for (const b of [...again, ...made]) {
          const bmBox = await renderLabelBitmap(product, widthMm, heightMm, 'box', { boxPcs: b.pcs, boxId: b.box_id, note: `BOX #${b.box_id} · ${b.pcs} PCS` });
          jobs.push({ ...bmBox, widthMm, heightMm, copies: 1 });
        }
      }
      // New boxes are saved now: clear the typed sizes so printing again
      // doesn't make duplicates (saved boxes can be reprinted instead).
      if (Object.values(units).includes('box')) { setBoxSizes({}); setReprint({}); loadSavedBoxes(); }
      if (needInfo.length > 0) {
        showToast(`Set pieces-per-box for: ${needInfo.slice(0, 3).join(', ')}${needInfo.length > 3 ? '…' : ''}`, 'error');
      }
      if (jobs.length === 0) { showToast('Nothing to print', 'error'); setStickerSending(false); return; }

      if (sendVia === 'online') {
        const labelCount = jobs.reduce((n, j) => n + (Number(j.copies) || 1), 0);
        const { data: row, error: insErr } = await supabase.from('print_jobs')
          .insert({ payload: { printerIp: ip, printerPort: Number(printerPort) || 9100, jobs }, label_count: labelCount })
          .select('job_id').single();
        if (insErr || !row) throw new Error(insErr?.message ?? 'Could not send the job');

        showToast(`Sent ${labelCount} label${labelCount === 1 ? '' : 's'} — waiting for the printer…`);

        // Follow the job until the printer PC reports back (up to a minute).
        const jobId = (row as { job_id: number }).job_id;
        const finalStatus = await waitForPrintJob(jobId);
        if (finalStatus?.status === 'done') {
          // Only now are these labels really printed — mark them, so a repeat
          // asks first. (A failed or unanswered job leaves them unmarked.)
          await markPrinted(entries.map(([pid]) => Number(pid)));
          // Auto-uncheck everything that just printed so it can't be reprinted
          // by mistake. It keeps its "✓ Printed" badge and can be re-selected
          // by hand if another copy is genuinely needed.
          setSelected(prev => {
            const next = { ...prev };
            for (const [pid] of entries) delete next[Number(pid)];
            return next;
          });
          showToast(`🖨️ Printed ${labelCount} label${labelCount === 1 ? '' : 's'} — unchecked`);
          setStickerOpen(false);
        } else if (finalStatus?.status === 'failed') {
          showToast(`Print failed: ${finalStatus.message ?? 'unknown error'}`, 'error');
        } else {
          showToast('No reply from the printer PC yet — is it on with the sticker helper running? The job waits 10 min.', 'error');
        }
        setStickerSending(false);
        return;
      }

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

      // Mark everything in this batch as printed (saved before the page
      // navigates to the relay), so a repeat needs confirmation on any device.
      await markPrinted(entries.map(([pid]) => Number(pid)));

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
    <div className="h-screen pt-14 print:pt-0 bg-navy flex flex-col overflow-hidden">
      <div className="print-hide">
        <AdminNavbar onLogout={() => { apiLogout(); window.location.href = '/admin'; }} />
      </div>
      <header className="print-hide shrink-0 bg-surface border-b border-white/8 px-4 flex items-center gap-3 h-14">
        <span className="flex-1 text-xs text-muted font-mono whitespace-nowrap">
          {totalLabels} label{totalLabels !== 1 ? 's' : ''}
        </span>
        <button
          onClick={() => setStickerOpen(true)}
          disabled={totalLabels === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal text-navy text-xs font-bold shadow-[0_4px_14px_rgba(0,212,255,0.3)] hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed print-hide"
          title="Choose size and print to the sticker printer"
        >
          🖨️ Print
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex print-hide w-full max-w-3xl mx-auto bg-surface sm:border-x border-white/8 flex-col">
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
              const unit     = unitOf(p.product_id);
              const boxes    = isSel && unit === 'box' ? boxesFor(p) : [];
              const saved    = isSel && unit === 'box' ? savedFor(p) : [];
              const again    = isSel && unit === 'box' ? reprintFor(p) : [];
              const boxTotal = boxes.length + again.length;
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
                    {printed[p.product_id] && (
                      <span className="inline-block mt-1 text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-success/12 border border-success/30 text-success uppercase tracking-wider">✓ Printed</span>
                    )}

                    {/* Selected: print as pieces or boxes */}
                    {isSel && (
                      <div className="mt-1.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <div className="flex rounded-lg border border-white/10 overflow-hidden">
                            {([['pcs', 'Pcs'], ['box', 'Box']] as const).map(([k, lbl]) => (
                              <button
                                key={k}
                                onClick={() => setUnits(u => ({ ...u, [p.product_id]: k }))}
                                className={`px-2.5 py-1 text-[10px] font-bold transition-all ${
                                  unit === k ? 'bg-teal text-navy' : 'bg-surface2 text-muted hover:text-slate-100'
                                }`}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                          {unit === 'box' && (
                            <input
                              type="text"
                              inputMode="numeric"
                              value={boxSizes[p.product_id] ?? ''}
                              onChange={e => setBoxSizes(b => ({ ...b, [p.product_id]: e.target.value }))}
                              placeholder={p.pieces_per_box ? `${p.pieces_per_box} pcs/box` : 'pcs per box'}
                              className="w-28 px-2 py-1 rounded-lg bg-surface2 border border-white/10 text-[11px] text-slate-100 placeholder:text-muted/50 outline-none focus:border-teal/40 font-mono"
                            />
                          )}
                        </div>
                        {unit === 'box' && (
                          <p className={`text-[9px] mt-1 ${boxTotal ? 'text-muted' : 'text-danger'}`}>
                            {boxes.length
                              ? `New: ${boxes.length} box${boxes.length === 1 ? '' : 'es'} — ${boxes.join(' + ')} pcs (saved when printed)`
                              : again.length ? 'No new boxes' : 'Type the pcs in each box, e.g. 20, 30, 20, 40, 50'}
                          </p>
                        )}
                        {unit === 'box' && saved.length > 0 && (
                          <div className="mt-1.5 rounded-lg border border-white/8 bg-surface2/60 p-1.5">
                            <label className="flex items-center gap-1.5 text-[10px] text-slate-200 font-semibold">
                              <input
                                type="checkbox"
                                checked={!!reprint[p.product_id]}
                                onChange={e => setReprint(r => ({ ...r, [p.product_id]: e.target.checked }))}
                              />
                              Reprint saved boxes ({saved.length})
                            </label>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {saved.map(b => (
                                <span key={b.box_id} className="inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded-md bg-surface border border-white/10 text-muted">
                                  #{b.box_id} · {b.pcs} pcs
                                  <button
                                    title="Remove this box (made by mistake)"
                                    onClick={async () => {
                                      if (!window.confirm(`Remove box #${b.box_id} (${b.pcs} pcs)? Its sticker will no longer scan.`)) return;
                                      const { error } = await supabase.rpc('void_box', { p_box_id: b.box_id });
                                      if (error) showToast(error.message, 'error'); else loadSavedBoxes();
                                    }}
                                    className="text-danger/70 hover:text-danger font-bold"
                                  >×</button>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {isSel && unit === 'box' ? (
                    <div className="shrink-0 mt-0.5 flex flex-col items-center gap-0.5" onClick={e => e.stopPropagation()}>
                      <span className="text-xs font-bold text-teal px-2 py-1 rounded-lg border border-teal/30 bg-teal/10">📦 {boxTotal}</span>
                      <span className="text-[9px] font-mono text-muted">/{stock} pcs</span>
                    </div>
                  ) : isSel ? (
                    <div className="shrink-0 mt-0.5 flex flex-col items-center gap-0.5" onClick={e => e.stopPropagation()}>
                      <input
                        type="number"
                        value={copies === 0 ? '' : copies}
                        placeholder="0"
                        min={0}
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
              <h3 className="text-base font-bold text-slate-100 text-center mb-1">🖨️ Sticker Printer</h3>
              <p className="text-xs text-muted text-center mb-3">
                Works from this PC or your phone — the labels go to the printer PC over the internet.
              </p>
              {sendVia === 'online' && (() => {
                // ready = laptop online and printer plugged in (or not reported by an older helper)
                const state = !relaySeen.checked ? 'checking'
                  : !relaySeen.online ? 'laptop-off'
                  : relaySeen.queueFound === false ? 'no-queue'
                  : relaySeen.printerConnected === false ? 'unplugged'
                  : 'ready';
                const tone = state === 'checking' ? 'border-white/10 bg-surface2 text-muted'
                  : state === 'ready' ? 'border-success/30 bg-success/10 text-success'
                  : state === 'unplugged' ? 'border-gold/30 bg-gold/10 text-gold'
                  : 'border-danger/30 bg-danger/10 text-danger';
                const dot = state === 'checking' ? 'bg-muted' : state === 'ready' ? 'bg-success' : state === 'unplugged' ? 'bg-gold' : 'bg-danger';
                const text = {
                  'checking':   'Checking the printer laptop…',
                  'ready':      'Printer ready — laptop online, sticker printer connected',
                  'unplugged':  'Laptop is online, but the sticker printer is not connected — plug in its USB cable',
                  'no-queue':   'Laptop is online, but its sticker print queue is missing — run setup.ps1 on the laptop',
                  'laptop-off': 'Printer laptop is offline — open the laptop and log in (the helper starts by itself). Jobs wait 10 minutes.',
                }[state];
                return (
                  <div className={`mb-4 px-3 py-2 rounded-lg border text-[11px] font-semibold flex items-center gap-2 ${tone}`}>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                    {text}
                  </div>
                );
              })()}

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

              <details className="mb-3 rounded-lg border border-white/8 bg-surface2/50 px-3 py-2" open={sendVia === 'direct'}>
              <summary className="text-[11px] font-semibold text-muted cursor-pointer">Advanced: printer connection</summary>
              <div className="mt-2">
              <label className="flex items-center gap-2 text-[11px] text-slate-200 mb-3">
                <input type="checkbox" checked={sendVia === 'direct'} onChange={e => setSendVia(e.target.checked ? 'direct' : 'online')} />
                Send straight to a helper address on this network (old way)
              </label>
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

              <p className="text-[10px] text-muted mb-3 leading-relaxed">
                Printer IP: <b>usb</b> for the printer on the shop PC&apos;s cable (blank = usb), or a WiFi printer&apos;s IP.
              </p>
              <BluetoothPrinterTest />
              </div>
              </details>

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
                  {stickerSending ? 'Printing…' : 'Print stickers 🖨️'}
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
