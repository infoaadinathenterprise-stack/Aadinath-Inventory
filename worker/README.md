# Auth Worker — deploy guide

Login and staff management run here (a standalone Cloudflare Worker) instead
of Pages Functions, which don't reliably run on this project. The app calls
this Worker's URL for `/login` and `/staff`.

You can deploy it two ways. The **dashboard** way needs no tools.

---

## Option A — Cloudflare dashboard (no CLI, recommended)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. **Name it exactly `aadinath-auth`** (so its URL becomes
   `https://aadinath-auth.info-aadinathenterprise.workers.dev`, which the app
   already points to). Click **Deploy** to create it.
3. Click **Edit code**, delete the sample, and **paste the entire contents of
   `auth-worker.js`**. Click **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets** and add three
   **Secrets** (encrypted):
   - `SUPABASE_URL` = `https://mculftdutoavwueluyma.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service_role key
   - `SUPABASE_JWT_SECRET` = your Supabase JWT secret
   (Both keys: Supabase → Project Settings → API.)
5. **Deploy again** so the secrets take effect.

Test it: open `https://aadinath-auth.info-aadinathenterprise.workers.dev/health`
in a browser — you should see `{"ok":true,...}`.

## Option B — Wrangler CLI

From this `worker/` folder:

```bash
npx wrangler deploy
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_JWT_SECRET
```

---

## If you name the Worker something else

The app defaults to `https://aadinath-auth.info-aadinathenterprise.workers.dev`.
If your Worker ends up at a different URL, set an environment variable on the
**Pages** site (Settings → Environment variables → Production):

```
NEXT_PUBLIC_AUTH_BASE = https://<your-worker-url>
```

then redeploy the Pages site.

## After it's deployed

1. Make sure your `app_users` admin row has the password in the **`pin`**
   column and **`pin_hash` empty** (see the main chat — don't hand-type into
   `pin_hash`).
2. Log in at `/admin` with that username + PIN.
3. Only once login works, run `supabase/02_enable_rls.sql` to lock the DB down.

You no longer need the `SUPABASE_*` secrets on the Pages project — the Pages
Functions under `functions/api/` are unused now (the Worker replaces them).
