// ============================================================================
//  Jay Aadinath — standalone auth Worker
//  Deploy this SEPARATELY from the Pages site. Cloudflare Pages Functions
//  don't reliably materialize on this project (same issue you hit with
//  Gemini), so login + staff management live here instead.
//
//  Routes (POST):
//    /login   { username, pin }            -> { token, role, full_name, user_id }
//    /staff   { action, ... } + Bearer     -> admin-only user management
//  (also accepts /api/login and /api/staff)
//
//  Secrets to set on this Worker (Settings -> Variables):
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
//
//  No build step needed — this is plain ES-module JS you can paste straight
//  into the Cloudflare dashboard Worker editor, or deploy with wrangler.
// ============================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── base64url ────────────────────────────────────────────────────────────────

function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToB64url(s) {
  return bytesToB64url(new TextEncoder().encode(s));
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── PIN hashing (PBKDF2-HMAC-SHA256) — pbkdf2$<iter>$<salt>$<hash> ────────────

const PBKDF2_ITERATIONS = 100000;

async function pbkdf2Bits(pin, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256,
  );
  return new Uint8Array(bits);
}
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(bits)}`;
}
async function verifyPin(pin, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = b64urlToBytes(parts[2]);
  const bits = await pbkdf2Bits(pin, salt, iterations);
  return timingSafeEqual(bytesToB64url(bits), parts[3]);
}

// ── JWT (HS256), Supabase-compatible ─────────────────────────────────────────

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage,
  );
}
async function signToken(secret, payload) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub:       payload.sub,
    role:      'authenticated',
    aud:       'authenticated',
    app_role:  payload.app_role,
    full_name: payload.full_name,
    iat:       now,
    exp:       now + (payload.ttlSeconds || 12 * 60 * 60),
  };
  const data = `${strToB64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${strToB64url(JSON.stringify(claims))}`;
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}
async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const key = await hmacKey(secret, ['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))); }
  catch { return null; }
  if (!claims.exp || Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}
async function requireAuth(request, secret) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1], secret);
}

// ── Supabase REST (service role — bypasses RLS) ──────────────────────────────

function sbFetch(env, path, init = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
function missingEnv(env) {
  const absent = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET'].filter(k => !env[k]);
  return absent.length ? `Server not configured — missing: ${absent.join(', ')}` : null;
}
async function errText(res, fallback) {
  try {
    const j = await res.json();
    return j.message || j.details || j.hint || fallback;
  } catch { return fallback; }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  const cfg = missingEnv(env);
  if (cfg) return json({ error: cfg }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid request' }, 400); }

  const username = (body.username || '').trim();
  const pin      = (body.pin || '').trim();
  if (!username || !pin) return json({ error: 'Enter username and PIN' }, 400);

  const res = await sbFetch(
    env,
    'app_users?select=user_id,full_name,email,role,active_status,pin_hash&active_status=eq.true',
  );
  if (!res.ok) return json({ error: 'Login service unavailable' }, 502);
  const users = await res.json();

  const id = username.toLowerCase();
  const candidates = users.filter(
    u => (u.email && u.email.toLowerCase() === id) || u.full_name.toLowerCase() === id,
  );

  for (const user of candidates) {
    let ok = await verifyPin(pin, user.pin_hash);

    // Legacy fallback: a plaintext value sitting in pin_hash (a row that was
    // never hashed) that matches what was typed -> accept it once and upgrade
    // it to a real hash so it's stored securely from now on.
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
      } catch { /* non-fatal */ }
    }

    if (ok) {
      const token = await signToken(env.SUPABASE_JWT_SECRET, {
        sub:       String(user.user_id),
        app_role:  user.role === 'admin' ? 'admin' : 'staff',
        full_name: user.full_name,
      });
      return json({ token, role: user.role, full_name: user.full_name, user_id: user.user_id });
    }
  }

  return json({ error: 'Incorrect username or PIN' }, 401);
}

async function handleStaff(request, env) {
  const cfg = missingEnv(env);
  if (cfg) return json({ error: cfg }, 500);

  const claims = await requireAuth(request, env.SUPABASE_JWT_SECRET);
  if (!claims)                     return json({ error: 'Not signed in' }, 401);
  if (claims.app_role !== 'admin') return json({ error: 'Admins only' }, 403);

  let body;
  try { body = await request.json(); }
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
      const fullName = (body.full_name || '').trim();
      const pin      = (body.pin || '').trim();
      const role     = body.role === 'admin' ? 'admin' : 'staff';
      if (!fullName || !pin) return json({ error: 'Full name and PIN are required' }, 400);
      const pin_hash = await hashPin(pin);
      const res = await sbFetch(env, 'app_users', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          full_name: fullName,
          email: (body.email || '').toString().trim() || null,
          pin_hash, role, active_status: true,
        }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not add user') }, 502);
      const rows = await res.json();
      return json({ user: Array.isArray(rows) ? rows[0] : rows });
    }
    case 'reset-pin': {
      const pin = (body.pin || '').trim();
      if (!body.user_id || !pin) return json({ error: 'user_id and PIN required' }, 400);
      const pin_hash = await hashPin(pin);
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pin_hash }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not reset PIN') }, 502);
      return json({ ok: true });
    }
    case 'set-active': {
      if (!body.user_id || typeof body.active !== 'boolean') return json({ error: 'user_id and active required' }, 400);
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ active_status: body.active }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not update account') }, 400);
      return json({ ok: true });
    }
    case 'set-role': {
      if (!body.user_id || (body.role !== 'admin' && body.role !== 'staff')) return json({ error: 'user_id and role required' }, 400);
      const res = await sbFetch(env, `app_users?user_id=eq.${body.user_id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ role: body.role }),
      });
      if (!res.ok) return json({ error: await errText(res, 'Could not update role') }, 400);
      return json({ ok: true });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (request.method === 'POST' && (path === '/login' || path === '/api/login')) return handleLogin(request, env);
    if (request.method === 'POST' && (path === '/staff' || path === '/api/staff')) return handleStaff(request, env);
    if (request.method === 'GET'  && (path === '' || path === '/' || path === '/health')) {
      return json({ ok: true, service: 'aadinath-auth', time: new Date().toISOString() });
    }
    return json({ error: 'Not found' }, 404);
  },
};
