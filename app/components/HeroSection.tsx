'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';

const CATEGORIES = ['Engine Oils', 'Batteries', 'Bearings', 'Filters', 'Consumables'];

export default function HeroSection() {
  return (
    <section className="relative min-h-[92vh] flex items-center justify-center overflow-hidden">

      {/* Soft animated backdrop */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, #0b1120 0%, #0e1a33 45%, #0a1526 75%, #0b1120 100%)',
          backgroundSize: '300% 300%',
          animation: 'gradient-shift 18s ease infinite',
        }}
      />

      {/* Single focal glow instead of particle noise */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className="w-[42rem] h-[42rem] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.07) 0%, transparent 65%)' }}
        />
      </div>

      {/* Faint blueprint grid for the industrial feel */}
      <div
        className="absolute inset-0 opacity-[0.025] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(56,189,248,1) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(56,189,248,1) 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
        }}
      />

      <div className="relative z-10 text-center px-5 sm:px-6 max-w-4xl mx-auto py-24">

        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-teal/25 bg-teal/5 text-teal text-[11px] sm:text-xs font-semibold uppercase tracking-widest mb-8"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse" />
          Auto Parts &amp; Consumables Distributor
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.6, ease: 'easeOut' as const }}
          className="text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.1] tracking-tight mb-6 text-slate-100"
        >
          Quality parts,
          <br />
          <span className="text-teal">delivered with trust.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.5 }}
          className="text-base sm:text-lg text-muted mb-8 max-w-xl mx-auto leading-relaxed"
        >
          Jay Aadinath Enterprises LTD supplies workshops, retailers and fleet
          operators with genuine automotive parts — from engine oils to
          specialty bearings.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="flex flex-wrap justify-center gap-2 mb-10"
        >
          {CATEGORIES.map((w, i) => (
            <motion.span
              key={w}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.55 + i * 0.07 }}
              className="px-3 py-1.5 rounded-lg bg-surface/80 border border-white/8 text-xs sm:text-sm text-slate-300"
            >
              {w}
            </motion.span>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.75, duration: 0.5 }}
          className="flex flex-col sm:flex-row gap-3 justify-center"
        >
          <Link
            href="/products"
            className="inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl font-bold text-navy bg-teal hover:bg-teal/90 transition-all duration-200 shadow-[0_8px_24px_rgba(56,189,248,0.25)] active:scale-[0.98]"
          >
            Browse Catalogue
            <span aria-hidden>→</span>
          </Link>
          <Link
            href="/#about"
            className="inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl font-semibold text-slate-200 border border-white/12 hover:border-teal/40 hover:text-teal transition-all duration-200"
          >
            Visit Our Stores
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.4 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 hidden sm:flex flex-col items-center gap-2"
        >
          <span className="text-[10px] text-muted/60 uppercase tracking-widest">Scroll</span>
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-px h-8 bg-linear-to-b from-teal/60 to-transparent"
          />
        </motion.div>
      </div>
    </section>
  );
}
