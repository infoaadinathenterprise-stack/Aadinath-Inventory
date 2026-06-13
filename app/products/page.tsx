'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { formatStock } from '@/lib/formatStock';
import type { Product } from '@/lib/types';
import ProductGrid from '../components/ProductGrid';

interface StockRow { quantity: number | null; box_quantity: number | null; }

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('products')
        .select('*, stock_by_location(quantity, box_quantity)')
        .eq('active_status', true)
        .order('product_name');

      if (error || !data) { setLoading(false); return; }

      const mapped: Product[] = data.map((row: Product & { stock_by_location?: StockRow[] }) => {
        const total_stock = (row.stock_by_location || []).reduce((sum, s) =>
          sum + (s.quantity || 0), 0
        );
        const { stock_by_location: _omit, ...rest } = row as Product & { stock_by_location?: StockRow[] };
        return { ...rest, total_stock };
      });

      const cats = [...new Set(mapped.map(p => p.type).filter(Boolean) as string[])].sort();
      setProducts(mapped);
      setCategories(cats);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <main className="min-h-screen pt-24 pb-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-8 sm:mb-12">
          <span className="text-[11px] sm:text-xs font-bold text-teal uppercase tracking-[0.2em]">Catalogue</span>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-100 mt-4 mb-4 tracking-tight">
            Our <span className="text-gradient">Products</span>
          </h1>
          <p className="text-muted max-w-lg mx-auto text-sm leading-relaxed px-2">
            Browse our full range of auto parts, lubricants, and consumables —
            all sourced from trusted manufacturers.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : (
          <ProductGrid products={products} categories={categories} />
        )}
      </div>
    </main>
  );
}
