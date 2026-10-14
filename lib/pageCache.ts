// Last-seen page data, so a page can show what it had last time instantly
// and swap in fresh data when its queries return (~1 s from Kenya).
//
// Stored in localStorage per device. Pages that change stock must not act
// on cached numbers — they check their "stale" flag and wait for fresh
// data first. Cleared on logout (lib/auth.ts).

const PREFIX = 'aad_cache_v1:';

export function readPageCache<T>(key: string): T | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writePageCache(key: string, data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    // Storage full or blocked (private mode): drop old entries and retry
    // once, else just go without a cache.
    try {
      clearPageCaches();
      localStorage.setItem(PREFIX + key, JSON.stringify(data));
    } catch { /* no cache this time */ }
  }
}

export function clearPageCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* nothing to clear */ }
}
