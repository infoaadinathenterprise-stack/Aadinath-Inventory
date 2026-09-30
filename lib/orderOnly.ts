import type { Product } from './types';

// Products typed in on the Place an Order page (/admin/stats) exist only
// for ordering: they carry this placeholder type, have no SKU and hold no
// stock. The inventory pages leave them out; Place an Order lists them,
// and remembers the supplier they're ordered from (order_supplier_id).
// Once one gets a SKU or stock it's an ordinary product everywhere.
export const ORDER_ONLY_TYPE = 'New Product';

export function isOrderOnly(p: Product, totalStock: number): boolean {
  return p.type === ORDER_ONLY_TYPE && !p.stock_keeping_unit?.trim() && totalStock === 0;
}
