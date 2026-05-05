'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import type { Product, StockMap } from '@/lib/types';

interface Props {
  products:     Product[];
  backStockMap: StockMap;
  mainStockMap: StockMap;
}

function Counter({ target, running }: { target: number; running: boolean }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!running) { setCount(0); return; }
    if (target === 0) { setCount(0); return; }
    const steps = 40;
    const inc   = target / steps;
    let cur = 0;
    const t = setInterval(() => {
      cur += inc;
      if (cur >= target) { setCount(target); clearInterval(t); }
      else setCount(Math.floor(cur));
    }, 800 / steps);
    return () => clearInterval(t);
  }, [running, target]);
  return <>{count}</>;
}

export default function StatsBar({ products, backStockMap, mainStockMap }: Props) {
  const ref    = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });

  const totalBack = products.reduce((s, p) => s + (backStockMap[p.product_id] || 0), 0);
  const totalMain = products.reduce((s, p) => s + (mainStockMap[p.product_id] || 0), 0);
  const inStock   = products.filter(p =>
    (backStockMap[p.product_id] || 0) + (mainStockMap[p.product_id] || 0) > 0
  ).length;

  const STATS = [
    { label: 'Total Products', value: products.length, icon: '🗂️',  color: 'text-teal',    border: 'border-teal/20'    },
    { label: 'In Stock',       value: inStock,          icon: '✅',  color: 'text-success', border: 'border-success/20' },
    { label: 'Out of Stock',   value: products.length - inStock, icon: '⚠️', color: 'text-danger', border: 'border-danger/20' },
    { label: 'Back Godown',    value: totalBack,        icon: '🏭',  color: 'text-gold',    border: 'border-gold/20'    },
    { label: 'Main Store',     value: totalMain,        icon: '🏪',  color: 'text-teal',    border: 'border-teal/20'    },
  ];

  return (
    <div ref={ref} className="px-4 pt-4 pb-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {STATS.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 20 }}
            animate={inView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: i * 0.08, duration: 0.4 }}
            className={`flex flex-col p-4 rounded-xl bg-surface border ${s.border} relative overflow-hidden`}
          >
            <div className="absolute top-2 right-2 text-lg opacity-60">{s.icon}</div>
            <span className={`text-2xl font-bold tabular-nums ${s.color}`}>
              <Counter target={s.value} running={inView} />
            </span>
            <span className="text-[11px] text-muted font-medium mt-0.5 leading-tight">{s.label}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
