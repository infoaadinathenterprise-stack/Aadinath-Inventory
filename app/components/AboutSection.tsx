'use client';

import { useRef } from 'react';
import { motion, useInView } from 'framer-motion';

const LOCATIONS = [
  {
    name:    'Back Godown',
    icon:    '🏭',
    desc:    'Main storage facility — where bulk inventory is held and dispatched.',
    hours:   'Mon – Sat: 9 AM – 6 PM',
    tagline: 'Bulk Storage',
  },
  {
    name:    'Main Store',
    icon:    '🏪',
    desc:    'Walk-in store — ready stock for immediate purchase and retail customers.',
    hours:   'Mon – Sun: 9 AM – 7 PM',
    tagline: 'Walk-in Store',
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
    <section id="about" className="py-24 px-6 border-t border-teal/10">
      <div className="max-w-5xl mx-auto">

        {/* Heading */}
        <FadeIn>
          <div className="text-center mb-16">
            <span className="text-xs font-bold text-teal uppercase tracking-widest">About Us</span>
            <h2 className="text-4xl md:text-5xl font-bold text-slate-100 mt-3 mb-4">
              Built for the{' '}
              <span className="text-teal">Road Ahead</span>
            </h2>
            <p className="text-muted max-w-xl mx-auto text-base leading-relaxed">
              Aadinath Enterprises has been supplying quality auto parts and consumables to workshops,
              retailers, and fleet operators. From engine oils to specialty bearings — we have it all.
            </p>
          </div>
        </FadeIn>

        {/* Location cards */}
        <div className="grid md:grid-cols-2 gap-6 mb-16">
          {LOCATIONS.map((loc, i) => (
            <FadeIn key={loc.name} delay={i * 0.15}>
              <div className="relative p-6 rounded-2xl bg-surface border border-teal/10 hover:border-teal/30 transition-all duration-300 group overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-teal/3 blur-2xl group-hover:bg-teal/6 transition-all duration-500" />
                <div className="flex items-start gap-4">
                  <span className="text-4xl">{loc.icon}</span>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-slate-100 text-lg">{loc.name}</h3>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal/10 border border-teal/20 text-teal uppercase tracking-wider">
                        {loc.tagline}
                      </span>
                    </div>
                    <p className="text-muted text-sm mb-3 leading-relaxed">{loc.desc}</p>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span>🕐</span>
                      <span>{loc.hours}</span>
                    </div>
                  </div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>

        {/* Contact */}
        <FadeIn delay={0.3}>
          <div className="relative p-8 rounded-2xl bg-surface border border-gold/20 overflow-hidden text-center">
            <div className="absolute inset-0 bg-gradient-to-br from-gold/5 to-transparent" />
            <div className="relative">
              <span className="text-3xl mb-4 block">📞</span>
              <h3 className="font-bold text-xl text-slate-100 mb-2">Get in Touch</h3>
              <p className="text-muted text-sm mb-6">
                Looking for a specific part? Reach out — we&apos;re happy to help source it for you.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <a
                  href="tel:+910000000000"
                  className="flex items-center gap-2 px-6 py-3 rounded-full bg-gold/10 border border-gold/30 text-gold text-sm font-semibold hover:bg-gold/20 transition-all duration-200"
                >
                  📱 +91 00000 00000
                </a>
                <a
                  href="mailto:contact@aadinath.com"
                  className="flex items-center gap-2 px-6 py-3 rounded-full bg-teal/10 border border-teal/30 text-teal text-sm font-semibold hover:bg-teal/20 transition-all duration-200"
                >
                  ✉️ contact@aadinath.com
                </a>
              </div>
            </div>
          </div>
        </FadeIn>

        {/* Footer note */}
        <FadeIn delay={0.4}>
          <p className="text-center text-muted text-xs mt-12">
            © {new Date().getFullYear()} Aadinath Enterprises. All rights reserved.
          </p>
        </FadeIn>
      </div>
    </section>
  );
}
