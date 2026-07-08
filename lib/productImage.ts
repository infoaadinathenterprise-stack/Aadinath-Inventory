// Branded product-image generator.
//
// Produces a clean, on-theme SVG tile per product — a category icon + the
// product name on the site's gradient background — so every product has a
// consistent, professional image with no third-party logos and nothing that
// can ever be "the wrong product". Deterministic from the product's own data.
//
// The result is a data URL that drops straight into an <img src> or the
// products.image_url column.

import type { Product } from '@/lib/types';

// ── Category icons (24×24, stroke-outline so one style renders them all) ─────
const ICONS: Record<string, string> = {
  battery:  '<rect x="3.5" y="8.5" width="13" height="7" rx="1"/><path d="M16.5 11h2.5v2h-2.5"/><path d="M6 6.8v1.7M13 6.8v1.7"/><path d="M7 12h2M12.5 12h2M13.5 11v2"/>',
  pump:     '<path d="M12 4.5c3.2 4 4.8 6 4.8 8.4A4.8 4.8 0 0 1 7.2 12.9C7.2 10.5 8.8 8.5 12 4.5z"/><path d="M10 13.2a2 2 0 0 0 2 1.9"/>',
  blower:   '<path d="M4 8.5h8.5a2.4 2.4 0 1 0-2.4-2.4"/><path d="M4 12.5h11a2.7 2.7 0 1 1-2.7 2.7"/><path d="M4 16.3h6.5a1.9 1.9 0 1 1-1.9 1.9"/>',
  compressor:'<circle cx="12" cy="12" r="8"/><path d="M12 12l3.4-2.6"/><path d="M12 4.5v1.6M19.5 12H18M12 19.5V18M4.5 12H6"/>',
  motor:    '<rect x="4" y="8" width="11" height="8" rx="1.4"/><path d="M6.5 8V6.6M9.5 8V6.6M12.5 8V6.6"/><path d="M15 10.5h3.5v3H15"/><circle cx="9.5" cy="12" r="1.3"/>',
  generator:'<rect x="4" y="7" width="16" height="11" rx="2"/><path d="M12.4 9.4l-1.8 3.3h2.4l-1.8 3.3"/><path d="M7 7V5.4M17 7V5.4"/>',
  bearing:  '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.3"/><circle cx="12" cy="5.6" r=".9"/><circle cx="12" cy="18.4" r=".9"/><circle cx="5.6" cy="12" r=".9"/><circle cx="18.4" cy="12" r=".9"/><circle cx="7.4" cy="7.4" r=".9"/><circle cx="16.6" cy="16.6" r=".9"/><circle cx="16.6" cy="7.4" r=".9"/><circle cx="7.4" cy="16.6" r=".9"/>',
  tyre:     '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.3"/><path d="M12 4v1.8M12 18.2V20M4 12h1.8M18.2 12H20M6.3 6.3l1.3 1.3M16.4 16.4l1.3 1.3M17.7 6.3l-1.3 1.3M7.6 16.4l-1.3 1.3"/>',
  wheel:    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.5"/><path d="M12 4.2v6M12 13.8v6M4.2 12h6M13.8 12h6M6.6 6.6l4.2 4.2M13.2 13.2l4.2 4.2M17.4 6.6l-4.2 4.2M10.8 13.2l-4.2 4.2"/>',
  blade:    '<circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.4"/><path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>',
  cable:    '<rect x="3" y="3.5" width="4" height="3" rx="1"/><rect x="17" y="17.5" width="4" height="3" rx="1"/><path d="M5 6.5v3.5a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3v1.5"/>',
  bolt:     '<path d="M8.2 5l3.8-1.8L15.8 5v2.6l-3.8 1.8-3.8-1.8z"/><path d="M10.5 9.6h3v8.2l-1.5 1.6-1.5-1.6z"/><path d="M10.5 12h3M10.5 14h3M10.5 16h3"/>',
  filter:   '<path d="M6 5.5h12l-1.6 3.8v7.4l-2.8 1.8-2.8-1.8-2.8-1.8V9.3z"/><path d="M6.7 9.3h10.6"/><path d="M9 12.4h6M10 15h4"/>',
  bulb:     '<path d="M12 3.5a5.6 5.6 0 0 0-3.7 9.8c.9.9 1.2 1.6 1.3 2.4h4.8c.1-.8.4-1.5 1.3-2.4A5.6 5.6 0 0 0 12 3.5z"/><path d="M9.6 18h4.8M10.4 20.4h3.2"/>',
  sparkplug:'<path d="M10 3.5h4v3.5h-4z"/><path d="M9.6 7h4.8v4.6l-1 1v3.4h-2.8v-3.4l-1-1z"/><path d="M11 19.5h2v1.8h-2z"/>',
  gear:     '<circle cx="12" cy="12" r="3.4"/><path d="M12 2.6v3M12 18.4v3M21.4 12h-3M5.6 12h-3M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1M18.6 18.6l-2.1-2.1M7.5 7.5L5.4 5.4"/>',
  wrench:   '<path d="M15.6 4.4a4 4 0 0 0-5.1 5L4.6 15.3l2.6 2.6 5.9-5.9a4 4 0 0 0 5-5.1l-2.4 2.4-2.2-.4-.4-2.2z"/>',
  pipe:     '<rect x="3" y="3" width="4.2" height="4.2" rx="1"/><path d="M5.1 7.2v5a3.5 3.5 0 0 0 3.5 3.5h4.5"/><path d="M13 12.2l3.4 3.4-3.4 3.4v-2.2h-2.2v-2.4H13z"/>',
  engine:   '<rect x="4.5" y="9" width="10" height="7" rx="1"/><path d="M14.5 11h2.5l1.5-1.5h1.5v6H18l-1.5-1.5h-2.5"/><path d="M6.5 9V6.8h4V9M7 12h3"/>',
  part:     '<path d="M12 3.2l8 4.4v8.8L12 20.8l-8-4.4V7.6z"/><path d="M12 3.2v17.6M4 7.6l8 4.4 8-4.4"/>',
};

// First matching rule wins — order specific before generic.
const RULES: { icon: string; keys: string[] }[] = [
  { icon: 'battery',    keys: ['batter'] },
  { icon: 'compressor', keys: ['compress'] },
  { icon: 'blower',     keys: ['blower', 'blow', 'fan', 'ventil'] },
  { icon: 'pump',       keys: ['pump', 'booster', 'submersible'] },
  { icon: 'generator',  keys: ['generat', 'genset', 'inverter'] },
  { icon: 'motor',      keys: ['alternator', 'dynamo', 'motor', 'starter', 'armature'] },
  { icon: 'bearing',    keys: ['bearing'] },
  { icon: 'tyre',       keys: ['tyre', 'tire', 'inner tube'] },
  { icon: 'wheel',      keys: ['wheel', 'bicycle', 'cycle', 'rim', 'spoke'] },
  { icon: 'blade',      keys: ['cutter', 'blade', 'saw', 'chaff', 'brush', 'mower', 'trimmer', 'disc', 'sharpen'] },
  { icon: 'sparkplug',  keys: ['pulser', 'spark', 'ignition', 'plug', 'cdi'] },
  { icon: 'cable',      keys: ['cable', 'wire', 'cord', 'harness'] },
  { icon: 'bolt',       keys: ['bolt', 'nut', 'screw', 'fastener', 'stud', 'washer', 'rivet'] },
  { icon: 'filter',     keys: ['filter', 'strainer'] },
  { icon: 'bulb',       keys: ['light', 'lamp', 'bulb', 'led', 'headl', 'torch'] },
  { icon: 'gear',       keys: ['gear', 'sprocket', 'clutch', 'chain', 'coil'] },
  { icon: 'wrench',     keys: ['tool', 'spanner', 'wrench', 'plier'] },
  { icon: 'pipe',       keys: ['pipe', 'hose', 'fitting', 'nozzle', 'valve', 'coupling', 'elbow'] },
  { icon: 'engine',     keys: ['engine', 'piston', 'crank', 'cylinder head'] },
];

function pickIcon(p: Product): string {
  const hay = `${p.type ?? ''} ${p.product_name ?? ''}`.toLowerCase();
  for (const r of RULES) if (r.keys.some(k => hay.includes(k))) return r.icon;
  return 'part';
}

function xesc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Wrap a name into at most `maxLines` lines of ~maxChars, adding an ellipsis
// if it still overflows.
function wrapName(name: string, maxChars: number, maxLines: number): string[] {
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  // Overflow → ellipsis on the last line.
  const used = lines.join(' ');
  if (used.length < name.trim().length && lines.length > 0) {
    let last = lines[maxLines - 1] ?? lines[lines.length - 1];
    if (last.length > maxChars - 1) last = last.slice(0, maxChars - 1);
    lines[lines.length - 1] = last.replace(/\s+$/, '') + '…';
  }
  return lines.slice(0, maxLines);
}

// Full 400×400 SVG markup for a product.
export function productImageSvg(p: Product): string {
  const icon = ICONS[pickIcon(p)] ?? ICONS.part;
  const type = (p.type ?? '').toUpperCase();
  const nameLines = wrapName(p.product_name ?? '', 22, 2);

  const nameY = nameLines.length === 2 ? [327, 351] : [338];
  const nameSvg = nameLines
    .map((ln, i) => `<text x="200" y="${nameY[i]}" text-anchor="middle" fill="#cbd5e1" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="600">${xesc(ln)}</text>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#12203a"/>
    <stop offset="1" stop-color="#0a111e"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.4" r="0.6">
    <stop offset="0" stop-color="#38bdf8" stop-opacity="0.18"/>
    <stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="400" height="400" fill="url(#bg)"/>
<rect width="400" height="400" fill="url(#glow)"/>
<circle cx="200" cy="168" r="118" fill="none" stroke="#38bdf8" stroke-opacity="0.10" stroke-width="1.5"/>
<circle cx="200" cy="168" r="90" fill="#0e1a30" stroke="#ffffff" stroke-opacity="0.06"/>
<g transform="translate(200 168) scale(6.1) translate(-12 -12)" fill="none" stroke="#7dd3fc" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icon}</g>
${type ? `<text x="200" y="299" text-anchor="middle" fill="#f6c453" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="700" letter-spacing="2.5">${xesc(type)}</text>` : ''}
${nameSvg}
<text x="200" y="384" text-anchor="middle" fill="#5b6b85" font-family="Arial, Helvetica, sans-serif" font-size="10" font-weight="700" letter-spacing="3">JAY AADINATH</text>
</svg>`;
}

// Data URL suitable for <img src> and the products.image_url column.
export function productImageDataUrl(p: Product): string {
  return `data:image/svg+xml,${encodeURIComponent(productImageSvg(p))}`;
}
