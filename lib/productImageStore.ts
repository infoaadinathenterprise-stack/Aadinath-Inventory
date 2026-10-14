// Product photos live in the public "product-images" Storage bucket
// (supabase/15_product_image_storage.sql); products.image_url holds only the
// link. Keeping photos out of the row keeps the products list — loaded by
// every page — small.

import { supabase } from '@/lib/supabase';

const BUCKET = 'product-images';

// An uploaded photo still stored inline in the row (base64 data URL).
// Generated SVG defaults are tiny and stay inline.
export function isInlinePhoto(url: string | null | undefined): url is string {
  return !!url && url.startsWith('data:image/') && !url.startsWith('data:image/svg');
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const type = head.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Uploads a photo (data URL) and returns its public link. Each upload gets a
// fresh name, so a replaced photo never shows a stale cached copy.
export async function uploadProductPhoto(dataUrl: string): Promise<string> {
  const blob = dataUrlToBlob(dataUrl);
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// What to save in products.image_url: photos go to Storage first; links,
// generated SVGs and null are saved as they are.
export async function storableImageUrl(url: string | null): Promise<string | null> {
  return isInlinePhoto(url) ? uploadProductPhoto(url) : url;
}
