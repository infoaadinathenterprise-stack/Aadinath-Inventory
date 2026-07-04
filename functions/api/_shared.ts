// Shared helpers for the auth-related Cloudflare Pages Functions.
// Files/folders that start with "_" are NOT routed by Pages, so this
// module is import-only and never reachable as an endpoint.
//
// Everything here runs on the Cloudflare Workers runtime, which gives
// us Web Crypto (crypto.subtle / getRandomValues), TextEncoder,
// atob/btoa — enough to hash PINs (PBKDF2) and sign/verify JWTs
// (HMAC-SHA256) with zero npm dependencies.

export interface AuthEnv {
  SUPABASE_URL: string;                 // e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY: string;    // service_role key — server secret, bypasses RLS
  SUPABASE_JWT_SECRET: string;          // project JWT secret — used to sign login tokens
}

// ── base64url ────────────────────────────────────────────────────────────────

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time string comparison (avoids leaking match length via timing).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── PIN hashing (PBKDF2-HMAC-SHA256) ─────────────────────────────────────────
// Stored format: pbkdf2$<iterations>$<saltB64url>$<hashB64url>

const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2Bits(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(bits)}`;
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = b64urlToBytes(parts[2]);
  const bits = await pbkdf2Bits(pin, salt, iterations);
  return timingSafeEqual(bytesToB64url(bits), parts[3]);
}

// ── JWT (HS256) ──────────────────────────────────────────────────────────────

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage,
  );
}

export interface AppClaims {
  sub: string;
  role: 'authenticated';
  aud: 'authenticated';
  app_role: 'admin' | 'staff';
  full_name: string;
  iat: number;
  exp: number;
}

// Mint a Supabase-compatible access token. Because it's signed with the
// project JWT secret and carries role:'authenticated', PostgREST accepts
// it and our RLS policies can read app_role via auth.jwt() ->> 'app_role'.
export async function signToken(
  secret: string,
  payload: { sub: string; app_role: 'admin' | 'staff'; full_name: string; ttlSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: AppClaims = {
    sub:       payload.sub,
    role:      'authenticated',
    aud:       'authenticated',
    app_role:  payload.app_role,
    full_name: payload.full_name,
    iat:       now,
    exp:       now + (payload.ttlSeconds ?? 12 * 60 * 60), // default 12h
  };
  const header = strToB64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = strToB64url(JSON.stringify(claims));
  const data   = `${header}.${body}`;
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

// Verify signature + expiry. Returns the claims or null if invalid.
export async function verifyToken(token: string, secret: string): Promise<AppClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await hmacKey(secret, ['verify']);
  const ok = await crypto.subtle.verify(
    'HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(`${header}.${body}`),
  );
  if (!ok) return null;
  let claims: AppClaims;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); }
  catch { return null; }
  if (!claims.exp || Math.floor(Date.now() / 1000) >= claims.exp) return null;
  return claims;
}

// Pull + verify the bearer token from a request. Returns claims or null.
export async function requireAuth(request: Request, secret: string): Promise<AppClaims | null> {
  const header = request.headers.get('Authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1], secret);
}

// ── Supabase REST (service role — bypasses RLS) ──────────────────────────────

export async function sbFetch(
  env: AuthEnv, path: string, init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
      ...(init.headers ?? {}),
    },
  });
}

// ── JSON response helpers ────────────────────────────────────────────────────

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function missingEnv(env: Partial<AuthEnv>): string | null {
  const need: (keyof AuthEnv)[] = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET'];
  const absent = need.filter(k => !env[k]);
  return absent.length ? `Server not configured — missing: ${absent.join(', ')}` : null;
}
