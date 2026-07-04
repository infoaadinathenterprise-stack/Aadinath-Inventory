import { createClient } from '@supabase/supabase-js';
import { TOKEN_KEY } from '@/lib/types';

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Every request carries our signed login token as the access token when a
// user is logged in, and falls back to the anon key otherwise (public
// storefront = read-only). The database enforces roles from this token via
// RLS, so tampering with localStorage roles no longer grants any access.
export const supabase = createClient(url, anon, {
  accessToken: async () => {
    if (typeof window === 'undefined') return anon;
    return localStorage.getItem(TOKEN_KEY) || anon;
  },
});
