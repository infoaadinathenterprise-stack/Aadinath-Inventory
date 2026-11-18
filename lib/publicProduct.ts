// ─────────────────────────────────────────────────────────────────────────────
//  What the public storefront may know about a product.
//
//  The storefront (static catalogue, product pages, live-stock refresh) must
//  never ask for or carry internal fields such as buying_price (our cost) —
//  anything it holds ends up in the page HTML for anyone to read and for
//  search engines to index. Query with PUBLIC_PRODUCT_COLUMNS only, and the
//  database (supabase/19_hide_cost_from_public.sql) refuses the rest to
//  logged-out visitors anyway.
// ─────────────────────────────────────────────────────────────────────────────

import type { Product } from '@/lib/types';

// Columns a logged-out visitor may read. Keep in sync with the column grant
// in supabase/19_hide_cost_from_public.sql.
export const PUBLIC_PRODUCT_COLUMNS = [
  'product_id', 'product_name', 'type', 'brand', 'model', 'stock_keeping_unit',
  'unit_type', 'unit_of_measure', 'display_unit', 'pieces_per_box',
  'box_selling_price', 'active_status', 'selling_price', 'image_url',
].join(', ');

// Copy only the public fields, so a row that came back with more (e.g. from an
// older cached page) can't leak the rest into the page.
export function toPublicProduct(row: Partial<Product> & { product_id: number; product_name: string }, total_stock: number): Product {
  return {
    product_id:         row.product_id,
    product_name:       row.product_name,
    type:               row.type ?? null,
    brand:              row.brand ?? null,
    model:              row.model ?? null,
    stock_keeping_unit: row.stock_keeping_unit ?? null,
    unit_type:          row.unit_type ?? null,
    unit_of_measure:    row.unit_of_measure ?? null,
    display_unit:       row.display_unit ?? null,
    pieces_per_box:     row.pieces_per_box ?? null,
    box_selling_price:  row.box_selling_price ?? null,
    active_status:      row.active_status ?? true,
    selling_price:      row.selling_price ?? null,
    image_url:          row.image_url ?? null,
    total_stock,
    // Internal fields: never sent to the storefront.
    buying_price:       null,
    reorder_level:      null,
    current_stock:      null,
    parent_product_id:  null,
    split_type:         null,
  };
}
