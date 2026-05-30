import { supabase } from '@/lib/supabase';
import { USER_KEY } from '@/lib/types';

function currentUser(): string {
  if (typeof window === 'undefined') return 'System';
  return localStorage.getItem(USER_KEY) || 'Admin';
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
