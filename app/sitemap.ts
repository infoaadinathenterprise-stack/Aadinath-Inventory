import type { MetadataRoute } from 'next';
import { getCatalog } from '@/lib/catalog';
import { SITE_URL, productPath, productImageAbsolute } from '@/lib/seo';

// Required for a data-fetching metadata route under `output: 'export'` — the
// sitemap is generated once at build, not per request.
export const dynamic = 'force-static';

// Generates /sitemap.xml at build: the home and catalogue pages, plus one entry
// for every product page so Google can discover and index each product.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const products = await getCatalog();

  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_URL,               lastModified: now, changeFrequency: 'weekly',  priority: 1 },
    { url: `${SITE_URL}/products`, lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
  ];

  const productPages: MetadataRoute.Sitemap = products.map((p) => ({
    url: `${SITE_URL}${productPath(p)}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.7,
    images: [productImageAbsolute(p)],
  }));

  return [...staticPages, ...productPages];
}
