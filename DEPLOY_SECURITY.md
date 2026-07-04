# Security hardening — deployment guide

This change moves login and role enforcement **off the browser and onto the
server**, so employees can no longer fake an admin role, write to the database
directly, or read anyone's PIN. Your staff still log in the same way (username
or email + PIN).

It comes in three parts that must be rolled out **in order**:

1. Two new server endpoints (Cloudflare Pages Functions) — already in the code.
2. Three server secrets you add in Cloudflare.
3. Two SQL scripts you run in Supabase (`supabase/01_...` then `supabase/02_...`).

Follow the steps top to bottom. Nothing goes fully "locked" until the very last
SQL script, so the site keeps working throughout.

---

## Step 1 — Get your three Supabase secrets

In the Supabase dashboard for this project:

- **Project Settings → API → Project URL** → this is `SUPABASE_URL`
  (it's `https://mculftdutoavwueluyma.supabase.co`).
- **Project Settings → API → Project API keys → `service_role`** (click reveal) →
  this is `SUPABASE_SERVICE_ROLE_KEY`. **Keep it secret** — it bypasses all
  security. Never put it in the app or any `NEXT_PUBLIC_` variable.
- **Project Settings → API → JWT Settings → JWT Secret** → this is
  `SUPABASE_JWT_SECRET`. (If your project shows "JWT signing keys" with a
  legacy secret, use the legacy **JWT Secret** value.)

## Step 2 — Add the secrets in Cloudflare

In the Cloudflare dashboard → your Pages project → **Settings → Environment
variables → Production** (do the same for **Preview** if you use previews):

Add these three, marked as **Secret / encrypted**:

| Name | Value |
|------|-------|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
| `SUPABASE_JWT_SECRET` | the JWT secret |

> Do **not** prefix these with `NEXT_PUBLIC_`. That prefix would ship them to
> the browser, which is exactly what we're fixing.

## Step 3 — Deploy the new code

Push/deploy as usual (your normal `git push origin master:main`). At this point
the site behaves exactly as before **plus** the new `/api/login` endpoint. The
database is not locked down yet, so nothing can break.

Quick check: open the site, sign in. It should work (login now goes through the
server). If it doesn't, verify Step 2 and that `/api/login` is reachable.

## Step 4 — Run the additive SQL (safe)

Supabase → **SQL Editor → New query** → paste **all** of
`supabase/01_security_setup.sql` → **Run**. This just adds a `pin_hash` column,
a helper, and the "can't remove the last admin" guard. It changes no
permissions, so the app keeps working.

## Step 5 — Migrate existing PINs (automatic)

Have each existing user sign in once (at minimum, sign in yourself). On first
successful login the server hashes their PIN and clears the old plaintext value.
Their existing PIN keeps working — nothing to re-enter.

## Step 6 — Run the lockdown SQL

Supabase → **SQL Editor → New query** → paste **all** of
`supabase/02_enable_rls.sql` → **Run**. This turns on Row-Level Security. From
now on:

- The public storefront can only **read** the product catalog.
- Writing anything requires being logged in.
- Admin-only actions (voiding sales, withdrawals, purchases, suppliers,
  creating/editing products, approvals, staff management) require a token whose
  signed role is `admin` — faking it in the browser does nothing.
- The `app_users` table (PIN hashes) is unreadable from any browser.

### Test right after Step 6
- Log in as **admin**: add a product, approve a stock request, void a sale,
  add a withdrawal, open Staff. All should work.
- Log in as **staff**: POS sale should work; a stock-in should go to Approvals;
  Sales/Purchases/Staff should be blocked.
- In a logged-out browser, open `/products` — it should still list products.

## Step 7 — (After a few days) drop the plaintext column

Once you're confident everyone has logged in and things are stable, run:

```sql
alter table public.app_users drop column pin;
```

---

## If something breaks

`supabase/02_enable_rls.sql` ends with an **EMERGENCY REVERT** block. Copy those
`disable row level security` lines into the SQL editor and run them to instantly
restore the previous open behavior while you investigate, then re-run Step 6
once fixed.

## Local development note

`next dev` does **not** run the `/api/*` Cloudflare functions, so login won't
work under plain `next dev`. To test the full flow locally use
`npx wrangler pages dev` and put the three secrets in a `.dev.vars` file
(same names). Or just test on a Cloudflare **Preview** deployment.

---

## What this does and doesn't cover

**Fixed (the four issues):**
1. Role spoofing via `localStorage` — the database now trusts the signed token's
   role, not the browser. Editing `localStorage` only changes what the UI draws.
2. Wide-open anonymous database access — anon is now read-only on the catalog;
   every write needs a logged-in user, and admin actions need a real admin.
3. Plaintext PINs + shipped master password — PINs are hashed and the table is
   sealed from browsers; the `admin123` master password is removed.
4. Last-admin lockout — a DB trigger blocks demoting/deactivating the last
   active admin.

**Still worth doing later (not part of these four):** a logged-in *staff* user
can still call the database directly to change stock quantities (that permission
is needed for POS to deduct stock, and RLS can't tell a real sale from a hand
edit). Closing that fully means moving the sell/transfer/stock math into
server-side database functions (RPCs) so stock can only change through
controlled operations. Say the word and that's the next step.
