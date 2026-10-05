'use client';

import { useMemo, useState } from 'react';
import type { Product } from '@/lib/types';
import { productImageDataUrl } from '@/lib/productImage';

interface Props {
  product:    Product;
  className?: string;
}

// A product's picture: the image uploaded on the Images page, or — when it
// has none, or it fails to load — the generated default (category icon +
// name) that the Images page shows for products without one.
export default function ProductThumb({ product: p, className = '' }: Props) {
  const fallback = useMemo(() => productImageDataUrl(p), [p]);
  const [failed, setFailed] = useState<string | null>(null);
  const src = p.image_url && p.image_url !== failed ? p.image_url : fallback;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={p.product_name}
      loading="lazy"
      decoding="async"
      onError={() => { if (src !== fallback) setFailed(p.image_url ?? null); }}
      className={`object-cover bg-surface2 ${className}`}
    />
  );
}
