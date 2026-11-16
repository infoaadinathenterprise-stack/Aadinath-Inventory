// ─────────────────────────────────────────────────────────────────────────────
//  Build-time catalogue fetch (server/SSG only).
//
//  Runs during `next build` (Server Components + the sitemap) to pull the full
//  active product list, with each product's total stock, straight from
//  Supabase using the public anon key (the catalogue is public, read-only).
//  The result is what the per-product static pages and the sitemap are built
//  from, so each product becomes real, crawlable HTML with its own URL.
//
//  NOTE: because the site is a static export, these pages are only as fresh as
//  the last deploy — a newly added product gets its page on the next build.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';

interface StockRow { quantity: number | null; box_quantity: number | null; }

// Memoise within a single build worker so generateStaticParams, generateMetadata
// and the page body don't each re-query.
let cached: Promise<Product[]> | null = null;

export function getCatalog(): Promise<Product[]> {
  if (!cached) cached = loadCatalog();
  return cached;
}

async function loadCatalog(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*, stock_by_location(quantity, box_quantity)')
    .eq('active_status', true)
    .order('product_name');

  if (error || !data) {
    // Never fail the whole build over a transient fetch issue — just build the
    // static pages (home, catalogue shell) without product pages this time.
    if (error) console.warn('[catalog] product fetch failed:', error.message);
    return [];
  }

  return (data as (Product & { stock_by_location?: StockRow[] })[]).map((row) => {
    const total_stock = (row.stock_by_location || []).reduce(
      (sum, s) => sum + (s.quantity || 0) + (s.box_quantity || 0) * (row.pieces_per_box || 1),
      0,
    );
    const { stock_by_location: _omit, ...rest } = row;
    return { ...rest, total_stock } as Product;
  });
}

export async function getProductBySlugId(id: number): Promise<Product | null> {
  const list = await getCatalog();
  return list.find((p) => p.product_id === id) ?? null;
}
