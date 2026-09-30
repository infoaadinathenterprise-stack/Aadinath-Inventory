// Minimal .xlsx writer — one sheet, strings and numbers, optional bold rows
// and column widths. Enough for simple exports without pulling in a
// spreadsheet library. The file is a ZIP (stored, no compression) of the
// handful of XML parts Excel needs. Every sheet opens with the company
// letterhead (lib/company.ts) unless `letterhead: false` is passed.

import { COMPANY } from './company';

export type Cell = string | number | null | undefined;

export interface SheetOptions {
  sheetName?:  string;
  boldRows?:   number[];   // 0-based row indexes to render bold
  colWidths?:  number[];   // in Excel "characters"
  letterhead?: boolean;    // default true
}

// Cell style indexes — must match cellXfs in styles.xml below.
// (index 5, centred wrapped italic, is unused since the "Dealers in" line went.)
const S_BOLD = 1, S_TITLE = 2, S_CENTER = 3, S_CENTER_BOLD = 4;

interface Layout {
  rowStyles:  Map<number, number>;
  rowHeights: Map<number, number>;   // in points
  merges:     string[];
}

const enc = new TextEncoder();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // strip control chars that are illegal in XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colName(i: number): string {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: Cell[][], opts: SheetOptions, layout: Layout): string {
  const cols = opts.colWidths?.length
    ? `<cols>${opts.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, r) => {
    const s = layout.rowStyles.get(r);
    const style = s ? ` s="${s}"` : '';
    const cells = row.map((v, c) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = `${colName(c)}${r + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
    }).join('');
    const ht = layout.rowHeights.get(r);
    return `<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells}</row>`;
  }).join('');
  const merges = layout.merges.length
    ? `<mergeCells count="${layout.merges.length}">${layout.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${merges}</worksheet>`;
}

// Prepends the letterhead rows, each merged across the sheet's columns and
// centred, and shifts the caller's bold rows down past them.
function withLetterhead(rows: Cell[][], opts: SheetOptions): { rows: Cell[][]; layout: Layout } {
  const layout: Layout = { rowStyles: new Map(), rowHeights: new Map(), merges: [] };
  const head = opts.letterhead === false ? [] : [
    // perLine: characters that fit per unit of column width; lineHt in pt.
    { text: COMPANY.name,    style: S_TITLE,       perLine: 0.6,  lineHt: 21 },
    { text: COMPANY.address, style: S_CENTER,      perLine: 0.85, lineHt: 16 },
    { text: COMPANY.contact, style: S_CENTER,      perLine: 0.85, lineHt: 16 },
    { text: COMPANY.pin,     style: S_CENTER_BOLD, perLine: 0.8,  lineHt: 16 },
  ];
  if (head.length) {
    const nCols = Math.max(opts.colWidths?.length ?? 0, ...rows.map(r => r.length), 1);
    const lastCol = colName(nCols - 1);
    // Every line wraps inside its merged cell, and Excel doesn't grow a
    // merged row to fit, so size each row from a rough (generous) estimate
    // of how many lines its text needs at the sheet's total width.
    const totalWidth = (opts.colWidths ?? []).reduce((a, w) => a + w, 0) || nCols * 9;
    head.forEach((h, i) => {
      layout.rowStyles.set(i, h.style);
      layout.merges.push(`A${i + 1}:${lastCol}${i + 1}`);
      const lines = Math.max(1, Math.ceil(h.text.length / (totalWidth * h.perLine)));
      layout.rowHeights.set(i, lines * h.lineHt + 2);
    });
  }
  const offset = head.length ? head.length + 1 : 0;   // + a blank spacer row
  for (const r of opts.boldRows ?? []) layout.rowStyles.set(r + offset, S_BOLD);
  const headRows: Cell[][] = head.length ? [...head.map(h => [h.text]), []] : [];
  return { rows: [...headRows, ...rows], layout };
}

function parts(rows: Cell[][], opts: SheetOptions): Record<string, string> {
  const sheet = withLetterhead(rows, opts);
  const name = esc((opts.sheetName ?? 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><name val="Calibri"/></font><font><i/><sz val="9"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheetXml(sheet.rows, opts, sheet.layout),
  };
}

// ── ZIP (store only) ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = enc.encode(path);
    const data = enc.encode(text);
    const crc  = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 names
    lv.setUint16(8, 0, true);           // method: store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

export function buildXlsx(rows: Cell[][], opts: SheetOptions = {}): Uint8Array {
  return zipStore(parts(rows, opts));
}

// Build and hand the file to the browser as a download.
export function downloadXlsx(filename: string, rows: Cell[][], opts: SheetOptions = {}): void {
  const bytes = buildXlsx(rows, opts);
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
