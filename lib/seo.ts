// ─────────────────────────────────────────────────────────────────────────────
//  SEO constants + helpers (public storefront).
//
//  Everything search engines need to find the business and each product lives
//  here: the canonical site URL, the structured company details used to build
//  the Organization / LocalBusiness JSON-LD, and the product-URL <-> product
//  mapping so every product gets one stable, indexable page.
// ─────────────────────────────────────────────────────────────────────────────

import type { Product } from '@/lib/types';

// Canonical production origin (no trailing slash). Overridable for previews.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL
  || 'https://jayaadinathenterprises.com').replace(/\/+$/, '');

// Display name (lib/company.ts keeps the ALL-CAPS letterhead version).
export const SITE_NAME = 'Jay Aadinath Enterprises Ltd';

export const SITE_TAGLINE = 'Auto Parts, Lubricants & Consumables — Kakamega, Kenya';

export const SITE_DESCRIPTION =
  'Jay Aadinath Enterprises Ltd is a trusted distributor of auto parts, '
  + 'lubricants, batteries, bearings, filters and workshop consumables in '
  + 'Kakamega, Kenya. Browse our catalogue and visit us or call to order.';

// Structured company details — the source for the business JSON-LD and the
// contact links. Kept here (not derived from the letterhead string) so the
// values Google reads are clean and unambiguous.
export const BUSINESS = {
  name:        SITE_NAME,
  legalName:   'Jay Aadinath Enterprises Ltd',
  phone:       '+254781747333',
  phoneHuman:  '0781 747333',
  email:       'info.aadinathenterprise@gmail.com',
  streetAddress: 'Next to G4S Securicor Office, Opposite Kakamega Primary School',
  poBox:       'P.O. Box 108',
  locality:    'Kakamega',
  region:      'Kakamega County',
  postalCode:  '50100',
  country:     'KE',
  // Approximate storefront coordinates (Kakamega town). Refine if you have the
  // exact pin from Google Maps / your Business Profile.
  latitude:    0.2827,
  longitude:   34.7519,
} as const;

export const CURRENCY = 'KES';

// Format a number as Kenyan shillings for display, e.g. 1200 -> "KSh 1,200".
export function formatKsh(amount: number): string {
  return 'KSh ' + Math.round(amount).toLocaleString('en-KE');
}

// ── Product <-> URL mapping ──────────────────────────────────────────────────
// A product's page lives at /products/<id>-<name-slug>. The numeric id leads so
// the page can be resolved even if the product is later renamed; the slug tail
// is purely for readable, keyword-rich URLs.

function slugify(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function productSlug(p: Pick<Product, 'product_id' | 'product_name'>): string {
  const tail = slugify(p.product_name || '');
  return tail ? `${p.product_id}-${tail}` : String(p.product_id);
}

// Extract the product id from a slug like "123-shell-helix-5w40" -> 123.
export function productIdFromSlug(slug: string): number | null {
  const n = parseInt(slug.split('-')[0], 10);
  return Number.isFinite(n) ? n : null;
}

export function productPath(p: Pick<Product, 'product_id' | 'product_name'>): string {
  return `/products/${productSlug(p)}`;
}

export function productUrl(p: Pick<Product, 'product_id' | 'product_name'>): string {
  return `${SITE_URL}${productPath(p)}`;
}

// Absolute, fetchable image URL for a product (schema.org wants a real URL, not
// a data URL). Uses the uploaded photo when it's an http(s) link, otherwise the
// site's placeholder.
export function productImageAbsolute(p: Product): string {
  const url = p.image_url;
  if (url && /^https?:\/\//i.test(url)) return url;
  return `${SITE_URL}/product-placeholder.svg`;
}

// A human, keyword-aware description for a single product page / meta tag.
export function productDescription(p: Product): string {
  const bits = [p.brand, p.type, p.model].filter(Boolean).join(' ');
  const lead = bits ? `${p.product_name} (${bits})` : p.product_name;
  return `Buy ${lead} from ${SITE_NAME} in Kakamega, Kenya. `
    + `Genuine auto parts and consumables — visit our store or call ${BUSINESS.phoneHuman} to order.`;
}
