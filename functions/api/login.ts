// POST /api/login  { username, pin }  →  { token, role, full_name, user_id }
//
// This is the ONLY place a PIN is checked. It runs server-side with the
// Supabase service-role key, so it can read the (hidden-from-clients)
// app_users table, verify the PIN hash, and mint a signed token that the
// browser then uses for every DB request. The browser never sees a PIN
// hash and cannot forge the token — the role inside it is signed.

import {
  type AuthEnv, hashPin, verifyPin, signToken, sbFetch, json, missingEnv,
} from './_shared';

interface UserRow {
  user_id:       number;
  full_name:     string;
  email:         string | null;
  role:          'admin' | 'staff';
  active_status: boolean;
  pin_hash:      string | null;       // may hold a legacy plaintext value; auto-upgraded on login
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  const env = context.env;
  const cfg = missingEnv(env);
  if (cfg) return json({ error: cfg }, 500);

  let body: { username?: string; pin?: string };
  try { body = await context.request.json(); }
  catch { return json({ error: 'Invalid request' }, 400); }

  const username = (body.username ?? '').trim();
  const pin      = (body.pin ?? '').trim();
  if (!username || !pin) return json({ error: 'Enter username and PIN' }, 400);

  // Fetch active users and match by email or full name (case-insensitive),
  // mirroring the app's existing login behavior. Service role → RLS bypassed.
  const res = await sbFetch(
    env,
    'app_users?select=user_id,full_name,email,role,active_status,pin_hash&active_status=eq.true',
  );
  if (!res.ok) return json({ error: 'Login service unavailable' }, 502);
  const users = (await res.json()) as UserRow[];

  const id = username.toLowerCase();
  const candidates = users.filter(
    u => (u.email?.toLowerCase() === id) || (u.full_name.toLowerCase() === id),
  );

  // Try each candidate (handles duplicate names) — accept the first whose PIN verifies.
  for (const user of candidates) {
    let ok = await verifyPin(pin, user.pin_hash);

    // Legacy fallback: a plaintext value sitting in pin_hash (never hashed)
    // that matches what was typed. Accept once and upgrade it to a real hash.
    if (!ok && user.pin_hash != null
        && !String(user.pin_hash).startsWith('pbkdf2$')
        && String(user.pin_hash) === pin) {
      ok = true;
      try {
        const newHash = await hashPin(pin);
        await sbFetch(env, `app_users?user_id=eq.${user.user_id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ pin_hash: newHash }),
        });
      } catch { /* non-fatal: login still succeeds, migrate next time */ }
    }

    if (ok) {
      const token = await signToken(env.SUPABASE_JWT_SECRET, {
        sub:       String(user.user_id),
        app_role:  user.role === 'admin' ? 'admin' : 'staff',
        full_name: user.full_name,
      });
      return json({
        token,
        role:      user.role,
        full_name: user.full_name,
        user_id:   user.user_id,
      });
    }
  }

  return json({ error: 'Incorrect username or PIN' }, 401);
};
