'use client';

// Client-side session helpers. The security lives in the signed token and
// the database's RLS policies — these functions just store the token the
// server issued and read the (already-verified) role out of it for UI
// purposes. Faking any of these localStorage values only changes what the
// UI shows; it grants no database access, because the token's signature
// can't be forged.

import { SESSION_KEY, USER_KEY, ROLE_KEY, TOKEN_KEY, type UserRole } from '@/lib/types';

// Auth runs on a standalone Cloudflare Worker (Pages Functions don't
// reliably materialize on this project — same reason Gemini uses a
// separate worker). Override with NEXT_PUBLIC_AUTH_BASE if you name the
// worker differently; the default assumes it's deployed as "aadinath-auth"
// on the info-aadinathenterprise.workers.dev subdomain.
const AUTH_BASE = (process.env.NEXT_PUBLIC_AUTH_BASE
  || 'https://aadinath-auth.info-aadinathenterprise.workers.dev').replace(/\/+$/, '');

export interface LoginResult {
  ok:         boolean;
  error?:     string;
  role?:      UserRole;
  full_name?: string;
}

// Decode the (unverified) JWT payload just to read display fields. Never
// used for a security decision — the server already verified it.
function decodePayload(token: string): { app_role?: string; full_name?: string; exp?: number } | null {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch { return null; }
}

export async function login(username: string, pin: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, pin }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the login service. Check your connection.' };
  }

  let data: { token?: string; role?: UserRole; full_name?: string; error?: string };
  try { data = await res.json(); }
  catch { return { ok: false, error: 'Unexpected response from login service' }; }

  if (!res.ok || !data.token) {
    return { ok: false, error: data.error || 'Incorrect username or PIN' };
  }

  const role: UserRole = data.role === 'admin' ? 'admin' : 'staff';
  localStorage.setItem(TOKEN_KEY,   data.token);
  localStorage.setItem(SESSION_KEY, '1');
  localStorage.setItem(USER_KEY,    data.full_name || username);
  localStorage.setItem(ROLE_KEY,    role);
  return { ok: true, role, full_name: data.full_name };
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ROLE_KEY);
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

// True only when a non-expired token is present. Page guards use this so a
// stale/forged SESSION_KEY flag alone no longer opens the admin shell.
export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;
  const payload = decodePayload(token);
  if (!payload?.exp) return false;
  return Date.now() / 1000 < payload.exp;
}

export function currentRole(): UserRole {
  const token = getToken();
  const role = token ? decodePayload(token)?.app_role : null;
  return role === 'admin' ? 'admin' : 'staff';
}

// Is this Supabase/PostgREST error caused by a rejected or missing login
// token (rather than a real data problem)? Used to tell an expired session
// apart from an actual failure, so we can send the user to re-login instead
// of showing a blank page.
export function isAuthError(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  const code = (err.code ?? '').toString();
  const msg  = (err.message ?? '').toLowerCase();
  if (code === 'PGRST301' || code === '401') return true;   // JWT expired / not acceptable
  return /\bjwt\b|token|expired|not authenticated|unauthorized|invalid claim|invalid signature|permission denied/.test(msg);
}

// Call from a data-load error handler. If the session is gone or the server
// rejected the token, clear it and bounce to the admin login screen (returns
// true so the caller can stop). Otherwise returns false (real error).
export function redirectIfSessionInvalid(err?: { message?: string; code?: string } | null): boolean {
  if (typeof window === 'undefined') return false;
  if (!isAuthenticated() || isAuthError(err)) {
    logout();
    if (!window.location.pathname.match(/^\/admin\/?$/)) {
      window.location.href = '/admin';
    } else {
      window.location.reload();
    }
    return true;
  }
  return false;
}

// POST helper for the admin-only /api/staff endpoint (adds the bearer token).
export async function staffApi<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = getToken();
  if (!token) return { ok: false, error: 'Not signed in' };
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/staff`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ action, ...payload }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
  let data: Record<string, unknown> & { error?: string };
  try { data = await res.json(); }
  catch { return { ok: false, error: 'Unexpected server response' }; }
  if (!res.ok) return { ok: false, error: data.error || 'Request failed' };
  return { ok: true, data: data as T };
}
