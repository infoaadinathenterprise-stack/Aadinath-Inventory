import { supabase } from '@/lib/supabase';
import { USER_KEY } from '@/lib/types';

function currentUser(): string {
  if (typeof window === 'undefined') return 'System';
  return localStorage.getItem(USER_KEY) || 'Admin';
}

// ── Atomic stock engine (see supabase/03_stock_functions.sql) ────────────────
// One database transaction applies every stock change (as a delta against the
// live, row-locked value) and optionally records the sale. This replaces the
// old read-modify-write pattern that could lose updates or half-write a sale.

export interface StockOp {
  product_id:  number;
  location_id: number;
  dq:          number;               // delta to loose pieces (can be negative)
  db:          number;               // delta to whole boxes  (can be negative)
  mov_type?:   string;               // SALE | TRANSFER | ADJUSTMENT_IN | ADJUSTMENT_OUT | AUTO_DEDUCT
  mov_qty?:    number;
  mov_from?:   number | null;
  mov_to?:     number | null;
  reason?:     string;
}

export interface SaleItemPayload {
  product_id:   number | null;
  product_name: string;
  quantity:     number;
  unit:         string;
  unit_price:   number | null;
  cost_price:   number | null;
  line_total:   number | null;
}

export interface SalePayload {
  sale_date:    string;              // YYYY-MM-DD (caller's local date)
  location_id:  number;
  total_amount: number;
  item_count:   number;
  notes?:       string | null;
  items:        SaleItemPayload[];
}

// Apply a batch of stock changes (+ optional sale) atomically. Throws on any
// failure — including "Not enough stock" — with nothing written.
export async function stockTxn(ops: StockOp[], sale?: SalePayload | null): Promise<{ sale_id?: number }> {
  const { data, error } = await supabase.rpc('stock_txn', { p_ops: ops, p_sale: sale ?? null });
  if (error) throw new Error(error.message);
  return (data ?? {}) as { sale_id?: number };
}

export async function approveRequest(requestId: number): Promise<void> {
  const { error } = await supabase.rpc('approve_stock_request', { p_request_id: requestId });
  if (error) throw new Error(error.message);
}

export async function rejectRequest(requestId: number): Promise<void> {
  const { error } = await supabase.rpc('reject_stock_request', { p_request_id: requestId });
  if (error) throw new Error(error.message);
}

export async function upsertStock(
  productId: number,
  locationId: number,
  fields: Partial<{ quantity: number; box_quantity: number }>,
): Promise<void> {
  const { data } = await supabase
    .from('stock_by_location')
    .select('id')
    .eq('product_id', productId)
    .eq('location_id', locationId);

  const now = new Date().toISOString();
  if (data && data.length > 0) {
    await supabase
      .from('stock_by_location')
      .update({ ...fields, updated_at: now })
      .eq('product_id', productId)
      .eq('location_id', locationId);
  } else {
    await supabase
      .from('stock_by_location')
      .insert({
        product_id:   productId,
        location_id:  locationId,
        quantity:     0,
        box_quantity: 0,
        ...fields,
        updated_at:   now,
      });
  }
}

// Submit a stock-addition request that waits for admin approval.
// Stock is NOT modified until an admin approves it in /admin/approvals.
export async function submitPendingRequest(
  productId:  number,
  locationId: number,
  qty:        number,
  reason:     string,
): Promise<void> {
  const user  = currentUser();
  const now   = new Date().toISOString();
  const notes = `[${user}] ${reason}`;
  const { error } = await supabase.from('stock_requests').insert({
    product_id:       productId,
    request_type:     'ADJUSTMENT_IN',
    quantity:         qty,
    to_location_id:   locationId,
    from_location_id: null,
    notes,
    status:           'PENDING',
    requested_at:     now,
  });
  if (error) throw new Error('Could not submit request: ' + error.message);
}

export async function logMovement(
  productId: number,
  fromLoc:   number | null,
  toLoc:     number | null,
  qty:       number,
  type:      string,
  reason:    string,
  snapshot?: { before: number; after: number },
): Promise<void> {
  const user        = currentUser();
  const now         = new Date().toISOString();
  const snapSuffix  = snapshot != null ? ` (was: ${snapshot.before} → now: ${snapshot.after})` : '';
  const notes       = `[${user}] ${reason}${snapSuffix}`;

  const { error } = await supabase.from('stock_requests').insert({
    product_id:       productId,
    request_type:     type,
    quantity:         qty,
    from_location_id: fromLoc,
    to_location_id:   toLoc,
    notes,
    status:           'APPROVED',
    requested_at:     now,
    approved_at:      now,
  });
  if (error) throw new Error('Could not record movement: ' + error.message);
}
