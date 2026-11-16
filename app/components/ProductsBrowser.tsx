'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';
import ProductGrid from './ProductGrid';
import { readPageCache, writePageCache } from '@/lib/pageCache';

interface StockRow { quantity: number | null; box_quantity: number | null; }

interface Props {
  // Pre-rendered at build so the product names/links are in the static HTML
  // (crawlable + indexable). The client then refreshes to the latest stock.
  initialProducts:   Product[];
  initialCategories: string[];
}

export default function ProductsBrowser({ initialProducts, initialCategories }: Props) {
  const [products,   setProducts]   = useState<Product[]>(initialProducts);
  const [categories, setCategories] = useState<string[]>(initialCategories);

  useEffect(() => {
    // Last visit's catalogue shows instantly; the fresh one replaces it.
    const cached = readPageCache<{ products: Product[]; categories: string[] }>('storefront');
    if (cached) { setProducts(cached.products); setCategories(cached.categories); }

    async function load() {
      const { data, error } = await supabase
        .from('products')
        .select('*, stock_by_location(quantity, box_quantity)')
        .eq('active_status', true)
        .order('product_name');

      if (error || !data) return;

      const mapped: Product[] = data
        .map((row: Product & { stock_by_location?: StockRow[] }) => {
          const total_stock = (row.stock_by_location || []).reduce((sum, s) =>
            sum + (s.quantity || 0), 0
          );
          const { stock_by_location: _omit, ...rest } = row as Product & { stock_by_location?: StockRow[] };
          return { ...rest, total_stock };
        })
        .filter(p => (p.total_stock ?? 0) > 0);

      const cats = [...new Set(mapped.map(p => p.type).filter(Boolean) as string[])].sort();
      setProducts(mapped);
      setCategories(cats);
      writePageCache('storefront', { products: mapped, categories: cats });
    }
    load();
  }, []);

  return <ProductGrid products={products} categories={categories} />;
}
