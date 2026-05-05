import { supabase }    from '@/lib/supabase';
import { formatStock } from '@/lib/formatStock';
import type { Product } from '@/lib/formatStock';
import ProductGrid     from '../components/ProductGrid';

interface StockRow { quantity: number | null; box_quantity: number | null; }

async function getProducts(): Promise<{ products: Product[]; categories: string[] }> {
  const { data, error } = await supabase
    .from('products')
    .select('*, stock_by_location(quantity, box_quantity)')
    .eq('active_status', true)
    .order('product_name');

  if (error || !data) return { products: [], categories: [] };

  const products: Product[] = data.map((row: Product & { stock_by_location?: StockRow[] }) => {
    const ppb         = row.pieces_per_box ?? 0;
    const total_stock = (row.stock_by_location || []).reduce((sum, s) =>
      sum + (s.quantity || 0), 0
    );
    const { stock_by_location: _omit, ...rest } = row as Product & { stock_by_location?: StockRow[] };
    return { ...rest, total_stock };
  });

  const categories = [...new Set(
    products.map(p => p.type).filter(Boolean) as string[]
  )].sort();

  return { products, categories };
}

export default async function ProductsPage() {
  const { products, categories } = await getProducts();

  return (
    <main className="min-h-screen pt-24 pb-20">
      <div className="max-w-7xl mx-auto px-6">

        {/* Page header */}
        <div className="text-center mb-12">
          <span className="text-xs font-bold text-teal uppercase tracking-widest">Catalogue</span>
          <h1 className="text-4xl md:text-5xl font-bold text-slate-100 mt-3 mb-4">
            Our <span className="text-teal">Products</span>
          </h1>
          <p className="text-muted max-w-lg mx-auto text-sm leading-relaxed">
            Browse our full range of auto parts, lubricants, and consumables.
            All products sourced from trusted manufacturers.
          </p>
        </div>

        {/* Product grid with client-side filter + search */}
        <ProductGrid products={products} categories={categories} />
      </div>
    </main>
  );
}
