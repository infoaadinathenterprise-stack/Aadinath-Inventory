'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

const LOCATIONS = [
  {
    name:    'Main Store',
    icon:    '🏪',
    desc:    'Walk-in store — ready stock for immediate purchase and retail customers.',
    hours:   'Mon – Sun: 9 AM – 7 PM',
    tagline: 'Walk-in Store',
  },
  {
    name:    'Main Store · First Floor',
    icon:    '🏬',
    desc:    'Extended showroom floor — specialty parts and additional ready stock.',
    hours:   'Mon – Sun: 9 AM – 7 PM',
    tagline: 'Showroom',
  },
  {
    name:    'Back Godown',
    icon:    '🏭',
    desc:    'Main storage facility — where bulk inventory is held and dispatched.',
    hours:   'Mon – Sat: 9 AM – 6 PM',
    tagline: 'Bulk Storage',
  },
];

function FadeIn({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref    = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.6 }}
    >
      {children}
    </motion.div>
  );
}

export default function AboutSection() {
  return (
    <section id="about" className="py-24 px-5 sm:px-6 border-t border-white/5">
      <div className="max-w-5xl mx-auto">

        <FadeIn>
          <div className="text-center mb-14 sm:mb-16">
            <span className="text-[11px] sm:text-xs font-bold text-teal uppercase tracking-[0.2em]">About Us</span>
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-slate-100 mt-4 mb-5 tracking-tight">
              Built for the <span className="text-gradient">road ahead</span>
            </h2>
            <p className="text-muted max-w-xl mx-auto text-sm sm:text-base leading-relaxed">
              Jay Aadinath Enterprises LTD has been supplying quality auto parts and consumables to workshops,
              retailers, and fleet operators. From engine oils to specialty bearings — we have it all.
            </p>
          </div>
        </FadeIn>

        <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-5 mb-14">
          {LOCATIONS.map((loc, i) => (
            <FadeIn key={loc.name} delay={i * 0.12}>
              <div className="relative h-full p-5 sm:p-6 rounded-2xl card-lux hover:border-teal/25 transition-colors duration-300 group overflow-hidden">
                <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-teal/4 blur-2xl group-hover:bg-teal/8 transition-all duration-500 pointer-events-none" />

                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl mb-4"
                  style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.14), rgba(79,70,229,0.10))', border: '1px solid rgba(56,189,248,0.2)' }}
                >
                  {loc.icon}
                </div>

                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <h3 className="font-bold text-slate-100 text-base">{loc.name}</h3>
                </div>
                <span className="inline-block text-[9px] font-bold px-2 py-0.5 rounded-full bg-teal/10 border border-teal/20 text-teal uppercase tracking-wider mb-3">
                  {loc.tagline}
                </span>
                <p className="text-muted text-[13px] mb-4 leading-relaxed">{loc.desc}</p>
                <div className="flex items-center gap-2 text-xs text-muted/80">
                  <span>🕐</span>
                  <span>{loc.hours}</span>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.3}>
          <div className="relative p-8 sm:p-10 rounded-3xl card-lux overflow-hidden text-center">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(600px 300px at 50% 0%, rgba(243,185,77,0.07), transparent 70%)' }} />
            <div className="relative">
              <h3 className="font-extrabold text-2xl sm:text-3xl text-slate-100 mb-2 tracking-tight">
                Looking for a <span className="text-gradient-gold">specific part?</span>
              </h3>
              <p className="text-muted text-sm mb-7 max-w-md mx-auto">
                Reach out — we&apos;re happy to help source it for you.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <a
                  href="tel:+910000000000"
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-2xl bg-gold/10 border border-gold/30 text-gold text-sm font-semibold hover:bg-gold/20 transition-all duration-200"
                >
                  📱 +91 00000 00000
                </a>
                <a
                  href="mailto:contact@aadinath.com"
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-7 py-3.5 rounded-2xl btn-primary text-sm font-semibold"
                >
                  ✉️ contact@aadinath.com
                </a>
              </div>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={0.4}>
          <p className="text-center text-muted/50 text-xs mt-12">
            © {new Date().getFullYear()} Jay Aadinath Enterprises LTD. All rights reserved.
          </p>
        </FadeIn>
      </div>
    </section>
  );
}
