# Theming

trickshot's colors all resolve from one **semantic base palette**. A theme is just an
override of that palette; everything else — the shadcn primitives *and* the bespoke
layout — derives from it. All of this lives in `src/app.css`.

## The layers (top of `app.css`)

```
--base-*  (:root)                  ← the single source of truth (13 vars)
   │  overridden per theme by  [data-theme="ocean"] { --base-*: … }
   ▼
shadcn --* tokens (.dark)           ← --background, --primary, … = var(--base-*)
--app-* tokens (@layer components)  ← --app-bg, --app-panel, … = var(--base-*)
   ▼
@theme inline { --color-*: var(--*) }   ← Tailwind utilities (bg-primary, …)
bespoke CSS ( .app-header, .msg, … )    ← uses var(--app-*)
```

Because both token families point at `--base-*`, a theme sets ~13 vars and the entire
UI follows — no more editing two parallel blocks in sync.

## The base palette

| Token | Role | shadcn tokens it feeds | `--app-*` it feeds |
|---|---|---|---|
| `--base-bg` | app canvas | `--background`, `--primary-foreground`* | `--app-bg`, `--app-accent-text`* |
| `--base-surface` | panels (header, sidebar, cards, popovers) | `--card`, `--popover`, `--sidebar` | `--app-panel` |
| `--base-surface-raised` | hover / secondary / muted / accent surfaces | `--secondary`, `--muted`, `--accent`, `--sidebar-accent` | `--app-panel-2` |
| `--base-border` | dividers, inputs | `--border`, `--input`, `--sidebar-border` | `--app-border` |
| `--base-text` | primary text | `--foreground` + `*-foreground` | `--app-text` |
| `--base-text-muted` | dim / secondary text | `--muted-foreground` | `--app-dim` |
| `--base-accent` | brand accent | `--primary`, `--ring`, `--sidebar-primary/ring`, `--chart-1` | `--app-accent` |
| `--base-on-accent` | text/icon on accent fills | `--primary-foreground` | `--app-accent-text` |
| `--base-danger` | errors / destructive | `--destructive` | `--app-danger` |
| `--base-success` | online / running dot | `--chart-2` | — (`.dot.on`) |
| `--base-info` / `--base-warning` / `--base-special` | chart accents | `--chart-3/4/5` | — |
| `--base-overlay` | modal scrim | — (`[data-slot=dialog-overlay]`) | — |
| `--base-selection` | text-selection highlight *background* (neutral grey); the selected text itself is recolored to `--base-accent` with a slight accent glow (`::selection`) | — | — |

\* In the default dark theme `--base-on-accent` and the canvas happen to share a value;
they're separate tokens so a light theme can decouple them.

## Adding a theme

Two edits, nothing else:

1. **`src/app.css`** — add an override block (only what differs from the default):
   ```css
   [data-theme="slate"] {
     --base-bg: #15171c;
     --base-surface: #1d2027;
     --base-accent: #8a8fff;
     /* …any subset of the 13 base vars… */
   }
   ```
2. **`src/lib/stores.ts`** — add `{ id: "slate", label: "Slate" }` to `THEMES`.

The switcher in the header picks it up automatically.

## How switching works

- `stores.ts › theme` is a persisted writable. On every change it sets
  `document.documentElement.dataset.theme` (which the `[data-theme]` blocks key off)
  and saves to `localStorage["trickshot.theme"]`.
- `ThemeSelector.svelte` (header, right side) is a shadcn `Select` bound to that store.
- `index.html` has a tiny inline script that applies the saved theme **before first
  paint**, so reloading on a non-default theme doesn't flash the default palette.
- The default theme is **terracotta** = the `:root` base values, so it needs no
  `[data-theme]` block.

## Notes & caveats

- **Stay in the dark family.** The app keeps `class="dark"` on `<html>` because the
  shadcn primitives use `dark:` variant utilities (e.g. `dark:bg-input/30`) tuned for a
  dark surface. Themes are palette swaps *within* dark mode — they derive those
  variants from the themed base tokens, so dark-ish themes look right. A genuinely
  light theme would need those `dark:` variants revisited; out of scope for now.
- **No hardcoded colors.** Two former leaks were tokenized: the running-dot green
  (`.dot.on` → `--base-success`) and the dialog scrim (an unlayered
  `[data-slot=dialog-overlay]` rule → `--base-overlay`, so the generated `ui/` file is
  left untouched). Keep new colors behind `--base-*` — never inline a hex.
- The unused shadcn **light** (`:root`, oklch) values are left as the stock shadcn
  baseline; they're inert while `class="dark"` is active.
