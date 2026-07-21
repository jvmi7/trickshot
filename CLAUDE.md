# trickshot

Desktop GUI for Claude Code with first-class git worktrees. Tauri 2 (Rust core) + Svelte 5 / TypeScript webview (UI styled with Tailwind v4 + shadcn-svelte). **The chat pane is the real Claude Code CLI TUI on a per-worktree PTY** — there is no app-managed agent process and no API key. Package manager is **bun** (`bun.lock`) — never npm/yarn. The `$lib` alias maps to `src/lib`.

Goals for any change here, in priority order: (1) clean, consistent code; (2) organized so an LLM can locate and reason about any concern from one file; (3) **performance is first-class** — see the dedicated section.

## Consistency & cohesion (the prime directive)

Goal #1 means: **one pattern per concern, applied predictably.** A *second* way to do something the codebase already does is the main source of bugs here — don't introduce one. Before writing code:

1. **Find the concern's home** in *Where things live* and put the code there. Never create a parallel location — a second IPC entry point, a stray `localStorage` key, a one-off error toast.
2. **Reuse the existing primitive/helper; extend, don't fork.** shadcn `ui/*` for UI, `api.ts` for IPC, store mutators for state. If one *almost* fits, widen it — don't add a near-duplicate beside it.
3. **Match the file you're editing** — same error path, same naming. Don't leave two patterns side-by-side in one file.
4. **Copy the established shape** when adding to a known category (a new IPC command, a persisted store, a themed token) — replicate the existing template in that section *including its guards* (try/catch, `??` fallbacks, the SYNC RULE), not a fresh variant.
5. **Prefer the boring, explicit, greppable option** — a named helper over an inline trick. No clever one-offs.

If a genuinely new pattern is unavoidable, say so explicitly in your reasoning and apply it to **every** instance of that concern — never half-migrate, leaving two patterns where there was one.

## Architecture (2 processes, the CLI on a PTY)

```
Svelte webview (Vite)
  -> src/lib/api.ts          (Tauri IPC: invoke<T>() / listen())
  -> Rust core (src-tauri)   terminal.rs runs ONE claude PTY per worktree (concurrent);
                             worktree.rs shells git; scripts/github/generate/usage
  -> the user's PATH `claude` CLI (TUI)  -> Anthropic API
```

- **One chat per worktree, running concurrently.** Selecting a worktree opens its claude-slot PTY resuming the newest session id (idempotent); PTYs keep running when you switch. No global start/stop — a worktree just *has* a chat.
- Rust -> webview: worktree-tagged Tauri events — `script-event` and `term-event`, both the `{ worktree, kind, data }` envelope — so the UI routes each to the right consumer.
- The agent's own config (model, permissions, MCP, slash commands, CLAUDE.md) is Claude Code's — the app adds no layer on top.
- Full detail and the command tables live in `ARCHITECTURE.md`.

## Cross-process contract + SYNC RULE (most important)

The Rust ↔ TS seams are **hand-mirrored** — there is no compiler link across the IPC boundary:
- `src-tauri/src/worktree_map.rs` — the shared `WorktreeEvent { worktree, kind, data }` struct emitted on `script-event`/`term-event` (one envelope, two channels), mirrored by the TS `ScriptEnvelope`/`TermEnvelope` in `src/lib/types.ts`.
- `src-tauri/src/lib.rs`'s `generate_handler![]` ↔ `api.ts`'s `invoke()` set ↔ the `ARCHITECTURE.md` command table.
- `terminal.rs › CLAUDE_SLOT` ↔ `lib/terminal.ts › claudeTermKey` (the NUL-suffixed claude-PTY key).

**When you add or change a command, an event kind, or the envelope, edit both sides and `ARCHITECTURE.md` in the SAME commit.** These seams are guarded by `src/lib/conformance.test.ts` — a `bun test` that fails when the `lib.rs` command set ≠ the `api.ts` `invoke()` set, a command is undocumented, the `WorktreeEvent` struct ≠ the TS envelopes (`ScriptEnvelope`/`TermEnvelope`), or the theme/font CSS fallbacks drift from their TS source. Add the matching doc/code entry in the same commit and it stays green; forget one and CI catches it.

Boundary arg casing (deliberate asymmetry, matches Tauri serde defaults):
- Command **args are camelCase** (`repoPath`, `worktree`, `worktreePath`, `baseRef`); Rust commands declare them snake_case and Tauri maps automatically.
- Command **results are snake_case** (`Worktree.is_main`, `w.branch`) — mirror the Rust struct exactly, do not rename to camelCase.

## Where things live

| Concern | File |
|---|---|
| IPC surface (the only one) | `src/lib/api.ts` |
| App-side types (`Worktree`/`Repo`/`GitStatus`/`UsageInfo`/`ScriptEnvelope`/`TermEnvelope`/…) | `src/lib/types.ts` |
| Per-worktree state: persisted repos, worktrees, selection, session status, git stats, unread — each a `createWorktreeMap<T>` (store + `set`/`update`/`remove`/`active`, optionally persisted) | `src/lib/stores.ts` |
| Persisted-store template (`createPersisted`/`createPersistedString` + shape guards + `purgeRetiredKeys`) | `src/lib/persist.ts` |
| Session/worktree orchestration: `activateWorktree`, `openRepository`, `restoreWorkspace`, `ensureClaudeOpen`, `sendToCli`, `submitTurnToChat`, `handleCliExit` | `src/lib/session.ts` (re-exported via `stores.ts`) |
| Provider DISPLAY registry (per-provider copy: sign-in banner, usage footnote, auth-error matcher) — the only webview module that may name a provider | `src/lib/providers.ts` |
| CLI busy/idle detection (PTY output flow → busy dot / unread) | `src/lib/cliActivity.ts` (pure tracker + tests) wired in `terminal.ts › noteCliActivity` |
| Integrated terminal (PTYs per worktree: shell + claude slots) | `src-tauri/src/terminal.rs` (portable-pty commands, `launch` whitelist) + `src/lib/terminal.ts` (xterm cache + `term-event` router + `attachTerminal` + `claudeTermKey`) + `TerminalPane.svelte`/`ClaudeTerminalPane.svelte` |
| The chat pane (the real Claude Code TUI; MULTIPLE concurrent chats per worktree, rendered as tabs or an n-up grid) | `ClaudeTerminalPane.svelte` (the surface: strip + layouts) + `ClaudeTerminalCell.svelte` (one chat's terminal) + `stores.ts › chatSessionsByWorktree/focusedChatByWorktree/chatLayout/chatStatusByKey` + `session.ts › ensureClaudeOpen/sendToCli/submitTurnToChat/handleCliExit` + `agent.rs › latest_session_id` |
| Compose popup (⌘E long-prompt editor → bracketed-paste into the CLI) | `ComposeDialog.svelte` + `stores.ts › composeOpen/composeDraft` |
| Theme definitions (the `--base-*` palettes behind `[data-theme]`) | `src/lib/themes.ts` (injected via `app.css`/`stores.ts`, see THEMING.md) |
| Syntax highlighting (DiffView) | `src/lib/highlight.ts` |
| Cross-process conformance gates (the no-compiler-link seams: commands↔api↔docs, `WorktreeEvent`↔the TS envelopes, theme/font CSS fallbacks, no raw IPC in `.svelte`, the design-system scale guards) | `src/lib/conformance.test.ts` |
| Design-system reference (token scales, two-home rule, shared classes, tiers, recipes) | `DESIGN_SYSTEM.md` (color deep-dive: `THEMING.md`) |
| UI components (one per concern) | `src/lib/components/*.svelte` |
| Global header (slots: `title`/`left`/`actions` + sidebar toggle) | `src/lib/components/Header.svelte` |
| shadcn-svelte primitives (the UI building blocks) | `src/lib/components/ui/` |
| `cn()` + shadcn type helpers | `src/lib/utils.ts` |
| DOM/interaction helpers (Svelte `use:` actions + init): sliding active-pill highlight, cursor-proximity border glow, terminal-backdrop cursor trail | `src/lib/slidingHighlight.ts`, `src/lib/borderGlow.ts`, `src/lib/cursorTrail.ts` |
| shadcn config (aliases, base color) | `components.json` |
| Git review (status/diff/stage/commit/push/merge) | `src-tauri/src/worktree.rs` (commands) + `src/lib/components/GitPanel.svelte` + `DiffView.svelte` — a header POPOVER (`ViewToggle`'s ± trigger, `stores.ts › changesOpen`), not a page |
| GitHub PRs (create + checks via `gh` CLI, "fix failing checks → agent") | `src-tauri/src/github.rs` (commands) + `PrPanel.svelte` (rendered by `GitPanel`) |
| AI commit / PR text (one-shot `claude -p`, the same PATH binary as the chat; no API key) | `src-tauri/src/generate.rs` (commands) + `api.generateCommitMessage`/`generatePrText` + wand buttons in `GitPanel.svelte`/`PrPanel.svelte` |
| Review queue (batched diff-line comments → ONE structured prompt into the CLI; persisted) | `src/lib/review.ts` (shape + `formatReviewPrompt`, tested) + `stores.ts › reviewQueueByWorktree` + the tray/dialog in `GitPanel.svelte` + `DiffView`'s `commentedLines` markers |
| Subscription usage + provider auth probe (`get_usage`/`check_auth`, provider-gated) | `src-tauri/src/usage.rs` + `UsageIndicator.svelte` + `stores.ts › refreshUsage`/`refreshAuth` + `AuthNotice.svelte` (the sign-in banner in `Welcome`) |
| Shared Rust per-worktree plumbing (poison-safe `WorktreeMap<T>`, the `WorktreeEvent` envelope, generation counter) | `src-tauri/src/worktree_map.rs` |
| Project scripts (repo `.trickshot/settings.json`: setup/run/archive, `TRICKSHOT_PORT` block) | `src-tauri/src/scripts.rs` (commands) + `src/lib/scriptEvents.ts` (router, 16ms-batched) + `RunScripts.svelte` (header Run button) + `RunOutput.svelte` (the Run tab) |
| Workspace archiving + History (Claude Code's path-keyed session store makes restore resume the chat) | `stores.ts › archivedWorkspaces` + archive/restore/purge flows in `Worktrees.svelte` (shared restore: `session.ts › restoreWorkspace`) |
| Fleet overview (mission control: all worktrees w/ status/±/badges, click-to-jump; shown when no worktree selected) | `src/lib/components/Fleet.svelte` (wired in `App.svelte`; palette "Fleet overview" deselects to reach it) |
| Per-workspace terminal profiles (path-hash → full ANSI palette/accent; identity chips + header ❯) | `src/lib/termProfiles.ts` (data + `profileFor/Accent`, tested) + `terminal.ts › themeColors(key)` + `stores.ts` `--ws-*` reflect |
| ANSI (SGR) rendering for script output — the ONE home | `src/lib/ansi.ts` (+ tests) + `AnsiText.svelte`; `--app-ansi-*` tokens in app.css (conformance §8) |
| Command palette (⌘K) + shortcuts (⌘⇧N/⌘⇧D/⌘⇧P in `App.svelte`) | `CommandPalette.svelte` + `stores.ts › commandPaletteOpen`/`newWorktreeRequest`/`activateWorktree` |
| Background fleet (unread badges) | `unreadByWorktree` store + `Worktrees.svelte`/`Fleet.svelte` badges; the busy/turn-end signal is derived from PTY output flow (`cliActivity.ts`). (The notification system — OS `notify` command + in-app bell — was DELETED by user request; don’t reintroduce it.) |
| Rust commands: session-store scan / git worktrees + repo icons | `src-tauri/src/agent.rs`, `worktree.rs` |
| Rust command registry (`generate_handler!`) | `src-tauri/src/lib.rs` |
| Permission scope (dialog) | `src-tauri/capabilities/default.json` |

`src/lib/api.ts` is the **sole hook layer.** Components import `* as api` and call `pickDirectory` / `termOpen` / `onTermEvent` etc. **Never** import or call `invoke()` (`@tauri-apps/api/core`) or `listen()` (`@tauri-apps/api/event`) directly in a `.svelte` file — add a new typed wrapper to `api.ts` first. Its header says `THIS IS THE PRIMARY HOOK POINT`.

## Component Library — shadcn FIRST, ALWAYS (hard rule)

**Any time you build, touch, or introduce UI, shadcn-svelte is the default — not a fallback.** Never hand-write a button, input, select, dialog, dropdown, popover, tooltip, etc. when shadcn provides it. UI is composed from small, generic primitives — never large, hyper-specialized components. Before writing a single line of new markup, walk these steps IN ORDER and stop at the first hit:

1. **Reuse `src/lib/components/ui/`** — if the primitive is already vendored locally, use it. Import via `$lib/components/ui/<name>` + `cn()` from `$lib/utils`.
2. **Check the shadcn-svelte registry** — if it's NOT local, assume it exists upstream and pull it in instead of hand-writing: `bunx shadcn-svelte@latest add <name> -y` (catalog: https://shadcn-svelte.com/docs/components). It lands in `ui/<name>/` (and auto-adds any deps it needs). This is the expected path for new primitives — adding a registry component is preferred over writing your own.
3. **Only then hand-build** — and only if the registry genuinely has no equivalent. Build it as a small, generic, **prop-driven** primitive (no `stores`/`api` import — it takes props and renders, nothing more), and put it in the **flat `src/lib/components/` dir, NOT in `ui/`**. `ui/` is reserved for shadcn-registry output, which `bunx shadcn-svelte add <name> -o` overwrites wholesale — a hand-authored file there gets clobbered on the next sync. The precedent for "hand-built generic primitive" is `IconButton` / `HeaderIconButton`, which live alongside the feature components. Treat hand-building as the rare exception and say so in your reasoning.

> shadcn-svelte components are thin styled wrappers over `bits-ui` (the headless primitive layer, like Radix for React). "Use shadcn" and "use bits-ui" are the same stack — the registry component imports `bits-ui` for you. So reach for the shadcn registry, not raw `bits-ui`, unless you're deliberately authoring a new `ui/` primitive.

- Primitives are building blocks (`Button`, `Dialog`, `Input`), kept generic; feature components in `src/lib/components/` compose them. Import via `$lib/components/ui/<name>` + `cn()` from `$lib/utils`.
- **The flat `components/` dir holds TWO tiers — keep the split clean.** (a) **Prop-driven primitives** that take props and render, with NO `stores`/`api` import (`IconButton`, `HeaderIconButton`, `Header`, `DiffView`, `IdentityGlyph`, `AnsiText`) — generic, movable, the hand-built siblings of `ui/*`. (b) **Feature components** that couple to `stores`/`api` for session/app state (`ClaudeTerminalPane`, `TerminalPane`, `GitPanel`, `PrPanel`, `Worktrees`, `Fleet`, `AuthNotice`, `ComposeDialog`, the `Settings*`/`CommandPalette` set). A primitive must NOT reach into a store — pass the data in as a prop and let a feature component own the wiring. (Both tiers share the one flat dir on purpose — no `primitives/` subfolder; the store-import test is the only boundary that matters.)
- **Animations: the `data-open`/`data-closed` variant fix is load-bearing.** Generated `ui/*` components animate via `data-open:`/`data-closed:` utilities, but the installed bits-ui (2.18.1, latest) stamps `data-state="open"/"closed"` — a naming mismatch that makes open/close animations silently no-op. `app.css` defines `@custom-variant data-open`/`data-closed` mapping BOTH spellings, so animations work. Keep those variants when editing `app.css`; if a newly added component still won't animate, that mapping is the first thing to check.
- `ui/*` are Svelte 5 + `tailwind-variants` + `bits-ui`. Don't hand-edit them cosmetically (`add -o` overwrites them); theme via tokens, not per-component edits. Setup lives in `components.json` + `$lib/utils.ts`.

## Icons — Lucide ONLY (hard rule)

**Every icon comes from [Lucide](https://lucide.dev/icons/) (`@lucide/svelte`), the same set shadcn-svelte ships with.** Import per-icon and render as a component: `import House from "@lucide/svelte/icons/house";` then `<House class="size-4" />`. They're SVGs — size with `size-*` (or width/height); they inherit `currentColor`. Icon names are kebab-case (e.g. `panel-left`, `chevron-down`, `arrow-up`); some are renamed (`home` → `house`). Browse at lucide.dev or `ls node_modules/@lucide/svelte/dist/icons/`.

- **NO other icon library, ever** (no `lineicons`, `@phosphor-icons/*`, etc.) and **no hand-rolled inline `<svg>` icons** in app components — find the closest Lucide glyph instead. Both were removed deliberately; don't reintroduce them.
- This is the icon set shadcn registry components already use, so newly `add`ed `ui/*` components need no icon rewrite. Icons in use are an open, growing set — grep the imports for the current list.
- The floating titlebar icon button pattern is `HeaderIconButton.svelte` (`.header-icon-btn`, which sizes its `svg`) — a fixed-position wrapper over `IconButton`; reuse it for any floating titlebar icon. (The settings entry lives as a sidebar-foot `Button`, not a floating icon.)

## Styling (Tailwind v4)

- **The scales are the only source of style literals (see `DESIGN_SYSTEM.md`; conformance-enforced).** Type = `--text-2xs/xs/sm/md/base` (px-valued — the app runs a 14px root, so rem utilities are 87.5%-scaled); radius = the `--radius`-derived ladder (+ literal `999px` pills); z-order across components = `--app-z-*`; feedback transitions = `--app-duration-fast` (structural = `--app-duration-slow` + `--ease-*`); the one shadow = `--app-shadow-float`. Raw `font-size: NNpx`, transition durations, `z-index` (beyond local 0/1), `border-radius: NNpx`, and color literals in components FAIL `bun test`. New token kinds follow the **two-home rule**: Tailwind-namespaced kinds go in `@theme inline`, everything else is an `--app-*` var.
- **One focus treatment.** The global `@layer base :focus-visible` rule in `app.css` rings every hand-styled interactive element (themed via `--ring`); never write a per-component focus ring. shadcn `ui/*` keep their own ring utilities — expected.
- **Shared pattern classes over scoped copies.** `.section-label`, `.empty-state`, `.error-text`/`.notice-text`, `.panel-section`/`.panel-spacer`/`.panel-form` (app.css `@layer components`) are the one home for those recurring shapes — compose them, don't re-roll a scoped sibling. Pills/chips = `badgeVariants` (`ui/badge`); borderless textareas = `InputGroupTextarea` (`ui/input-group`); the chromeless Select trigger = `ghostSelectTrigger` (`$lib/utils.ts`).
- **The interactive UI is shadcn primitives.** Buttons, inputs, textarea, dialog are `ui/` components. Only app-specific layout that has no shadcn counterpart — sidebar rows, repo headers, the terminal pane chrome — is hand-styled in `app.css`.
- **One base palette drives everything (see `THEMING.md`).** Colors resolve from a semantic `--base-*` palette (`:root` in `app.css`): both the shadcn tokens (`--background`, `--primary`, `--border`, … in `.dark`) and the bespoke `--app-*` tokens are defined as `var(--base-*)`. So **change a color in ONE place — the `--base-*` var** (or a `[data-theme]` override block); never re-hardcode a hex in `.dark`, `--app-*`, or a component. A theme = overriding `--base-*` under `[data-theme="<id>"]`, selected via `stores.ts › theme` → `<html data-theme>`. Still NEVER reuse a shadcn token *name* for app styling — name collisions corrupt `ui/` components; that's why the bespoke layer uses the `--app-*` namespace.
- **App CSS lives in `@layer components`** (`app.css`) so Tailwind's `utilities` layer always wins for shadcn primitives. The only deliberately-unlayered element selectors are at the foot of `app.css`: (1) the `cursor` rules (`input,textarea,[contenteditable] { cursor:text }` / `button:not(:disabled),a,[role=button],… { cursor:pointer }`), which must reach `<button data-slot="button">` to set the right cursor and set only `cursor` so the bleed is wanted; and (2) `[data-slot="button"]:active { translate:none; transform:none }`, which cancels the shadcn Button base's `active:translate-y-px` press-down nudge app-wide (it's an `@layer utilities` rule, so only an unlayered rule beats it). Any OTHER element selector belongs in `@layer components`, or it bleeds onto shadcn primitives.
- Dark mode is on via `class="dark"` on `<html>` (`index.html`). For new UI, prefer shadcn primitives + Tailwind utilities/shadcn tokens (`bg-background`, `text-foreground`, `border-border`) over new `--app-*` vars.
- **Scoped `<style>` vs `app.css` — split by REACH, not habit.** A rule that only dresses ONE component's own DOM lives in that component's scoped `<style>` block (the precedent: `DiffView`'s `.diff` lines, `GitPanel`'s `.git-*`, `UsageIndicator`'s `.usage-chip`, `Fleet`'s `.fleet-*`). Only styles that are SHARED across components, themed via `--app-*`/`--base-*`, or target a global structure (sidebar rows, the icon-chrome button) belong in `app.css`'s `@layer components`. Don't bloat the global sheet with a one-component cosmetic rule, and don't fork a shared class into a per-component `<style>`. Reach for Tailwind utilities + shadcn tokens first; a `<style>` block is for the structural CSS utilities can't express cleanly.

## Conventions — TypeScript

- DO route every IPC call through `api.ts` with a generic-typed `invoke<T>()`; DON'T scatter raw `invoke("...")` / `listen()` in components.
- DO type every boundary explicitly (`Worktree`, `GitStatus`, the event envelopes); DON'T return bare `any` or untyped objects across IPC.
- DO confine each unavoidable cast to one line with a WHY comment; DON'T sprinkle untracked casts. Keep control flow explicit and greppable — prefer a named helper over an inline trick.
- DO keep `??` fallbacks on per-worktree map reads (`w.branch ?? '(detached)'`); a missing field must render nothing, never throw.
- DO write comments that explain WHY (the non-obvious invariant); DON'T add WHAT comments restating the code.

## Conventions — Svelte (v5)

- DO write **every** component with runes (`$state`, `$derived`, `$props`, `$effect`) + snippets. The runes migration is **complete** — there is no remaining legacy syntax (`export let`/`$:`/`<slot>`/`on:`) anywhere; keep it that way, never reintroduce it.
- **Component shape is fixed — copy it, don't improvise.** Declare props with an **inline type**, never a separate `interface Props`: `let { foo, bar }: { foo: string; bar?: Snippet } = $props()`. (Only `ui/*` differ — they use the `WithElementRef`/`WithoutChildren` type helpers; match those when editing a `ui/*` file.) Bind native events with the lowercase `on*` form (`onclick`, `onkeydown`) — never legacy `on:click`; name your own callback props `onFoo` to mirror bits-ui (`onValueChange`, `onOpenChange`). Read stores reactively with `$store` auto-subscription in markup/`$derived`/`$effect`; reserve `get(store)` for one-shot **non-reactive** reads (onMount setup, inside an event handler). Order every component's `<script>`: imports → props → `$state` → `$derived` → `$effect` → functions, then markup.
- **State location is fixed by lifetime — don't improvise.** Cross-component or persisted state lives in the store modules as a `writable` + **named mutator functions**; components call the mutators (`setStatus`, `setMainView`, `selectWorktree`, …), not `.set()/.update()` inline — this holds even for small UI toggles (`toggleSidebar`, `toggleShell`). The store layer is SPLIT by subsystem (`stores.ts` state + `session.ts` orchestration + `persist.ts`) but `stores.ts` re-exports everything — components import ONLY from `stores`. session.ts and stores.ts import each other (a deliberate ESM cycle): cross-module access must stay CALL-time only, `createWorktreeMap` must stay a hoisted `function` declaration, and its `.active()` builds its derived lazily — see the CIRCULAR-IMPORT CONTRACT comments before touching that seam. Ephemeral single-component UI state (input text, open/closed flags) stays local (`$state`/`let`). Don't promote ephemeral state into a store or drill shared state through props. New per-worktree state is a `createWorktreeMap<T>` (+ `persistKey` if it persists), never a fresh `writable<Record<…>>` trio — that factory IS the template.
- **A no-op mutation must preserve map identity.** When a mutator can be a no-op (clearing already-empty state, setting an unchanged value), return the **same map object** instead of a fresh `{...m}` — copy the guard in `clearUnread`/`clearReviewQueue`/`createWorktreeMap.remove` (`return m` when nothing changed). What this buys: it skips the per-event allocation **and** stops downstream **derived** stores that resolve to a primitive/`null` (`activeGitStat`, …) from re-propagating. What it does NOT buy: it does not silence a `writable`'s own subscribers — svelte's `safe_not_equal` flags every object value as changed, so direct `$store` readers and object/array-returning deriveds still re-run on a same-identity set. So it's a real allocation + primitive-derived-render saver, not a "fires no subscribers" guarantee. Both the identity contract and this limitation are pinned by `stores.test.ts`; don't downgrade a guard to a blind `{...m}`.
- **Persisted state follows ONE template** (every `trickshot.*` store, built on `persist.ts › createPersisted`): a `load()` that JSON-parses with a shape guard and falls back on error → `writable(load())` → a `.subscribe()` that writes back inside `try/catch` (swallow quota errors) under a `trickshot.<name>` key. Copy it exactly; never ship a persisted store that skips the validation or the quota guard. When a persisted store is RETIRED, add its key to `persist.ts › purgeRetiredKeys` so stale data doesn't rot in localStorage.
- **IPC command rejections** (Rust returns `Err(String)`) → catch and set a **local `error` state** in that component (the Worktrees pattern). PTY-level failures surface inside the terminal itself (the `[terminal not connected]` line). Don't invent new error surfaces.
- **NO TypeScript casts in markup expressions.** `as any` / `as Foo` belong only inside `<script>`. Never write a cast inside a `{...}` template expression — compute it in a `$derived` value or a `<script>` const first. This is a hard compile error: the Svelte template parser is not TypeScript.

## Conventions — Rust

- DO register every new command in BOTH its module AND the `tauri::generate_handler![]` list in `lib.rs` — unlisted commands are not callable from `invoke()`.
- DO return `Result<_, String>` and `map_err(|e| e.to_string())` — errors propagate to the UI by convention, not exceptions.
- DO build per-worktree process maps on the shared `WorktreeMap<T>` (`worktree_map.rs`) — one entry per worktree path, running concurrently; it provides the poison-safe `lock()` (never `.lock().unwrap()`), the `WorktreeEvent` envelope, and `next_generation()` for the respawn-identity check (a stale reader/waiter must never remove its successor's entry). `run_script`/`term_open` are idempotent-or-replace per worktree and hold the lock across the check/spawn/insert so two calls can't double-spawn. Blocking pipe/PTY writes happen on the per-entry `Arc<Mutex<…>>`, NOT under the whole-map lock. Keep `lib.rs`'s `RunEvent::ExitRequested`/`Exit` handler that kills all scripts/PTYs on quit — without it you orphan dev servers and claude CLIs.
- DO mark subprocess/network-bound commands `async fn` + `tauri::async_runtime::spawn_blocking` (the worktree.rs/github.rs/usage.rs shape) — a sync command runs on the main thread and a slow `git push` freezes the whole app.
- DO keep the worktree dir scheme `../.<repo>-worktrees/<branch>` and the "base_ref cannot be applied to an existing branch" loud-fail in `create_worktree` if you touch it.

## Conventions — Testing

Test **pure, deterministic logic**; don't test I/O, UI, or a live CLI. The bar is "branchy logic that would silently break" — parsers, trackers, formatters.

- DO colocate a `*.test.ts` next to the module and run it with `bun test`. The existing set IS the template: `cliActivity.test.ts` (the busy/idle tracker), `ansi.test.ts` (the SGR parser), `review.test.ts` (the review-prompt formatter), `termProfiles.test.ts`, `stores.test.ts` (the identity-guard contract). Extend the matching file when you touch that logic; add a sibling `*.test.ts` for a new pure module.
- DO put the cross-process "do these hand-mirrored seams still line up?" checks in `src/lib/conformance.test.ts` (the ONE home for them) — it reads source/docs as text and asserts the command/envelope/theme/font seams that have no compiler link. It's the exception to "test pure logic only": it guards the SYNC RULE so drift fails CI instead of production. Extend it (don't fork a parallel checker) when you add a seam that the compiler can't see.
- DO put Rust parser/helper tests in an inline `#[cfg(test)] mod tests` in the same file (see `worktree.rs`'s git status/diff parsers, `agent.rs`'s session-store scan), run by `cargo test`.
- DON'T write tests for Svelte components, `api.ts` IPC plumbing, Rust command wiring, or anything that needs a running `claude` binary — those are covered by the typecheck/clippy gates and the CI prod-build job, not unit tests.

## PERFORMANCE (first-class)

The hot path is the PTY stream (a TUI repainting at full rate) and bursty script output. Preserve these; they are load-bearing, not optional.

- **The PTY round-trip stays thin.** `term-event` data goes straight into the cached xterm instance (`terminal.ts › handleTermEvent`) — no parsing, no store writes per chunk. The only per-chunk work besides `term.write()` is `noteCliActivity`'s O(1) tracker update. Don't add per-chunk allocation, regex, or store traffic on this path.
- **Batch script output.** `scriptEvents.ts` coalesces a chatty build log into ONE `scriptRunByWorktree` store write per 16ms window (`setTimeout`, not rAF, so backgrounded windows still flush), and the run store keeps a BOUNDED tail (2000 lines). Keep both.
- **Rust relays do ZERO work per chunk.** PTY output and script lines are emitted as-is in the `WorktreeEvent` envelope — no per-chunk transform beyond UTF-8 boundary handling. Parsing belongs to the webview consumer.
- **Fit/resize is debounced and veiled.** `attachTerminal` coalesces ResizeObserver bursts into one fit after the pane settles (the resize veil masks the reflow) and rAF-coalesces fits; the settle/boot loops exist because xterm's metrics lie before the renderer measures the font. Don't fit synchronously in an observer callback — it thrashes layout.
- **Measure before tuning** the 16ms window, the CLI idle threshold (`cliActivity.ts › CLI_IDLE_MS`), or the script-tail cap — profile a real TUI repaint burst and a chatty dev server, not a hello-world.

## Build / run

```
bun install            # install deps
bun run dev            # tauri dev (frontend hot-reloads)
bun run build          # release
bun run check          # svelte-check typecheck (webview, src/** only)
bun run test           # bun test (TS unit tests); Rust units run via `cargo test` in src-tauri
bun run lint           # Biome lint + format check (TS/JS/JSON; `.svelte` is covered by svelte-check, not Biome)
bun run format         # Biome autofix + format
```

CI (`.github/workflows/ci.yml`) runs three jobs on every push/PR. **frontend:** `lint` + `check` + `bun test`. **rust:** `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` (warnings fail; `--all-targets` lints tests too) + `cargo test`. **build:** compiles the frontend + app crate together so a capability/prod-build break can't slip through. This is the safety net for the hand-mirrored command/envelope seams — keep `cargo fmt`-clean and Biome-clean before pushing. Biome's `noExplicitAny`/`noAssignInExpressions`/`noNonNullAssertion`/`useTemplate` are intentionally **off** (`biome.json`) because the codebase uses those idioms deliberately — don't re-enable without auditing the call sites. TS `noUncheckedIndexedAccess` is **on**: per-worktree `Record<string,…>` reads are `T | undefined`, so keep the `?? fallback`.

## Gotchas

- **Auth/config is the user's own Claude Code.** The chat runs the user's PATH-installed `claude` with their own login, permission settings, MCP config, and CLAUDE.md files. There is NO API key in this app and no per-session config plumbing — don't add either. `check_cli` (binary on PATH?) and `check_auth` (credentials exist?) are the onboarding probes.
- **The claude-slot PTY key is a hand-mirrored pair.** `terminal.rs › CLAUDE_SLOT` (Rust) and `terminal.ts › claudeTermKey` (TS) both define `worktree + "\u0000claude"` (NUL can't occur in a path, so the composite key can't collide). Change one, change both.
- **Resume forks.** Claude Code's `--resume` mints a NEW session id, so the app never persists one — every open scans for the newest `.jsonl` via `latest_session_id`. Don't reintroduce a persisted session id; it goes stale on first use.
- **No auto-respawn on CLI exit.** `handleCliExit` marks the session `stopped`; typing into the pane or re-activating the worktree revives it. Auto-reopen would fork-bomb on a crash-looping CLI.
- **Injected prompts must not read as turns starting.** `sendToCli` wraps text in bracketed paste AND calls `noteCliInput` first — the echo of injected keystrokes would otherwise light the busy indicator (see `cliActivity.ts`). Any new "hand text to the agent" feature goes through `submitTurnToChat`, never raw `termWrite`.
- **Busy detection is heuristic.** `cliActivity.ts` infers busy/idle from output flow, with mutes bridging known non-turn bursts (the resume boot paint, the reload repaint wiggle — see `ensureClaudeOpen`). If you add a new programmatic burst source, mute it (`muteCliActivity`) or it shows a phantom "working…" dot.
- **CSP is set, not null.** `tauri.conf.json`'s `app.security.csp` is a restrictive policy (the webview is local-only). It's a tripwire: if you render external content as HTML, keep it escaped/sanitized. If you tighten the CSP further, re-verify the window renders with `bun run dev` (a wrong directive white-screens the app).
- **Persistence.** Repos, selected worktree, per-worktree provider, theme, font, terminal font size, uniform type, commit mode, the subscription usage cache, the review queue, and archived workspaces persist to `localStorage` (keys `trickshot.*` — grep `trickshot.` for the full set). Chat history is NOT app state — it lives in Claude Code's own session store (`~/.claude/projects/<encoded path>/`), which is also what makes archive→restore resume the conversation (the store is keyed by worktree path and the path scheme is deterministic). Worktree lists are repopulated from git (`list_worktrees`) on launch — git is the source of truth, not a persisted list. Retired keys are purged on launch (`persist.ts › purgeRetiredKeys`).
- **macOS packaging:** no embedded binaries or JIT entitlements — the app ships no external binary; the CLI is the user's own install.
