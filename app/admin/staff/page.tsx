'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/supabase';
import { SESSION_KEY, ROLE_KEY } from '@/lib/types';
import AdminNavbar from '../components/AdminNavbar';
import Toast, { type ToastState } from '../components/Toast';

interface AppUser {
  user_id:       number;
  full_name:     string;
  email:         string | null;
  role:          'admin' | 'staff';
  active_status: boolean;
  created_at:    string;
}

const inputCls = 'w-full px-3 py-2.5 rounded-xl bg-surface2 border border-white/8 text-slate-100 text-sm placeholder:text-muted/40 outline-none focus:border-teal/40 transition-colors';

export default function StaffPage() {
  const router = useRouter();
  const [users,    setUsers]    = useState<AppUser[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<ToastState | null>(null);
  const [showForm, setShowForm] = useState(false);
  let toastId = 0;

  // New member form
  const [fullName,  setFullName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [pin,       setPin]       = useState('');
  const [newRole,   setNewRole]   = useState<'admin' | 'staff'>('staff');

  function showToast(msg: string, type: ToastState['type']) {
    setToast({ msg, type, id: ++toastId });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = '/admin';
  }

  const firstLoad = useRef(true);
  const load = useCallback(async () => {
    if (firstLoad.current) setLoading(true);
    const { data, error } = await supabase
      .from('app_users')
      .select('user_id, full_name, email, role, active_status, created_at')
      .order('created_at', { ascending: true });
    if (error) showToast(error.message, 'error');
    setUsers((data ?? []) as AppUser[]);
    firstLoad.current = false;
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ok   = typeof window !== 'undefined' && localStorage.getItem(SESSION_KEY) === '1';
    const role = (typeof window !== 'undefined' ? localStorage.getItem(ROLE_KEY) : null) ?? 'admin';
    if (!ok || role !== 'admin') { router.replace('/admin'); return; }
    load();
  }, [router, load]);

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.trim() || !pin.trim()) {
      showToast('Full name and PIN are required', 'error'); return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from('app_users').insert({
        full_name:     fullName.trim(),
        email:         email.trim() || null,
        pin:           pin.trim(),
        role:          newRole,
        active_status: true,
      });
      if (error) throw new Error(error.message);
      showToast(`${fullName} added ✓`, 'success');
      setFullName(''); setEmail(''); setPin(''); setNewRole('staff');
      setShowForm(false);
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Error adding user', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(user: AppUser) {
    const { error } = await supabase
      .from('app_users')
      .update({ active_status: !user.active_status })
      .eq('user_id', user.user_id);
    if (error) { showToast(error.message, 'error'); return; }
    setUsers(u => u.map(m => m.user_id === user.user_id ? { ...m, active_status: !m.active_status } : m));
    showToast(user.active_status ? 'Account deactivated' : 'Account activated', 'success');
  }

  async function resetPin(user: AppUser) {
    const newPin = window.prompt(`Set new PIN for ${user.full_name}:`);
    if (!newPin?.trim()) return;
    const { error } = await supabase
      .from('app_users')
      .update({ pin: newPin.trim() })
      .eq('user_id', user.user_id);
    if (error) showToast(error.message, 'error');
    else showToast(`PIN updated for ${user.full_name} ✓`, 'success');
  }

  return (
    <div className="min-h-screen bg-navy">
      <AdminNavbar onLogout={handleLogout} />
      <main className="pt-14 max-w-3xl mx-auto px-4 pb-10">
        <div className="pt-5 pb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-100">👥 Staff Accounts</h2>
            <p className="text-xs text-muted mt-0.5">{users.length} member{users.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setShowForm(f => !f)}
            className="px-4 py-2 rounded-xl bg-teal/10 border border-teal/30 text-teal text-xs font-bold hover:bg-teal/20 transition-all"
          >
            {showForm ? '✕ Cancel' : '+ Add Staff'}
          </button>
        </div>

        {/* Add form */}
        <AnimatePresence>
          {showForm && (
            <motion.form
              onSubmit={addMember}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden mb-4"
            >
              <div className="bg-surface border border-teal/20 rounded-xl p-4 flex flex-col gap-3">
                <p className="text-xs font-bold text-teal uppercase tracking-widest">New Staff Member</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Full Name *</label>
                    <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Raju Sharma" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Email (optional)</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="e.g. raju@example.com" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">PIN / Password *</label>
                    <input type="password" value={pin} onChange={e => setPin(e.target.value)} placeholder="Create a PIN" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-widest block mb-1">Role</label>
                    <select value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'staff')} className={inputCls}>
                      <option value="staff">Staff</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-2.5 rounded-xl bg-teal/15 border border-teal/30 text-teal text-sm font-bold hover:bg-teal/25 disabled:opacity-50 transition-all"
                >
                  {saving ? 'Adding…' : 'Add Member'}
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        {/* Permissions info */}
        <div className="mb-4 px-3 py-2.5 rounded-xl bg-gold/5 border border-gold/20 text-xs text-gold/80 leading-relaxed">
          <span className="font-bold">Staff access:</span> Inventory (add only — pending approval) · POS · Audit<br />
          <span className="font-bold">Admin access:</span> All pages + approving stock requests
        </div>

        {/* Login hint */}
        <div className="mb-4 px-3 py-2 rounded-xl bg-surface border border-white/8 text-xs text-muted">
          Staff log in using their <span className="text-slate-300">full name</span> or <span className="text-slate-300">email</span> + their PIN.
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-7 h-7 rounded-full border-2 border-teal border-t-transparent animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {users.map(m => (
              <div
                key={m.user_id}
                className={`bg-surface border rounded-xl px-4 py-3 flex items-center gap-3 ${m.active_status ? 'border-white/8' : 'border-white/4 opacity-50'}`}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-base font-bold shrink-0"
                  style={{ background: m.role === 'admin' ? 'rgba(255,188,0,0.15)' : 'rgba(0,212,255,0.12)' }}
                >
                  {m.full_name.charAt(0).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-slate-100 truncate">{m.full_name}</span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border uppercase tracking-widest ${
                      m.role === 'admin'
                        ? 'bg-gold/10 border-gold/30 text-gold'
                        : 'bg-teal/10 border-teal/25 text-teal'
                    }`}>{m.role}</span>
                    {!m.active_status && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-danger/10 border border-danger/30 text-danger uppercase">Inactive</span>
                    )}
                  </div>
                  <p className="text-xs text-muted truncate">{m.email ?? 'No email set'}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => resetPin(m)}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-surface2 border border-white/8 text-muted hover:text-teal hover:border-teal/30 transition-all"
                  >
                    Reset PIN
                  </button>
                  <button
                    onClick={() => toggleActive(m)}
                    className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg border transition-all ${
                      m.active_status
                        ? 'bg-danger/10 border-danger/25 text-danger hover:bg-danger/20'
                        : 'bg-success/10 border-success/25 text-success hover:bg-success/20'
                    }`}
                  >
                    {m.active_status ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            ))}
            {users.length === 0 && (
              <p className="text-center text-sm text-muted py-12">No users found. Add one above.</p>
            )}
          </div>
        )}
      </main>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
