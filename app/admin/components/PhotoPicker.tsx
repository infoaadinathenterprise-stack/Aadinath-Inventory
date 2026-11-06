'use client';

import { useRef } from 'react';

// Two ways to add a photo: take one with the camera, or pick an existing one
// from the gallery / files. On a laptop both open the file chooser (the
// "Camera" one is a phone feature); on a phone "Camera" opens the camera
// straight away and "Gallery" opens the photo library.
export default function PhotoPicker({ onPick, multiple = false, size = 'md' }: {
  onPick:    (files: File[]) => void;
  multiple?: boolean;
  size?:     'sm' | 'md';
}) {
  const cameraRef  = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  function handle(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) onPick(files);
  }

  const btn = size === 'sm'
    ? 'py-2 text-[11px]'
    : 'py-3 text-xs';

  return (
    <div className="flex gap-2">
      <button type="button" onClick={() => cameraRef.current?.click()}
        className={`flex-1 ${btn} rounded-xl border-2 border-dashed border-white/15 text-muted font-bold hover:border-teal/40 hover:text-teal hover:bg-teal/5 transition-all`}>
        📷 Take photo
      </button>
      <button type="button" onClick={() => galleryRef.current?.click()}
        className={`flex-1 ${btn} rounded-xl border-2 border-dashed border-white/15 text-muted font-bold hover:border-teal/40 hover:text-teal hover:bg-teal/5 transition-all`}>
        🖼️ From gallery / files
      </button>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handle} />
      <input ref={galleryRef} type="file" accept="image/*" multiple={multiple} className="hidden" onChange={handle} />
    </div>
  );
}
