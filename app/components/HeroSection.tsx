'use client';

import { motion } from 'framer-motion';
import Link from 'next/link';

const WORDS = ['Oils', 'Batteries', 'Bearings', 'Filters', 'Consumables'];

const PARTICLES = [
  { id: 0,  left: '10%', top: '20%', size: 8,  delay: 0.0, duration: 8  },
  { id: 1,  left: '25%', top: '60%', size: 12, delay: 0.5, duration: 11 },
  { id: 2,  left: '47%', top: '35%', size: 6,  delay: 1.0, duration: 9  },
  { id: 3,  left: '70%', top: '80%', size: 10, delay: 1.5, duration: 12 },
  { id: 4,  left: '85%', top: '15%', size: 8,  delay: 2.0, duration: 7  },
  { id: 5,  left: '60%', top: '50%', size: 14, delay: 0.8, duration: 10 },
  { id: 6,  left: '35%', top: '90%', size: 6,  delay: 1.2, duration: 13 },
  { id: 7,  left: '90%', top: '40%', size: 10, delay: 0.3, duration: 8  },
  { id: 8,  left: '15%', top: '75%', size: 5,  delay: 2.5, duration: 9  },
  { id: 9,  left: '55%', top: '10%', size: 9,  delay: 0.7, duration: 11 },
  { id: 10, left: '78%', top: '65%', size: 7,  delay: 1.8, duration: 14 },
  { id: 11, left: '42%', top: '45%', size: 11, delay: 0.4, duration: 7  },
  { id: 12, left: '20%', top: '30%', size: 4,  delay: 3.0, duration: 10 },
  { id: 13, left: '65%', top: '25%', size: 8,  delay: 1.1, duration: 9  },
  { id: 14, left: '30%', top: '55%', size: 6,  delay: 2.2, duration: 12 },
  { id: 15, left: '50%', top: '70%', size: 10, delay: 0.6, duration: 8  },
  { id: 16, left: '80%', top: '85%', size: 5,  delay: 1.9, duration: 11 },
  { id: 17, left: '5%',  top: '50%', size: 7,  delay: 0.2, duration: 13 },
  { id: 18, left: '93%', top: '70%', size: 9,  delay: 2.8, duration: 9  },
  { id: 19, left: '38%', top: '15%', size: 6,  delay: 1.4, duration: 10 },
];


export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">

      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(135deg, #0a0f1e 0%, #0d1a30 40%, #071420 70%, #0a0f1e 100%)',
          backgroundSize: '400% 400%',
          animation: 'gradient-shift 12s ease infinite',
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className="w-150 h-150 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(0,212,255,0.08) 0%, transparent 70%)',
          }}
        />
      </div>

      {PARTICLES.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full bg-teal pointer-events-none"
          style={{ left: p.left, top: p.top, width: p.size, height: p.size }}
          animate={{ y: [0, -25, 0], opacity: [0.2, 0.7, 0.2], scale: [1, 1.2, 1] }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}

      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(0,212,255,1) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(0,212,255,1) 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative z-10 text-center px-6 max-w-5xl mx-auto">

        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-teal/30 bg-teal/5 text-teal text-xs font-semibold uppercase tracking-widest mb-8"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse" />
          Trusted Auto Parts Distributor
        </motion.div>

        <h1 className="text-5xl md:text-7xl font-bold leading-tight mb-4">
          {'Aadinath Enterprises'.split(' ').map((word, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 + i * 0.12, duration: 0.6, ease: 'easeOut' as const }}
              className={`inline-block mr-4 ${i === 1 ? 'text-teal' : 'text-slate-100'}`}
            >
              {word}
            </motion.span>
          ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.9, duration: 0.6 }}
          className="text-lg md:text-xl text-muted mb-4 max-w-2xl mx-auto"
        >
          Your one-stop distributor for premium automotive products.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.1 }}
          className="flex flex-wrap justify-center gap-3 mb-10"
        >
          {WORDS.map((w, i) => (
            <motion.span
              key={w}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 1.2 + i * 0.1 }}
              className="px-3 py-1 rounded-full bg-surface border border-teal/20 text-sm text-muted"
            >
              {w}
            </motion.span>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.4, duration: 0.5 }}
          className="flex flex-col sm:flex-row gap-4 justify-center"
        >
          <Link
            href="/products"
            className="group relative inline-flex items-center gap-2 px-8 py-4 rounded-full font-bold text-navy bg-teal hover:bg-teal/90 transition-all duration-300 shadow-lg"
            style={{ animation: 'pulse-glow 3s ease-in-out infinite' }}
          >
            Browse Products
            <motion.span
              animate={{ x: [0, 4, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              →
            </motion.span>
          </Link>
          <Link
            href="/#about"
            className="inline-flex items-center gap-2 px-8 py-4 rounded-full font-semibold text-teal border border-teal/40 hover:border-teal hover:bg-teal/5 transition-all duration-300"
          >
            Learn More
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2 }}
          className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        >
          <span className="text-xs text-muted uppercase tracking-widest">Scroll</span>
          <motion.div
            animate={{ y: [0, 8, 0] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="w-px h-8 bg-linear-to-b from-teal to-transparent"
          />
        </motion.div>
      </div>
    </section>
  );
}
