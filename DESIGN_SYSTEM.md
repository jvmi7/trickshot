# Design System

The umbrella reference for trickshot's visual system. **Color** has its own deep-dive
in [THEMING.md](THEMING.md) (the `--base-*` palette → shadcn + `--app-*` pipeline);
this doc covers everything above color: the token scales, where each kind of token
lives, the when-to-use-what decision tree, the shared pattern classes, component
tiers, interaction states, and the recipes for extending the system. Most rules
here are machine-checked by `src/lib/conformance.test.ts` §7 — a violating literal
fails `bun test`, so this doc describes what CI enforces, not aspirations.

## The 14px root (read this first)

`app.css` sets `:root { font-size: 14px }`, so `1rem = 14px` and every rem-based
Tailwind value is 87.5% of its stock size: the spacing unit is **3.5px** (`px-8` =
28px, `h-9` = 31.5px), and the stock text scale landed on fractional px — which is
why raw `font-size: 11px` literals once proliferated. Consequences:

- **The `--text-*` scale is px-valued** (below) so utilities hit the bespoke grid
  exactly.
- **There is deliberately NO bespoke spacing scale.** Primitives (`ui/*`, utility
  classes) live on Tailwind's 3.5px grid; bespoke structural CSS uses literal px
  (`padding: 0 32px`). Don't convert between them mechanically — `32px` ≠ `px-8`.
- The radius ladder resolves against 14px too: `--radius-sm` = 10px, `--radius-xs`
  = 6px, `--radius-2xs` = 2px, `--radius-xl` = 18px.

## Token reference

**The two-home rule:** if Tailwind v4 has a theme namespace for the token kind
(`--text-*`, `--radius-*`, `--ease-*`, `--color-*`, `--font-*`) it lives in the
`@theme inline` block (gaining a utility class); otherwise it's an `--app-*` var in
the `@layer components :root` block. Never define a bare shadcn-shaped name
(`--border`, `--muted`, …) — that corrupts `ui/*` (CLAUDE.md).

### Typography — `@theme inline` (`text-*` utilities)

| Token | Value | Use |
|---|---|---|
| `--text-2xs` | 10px | overlines, micro-badges (`.wt-unread`) |
| `--text-xs` | 11px | **the workhorse small size**: section labels, pills, meta, errors |
| `--text-sm` | 12px | secondary body: empty states, tool rows |
| `--text-md` | 13px | list rows, thread messages |
| `--text-base` | 14px | body (= the `:root` size) |

In markup use the utility (`text-xs`); in a scoped rule use `var(--text-xs)`. Raw
`font-size: NNpx` fails CI (the `:root` 14px anchor and `/* conformance-allowlisted */`
lines excepted). The `.markdown` `em` sizes are relative-by-design and exempt.

### Radius — `@theme inline` (`rounded-*` utilities)

Single source `--radius: 1rem`; the ladder is `--radius-2xs/xs/sm/md/lg/xl`
(2/6/10/12/14/18px at the 14px root). `999px` is the blessed **pill** radius and
stays literal, as does `50%`. Any other raw `border-radius: NNpx` fails CI — pick
the nearest step (that snap is a deliberate, tiny visual delta).

### Z-index — `--app-*` block

| Token | Value | Use |
|---|---|---|
| `--app-z-overlay` | 3 | in-pane overlays (edge fades) |
| `--app-z-float` | 4 | floating affordances over content (reply pill) |
| `--app-z-indicator` | 5 | scroll indicator (above the fades) |
| `--app-z-chrome` | 20 | window chrome (sidebar resize, titlebar buttons) |

shadcn overlays own `z-50` — stay below it. Local stacking *inside* one component
(`z-index: 0/1`) stays literal; anything ordering ACROSS components uses the ladder
(CI-enforced).

### Motion — durations in `--app-*`, easings in `@theme inline`

| Token | Value | Use |
|---|---|---|
| `--app-duration-fast` | 120ms | **THE feedback duration** — every hover/color/opacity transition |
| `--app-duration-slow` | 300ms | structural: panel slides, fades, reveals |
| `--ease-out-soft` | cubic-bezier(0.22, 1, 0.36, 1) | deceleration reveals (scroll indicator) |
| `--ease-slide` | cubic-bezier(0.4, 0, 0.2, 1) | structural slides (sidebar collapse) |

Literal `transition` durations fail CI. Keyframe `animation` choreography
(dot-pulse, shimmer, caret blink) keeps literal durations by design — those are
rhythms, not interaction feedback.

### Shadow — `--app-*` block

`--app-shadow-float: 0 1px 4px rgb(0 0 0 / 0.18)` — the one elevation shadow
(floating reply pill). Black-based on purpose so it stays legible over light-valued
theme palettes. If a theme ever needs a custom shadow, promote it to a
`ThemePalette` key via `PALETTE_VARS` (themes.ts) rather than forking per-site —
the precedent: `termGlow` → `--base-term-glow`, the per-theme terminal glyph glow.

### ANSI palette + mono stack — `--app-*` block

| Token | Value | Use |
|---|---|---|
| `--app-ansi-0..15` | palette-derived, zero literals: 1-5 = `--base-danger/success/warning/info/special`; 0 = border, 7 = text-muted, 15 = text; 6/14 = cyan mixes (`color-mix` of info⊕success / info⊕text); 8 = border⊕text-muted; brights 9-13 = `color-mix(in srgb, hue 75%, var(--base-text))` | the 16 ANSI slots read by `.ansi-fg-N`/`.ansi-bg-N` (emitted by `ansi.ts` → `AnsiText`); conformance §8 pins the token↔rule↔emitter pairing |
| `--app-font-mono` | `ui-monospace, Menlo, monospace` | mono stack for terminal-flavored surfaces (the terminal chat skin) |

### Layout + color

`--chat-col: 740px` (the chat reading column, consumed via `.chat-col`); `--app-font`
(the active font stack). Color: see THEMING.md — 16 `--base-*` palette tokens feed
both the shadcn tokens (`.dark` block) and the `--app-*` aliases. **What bespoke CSS
may read:** `--app-*` where an alias exists (`--app-danger`, not `--destructive`),
`--base-*` for the state hues with no alias (`success`/`warning`/`special`), and
shadcn `--*` names ONLY inside Tailwind utility classes (`bg-destructive/10` is
fine). The `var(--app-x, var(--fallback))` idiom is dead — the tokens are always
defined; a reintroduced fallback fails CI.

## When to build UI, in order (stop at the first hit)

1. **A shadcn primitive exists** → use it (vendor via `bunx shadcn-svelte add` if
   needed). This includes the non-obvious ones: pills/chips are `badgeVariants`
   (see Adoptions), borderless textareas are `InputGroupTextarea`.
2. **Tailwind utilities + shadcn tokens in markup** (`text-muted-foreground`,
   `bg-background`, `rounded-sm`) — the default for new styling.
3. **The pattern repeats across ≥ 2 components** → a shared class in `app.css`'s
   `@layer components` (reading `--app-*`/`--base-*`). The existing set is below —
   extend it, don't fork a sibling copy.
4. **One-component structural CSS** → the component's scoped `<style>` (reading
   `--app-*`/`--base-*` + the scales; never raw literals, never shadcn var names).

### The shared pattern classes (app.css)

| Class | What it is | Consumers (illustrative) |
|---|---|---|
| `.chat-col` | the centered chat reading column (`--chat-col` + 32px gutters) | messages, composer, suggestions, queued, auth banner |
| `.section-label` | 11px/600 uppercase overline (typography only — compose layout per-site) | sidebar sections, repo names, PR title, queue/thread labels |
| `.empty-state` | centered dim "nothing here" text | git panel, run output, diff view, chat |
| `.error-text` / `.notice-text` | pre-wrapped danger/success feedback text | git/PR/run/terminal/thread errors |
| `.text-action` | ghost inline text button (dim → text on hover) | queue actions, thread quote toggle |
| `.panel-section` / `.panel-spacer` / `.panel-form` | bordered panel sections + form column | git commit block, PR block |
| `.icon-chrome-btn` | the 24px dim→hover chrome square | titlebar + sidebar icon buttons |
| `.ansi-fg-{0..15}` / `.ansi-bg-{0..15}` / `.ansi-bold/dim/italic/underline` | ANSI SGR span styling over the `--app-ansi-*` slots (classes emitted by `ansi.ts`; conformance §8) | `AnsiText` (via Collapsible tool results, RunOutput) |
| `.text-table` | scopes a table onto the shared `.markdown` data-table look (`:where(.markdown, .text-table)`) | `TextTable` (tool-result tabular view) |

## Component tiers & primitive adoptions

The two-tier rule (CLAUDE.md): prop-driven primitives (no `stores`/`api` imports)
vs feature components, both in the flat `components/` dir; `ui/` is registry output
that `add -o` overwrites — never hand-edit it cosmetically, never place hand-built
files there. Established adoptions to reuse, not re-invent:

- **Pills/chips = `badgeVariants`** (`ui/badge`): `variant: "outline"` for bordered
  pills (thread pill, floating reply), `"ghost"` for passive text chips (usage
  chip). Badge brings the focus ring for free; keep only positional/one-off color
  residuals scoped.
- **Borderless textareas = `InputGroupTextarea`** (`ui/input-group`) — the
  composer and thread reply inputs. Don't re-create the long
  `border-0 bg-transparent …` class string.
- **Chromeless Select trigger = `ghostSelectTrigger`** (`$lib/utils.ts`) — the
  model/permission selectors' shared trigger recipe.
- **Tabs boundary:** `ui/tabs` = content-panel tabs (Settings); `ViewToggle` = the
  app's segmented control (justified by the `slidingHighlight` pill). Don't migrate
  one into the other.
- `ui/separator` is vendored but only consumed via Select's internals — prefer it
  over a hand-rolled divider if one is ever needed.

## Interaction states

- **Focus:** ONE global rule (`@layer base :focus-visible` in app.css) gives every
  hand-styled interactive element the themed ring. **Never write a per-component
  focus ring.** shadcn `ui/*` keep their own ring utilities (utilities layer beats
  base) — that's expected and consistent.
- **Hover:** recolor/reveal at `var(--app-duration-fast)`. There is deliberately no
  press-down (`:active`) feedback app-wide (the shadcn nudge is globally cancelled;
  see app.css's unlayered foot).
- **Disabled:** shadcn primitives own it via `disabled:*` utilities; hand-styled
  controls are never rendered disabled — if one must be, use the same utilities.

## Recipes

**Add a theme** — one entry in `themes.ts › THEMES` (all 16 palette keys required
by the type). If it becomes the default (first entry), sync the `app.css :root`
static fallback (CI-guarded). Full walkthrough in THEMING.md.

**Add a LIGHT-VALUED theme** — it's *just a theme*, not a mode; `class="dark"`
stays (it's the token-activation selector). Palette checklist: light `bg`/
`surface`/`surfaceRaised`, dark `text`/`textMuted`, `onAccent` decoupled from `bg`
(dark text over the accent if the accent is light), a **lighter** `overlay` scrim,
a `selection` tone that reads at 20% over white, borders dark enough to divide
light surfaces. Then verify: the `dark:` opacity tints in `ui/*` now tint light
values (lighter hovers — expected), `::selection`, the dialog scrim, edge fades
(they follow `--base-bg`), diff add/del tints, and `--app-shadow-float` legibility.
The CI guard that keeps this possible: `ui/*` `dark:` utilities must stay
value-relative (no `dark:bg-zinc-900`-style literals).

**Add a font** — `@font-face` + a `--font-*` stack var + a `[data-font="<id>"]`
block in app.css, + an entry in `stores.ts › FONTS`. The block↔registry match is
CI-guarded.

**Add a token** — pick the home by the two-home rule; document it in the matching
table here; if it's a new *kind* of token, extend conformance §7 so raw literals of
that kind can't creep back.
