'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence, useMotionValueEvent, useScroll } from 'framer-motion';

const NAV_LINKS = [
  { href: '/',         label: 'Home',     emoji: '🏠' },
  { href: '/products', label: 'Products', emoji: '📦' },
  { href: '/#about',   label: 'About',    emoji: 'ℹ️'  },
];

export default function Navbar() {
  const [open, setOpen]       = useState(false);
  const [hidden, setHidden]   = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  const router = useRouter();

  useMotionValueEvent(scrollY, 'change', (latest) => {
    const prev = scrollY.getPrevious() ?? 0;
    if (!open) setHidden(latest > prev && latest > 80);
    setScrolled(latest > 20);
  });

  return (
    <>
      <motion.nav
        variants={{ visible: { y: 0 }, hidden: { y: '-100%' } }}
        animate={hidden && !open ? 'hidden' : 'visible'}
        transition={{ duration: 0.3, ease: 'easeInOut' as const }}
        className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-navy/80 backdrop-blur-md border-b border-teal/10 shadow-lg'
            : 'bg-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center group">
            <span className="font-bold text-xl text-teal tracking-tight group-hover:opacity-80 transition-opacity">
              Jay Aadinath
            </span>
            <span className="text-gold font-bold text-xl">·</span>
          </Link>

          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="flex flex-col justify-center items-center gap-1.5 w-10 h-10 rounded-xl bg-surface/80 border border-white/8 hover:border-teal/30 transition-all duration-200"
          >
            <span className="w-5 h-px bg-slate-300 block" />
            <span className="w-5 h-px bg-slate-300 block" />
            <span className="w-3.5 h-px bg-slate-300 block self-start ml-1.25" />
          </button>
        </div>
      </motion.nav>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />

            <motion.div
              key="drawer"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-72 z-50 flex flex-col bg-surface border-l border-teal/10 shadow-2xl"
            >
              <div className="flex items-center justify-between px-6 h-16 border-b border-white/5">
                <span className="font-bold text-teal text-base tracking-tight">
                  Jay Aadinath<span className="text-gold">·</span>
                </span>
                <button
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface2 text-muted hover:text-slate-100 hover:bg-white/8 transition-all text-lg"
                >
                  ×
                </button>
              </div>

              <nav className="flex-1 px-4 py-6 flex flex-col gap-1">
                {NAV_LINKS.map(({ href, label, emoji }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl text-muted hover:text-slate-100 hover:bg-white/5 transition-all duration-200 text-sm font-medium"
                  >
                    <span className="text-base">{emoji}</span>
                    {label}
                  </Link>
                ))}

                <div className="my-3 border-t border-white/8" />

                <button
                  onClick={() => { setOpen(false); router.push('/admin'); }}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl text-gold hover:bg-gold/8 border border-gold/20 hover:border-gold/40 transition-all duration-200 text-sm font-semibold w-full text-left"
                >
                  <span className="text-base">🔐</span>
                  Admin Panel
                  <span className="ml-auto text-gold/50 text-xs">→</span>
                </button>
              </nav>

              <div className="px-6 py-4 border-t border-white/5">
                <p className="text-xs text-muted/50 text-center">
                  © {new Date().getFullYear()} Jay Aadinath Enterprises LTD
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
