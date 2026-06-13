'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';

const STATS = [
  { value: 250, suffix: '+', label: 'Products' },
  { value: 3,   suffix: '',  label: 'Locations' },
  { value: 15,  suffix: '+', label: 'Categories' },
  { value: 100, suffix: '%', label: 'Genuine Parts' },
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
    <section ref={ref} className="py-16 sm:py-20 px-5 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6 }}
        className="max-w-4xl mx-auto card-lux rounded-3xl grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-white/6 overflow-hidden"
      >
        {STATS.map((stat) => (
          <div key={stat.label} className="flex flex-col items-center text-center px-4 py-7 sm:py-9">
            <span
              className="text-3xl sm:text-4xl font-extrabold text-gradient mb-1.5 tabular-nums"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              <Counter target={stat.value} suffix={stat.suffix} running={inView} />
            </span>
            <span className="text-[11px] sm:text-xs text-muted font-semibold uppercase tracking-[0.14em]">{stat.label}</span>
          </div>
        ))}
      </motion.div>
    </section>
  );
}
