'use client';

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export type ToastType = 'success' | 'error' | 'info' | '';

export interface ToastState {
  msg:  string;
  type: ToastType;
  id:   number;
}

interface Props {
  toast:      ToastState | null;
  onDismiss:  () => void;
}

const STYLES: Record<ToastType, string> = {
  success: 'bg-success/15 border-success/40 text-success',
  error:   'bg-danger/15  border-danger/40  text-danger',
  info:    'bg-teal/15    border-teal/40    text-teal',
  '':      'bg-surface2   border-white/10   text-slate-100',
};

const ICONS: Record<ToastType, string> = {
  success: '✓', error: '✕', info: 'ℹ', '': '•',
};

export default function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 2800);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] pointer-events-none">
      <AnimatePresence mode="wait">
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ y: 60, opacity: 0, scale: 0.9 }}
            animate={{ y: 0,  opacity: 1, scale: 1 }}
            exit={{   y: 60, opacity: 0, scale: 0.9 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            className={`flex items-center gap-2.5 px-5 py-3 rounded-xl border text-sm font-semibold shadow-2xl whitespace-nowrap ${STYLES[toast.type]}`}
          >
            <span className="font-bold text-base">{ICONS[toast.type]}</span>
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
