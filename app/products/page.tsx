import type { Metadata } from 'next';
import { getCatalog } from '@/lib/catalog';
import { SITE_NAME, SITE_URL } from '@/lib/seo';
import ProductsBrowser from '../components/ProductsBrowser';

export const metadata: Metadata = {
  title: 'Products',
  description:
    `Browse the full catalogue of auto parts, lubricants, batteries, bearings, `
    + `filters and workshop consumables stocked by ${SITE_NAME} in Kakamega, Kenya.`,
  alternates: { canonical: '/products' },
  openGraph: {
    type: 'website',
    title: `Products — ${SITE_NAME}`,
    description: `Our full range of auto parts and consumables, sourced from trusted manufacturers.`,
    url: `${SITE_URL}/products`,
    siteName: SITE_NAME,
  },
};

// Server component: fetches the catalogue at build so the product list is in
// the static HTML (indexable + crawlable), then hands it to the client browser
// for search/filtering and live-stock refresh.
export default async function ProductsPage() {
  const all = await getCatalog();
  const inStock = all.filter(p => (p.total_stock ?? 0) > 0);
  const categories = [...new Set(inStock.map(p => p.type).filter(Boolean) as string[])].sort();

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

        <ProductsBrowser initialProducts={inStock} initialCategories={categories} />
      </div>
    </main>
  );
}
