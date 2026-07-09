'use client';

// Resize + compress an image (a File from an upload, or a Blob fetched via the
// worker proxy) down to a JPEG data URL. Keeps stored images small and
// consistent, and self-hosts the picture so it doesn't rot or hotlink.
export async function compressToDataUrl(src: Blob, max = 600, targetBytes = 250_000): Promise<string> {
  const objectUrl = URL.createObjectURL(src);
  try {
    const img = await loadImage(objectUrl);
    let w = img.width, h = img.height;
    if (!w || !h) throw new Error('Not a valid image');
    if (w > max || h > max) {
      if (w > h) { h = Math.round(h * max / w); w = max; }
      else       { w = Math.round(w * max / h); h = max; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(img, 0, 0, w, h);

    let q = 0.82;
    let out = canvas.toDataURL('image/jpeg', q);
    while (out.split(',')[1].length * 0.75 > targetBytes && q > 0.4) {
      q -= 0.1;
      out = canvas.toDataURL('image/jpeg', q);
    }
    return out;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}
