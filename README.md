# Brew Ledger

A coffee and caffeine tracker. Log each cup, see how much caffeine is still in
your system at bedtime, and track daily totals against a cap.

The tracker works with no backend at all: every visitor's ledger lives in their
own browser. Sign in — if a Supabase project is configured — and it also syncs
across their devices. Local storage stays the source of truth, so the app keeps
working offline, signed out, or with the backend down.

## Layout

| Path | What it is |
|------|------------|
| `coffee-tracker/index.html` | The app. Edit this. A fragment: no `<html>`/`<body>`. |
| `coffee-tracker/sync.js` | Merge rules and the push/pull engine. |
| `coffee-tracker/sync.test.js` | Tests for the above. |
| `coffee-tracker/retired.html` | The "moved" page published at the old Claude Artifact URL. |
| `supabase/schema.sql` | Tables, triggers and Row Level Security policies. |
| `tools/build-standalone.py` | Assembles `dist/index.html`. |
| `netlify.toml` | Netlify build config and security headers. |
| `dist/` | Build output. Git-ignored; never edit. |

```sh
python3 tools/build-standalone.py          # build (sync off)
node --test coffee-tracker/sync.test.js    # test the sync logic
```

The build inlines `sync.js`, adds the Supabase client from a CDN, wraps
everything in a real HTML document, and substitutes `SUPABASE_URL` and
`SUPABASE_ANON_KEY` from the environment. Without those two variables the page
detects the missing config, hides the sync panel, and runs local-only.

## Setting up the backend

**1. Create a Supabase project** at <https://supabase.com>. The free tier is
enough.

**2. Apply the schema.** SQL Editor → New query → paste `supabase/schema.sql` →
Run. This creates the tables *and* the Row Level Security policies. Do not skip
it or create the tables by hand: RLS is the only thing keeping one person's
ledger out of another's.

**3. Decide about email confirmation.** Authentication → Sign In / Up → Email.
With "Confirm email" **on** (the default) a new account must click a link
before it works, and the free tier's built-in mailer is rate-limited to a few
messages an hour — fine for you, awkward for onboarding several friends at
once. Turning it off lets people sign in immediately, at the cost of allowing
sign-ups with addresses they do not own. Either is defensible here; know which
you chose.

**4. Copy the keys.** Project Settings → API: the Project URL and the `anon`
public key.

**5. Give them to the site.** Netlify → Site configuration → Environment
variables → add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then redeploy.

The anon key is meant to be public — it ships inside the page and anyone can
read it. It is not a password and grants nothing on its own; the RLS policies
decide what a request may touch. Keeping it in an environment variable rather
than in git is tidiness, not secrecy. The **service role** key is the opposite:
it bypasses RLS entirely and must never appear in this repository or in the
page.

## Deploying

**Netlify** builds from this repository: build command
`python3 tools/build-standalone.py`, publish directory `dist`. `netlify.toml`
declares both, plus a Content-Security-Policy restricting the page to the
Supabase and CDN hosts it actually uses — headers being the thing GitHub Pages
cannot do.

**GitHub Pages** also still deploys, from `.github/workflows/pages.yml`, at
<https://zakariakirati7.github.io/SSC/>. It runs the tests, builds, and
publishes `dist/`. To enable sync there too, add `SUPABASE_URL` and
`SUPABASE_ANON_KEY` as repository secrets (Settings → Secrets and variables →
Actions); without them that deploy stays local-only.

Running both is fine, but they are separate origins with separate browser
storage: a signed-out ledger on one is invisible to the other. Signed in, both
show the same synced data.

## How sync behaves

- **Local first.** Every change is written to `localStorage` immediately and
  pushed afterwards. Losing the network loses nothing.
- **Union merges.** Two devices that each logged a different cup end up with
  both. Cups carry unique ids, so one seen on both sides is kept once, and
  merging is order-independent. A day is never overwritten wholesale.
- **Batched writes.** Rapid edits collapse into one request, a failed push is
  retried rather than dropped, and an edit made mid-request is not lost.
- **Sample data never syncs.** The example cups shown on an empty ledger are
  illustration, and are dropped the moment anything real arrives.

## Caffeine figures

Per-drink values are typical preparations, not measurements — a different
roast, grinder, or pour will move them. The in-system curve assumes a
45-minute rise to peak followed by first-order elimination on a 5-hour
half-life, which is an average. Not medical advice.
