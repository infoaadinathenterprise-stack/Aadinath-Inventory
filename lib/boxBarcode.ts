// ─────────────────────────────────────────────────────────────────────────────
//  Box vs piece barcodes.
//
//  A PIECE sticker's barcode is the plain SKU → sold as 1 piece.
//
//  A BOX sticker's barcode is "BX<box_id>" (e.g. BX123): a saved box in the
//  product_boxes table, with its own piece count. The POS looks the box up,
//  sells all its pieces at the piece price and marks it sold, so the same box
//  can't be sold twice. Short, so it prints cleanly on small labels.
//
//  Older box stickers carry "BX:<SKU>:<pcs>" (no saved box behind them) and
//  still scan as a box of <pcs> pieces. A SKU starts with a 4-digit id, so it
//  never collides with either box format.
// ─────────────────────────────────────────────────────────────────────────────

export const BOX_PREFIX = 'BX:';

// Barcode for a saved box (product_boxes.box_id).
export function savedBoxBarcode(boxId: number): string {
  return `BX${boxId}`;
}

// Barcode for an old-style unsaved box: marker + SKU + piece count.
export function boxBarcodeValue(sku: string, pcs: number): string {
  return `${BOX_PREFIX}${sku}:${pcs}`;
}

export type ParsedScan =
  | { kind: 'savedBox'; boxId: number }
  | { kind: 'box'; value: string; boxPcs: number | null }   // old "BX:<SKU>:<pcs>"
  | { kind: 'piece'; value: string };

// Work out what a scanned/typed code is.
export function parseScan(code: string): ParsedScan {
  const c = (code ?? '').trim();
  const saved = /^BX(\d+)$/i.exec(c);
  if (saved) return { kind: 'savedBox', boxId: Number(saved[1]) };
  if (!c.toUpperCase().startsWith(BOX_PREFIX)) return { kind: 'piece', value: c };
  const rest = c.slice(BOX_PREFIX.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > 0) {
    const pcs = parseInt(rest.slice(lastColon + 1), 10);
    return { kind: 'box', value: rest.slice(0, lastColon).trim(), boxPcs: Number.isFinite(pcs) && pcs > 0 ? pcs : null };
  }
  return { kind: 'box', value: rest.trim(), boxPcs: null };
}
