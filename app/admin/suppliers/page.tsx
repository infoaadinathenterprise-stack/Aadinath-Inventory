'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import type { Supplier } from '@/lib/types';
import { SESSION_KEY, ROLE_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

interface SupplierForm {
  supplier_name: string;
  phone: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: SupplierForm = { supplier_name: '', phone: '', address: '', notes: '' };

function SuppliersDashboard() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [modal,     setModal]     = useState<{ editing: Supplier | null } | null>(null);
  const [form,      setForm]      = useState<SupplierForm>(EMPTY_FORM);
  const [saving,    setSaving]    = useState(false);
  const [toast,     setToast]     = useState<ToastState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const toastId = useRef(0);
  const router = useRouter();

  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') router.replace('/admin');
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('suppliers').select('*').eq('active_status', true).order('supplier_name');
    if (error) {
      setToast({ msg: 'Failed to load suppliers: ' + error.message, type: 'error', id: ++toastId.current });
    } else {
      setSuppliers((data ?? []) as Supplier[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId.current });
  }

  function openAdd() {
    setForm(EMPTY_FORM);
    setModal({ editing: null });
  }

  function openEdit(s: Supplier) {
    setForm({ supplier_name: s.supplier_name, phone: s.phone ?? '', address: s.address ?? '', notes: s.notes ?? '' });
    setModal({ editing: s });
  }

  async function save() {
    if (!form.supplier_name.trim()) { showToast('Supplier name is required', 'error'); return; }
    const dup = suppliers.find(s =>
      s.supplier_name.toLowerCase() === form.supplier_name.trim().toLowerCase() &&
      s.supplier_id !== modal?.editing?.supplier_id
    );
    if (dup) { showToast(`"${dup.supplier_name}" already exists`, 'error'); return; }

    setSaving(true);
    const payload = {
      supplier_name: form.supplier_name.trim(),
      phone:   form.phone.trim()   || null,
      address: form.address.trim() || null,
      notes:   form.notes.trim()   || null,
      active_status: true,
    };
    const { error } = modal?.editing
      ? await supabase.from('suppliers').update(payload).eq('supplier_id', modal.editing.supplier_id)
      : await supabase.from('suppliers').insert(payload);
    setSaving(false);
    if (error) { showToast('Error: ' + error.message, 'error'); return; }
    showToast(modal?.editing ? 'Supplier updated ✓' : 'Supplier added ✓', 'success');
    setModal(null);
    load();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { error } = await supabase.from('suppliers').update({ active_status: false }).eq('supplier_id', deleteTarget.supplier_id);
    if (error) { showToast('Error: ' + error.message, 'error'); }
    else { showToast('Supplier removed', 'success'); load(); }
    setDeleteTarget(null);
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  const filtered = suppliers.filter(s =>
    !search || s.supplier_name.toLowerCase().includes(search.toLowerCase()) ||
    (s.phone ?? '').includes(search) || (s.address ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-7xl mx-auto w-full px-4 pb-10">

        <div className="flex items-center justify-between pt-5 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-100">Suppliers</h2>
            <p className="text-xs text-muted mt-0.5">{suppliers.length} suppliers</p>
          </div>
          <button
            onClick={openAdd}
            className="px-4 py-2 rounded-xl bg-teal/10 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/20 transition-all"
          >
            + Add Supplier
          </button>
        </div>

        <div className="relative mb-4">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">🔍</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search suppliers..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-surface border border-white/8 text-slate-100 text-sm placeholder:text-muted/50 outline-none focus:border-teal/40"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-muted">
            <div className="text-4xl mb-3">🏢</div>
            <p className="text-sm">{search ? 'No suppliers found' : 'No suppliers yet. Add your first one.'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {filtered.map((s, i) => (
              <motion.div
                key={s.supplier_id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="bg-surface border border-white/8 rounded-xl p-4 flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/20 flex items-center justify-center text-lg shrink-0">🏢</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-slate-100">{s.supplier_name}</div>
                  <div className="text-xs text-muted mt-0.5">
                    {[s.phone, s.address].filter(Boolean).join(' · ') || 'No contact info'}
                  </div>
                  {s.notes && <div className="text-xs text-muted/60 mt-0.5 truncate">{s.notes}</div>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => openEdit(s)} className="w-8 h-8 rounded-lg bg-surface2 border border-white/8 text-muted hover:text-teal hover:border-teal/30 flex items-center justify-center text-sm transition-all">✏️</button>
                  <button onClick={() => setDeleteTarget(s)} className="w-8 h-8 rounded-lg bg-surface2 border border-white/8 text-muted hover:text-danger hover:border-danger/30 flex items-center justify-center text-sm transition-all">🗑</button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      <AnimatePresence>
        {modal && (
          <>
            <motion.div key="bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setModal(null)} />
            <motion.div key="md" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 220 }}
              className="fixed bottom-0 inset-x-0 z-50 max-w-lg mx-auto bg-surface border border-white/8 rounded-t-2xl p-5 pb-8"
            >
              <div className="w-8 h-1 rounded-full bg-white/10 mx-auto mb-4" />
              <h3 className="text-base font-bold text-slate-100 mb-4">{modal.editing ? 'Edit Supplier' : 'Add Supplier'}</h3>
              <div className="flex flex-col gap-3">
                {(['supplier_name', 'phone', 'address', 'notes'] as const).map(field => (
                  <div key={field}>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">
                      {field === 'supplier_name' ? 'Supplier Name *' : field.charAt(0).toUpperCase() + field.slice(1)}
                    </label>
                    <input
                      value={form[field]}
                      onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && field !== 'notes' && save()}
                      placeholder={field === 'supplier_name' ? 'e.g. Nairobi Tools Ltd' : field === 'phone' ? '+91...' : ''}
                      className="w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm placeholder:text-muted/40 outline-none focus:border-teal/40 transition-colors"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={() => setModal(null)} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold hover:text-slate-100 transition-colors">Cancel</button>
                <button onClick={save} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/25 transition-colors disabled:opacity-50">
                  {saving ? 'Saving…' : modal.editing ? 'Update' : 'Add Supplier'}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteTarget && (
          <>
            <motion.div key="dbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
            <motion.div key="dbox" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 z-50 flex items-center justify-center px-6"
            >
              <div className="bg-surface border border-white/8 rounded-2xl p-6 w-full max-w-xs text-center">
                <div className="text-3xl mb-3">🗑️</div>
                <h3 className="font-bold text-slate-100 mb-2">Delete "{deleteTarget.supplier_name}"?</h3>
                <p className="text-xs text-muted mb-5">Past purchases linked to them will remain intact.</p>
                <div className="flex gap-3">
                  <button onClick={() => setDeleteTarget(null)} className="flex-1 py-2.5 rounded-xl bg-surface2 border border-white/8 text-muted text-sm font-semibold">Cancel</button>
                  <button onClick={confirmDelete} className="flex-1 py-2.5 rounded-xl bg-danger/15 border border-danger/30 text-danger text-sm font-bold">Delete</button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default function SuppliersPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const router = useRouter();
  useEffect(() => {
    const ok = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    if (!ok) router.replace('/admin');
    else setAuthed(true);
  }, [router]);
  if (authed === null) return <div className="min-h-screen bg-navy" />;
  return <SuppliersDashboard />;
}
