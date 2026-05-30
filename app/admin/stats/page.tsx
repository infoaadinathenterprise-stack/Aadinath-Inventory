'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useProducts } from '@/lib/hooks/useProducts';
import { SESSION_KEY, USER_KEY, ROLE_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';

// Stock-totals dashboard moved off the Inventory page so it doesn't eat
// vertical space from the scrollable product list. Each card here is a
// link back to /admin?filter=… that pre-filters the inventory list to
// the matching set of products.

export default function StatsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null;
    if (!ok || role !== 'admin') router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <StatsDashboard />;
}

function StatsDashboard() {
  const { products, backStockMap, mainStockMap, backBoxMap, mainBoxMap, loading } = useProducts();

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/admin';
  }

  // Treat boxes as their piece-equivalent so "in stock" / "out of stock"
  // counts agree with what the user sees on the cards in inventory.
  function pieceTotal(map: Record<number, number>, boxMap: Record<number, number>, p: { product_id: number; pieces_per_box: number | null }) {
    const ppb = p.pieces_per_box ?? 0;
    return (map[p.product_id] || 0) + (boxMap[p.product_id] || 0) * ppb;
  }

  const totalBack = products.reduce((s, p) => s + pieceTotal(backStockMap, backBoxMap, p), 0);
  const totalMain = products.reduce((s, p) => s + pieceTotal(mainStockMap, mainBoxMap, p), 0);
  const inStock   = products.filter(p =>
    pieceTotal(backStockMap, backBoxMap, p) + pieceTotal(mainStockMap, mainBoxMap, p) > 0,
  ).length;
  const outStock  = products.length - inStock;
  const backCount = products.filter(p => pieceTotal(backStockMap, backBoxMap, p) > 0).length;
  const mainCount = products.filter(p => pieceTotal(mainStockMap, mainBoxMap, p) > 0).length;

  // value = the total piece count for piece-pool cards, or the product
  // count for status cards. sub = the secondary line under the value.
  const CARDS: { label: string; value: number; sub: string; icon: string; href: string; tone: 'teal' | 'gold' | 'success' | 'danger' }[] = [
    { label: 'Total Products', value: products.length, sub: 'all active products',     icon: '🗂️',  href: '/admin',                     tone: 'teal'    },
    { label: 'In Stock',       value: inStock,         sub: `${products.length ? Math.round(100 * inStock / products.length) : 0}% of catalog`, icon: '✅', href: '/admin?filter=in_stock',     tone: 'success' },
    { label: 'Out of Stock',   value: outStock,        sub: 'needs reorder',           icon: '⚠️',  href: '/admin?filter=out_of_stock', tone: 'danger'  },
    { label: 'Back Godown',    value: totalBack,       sub: `${backCount} product${backCount === 1 ? '' : 's'}`, icon: '🏭', href: '/admin?filter=back_only', tone: 'gold' },
    { label: 'Main Store',     value: totalMain,       sub: `${mainCount} product${mainCount === 1 ? '' : 's'}`, icon: '🏪', href: '/admin?filter=main_only', tone: 'teal' },
  ];

  const toneClass: Record<typeof CARDS[number]['tone'], { border: string; value: string }> = {
    teal:    { border: 'border-teal/20 hover:border-teal/40',       value: 'text-teal' },
    gold:    { border: 'border-gold/20 hover:border-gold/40',       value: 'text-gold' },
    success: { border: 'border-success/20 hover:border-success/40', value: 'text-success' },
    danger:  { border: 'border-danger/20 hover:border-danger/40',   value: 'text-danger' },
  };

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">
        <div className="pt-5 pb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-100">Stats</h2>
            <p className="text-xs text-muted mt-0.5">Tap a card to open the inventory filtered to it</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {CARDS.map((c, i) => (
              <motion.div
                key={c.label}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.3 }}
              >
                <Link
                  href={c.href}
                  className={`flex flex-col p-5 rounded-2xl bg-surface border ${toneClass[c.tone].border} relative overflow-hidden cursor-pointer transition-all group`}
                >
                  <div className="absolute top-3 right-3 text-2xl opacity-50 group-hover:opacity-90 transition-opacity">{c.icon}</div>
                  <span className={`text-3xl font-bold tabular-nums ${toneClass[c.tone].value}`}>
                    {c.value}
                  </span>
                  <span className="text-xs text-slate-200 font-semibold mt-1">{c.label}</span>
                  <span className="text-[10px] text-muted mt-0.5">{c.sub}</span>
                  <span className="text-[10px] text-muted/60 mt-2 group-hover:text-teal transition-colors">
                    Open filtered inventory →
                  </span>
                </Link>
              </motion.div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
