'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, AnimatePresence, useMotionValueEvent, useScroll } from 'framer-motion';

const NAV_LINKS = [
  { href: '/',         label: 'Home' },
  { href: '/products', label: 'Products' },
  { href: '/#about',   label: 'About' },
];

export default function Navbar() {
  const [open, setOpen]         = useState(false);
  const [hidden, setHidden]     = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  const router   = useRouter();
  const pathname = usePathname();

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
            ? 'bg-navy/85 backdrop-blur-md border-b border-white/5 shadow-lg'
            : 'bg-transparent'
        }`}
      >
        <div className="max-w-7xl mx-auto px-5 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Brand */}
          <Link href="/" className="flex items-center gap-2.5 group min-w-0">
            <span className="w-8 h-8 rounded-lg bg-teal/10 border border-teal/25 flex items-center justify-center text-teal font-bold text-sm shrink-0 group-hover:bg-teal/15 transition-colors">
              JA
            </span>
            <span className="font-bold text-base sm:text-lg text-slate-100 tracking-tight truncate">
              Jay Aadinath<span className="text-teal"> Enterprises</span>
            </span>
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'text-teal bg-teal/10'
                      : 'text-muted hover:text-slate-100 hover:bg-white/5'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <button
              onClick={() => router.push('/admin')}
              className="ml-2 px-4 py-2 rounded-lg text-sm font-semibold text-gold border border-gold/25 hover:bg-gold/10 transition-colors"
            >
              Staff Login
            </button>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="md:hidden flex flex-col justify-center items-center gap-1.5 w-10 h-10 rounded-xl bg-surface/80 border border-white/8 hover:border-teal/30 transition-all duration-200"
          >
            <span className="w-5 h-0.5 rounded-full bg-slate-300 block" />
            <span className="w-5 h-0.5 rounded-full bg-slate-300 block" />
            <span className="w-5 h-0.5 rounded-full bg-slate-300 block" />
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
              className="fixed right-0 top-0 bottom-0 w-72 z-50 flex flex-col bg-surface border-l border-white/8 shadow-2xl"
            >
              <div className="flex items-center justify-between px-6 h-16 border-b border-white/5">
                <span className="font-bold text-slate-100 text-base tracking-tight">
                  Jay Aadinath<span className="text-teal"> Enterprises</span>
                </span>
                <button
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface2 text-muted hover:text-slate-100 hover:bg-white/8 transition-all text-lg"
                >
                  ×
                </button>
              </div>

              <nav className="flex-1 px-4 py-6 flex flex-col gap-1">
                {NAV_LINKS.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="px-4 py-3 rounded-xl text-muted hover:text-slate-100 hover:bg-white/5 transition-all duration-200 text-sm font-medium"
                  >
                    {label}
                  </Link>
                ))}

                <div className="my-3 border-t border-white/8" />

                <button
                  onClick={() => { setOpen(false); router.push('/admin'); }}
                  className="px-4 py-3 rounded-xl text-gold hover:bg-gold/8 border border-gold/20 hover:border-gold/40 transition-all duration-200 text-sm font-semibold w-full text-left"
                >
                  Staff Login →
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
