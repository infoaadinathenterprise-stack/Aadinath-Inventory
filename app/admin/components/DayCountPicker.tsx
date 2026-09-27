'use client';

import { useEffect, useRef, useState } from 'react';

// Local-time yyyy-mm-dd (toISOString would shift to UTC and give the wrong
// day late in the evening).
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtYmd(s: string): string {
  return new Date(`${s}T00:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

interface Props {
  label:    string;
  value:    string;                  // yyyy-mm-dd
  onChange: (v: string) => void;
  counts:   Record<string, number>;  // yyyy-mm-dd → how many things happened that day
  min?:     string;
  max?:     string;
}

// A date field whose calendar marks each day with how many movements it
// had, so busy and empty days are visible before picking one.
export default function DayCountPicker({ label, value, onChange, counts, min, max }: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => { const d = new Date(`${value}T00:00:00`); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function toggle() {
    if (!open) { const d = new Date(`${value}T00:00:00`); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }
    setOpen(o => !o);
  }

  // Monday-first grid for the shown month.
  const lead = (month.getDay() + 6) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => ymd(new Date(month.getFullYear(), month.getMonth(), i + 1))),
  ];
  const monthMax = Math.max(1, ...cells.map(c => (c ? counts[c] ?? 0 : 0)));
  const monthTotal = cells.reduce((s, c) => s + (c ? counts[c] ?? 0 : 0), 0);
  const today = ymd(new Date());

  return (
    <div ref={ref} className="relative flex-1 min-w-40">
      <span className="text-[10px] text-muted block mb-1">{label}</span>
      <button
        type="button"
        onClick={toggle}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-surface border text-sm text-slate-100 transition-colors ${open ? 'border-teal/40' : 'border-white/8 hover:border-white/20'}`}
      >
        <span>{fmtYmd(value)}</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted tabular-nums">{counts[value] ?? 0}</span>
          <span aria-hidden>📅</span>
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 left-0 w-72 max-w-[calc(100vw-2rem)] p-3 rounded-2xl bg-surface border border-white/10 shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="w-8 h-8 rounded-lg hover:bg-white/5 text-slate-300" aria-label="Previous month">‹</button>
            <div className="text-center">
              <p className="text-sm font-bold text-slate-100">{month.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' })}</p>
              <p className="text-[10px] text-muted">{monthTotal} movement{monthTotal === 1 ? '' : 's'}</p>
            </div>
            <button type="button" onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="w-8 h-8 rounded-lg hover:bg-white/5 text-slate-300" aria-label="Next month">›</button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAYS.map(w => <span key={w} className="text-[10px] font-bold text-muted py-1">{w}</span>)}
            {cells.map((c, i) => {
              if (!c) return <span key={`e${i}`} />;
              const n = counts[c] ?? 0;
              const disabled = (min != null && c < min) || (max != null && c > max);
              const selected = c === value;
              // Busier days get a stronger badge.
              const strength = n === 0 ? 0 : n / monthMax;
              const badge = strength > 0.66 ? 'bg-teal text-navy' : strength > 0.33 ? 'bg-teal/60 text-navy' : 'bg-teal/25 text-teal';
              return (
                <button
                  key={c}
                  type="button"
                  disabled={disabled}
                  onClick={() => { onChange(c); setOpen(false); }}
                  title={`${fmtYmd(c)}: ${n} movement${n === 1 ? '' : 's'}`}
                  className={`relative h-10 rounded-lg flex flex-col items-center justify-center text-xs transition-colors disabled:opacity-25 disabled:cursor-not-allowed ${
                    selected ? 'bg-teal/20 border border-teal/50 text-slate-100 font-bold'
                      : c === today ? 'border border-white/20 text-slate-100 hover:bg-white/5'
                      : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <span className="leading-none">{Number(c.slice(8))}</span>
                  {n > 0 && (
                    <span className={`mt-0.5 min-w-4 px-1 rounded-full text-[9px] font-bold leading-[14px] tabular-nums ${badge}`}>{n > 99 ? '99+' : n}</span>
                  )}
                </button>
              );
            })}
          </div>

          <button type="button" onClick={() => { onChange(today); setOpen(false); }}
            className="mt-2 w-full py-1.5 rounded-lg bg-surface2 border border-white/10 text-[11px] font-bold text-slate-300 hover:border-white/25">
            Today
          </button>
        </div>
      )}
    </div>
  );
}
