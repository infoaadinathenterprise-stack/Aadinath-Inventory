// Files for a saved purchase order — PDF (lib/orderPdf.ts) or Excel — and
// handing them to the user: download, or the device's share sheet
// (WhatsApp, email, …) where the browser supports sharing files.

import { buildOrderPdf, lineName, showsPrices, unitLabel, type SavedOrder } from './orderPdf';
import { buildXlsx, type Cell } from './xlsx';

export type OrderFileKind = 'pdf' | 'xlsx';

const MIME: Record<OrderFileKind, string> = {
  pdf:  'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function orderFileName(order: SavedOrder, kind: OrderFileKind): string {
  const who = (order.supplier_name ?? 'No-supplier').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  return `${order.order_no}-${who}.${kind}`;
}

function orderSheet(order: SavedOrder): Uint8Array {
  const date = new Date(`${order.order_date}T00:00:00`)
    .toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
  // Same rules as the PDF: the supplier's name for each line, and prices
  // only when at least one line has one.
  const priced = showsPrices(order.items);
  const rows: Cell[][] = [
    ['Purchase Order'],
    [`Order no: ${order.order_no}`],
    [`Date: ${date}`],
    ...(order.supplier_name ? [[`To: ${order.supplier_name}`]] : []),
    [],
    priced ? ['#', 'Product', 'Price', 'Qty', 'Unit', 'Amount'] : ['#', 'Product', 'Qty', 'Unit'],
    ...order.items.map((l, i) => priced
      ? [i + 1, lineName(l), l.price > 0 ? l.price : '', l.qty, unitLabel(l.unit), l.price > 0 ? l.price * l.qty : '']
      : [i + 1, lineName(l), l.qty, unitLabel(l.unit)]),
    ...(priced ? [[], ['', '', '', '', 'Total', Number(order.total_amount)]] : []),
  ];
  const header = rows.findIndex(r => r[0] === '#');
  return buildXlsx(rows, {
    sheetName: order.order_no,
    // Title, the supplier line, the table header and the total in bold.
    boldRows:  [0, ...(order.supplier_name ? [3] : []), header, ...(priced ? [rows.length - 1] : [])],
    colWidths: priced ? [5, 46, 12, 7, 8, 14] : [5, 60, 8, 8],
  });
}

export async function buildOrderFile(order: SavedOrder, kind: OrderFileKind): Promise<File> {
  const blob = kind === 'pdf'
    ? await buildOrderPdf(order)
    : new Blob([orderSheet(order) as BlobPart], { type: MIME.xlsx });
  return new File([blob], orderFileName(order, kind), { type: MIME[kind] });
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canShareFile(file: File): boolean {
  return typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });
}

// Opens the share sheet. Resolves false if the user dismissed it.
// Call from a click, with the file already built — browsers only allow
// sharing right after a user gesture.
export async function shareFile(file: File, order: SavedOrder): Promise<boolean> {
  try {
    await navigator.share({
      files: [file],
      title: `Purchase Order ${order.order_no}`,
      text:  `Purchase Order ${order.order_no}${order.supplier_name ? ` for ${order.supplier_name}` : ''} — Jay Aadinath Enterprises Ltd.`,
    });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return false;
    throw e;
  }
}
