'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

interface Props {
  onScan:    (code: string) => void;
  onClose:   () => void;
  keepOpen?: boolean;
}

export default function BarcodeScanner({ onScan, onClose, keepOpen = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const firedRef = useRef(false);
  const [err, setErr]               = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [manualCode, setManualCode] = useState('');

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    firedRef.current = false;

    async function start() {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const { DecodeHintType, BarcodeFormat } = await import('@zxing/library');
        // Live 1D scanning off a phone camera is far more reliable when zxing
        // is told to TRY_HARDER and which symbologies to expect. Our stickers
        // are CODE128; manufacturer product barcodes are EAN/UPC. Without these
        // hints the reader spreads its effort across every format and often
        // never locks onto a CODE128 code on a shaky, slightly-blurred frame.
        const hints = new Map();
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.DATA_MATRIX, // our sticker codes
          BarcodeFormat.QR_CODE,
          BarcodeFormat.CODE_128,    // older stickers still in circulation
          BarcodeFormat.CODE_39,
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
        ]);
        const reader = new BrowserMultiFormatReader(hints);

        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const backCamera = devices.find(d =>
          d.label.toLowerCase().includes('back') ||
          d.label.toLowerCase().includes('rear') ||
          d.label.toLowerCase().includes('environment')
        ) ?? devices[devices.length - 1] ?? devices[0];

        controls = await reader.decodeFromVideoDevice(
          backCamera?.deviceId ?? undefined,
          videoRef.current!,
          (result, _err) => {
            if (!result || stopped) return;
            if (keepOpen) {
              if (firedRef.current) return;
              firedRef.current = true;
              onScan(result.getText());
              setTimeout(() => { if (!stopped) firedRef.current = false; }, 1500);
            } else {
              if (firedRef.current) return;
              firedRef.current = true;
              controls?.stop();
              onScan(result.getText());
            }
          },
        );

        fallbackTimer = setTimeout(() => {
          if (!firedRef.current && !stopped) setShowManual(true);
        }, 8000);
      } catch (e) {
        if (!stopped) setErr(e instanceof Error ? e.message : 'Camera unavailable');
      }
    }

    start();

    return () => {
      stopped = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (controls) { try { controls.stop(); } catch (_) {} }
      const v = videoRef.current;
      if (v?.srcObject) {
        (v.srcObject as MediaStream).getTracks().forEach(t => t.stop());
        v.srcObject = null;
      }
    };
  }, [onScan, keepOpen]);

  function submitManual() {
    const code = manualCode.trim();
    if (!code) return;
    onScan(code);
    setManualCode('');
    if (!keepOpen) onClose();
  }

  return (
    <motion.div
      className="fixed inset-0 z-200 bg-black/92 flex flex-col items-center justify-center gap-4"
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
        {keepOpen
          ? 'Point camera at barcode — keep scanning'
          : 'Point camera at barcode — detected automatically'}
      </p>
      {showManual && (
        <div className="flex flex-col items-center gap-2 w-full px-8 max-w-sm">
          <p className="text-xs text-muted text-center">No scan detected — enter SKU manually:</p>
          <div className="flex gap-2 w-full">
            <input
              autoFocus
              value={manualCode}
              onChange={e => setManualCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitManual(); }}
              placeholder="Type barcode / SKU..."
              className="flex-1 px-3 py-2 rounded-xl bg-surface2 border border-white/10 text-slate-100 text-sm outline-none focus:border-teal/50"
            />
            <button
              onClick={submitManual}
              className="px-4 py-2 rounded-xl bg-teal/20 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/30 transition-all"
            >
              Go
            </button>
          </div>
        </div>
      )}
      <button
        onClick={onClose}
        className={keepOpen
          ? 'px-8 py-2.5 rounded-xl bg-teal/20 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/30 transition-all'
          : 'px-8 py-2.5 rounded-xl bg-surface2 border border-white/10 text-slate-100 text-sm font-bold hover:border-danger/40 hover:text-danger transition-all'
        }
      >
        {keepOpen ? '✓ Done Scanning' : 'Close'}
      </button>
    </motion.div>
  );
}
