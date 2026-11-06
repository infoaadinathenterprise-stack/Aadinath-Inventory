// Delivery receipts for purchases: photos in the PRIVATE "delivery-receipts"
// bucket (supabase/16_purchase_delivery.sql). purchases.delivery_receipt_path
// holds the file's path; it's shown through a short-lived signed link.

import { supabase } from '@/lib/supabase';

const BUCKET = 'delivery-receipts';

// Downscale to ≤1200px JPEG, ~400 KB at most — readable, not heavy.
export function compressReceipt(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Please pick an image file')); return; }
    if (file.size > 15 * 1024 * 1024) { reject(new Error('Image too large. Max 15MB')); return; }
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1200;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d')?.drawImage(img, 0, 0, w, h);
      const tryQ = (q: number) => c.toBlob(b => {
        if (!b) { reject(new Error('Could not read image')); return; }
        if (b.size > 400_000 && q > 0.45) tryQ(q - 0.1); else resolve(b);
      }, 'image/jpeg', q);
      tryQ(0.75);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

export async function uploadReceipt(purchaseId: number, file: File): Promise<string> {
  const blob = await compressReceipt(file);
  const path = `${purchaseId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(`Receipt upload failed: ${error.message}`);
  return path;
}

// A link to view a receipt for the next hour (the bucket is private).
export async function receiptLink(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  return error ? null : data.signedUrl;
}

// Links for many receipts in one request (for the purchase cards).
export async function receiptLinks(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const d of data) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}

export async function removeReceipt(path: string): Promise<void> {
  await supabase.storage.from(BUCKET).remove([path]);
}
