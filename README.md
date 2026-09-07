# Brew Ledger

A coffee and caffeine tracker. Log each cup, see how much caffeine is still in
your system at bedtime, and track daily totals against a cap.

Everything runs in the browser. Each visitor's log is kept in their own
`localStorage` — there is no server, no account, and no shared data.

## Layout

| Path | What it is |
|------|------------|
| `index.html` | The published site. **Generated — do not edit.** |
| `coffee-tracker/index.html` | The source. Edit this. |
| `tools/build-standalone.py` | Wraps the source in a full HTML document. |

The source is written for the Claude Artifact runtime, which supplies its own
`<!doctype html><head>…</head><body>` wrapper at publish time — so that file
carries no document tags. GitHub Pages serves files as-is, so the build script
adds the wrapper.

After changing `coffee-tracker/index.html`:

```sh
python3 tools/build-standalone.py
```

## Deploying

`.github/workflows/pages.yml` deploys the repository root to GitHub Pages on
every push to the default branch, and fails the build if `index.html` is out
of date with its source.

Pages has to be switched on once by hand, at
<https://github.com/zakariakirati7/SSC/settings/pages> — set **Source** to
**GitHub Actions**. The workflow asks for this itself
(`actions/configure-pages` with `enablement: true`), but the token a workflow
receives cannot create a Pages site: that needs repository-admin rights, and
the call comes back `Resource not accessible by integration`. Once Pages is
on, the same step finds the existing site and the deploy proceeds.

The site is at <https://zakariakirati7.github.io/SSC/>.

Pages for a private repository requires a paid GitHub plan; on a free account
the repository must be public.

## Caffeine figures

Per-drink values are typical preparations, not measurements — a different
roast, grinder, or pour will move them. The in-system curve assumes a
45-minute rise to peak followed by first-order elimination on a 5-hour
half-life, which is an average. Not medical advice.
