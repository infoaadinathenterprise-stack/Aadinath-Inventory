'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';

const CATEGORIES = ['Engine Oils', 'Batteries', 'Bearings', 'Filters', 'Consumables'];

export default function HeroSection() {
  return (
    <section className="relative min-h-[94vh] flex items-center justify-center overflow-hidden">

      {/* Focal glow behind the headline */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className="w-[48rem] h-[48rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.10) 0%, rgba(79,70,229,0.05) 35%, transparent 65%)' }}
        />
      </div>

      {/* Faint blueprint grid, masked so it fades at the edges */}
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(141,163,197,1) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(141,163,197,1) 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 40%, black 30%, transparent 75%)',
        }}
      />

      <div className="relative z-10 text-center px-5 sm:px-6 max-w-4xl mx-auto py-28">

        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full glass border text-[11px] sm:text-xs font-semibold uppercase tracking-[0.18em] text-slate-300 mb-9"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-gold shadow-[0_0_8px_rgba(243,185,77,0.8)]" />
          Auto Parts &amp; Consumables Distributor
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, duration: 0.65, ease: 'easeOut' as const }}
          className="text-[2.6rem] sm:text-6xl md:text-7xl font-extrabold leading-[1.05] tracking-tight mb-7 text-slate-100"
        >
          Genuine parts.
          <br />
          <span className="text-gradient">Delivered with trust.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.32, duration: 0.5 }}
          className="text-base sm:text-lg text-muted mb-9 max-w-xl mx-auto leading-relaxed"
        >
          Jay Aadinath Enterprises LTD supplies workshops, retailers and fleet
          operators with premium automotive products — from engine oils to
          specialty bearings.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45 }}
          className="flex flex-wrap justify-center gap-2 mb-11"
        >
          {CATEGORIES.map((w, i) => (
            <motion.span
              key={w}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5 + i * 0.06 }}
              className="px-3.5 py-1.5 rounded-full glass border text-xs sm:text-sm text-slate-300"
            >
              {w}
            </motion.span>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.65, duration: 0.5 }}
          className="flex flex-col sm:flex-row gap-3 justify-center"
        >
          <Link
            href="/products"
            className="btn-primary inline-flex items-center justify-center gap-2 px-9 py-4 rounded-2xl font-bold text-[15px]"
          >
            Browse Catalogue
            <span aria-hidden>→</span>
          </Link>
          <Link
            href="/#about"
            className="inline-flex items-center justify-center gap-2 px-9 py-4 rounded-2xl font-semibold text-[15px] text-slate-200 card-lux hover:border-teal/30 transition-colors"
          >
            Visit Our Stores
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
