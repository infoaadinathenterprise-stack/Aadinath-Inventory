// Builds a purchase-order PDF from the plain data saved in purchase_orders,
// so the stored order is just text and the PDF is re-created on demand.

import { COMPANY } from './company';

export interface OrderLine {
  product_id:   number | null;
  product_name: string;
  price:        number;
  qty:          number;
}

export interface SavedOrder {
  order_id:      number;
  order_no:      string;
  supplier_id:   number | null;
  supplier_name: string | null;
  order_date:    string;
  created_by:    string | null;
  items:         OrderLine[];
  total_amount:  number;
  created_at:    string;
}

function ksh(n: number) {
  return 'Ksh ' + n.toLocaleString('en-KE');
}

function fmtDate(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

export async function buildOrderPdf(order: SavedOrder): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const left = 15, right = pageW - 15;
  const colNo = left, colName = left + 10, colPrice = right - 55, colQty = right - 28, colTotal = right;

  // ── Letterhead ──
  const mid = pageW / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(COMPANY.name, mid, 16, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(COMPANY.address, mid, 21.5, { align: 'center' });
  doc.text(COMPANY.contact, mid, 26, { align: 'center' });
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  const dealerLines: string[] = doc.splitTextToSize(COMPANY.dealers, right - left);
  doc.text(dealerLines, mid, 31, { align: 'center' });
  const headY = 31 + (dealerLines.length - 1) * 3.6 + 3;
  doc.setLineWidth(0.6);
  doc.line(left, headY, right, headY);

  // ── Order details ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('PURCHASE ORDER', left, headY + 7);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Order no: ${order.order_no}`, right, headY + 7, { align: 'right' });
  doc.text(`Date: ${fmtDate(order.order_date)}`, right, headY + 12, { align: 'right' });
  if (order.supplier_name) doc.text(`To: ${order.supplier_name}`, right, headY + 17, { align: 'right' });
  doc.setLineWidth(0.2);
  doc.line(left, headY + 21, right, headY + 21);

  let y = headY + 29;
  const header = () => {
    doc.setFont('helvetica', 'bold');
    doc.text('#', colNo, y);
    doc.text('Product', colName, y);
    doc.text('Price', colPrice, y, { align: 'right' });
    doc.text('Qty', colQty, y, { align: 'right' });
    doc.text('Amount', colTotal, y, { align: 'right' });
    doc.setLineWidth(0.2);
    doc.line(left, y + 2, right, y + 2);
    doc.setFont('helvetica', 'normal');
    y += 8;
  };
  header();

  order.items.forEach((it, i) => {
    const nameLines: string[] = doc.splitTextToSize(it.product_name, colPrice - colName - 22);
    const rowH = nameLines.length * 5 + 2;
    if (y + rowH > pageH - 25) { doc.addPage(); y = 20; header(); }
    doc.text(String(i + 1), colNo, y);
    doc.text(nameLines, colName, y);
    doc.text(ksh(it.price), colPrice, y, { align: 'right' });
    doc.text(String(it.qty), colQty, y, { align: 'right' });
    doc.text(ksh(it.price * it.qty), colTotal, y, { align: 'right' });
    y += rowH;
    doc.setDrawColor(220);
    doc.line(left, y - 3.5, right, y - 3.5);
    doc.setDrawColor(0);
  });

  if (y > pageH - 25) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold');
  doc.text('Total', colQty, y + 2, { align: 'right' });
  doc.text(ksh(order.total_amount), colTotal, y + 2, { align: 'right' });

  return doc.output('blob');
}

// Opens the PDF in a new tab. Popup blockers only allow a tab opened during
// the click itself, so callers that await something first (like saving the
// order) open the tab up front and pass it in.
export async function openOrderPdf(order: SavedOrder, win: Window | null = window.open('', '_blank')): Promise<void> {
  const blob = await buildOrderPdf(order);
  const url = URL.createObjectURL(blob);
  if (win) win.location.href = url;
  else window.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
