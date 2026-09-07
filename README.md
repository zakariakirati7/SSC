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

GitHub Pages serves this branch from the repository root. Enable it under
**Settings → Pages**:

- **Source:** Deploy from a branch
- **Branch:** `claude/cats-pdf-document-mdt9jl` · `/ (root)`

Pages for a private repository requires a paid GitHub plan; on a free account
the repository must be public.

## Caffeine figures

Per-drink values are typical preparations, not measurements — a different
roast, grinder, or pour will move them. The in-system curve assumes a
45-minute rise to peak followed by first-order elimination on a 5-hour
half-life, which is an average. Not medical advice.
