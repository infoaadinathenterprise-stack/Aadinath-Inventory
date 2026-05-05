'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

interface Props {
  onScan:  (code: string) => void;
  onClose: () => void;
}

export default function BarcodeScanner({ onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | null = null;

    async function start() {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        let fired = false;

        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          videoRef.current!,
          (result) => {
            if (!result || fired || stopped) return;
            fired = true;
            onScan(result.getText());
          },
        );
      } catch (e) {
        if (!stopped) setErr(e instanceof Error ? e.message : 'Camera unavailable');
      }
    }

    start();

    return () => {
      stopped = true;
      if (controls) { try { controls.stop(); } catch (_) {} }
      const v = videoRef.current;
      if (v?.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach(t => t.stop());
        v.srcObject = null;
      }
    };
  }, [onScan]);

  return (
    <motion.div
      className="fixed inset-0 z-[200] bg-black/92 flex flex-col items-center justify-center gap-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {err ? (
        <p className="text-danger text-sm font-semibold px-6 text-center">{err}</p>
      ) : (
        <video
          ref={videoRef}
          className="w-[min(90vw,400px)] h-[min(58vh,300px)] rounded-2xl object-cover border-2 border-teal bg-black block"
          autoPlay
          muted
          playsInline
        />
      )}
      <p className="text-slate-400 text-sm text-center px-6">
        Point camera at barcode — detected automatically
      </p>
      <button
        onClick={onClose}
        className="px-8 py-2.5 rounded-xl bg-surface2 border border-white/10 text-slate-100 text-sm font-bold hover:border-danger/40 hover:text-danger transition-all"
      >
        Close
      </button>
    </motion.div>
  );
}
