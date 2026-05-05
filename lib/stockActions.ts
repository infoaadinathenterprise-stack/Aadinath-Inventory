import { supabase } from '@/lib/supabase';

export async function upsertStock(
  productId: number,
  locationId: number,
  field: 'quantity' | 'box_quantity',
  value: number,
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
      .update({ [field]: value, updated_at: now })
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
        [field]:      value,
        updated_at:   now,
      });
  }
}

export async function logMovement(
  productId: number,
  fromLoc:   number | null,
  toLoc:     number | null,
  qty:       number,
  type:      string,
  reason:    string,
): Promise<void> {
  await supabase.from('stock_movements').insert({
    product_id:       productId,
    from_location_id: fromLoc,
    to_location_id:   toLoc,
    quantity:         qty,
    movement_type:    type,
    reason,
    performed_by:     1,
    approved_by:      1,
    status:           'APPROVED',
  });
}
