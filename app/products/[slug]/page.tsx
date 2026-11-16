import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCatalog, getProductBySlugId } from '@/lib/catalog';
import {
  SITE_URL, SITE_NAME, BUSINESS, CURRENCY, formatKsh,
  productSlug, productIdFromSlug, productPath, productUrl,
  productImageAbsolute, productDescription,
} from '@/lib/seo';

// Static export: pre-render one HTML page for every active product at build.
export async function generateStaticParams() {
  const products = await getCatalog();
  return products.map((p) => ({ slug: productSlug(p) }));
}

// Only the slugs above exist; anything else 404s (no server at runtime).
export const dynamicParams = false;

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const id = productIdFromSlug(slug);
  const product = id ? await getProductBySlugId(id) : null;
  if (!product) return { title: 'Product not found' };

  const title = product.product_name;
  const description = productDescription(product);
  const url = productUrl(product);
  const image = productImageAbsolute(product);

  return {
    title,
    description,
    alternates: { canonical: productPath(product) },
    openGraph: {
      type: 'website',
      title: `${title} — ${SITE_NAME}`,
      description,
      url,
      siteName: SITE_NAME,
      images: [{ url: image }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

function Breadcrumb({ name }: { name: string }) {
  return (
    <nav className="text-xs text-muted mb-6 flex items-center gap-1.5 flex-wrap" aria-label="Breadcrumb">
      <Link href="/" className="hover:text-teal transition-colors">Home</Link>
      <span className="text-muted/40">/</span>
      <Link href="/products" className="hover:text-teal transition-colors">Products</Link>
      <span className="text-muted/40">/</span>
      <span className="text-slate-300 truncate max-w-[60vw]">{name}</span>
    </nav>
  );
}

export default async function ProductPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const id = productIdFromSlug(slug);
  const product = id ? await getProductBySlugId(id) : null;
  if (!product) notFound();

  const p = product;
  const inStock = (p.total_stock ?? 0) > 0;
  const image = p.image_url && /^https?:\/\//i.test(p.image_url) ? p.image_url : '/product-placeholder.svg';
  const meta = [p.brand, p.model].filter(Boolean).join(' · ');
  const price = p.selling_price && p.selling_price > 0 ? p.selling_price : null;

  // ── Structured data: Product + Breadcrumb ──────────────────────────────────
  const productLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.product_name,
    image: [productImageAbsolute(p)],
    description: productDescription(p),
    category: p.type || 'Auto Parts',
    sku: p.stock_keeping_unit || undefined,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    offers: {
      '@type': 'Offer',
      url: productUrl(p),
      priceCurrency: CURRENCY,
      ...(price ? { price: String(price) } : {}),
      availability: inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home',     item: SITE_URL },
      { '@type': 'ListItem', position: 2, name: 'Products', item: `${SITE_URL}/products` },
      { '@type': 'ListItem', position: 3, name: p.product_name, item: productUrl(p) },
    ],
  };

  const ld = JSON.stringify([productLd, breadcrumbLd]).replace(/</g, '\\u003c');

  return (
    <main className="min-h-screen pt-24 pb-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ld }} />

      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <Breadcrumb name={p.product_name} />

        <div className="grid md:grid-cols-2 gap-6 sm:gap-10 items-start">
          {/* Image */}
          <div className="relative rounded-2xl card-lux overflow-hidden aspect-square bg-surface2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={p.product_name} className="w-full h-full object-cover" />
            {p.type && (
              <span className="absolute top-3 left-3 text-[10px] font-bold px-2.5 py-1 rounded-full glass border text-slate-200 uppercase tracking-wider">
                {p.type}
              </span>
            )}
          </div>

          {/* Details */}
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-100 tracking-tight leading-tight">
              {p.product_name}
            </h1>
            {meta && <p className="text-sm text-muted mt-2">{meta}</p>}

            <div className="mt-5 flex items-center gap-3 flex-wrap">
              {price && (
                <span className="text-2xl font-bold text-gradient">{formatKsh(price)}</span>
              )}
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${
                inStock
                  ? 'text-success border-success/30 bg-success/10'
                  : 'text-danger border-danger/30 bg-danger/10'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${inStock ? 'bg-success' : 'bg-danger'}`} />
                {inStock ? 'In Stock' : 'Out of Stock'}
              </span>
            </div>

            <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {p.brand && (<><dt className="text-muted">Brand</dt><dd className="text-slate-200 text-right">{p.brand}</dd></>)}
              {p.type  && (<><dt className="text-muted">Category</dt><dd className="text-slate-200 text-right">{p.type}</dd></>)}
              {p.model && (<><dt className="text-muted">Model</dt><dd className="text-slate-200 text-right">{p.model}</dd></>)}
              {p.stock_keeping_unit && (<><dt className="text-muted">SKU</dt><dd className="text-slate-200 text-right font-mono text-xs">{p.stock_keeping_unit}</dd></>)}
            </dl>

            <p className="mt-6 text-sm text-muted leading-relaxed">
              Available at {SITE_NAME}, Kakamega. Visit our store or call to place an order.
            </p>

            <div className="mt-6 flex items-center gap-3 flex-wrap">
              <a href={`tel:${BUSINESS.phone}`} className="btn-primary text-white text-sm font-semibold px-5 py-3 rounded-xl">
                Call {BUSINESS.phoneHuman}
              </a>
              <a href={`https://wa.me/${BUSINESS.phone.replace('+', '')}?text=${encodeURIComponent('Hi, I am interested in ' + p.product_name)}`}
                 target="_blank" rel="noopener noreferrer"
                 className="card-lux text-slate-100 text-sm font-semibold px-5 py-3 rounded-xl hover:text-teal transition-colors">
                WhatsApp
              </a>
            </div>

            <Link href="/products" className="inline-block mt-8 text-sm text-teal hover:underline">
              ← Back to all products
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
