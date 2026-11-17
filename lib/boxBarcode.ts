// ─────────────────────────────────────────────────────────────────────────────
//  Box vs piece barcodes.
//
//  A product that comes several-to-a-box can get TWO stickers per physical box:
//   • a PIECE sticker whose barcode is the plain SKU            → sold as 1 piece
//   • a BOX sticker whose barcode is "BX:<SKU>:<pcs>"           → sold as 1 box
//
//  The box barcode carries THAT box's piece count, so boxes of the same product
//  may hold different amounts (80, 75, …). At the POS a box is charged as
//  pcs × piece price and deducts pcs pieces — i.e. a normal piece sale of `pcs`
//  pieces, just displayed and counted as one box. Plain-SKU piece labels keep
//  working unchanged; a SKU starts with a 4-digit id so it never collides with
//  the "BX:" marker.
// ─────────────────────────────────────────────────────────────────────────────

export const BOX_PREFIX = 'BX:';

// The value encoded in a box sticker's Code128 barcode: marker + SKU + piece
// count of this particular box.
export function boxBarcodeValue(sku: string, pcs: number): string {
  return `${BOX_PREFIX}${sku}:${pcs}`;
}

// Split a scanned/typed code into the underlying SKU (or name), whether it was
// a box barcode, and (for a box) how many pieces that box holds.
export function parseScan(code: string): { value: string; isBox: boolean; boxPcs: number | null } {
  const c = (code ?? '').trim();
  if (!c.toUpperCase().startsWith(BOX_PREFIX)) {
    return { value: c, isBox: false, boxPcs: null };
  }
  const rest = c.slice(BOX_PREFIX.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > 0) {
    const pcs = parseInt(rest.slice(lastColon + 1), 10);
    return { value: rest.slice(0, lastColon).trim(), isBox: true, boxPcs: Number.isFinite(pcs) && pcs > 0 ? pcs : null };
  }
  return { value: rest.trim(), isBox: true, boxPcs: null };
}
