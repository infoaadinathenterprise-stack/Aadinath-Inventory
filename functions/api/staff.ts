// POST /api/staff  — admin-only staff management.
// Body: { action, ... }. Requires a valid admin bearer token.
//
// app_users is fully sealed from browsers by RLS (it holds PIN hashes),
// so all reads/writes to it go through this server function, which
// re-checks the caller's signed role. A staff member who fakes their
// role in localStorage still sends a token that says app_role:'staff',
// so every action here rejects them with 403.

import {
  type AuthEnv, hashPin, requireAuth, sbFetch, json, missingEnv,
} from './_shared';

interface Body {
  action:   'list' | 'create' | 'reset-pin' | 'set-active' | 'set-role';
  user_id?: number;
  full_name?: string;
  email?:   string | null;
  pin?:     string;
  role?:    'admin' | 'staff';
  active?:  boolean;
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  const env = context.env;
  const cfg = missingEnv(env);
  if (cfg) return json({ error: cfg }, 500);

  const claims = await requireAuth(context.request, env.SUPABASE_JWT_SECRET);
  if (!claims)                       return json({ error: 'Not signed in' }, 401);
  if (claims.app_role !== 'admin')   return json({ error: 'Admins only' }, 403);

  let body: Body;
  try { body = await context.request.json(); }
  catch { return json({ error: 'Invalid request' }, 400); }

  switch (body.action) {
    case 'list': {
      const res = await sbFetch(
        env,
        'app_users?select=user_id,full_name,email,role,active_status,created_at&order=created_at.asc',
      );
      if (!res.ok) return json({ error: 'Could not load users' }, 502);
      return json({ users: await res.json() });
    }

    case 'create': {
      const fullName = (body.full_name ?? '').trim();
      const pin      = (body.pin ?? '').trim();
      const role     = body.role === 'admin' ? 'admin' : 'staff';
      if (!fullName || !pin) return json({ error: 'Full name and PIN are required' }, 400);
      const pin_hash = await hashPin(pin);
      const res = await sbFetch(env, 'app_users', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          full_name:     fullName,
          email:         (body.email ?? '')?.toString().trim() || null,
          pin_hash,
          role,
          active_status: true,
        }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not add user') }, 502);
      const rows = await res.json();
      return json({ user: Array.isArray(rows) ? rows[0] : rows });
    }

    case 'reset-pin': {
      const pin = (body.pin ?? '').trim();
      if (!body.user_id || !pin) return json({ error: 'user_id and PIN required' }, 400);
      const pin_hash = await hashPin(pin);
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pin_hash }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not reset PIN') }, 502);
      return json({ ok: true });
    }

    case 'set-active': {
      if (!body.user_id || typeof body.active !== 'boolean') {
        return json({ error: 'user_id and active required' }, 400);
      }
      // The DB trigger prevents locking out the last admin; surface its
      // error message cleanly if it fires.
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ active_status: body.active }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not update account') }, 400);
      return json({ ok: true });
    }

    case 'set-role': {
      if (!body.user_id || (body.role !== 'admin' && body.role !== 'staff')) {
        return json({ error: 'user_id and role required' }, 400);
      }
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ role: body.role }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not update role') }, 400);
      return json({ ok: true });
    }

    default:
      return json({ error: 'Unknown action' }, 400);
  }
};

// Pull the Postgres/PostgREST error message out of a failed response so
// trigger errors (e.g. "Cannot deactivate the last active admin") reach
// the UI instead of a generic message.
async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json() as { message?: string; hint?: string; details?: string };
    return j.message || j.details || j.hint || fallback;
  } catch { return fallback; }
}
