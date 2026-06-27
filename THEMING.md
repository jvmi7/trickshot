# Theming

trickshot's colors all resolve from one **semantic base palette**. A theme is just a
full set of values for that palette; everything else — the shadcn primitives *and* the
bespoke layout — derives from it.

**The single source of truth is [`src/lib/themes.ts`](src/lib/themes.ts).** Each theme is
one data object there. The CSS variables, the picker, and the active-theme selection are
all derived from that config — there are no hand-written per-theme CSS blocks anymore.

## The layers

```
themes.ts  (THEMES: { id, label, palette })      ← the config (source of truth)
   │  installThemes() injects, per theme:
   ▼
:root[data-theme="<id>"] { --base-*: … }          ← generated CSS (in <style id="theme-vars">)
   │   (the bare :root in app.css is the static fallback = default theme)
   ▼
shadcn --* tokens (.dark)            ← --background, --primary, … = var(--base-*)
--app-* tokens (@layer components)   ← --app-bg, --app-panel, … = var(--base-*)
   ▼
@theme inline { --color-*: var(--*) }    ← Tailwind utilities (bg-primary, …)
bespoke CSS ( .app-header, .msg, … )     ← uses var(--app-*)
```

Because both token families point at `--base-*`, a theme sets the base palette and the
entire UI follows.

## The base palette (`ThemePalette` in themes.ts)

| Palette key | `--base-*` var | Role | shadcn tokens it feeds | `--app-*` it feeds |
|---|---|---|---|---|
| `bg` | `--base-bg` | app canvas | `--background`, `--primary-foreground`* | `--app-bg` |
| `surface` | `--base-surface` | panels (header, sidebar, cards, popovers) | `--card`, `--popover`, `--sidebar` | `--app-panel` |
| `surfaceRaised` | `--base-surface-raised` | hover / secondary / muted / accent surfaces | `--secondary`, `--muted`, `--accent`, `--sidebar-accent` | `--app-panel-2` |
| `border` | `--base-border` | dividers, inputs | `--border`, `--input`, `--sidebar-border` | `--app-border` |
| `text` | `--base-text` | primary text | `--foreground` + `*-foreground` | `--app-text` |
| `textMuted` | `--base-text-muted` | dim / secondary text | `--muted-foreground` | `--app-dim` |
| `accent` | `--base-accent` | brand accent | `--primary`, `--ring`, `--sidebar-primary/ring`, `--chart-1` | `--app-accent` |
| `onAccent` | `--base-on-accent` | text/icon on accent fills | `--primary-foreground` | `--app-accent-text` |
| `danger` | `--base-danger` | errors / destructive | `--destructive` | `--app-danger` |
| `success` | `--base-success` | online / running dot | `--chart-2` | — (`.dot.on`) |
| `info` / `warning` / `special` | `--base-info` / `-warning` / `-special` | chart accents | `--chart-3/4/5` | — |
| `overlay` | `--base-overlay` | modal scrim | — (`[data-slot=dialog-overlay]`) | — |
| `selection` | `--base-selection` | text-selection highlight *background*; selected text recolors to `--base-accent` + glows (`::selection`) | — | — |

\* In a dark theme `onAccent` and `bg` often share a value; they're separate keys so a
light theme can decouple them.

## Adding / removing a theme

**One edit, one file** — `src/lib/themes.ts`:

```ts
export const THEMES: Theme[] = [
  /* …existing… */
  {
    id: "slate",            // used by <html data-theme> + persisted
    label: "Slate",         // shown in the picker
    palette: {
      bg: "#15171c",
      surface: "#1d2027",
      surfaceRaised: "#272b34",
      border: "#363b46",
      text: "#dfe2ea",
      textMuted: "#8a8f9c",
      accent: "#8a8fff",
      onAccent: "#15171c",
      danger: "#e06c6c", success: "#5fb87a", info: "#6b9fd9",
      warning: "#d9b257", special: "#b57fd9",
      overlay: "rgb(0 0 0 / 0.5)", selection: "#837c7c",
    },
  },
];
```

That's it — the picker (`stores.ts › THEMES`) and the injected CSS both derive from this
list. **Define the full palette** (every `ThemePalette` key); themes are self-contained,
with no implicit inheritance. To **remove** a theme, delete its entry. To change the
**default**, make it the first entry (and mirror it into the `:root` fallback — see below).

## How it works

- **`themes.ts`** holds the config + the generator. `themesToCss()` walks `PALETTE_VARS`
  to emit one `:root[data-theme="<id>"] { --base-*: … }` block per theme.
- **`main.ts`** calls `installThemes()` *before mount*, which puts that CSS in a
  `<style id="theme-vars">`. The `:root[data-theme]` selectors (specificity 0,2,0)
  deliberately outrank the bare `:root` default (0,1,0), so the active theme always wins.
- **`stores.ts › theme`** is a persisted writable. On change it sets
  `document.documentElement.dataset.theme` and saves to `localStorage["trickshot.theme"]`.
  `THEMES` (id/label for the picker) is `.map()`-derived from the config; the default
  fallback is `DEFAULT_THEME` (the first config entry).
- **`Settings.svelte`** is a shadcn `Select` bound to that store, iterating `THEMES`.
- **`index.html`** has a tiny inline script that applies the saved `data-theme` **before
  first paint**, so reloading on a non-default theme doesn't flash the default.
- **`app.css :root`** keeps a literal copy of the **default theme** as a static fallback
  (styled before `installThemes()` runs / if no `data-theme` is set). Keep it in sync with
  `THEMES[0]` in themes.ts.

## Notes & caveats

- **Stay in the dark family.** The app keeps `class="dark"` on `<html>` because the
  shadcn primitives use `dark:` variant utilities (e.g. `dark:bg-input/30`) tuned for a
  dark surface. Themes are palette swaps *within* dark mode. A genuinely light theme would
  need those `dark:` variants revisited; out of scope.
- **No hardcoded colors.** Every color flows through a `--base-*` var (and thus the
  themes.ts palette). Never inline a hex in a component or token block; add/extend a
  palette key instead (`ThemePalette` + `PALETTE_VARS` + every theme + the consumer).
- The unused shadcn **light** (`:root`, oklch) values are the stock shadcn baseline;
  they're inert while `class="dark"` is active.
