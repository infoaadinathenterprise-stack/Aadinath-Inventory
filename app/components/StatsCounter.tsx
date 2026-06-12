'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';

const STATS = [
  { value: 250, suffix: '+', label: 'Products',      icon: '📦' },
  { value: 3,   suffix: '',  label: 'Locations',     icon: '📍' },
  { value: 15,  suffix: '+', label: 'Categories',    icon: '🗂️' },
  { value: 100, suffix: '%', label: 'Genuine Parts', icon: '✅' },
];

function Counter({ target, suffix, running }: { target: number; suffix: string; running: boolean }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!running) return;
    const duration = 1800;
    const steps    = 60;
    const increment = target / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= target) { setCount(target); clearInterval(timer); }
      else setCount(Math.floor(current));
    }, duration / steps);
    return () => clearInterval(timer);
  }, [running, target]);

  return <>{count}{suffix}</>;
}

export default function StatsCounter() {
  const ref    = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });

  return (
    <section ref={ref} className="py-20 px-6">
      <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-6">
        {STATS.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 30 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: i * 0.12, duration: 0.5 }}
            className="relative flex flex-col items-center text-center p-4 sm:p-6 rounded-2xl bg-surface border border-white/6 hover:border-teal/25 transition-colors duration-300"
          >
            <span className="text-2xl sm:text-3xl mb-2 sm:mb-3">{stat.icon}</span>
            <span className="text-3xl sm:text-4xl font-bold text-teal mb-1 tabular-nums">
              <Counter target={stat.value} suffix={stat.suffix} running={inView} />
            </span>
            <span className="text-xs sm:text-sm text-muted font-medium">{stat.label}</span>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
