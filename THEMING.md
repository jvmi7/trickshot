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
| `accent` | `--base-accent` | brand accent | `--primary`, `--ring`, `--sidebar-primary/ring`, `--chart-1` | `--app-accent`, `--app-selection-text` |
| `onAccent` | `--base-on-accent` | text/icon on accent fills | `--primary-foreground` | — (consumed via `--primary-foreground`) |
| `danger` | `--base-danger` | errors / destructive | `--destructive` | `--app-danger` |
| `success` | `--base-success` | online / running dot, diff additions | `--chart-2`† | — (`.dot.on`, `.diff-add`, diffstat, `.hljs-string`) |
| `info` / `warning` / `special` | `--base-info` / `-warning` / `-special` | chart accents + syntax/state hues | `--chart-3/4/5`† | — (`warning`→`.wt-pending`/`.hljs-number`; `special`→`.hljs-keyword`) |
| `overlay` | `--base-overlay` | modal scrim | — (`[data-slot=dialog-overlay]`) | — |
| `selection` | `--base-selection` | text-selection highlight *fill* (rendered at 20%); selected text recolors to `--base-accent` (`::selection`) | — | `--app-selection-bg` |
| `termGlow` | `--base-term-glow` | terminal glyph glow — a full `text-shadow` value (`none` disables); `currentColor` layers glow each glyph in its own ANSI color | — | — (`.term-host .xterm-rows`) |

\* In a dark theme `onAccent` and `bg` often share a value; they're separate keys so a
light theme can decouple them.

† The shadcn `--chart-*` tokens are stock-registry scaffolding with **no current UI
consumer** (no chart/badge component renders them yet), so `--chart-1/2/3/4/5` — and
`--base-info`, which feeds only `--chart-3` — are presently inert. They're kept for
registry compatibility (like the inert light `:root` values); a future shadcn `Chart`
would consume them. `success`/`warning`/`special` are still live via their non-chart
consumers above.

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

- **`class="dark"` is a permanent token-activation artifact, not a mode.** It selects
  the `.dark` block whose values ALL derive from `--base-*`, and the `dark:` variant
  utilities inside `ui/*` are opacity tints over tokens (`dark:bg-input/30`) — value-
  relative, so they stay correct over any palette. Themes — **including a light-valued
  one** — are plain palette swaps under it: adding "light" is just a `THEMES` entry with
  light `bg`/`surface`s, dark `text`, a decoupled `onAccent`, a lighter `overlay` scrim,
  and a `selection` tone that reads over white. See DESIGN_SYSTEM.md → "Add a
  light-valued theme" for the recipe + verification checklist. Never remove the class
  (that would revert shadcn tokens to their stock defaults and silence the tints).
- **No hardcoded colors.** Every color flows through a `--base-*` var (and thus the
  themes.ts palette). Never inline a hex in a component or token block; add/extend a
  palette key instead (`ThemePalette` + `PALETTE_VARS` + every theme + the consumer).
  This is now machine-checked by `conformance.test.ts` (no hex/rgb literals in
  components; no value-bound `dark:` colors in `ui/*`).
- The stock shadcn light-oklch `:root` baseline that used to sit in app.css was inert
  (nothing ever removes `.dark`) and has been **removed** so it can't masquerade as a
  light mode; only `--radius` remains at `:root`.
