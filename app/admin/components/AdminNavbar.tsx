'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ROLE_KEY, type UserRole } from '@/lib/types';

interface Props {
  onLogout: () => void;
}

const ALL_LINKS = [
  { emoji: '📦', label: 'Inventory', href: '/admin',                   roles: ['admin', 'staff'] as UserRole[] },
  { emoji: '📊', label: 'Stats',     href: '/admin/stats',             roles: ['admin'] as UserRole[] },
  { emoji: '🛒', label: 'Sales',     href: '/admin/sales',             roles: ['admin'] as UserRole[] },
  { emoji: '📋', label: 'History',   href: '/admin/history',           roles: ['admin'] as UserRole[] },
  { emoji: '🧾', label: 'Purchases', href: '/admin/purchases',         roles: ['admin'] as UserRole[] },
  { emoji: '🏢', label: 'Suppliers', href: '/admin/suppliers',         roles: ['admin'] as UserRole[] },
  { emoji: '🏷️', label: 'Labels',    href: '/admin/labels',            roles: ['admin'] as UserRole[] },
  { emoji: '🏭', label: 'POS',       href: '/admin/pos',               roles: ['admin', 'staff'] as UserRole[] },
  { emoji: '🗂️', label: 'Audit',     href: '/admin/inventory-audit',   roles: ['admin', 'staff'] as UserRole[] },
  { emoji: '✅', label: 'Approvals', href: '/admin/approvals',         roles: ['admin'] as UserRole[] },
  { emoji: '👥', label: 'Staff',     href: '/admin/staff',             roles: ['admin'] as UserRole[] },
];

export default function AdminNavbar({ onLogout }: Props) {
  const [open, setOpen]   = useState(false);
  const [role, setRole]   = useState<UserRole>('admin');
  const pathname          = usePathname();

  useEffect(() => {
    setRole((localStorage.getItem(ROLE_KEY) as UserRole) || 'admin');
  }, []);

  const links = ALL_LINKS.filter(l => l.roles.includes(role));
  const isAdmin = role === 'admin';

  return (
    <>
      <nav className="fixed top-0 inset-x-0 z-50 bg-navy border-b border-teal/10 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="font-bold text-base text-teal tracking-tight leading-none">
              Jay Aadinath<span className="text-gold">·</span>
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-widest ${
              isAdmin
                ? 'bg-gold/15 border-gold/30 text-gold'
                : 'bg-teal/15 border-teal/30 text-teal'
            }`}>
              {isAdmin ? 'Admin' : 'Staff'}
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-0.5">
            {links.map(({ emoji, label, href }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-teal/10 text-teal'
                      : 'text-muted hover:text-slate-100 hover:bg-white/5'
                  }`}
                >
                  <span>{emoji}</span>{label}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onLogout}
              className="text-xs text-muted hover:text-danger transition-colors duration-200 px-3 py-1.5 rounded-lg hover:bg-danger/10 border border-transparent hover:border-danger/20"
            >
              Sign out
            </button>
            <button
              onClick={() => setOpen(true)}
              aria-label="Open menu"
              className="w-9 h-9 rounded-lg bg-surface2 border border-white/8 hover:border-teal/30 transition-all lg:hidden flex flex-col justify-center items-center gap-1"
            >
              <span className="w-4 h-0.5 bg-slate-300 rounded-full" />
              <span className="w-4 h-0.5 bg-slate-300 rounded-full" />
              <span className="w-4 h-0.5 bg-slate-300 rounded-full" />
            </button>
          </div>
        </div>
      </nav>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              key="drawer"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-68 z-50 flex flex-col bg-surface border-l border-teal/10 shadow-2xl"
            >
              <div className="flex items-center justify-between px-5 h-14 border-b border-white/5">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-teal text-sm">Jay Aadinath<span className="text-gold">·</span></span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border uppercase tracking-widest ${
                    isAdmin
                      ? 'bg-gold/15 border-gold/30 text-gold'
                      : 'bg-teal/15 border-teal/30 text-teal'
                  }`}>
                    {isAdmin ? 'Admin' : 'Staff'}
                  </span>
                </div>
                <button onClick={() => setOpen(false)} className="w-7 h-7 flex items-center justify-center rounded-lg bg-surface2 text-muted hover:text-slate-100 transition-colors text-lg">×</button>
              </div>

              <nav className="flex-1 px-3 py-5 flex flex-col gap-1 overflow-y-auto">
                {links.map(({ emoji, label, href }) => {
                  const active = pathname === href;
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        active ? 'bg-teal/10 border border-teal/20 text-teal' : 'text-muted hover:text-slate-100 hover:bg-white/5'
                      }`}
                    >
                      <span>{emoji}</span>{label}
                      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-teal" />}
                    </Link>
                  );
                })}

                <div className="my-3 border-t border-white/8" />

                <Link
                  href="/"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-muted hover:text-slate-100 hover:bg-white/5 transition-all"
                >
                  <span>🏠</span> Back to Site
                  <span className="ml-auto text-muted/40 text-xs">↗</span>
                </Link>

                <div className="my-3 border-t border-white/8" />

                <button
                  onClick={() => { setOpen(false); onLogout(); }}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-danger hover:bg-danger/10 transition-all w-full text-left"
                >
                  <span>🚪</span> Sign Out
                </button>
              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
