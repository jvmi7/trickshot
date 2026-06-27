# trickshot

Desktop GUI for the Claude Agent SDK. Tauri 2 (Rust core) + Svelte 5 / TypeScript webview (UI styled with Tailwind v4 + shadcn-svelte) + a Bun-compiled sidecar that wraps `@anthropic-ai/claude-agent-sdk`. Three processes, one newline-delimited-JSON event stream. Package manager is **bun** (`bun.lock`) — never npm/yarn. The `$lib` alias maps to `src/lib`.

Goals for any change here, in priority order: (1) clean, consistent code; (2) organized so an LLM can locate and reason about any concern from one file; (3) **performance is first-class** — see the dedicated section.

## Consistency & cohesion (the prime directive)

Goal #1 means: **one pattern per concern, applied predictably.** A *second* way to do something the codebase already does is the main source of bugs here — don't introduce one. Before writing code:

1. **Find the concern's home** in *Where things live* and put the code there. Never create a parallel location — a second IPC entry point, a second SDK-parsing site, a stray `localStorage` key, a one-off error toast.
2. **Reuse the existing primitive/helper; extend, don't fork.** shadcn `ui/*` for UI, `api.ts` for IPC, `agentMessage.ts` for tool-label helpers, `Collapsible` for big text, store mutators for state. If one *almost* fits, widen it — don't add a near-duplicate beside it.
3. **Match the file you're editing** — same syntax mode (runes vs legacy), same error path, same naming. Don't leave two patterns side-by-side in one file.
4. **Copy the established shape** when adding to a known category (a new IPC command, a persisted store, a protocol `kind`, a themed token) — replicate the existing template in that section *including its guards* (try/catch, `??` fallbacks, the SYNC RULE), not a fresh variant.
5. **Prefer the boring, explicit, greppable option** — a named helper over an inline trick. No clever one-offs.

If a genuinely new pattern is unavoidable, say so explicitly in your reasoning and apply it to **every** instance of that concern — never half-migrate, leaving two patterns where there was one.

## Architecture (3 processes, one stream)

```
Svelte webview (Vite)
  -> src/lib/api.ts          (Tauri IPC: invoke<T>() / listen())
  -> Rust core (src-tauri)   agent.rs runs ONE sidecar per worktree (concurrent); worktree.rs shells git
  -> Bun sidecar PER WORKTREE   core.ts (neutral transport) -> providers/<id>.ts (adapter)
  -> native `claude` binary  -> Anthropic API
```

- **Provider-pluggable.** The sidecar speaks a provider-neutral protocol: `core.ts` is transport; a provider adapter (`sidecar/providers/<id>.ts`, default `claude`) runs the agent loop and maps native events into the neutral `AgentMessage` schema. The whole UI + protocol is Claude-agnostic; adding a provider is a new adapter, not a UI/protocol change.

- **One agent session per worktree, running concurrently.** Selecting a worktree starts its session (idempotent); sessions keep running when you switch. No global start/stop — a worktree just *has* an agent.
- Rust <-> sidecar: **newline-delimited JSON over stdin/stdout**. Rust relays bytes opaquely (no parsing).
- Rust -> webview: a single `agent-event` Tauri event **tagged with its worktree** (`{ worktree, kind, data }`) so the UI routes each to the right transcript.
- Full detail and the protocol/command tables live in `ARCHITECTURE.md`.

## Cross-process contract + SYNC RULE (most important)

The line-delimited JSON protocol (`Inbound` / `Outbound` `kind` unions) plus the worktree-tagged event envelope are **hand-mirrored across places**. The two TypeScript ends now share ONE source of truth; only the link to Rust is hand-mirrored:
- `shared/protocol.ts` — the **single** TS source of truth for the wire unions (`Inbound`/`Outbound`/`AgentMessage`/`ModelInfo`), all **provider-neutral** (nothing Claude-specific). Imported by BOTH ends so the two TS mirrors can't drift:
  - `src/lib/types.ts` re-exports them verbatim (the strict `AgentMessage` on `Outbound`'s message) and adds the app-only `Worktree`/`Repo`/`AgentEnvelope` (the last mirrors the Rust `AgentEvent` struct field-for-field).
  - `sidecar/core.ts` imports them (binding `Outbound`'s message to the SDK's own `SDKMessage`) + does by-hand `cmd.kind` parsing.
- `src-tauri/src/agent.rs` — the `AgentEvent { worktree, kind, data }` struct emitted on `agent-event`. **No compiler link to the TS side — still hand-mirrored.**
- `ARCHITECTURE.md` — the human-readable protocol + command tables.

**When you add or change a `kind`, payload, or the event envelope, edit `shared/protocol.ts`, the Rust struct (if the envelope changes), and `ARCHITECTURE.md` in the SAME commit.** A one-sided edit toward Rust is silently ignored: `api.ts` swallows unparseable stdout lines, so nothing throws — it just breaks. Both TS ends are now typechecked in CI (`check` for the webview, `check:sidecar` for the sidecar+shared) and `core.ts`'s dispatch + `App.svelte`'s consumer have `never` exhaustiveness guards, so an unhandled new `kind` is a COMPILE error on the TS side; the Rust ↔ TS match is still on you.

Boundary arg casing (deliberate asymmetry, matches Tauri serde defaults):
- Command **args are camelCase** (`repoPath`, `worktree`, `worktreePath`, `baseRef`, `payload`); Rust commands declare them snake_case and Tauri maps automatically.
- Command **results are snake_case** (`Worktree.is_main`, `w.branch`) — mirror the Rust struct exactly, do not rename to camelCase.

## Where things live

| Concern | File |
|---|---|
| IPC surface (the only one) | `src/lib/api.ts` |
| Wire protocol unions, provider-neutral (`Inbound`/`Outbound`/`AgentMessage`/`ModelInfo`) | `shared/protocol.ts` |
| Protocol re-export + app-side types (`TranscriptMessage`/`Worktree`/`Repo`/`AgentEnvelope`) | `src/lib/types.ts` |
| Per-worktree state: persisted repos, worktrees, selection, session status, etc. — each a `createWorktreeMap<T>` (store + `set`/`update`/`remove`/`active`, optionally persisted) | `src/lib/stores.ts` |
| Transcript engine: per-worktree message log — batched `appendMessage`, persistence, windowing, tool-call grouping | `src/lib/transcript.ts` (re-exported via `stores.ts`) |
| Agent-event router: the central reducer over the sidecar stream (`handleAgentEvent`/`handleSessionStatus`) | `src/lib/agentEvents.ts` (wired in `App.svelte`) |
| UI components (one per concern) | `src/lib/components/*.svelte` |
| Tool-label helpers for the loading footer | `src/lib/agentMessage.ts` |
| Neutral `AgentMessage` rendering (branches on `type`) | `src/lib/components/Message.svelte` |
| Sidecar transport (provider-neutral; frames JSON, dispatches `Inbound`) | `sidecar/core.ts` |
| Provider adapters (agent loop + native→neutral mapping, one per provider) | `sidecar/providers/*.ts` |
| Large-text truncation | `src/lib/components/Collapsible.svelte` |
| Global header (slots: `title`/`left`/`actions` + sidebar toggle) | `src/lib/components/Header.svelte` |
| shadcn-svelte primitives (the UI building blocks) | `src/lib/components/ui/` |
| `cn()` + shadcn type helpers | `src/lib/utils.ts` |
| shadcn config (aliases, base color) | `components.json` |
| Git review (status/diff/stage/commit/push/merge) | `src-tauri/src/worktree.rs` (commands) + `src/lib/components/GitPanel.svelte` + `DiffView.svelte` (Chat/Changes toggle in `App.svelte`) |
| Rust commands: agent lifecycle / git worktrees | `src-tauri/src/agent.rs`, `worktree.rs` |
| Rust command registry (`generate_handler!`) | `src-tauri/src/lib.rs` |
| Permission scope (shell:allow-spawn, sidecar, notification) | `src-tauri/capabilities/default.json` |
| Notifications & background fleet (unread/pending badges) | `notify` command (`agent.rs`) + `api.notify` + `unreadByWorktree`/`pendingPermission` stores + `Worktrees.svelte` badges; Notification hook → `notification` event in `App.svelte` |
| Agent → user questions (provider-neutral) | `question_request`/`question_reply` (`shared/protocol.ts`) + `QuestionModal.svelte` + `pendingQuestion`/`activeQuestion` stores + `api.replyQuestion`; Claude raises via the built-in `ask_user` SDK MCP tool in `providers/claude.ts` (built-in `AskUserQuestion` disallowed). A new provider emits the SAME `question_request` |
| Sidecar/bundle config | `src-tauri/tauri.conf.json` |
| Thin per-platform embed shims (~6-7 lines each) | `sidecar/agent.<platform>.ts` |
| Sidecar compile script | `scripts/build-sidecar.sh` |

`src/lib/api.ts` is the **sole hook layer.** Components import `* as api` and call `pickDirectory` / `startSession` / `sendUserTurn(worktree, …)` / `onAgentEvent` etc. **Never** import or call `invoke()` (`@tauri-apps/api/core`) or `listen()` (`@tauri-apps/api/event`) directly in a `.svelte` file — add a new typed wrapper to `api.ts` first. Its header says `THIS IS THE PRIMARY HOOK POINT`.

## Component Library — shadcn FIRST, ALWAYS (hard rule)

**Any time you build, touch, or introduce UI, shadcn-svelte is the default — not a fallback.** Never hand-write a button, input, select, dialog, dropdown, popover, tooltip, etc. when shadcn provides it. UI is composed from small, generic primitives — never large, hyper-specialized components. Before writing a single line of new markup, walk these steps IN ORDER and stop at the first hit:

1. **Reuse `src/lib/components/ui/`** — if the primitive is already vendored locally, use it. Import via `$lib/components/ui/<name>` + `cn()` from `$lib/utils`.
2. **Check the shadcn-svelte registry** — if it's NOT local, assume it exists upstream and pull it in instead of hand-writing: `bunx shadcn-svelte@latest add <name> -y` (catalog: https://shadcn-svelte.com/docs/components). It lands in `ui/<name>/` (and auto-adds any deps it needs). This is the expected path for new primitives — adding a registry component is preferred over writing your own.
3. **Only then hand-build** — and only if the registry genuinely has no equivalent. Build it as a small, generic, reusable primitive in `ui/` (wrapping `bits-ui`, themed via tokens), NOT a one-off monolith. Treat this as the rare exception and say so in your reasoning.

> shadcn-svelte components are thin styled wrappers over `bits-ui` (the headless primitive layer, like Radix for React). "Use shadcn" and "use bits-ui" are the same stack — the registry component imports `bits-ui` for you. So reach for the shadcn registry, not raw `bits-ui`, unless you're deliberately authoring a new `ui/` primitive.

- Primitives are building blocks (`Button`, `Dialog`, `Input`), kept generic; feature components in `src/lib/components/` compose them. Import via `$lib/components/ui/<name>` + `cn()` from `$lib/utils`.
- **Animations: the `data-open`/`data-closed` variant fix is load-bearing.** Generated `ui/*` components animate via `data-open:`/`data-closed:` utilities, but the installed bits-ui (2.18.1, latest) stamps `data-state="open"/"closed"` — a naming mismatch that makes open/close animations silently no-op. `app.css` defines `@custom-variant data-open`/`data-closed` mapping BOTH spellings, so animations work. Keep those variants when editing `app.css`; if a newly added component still won't animate, that mapping is the first thing to check.
- `ui/*` are Svelte 5 + `tailwind-variants` + `bits-ui`. Don't hand-edit them cosmetically (`add -o` overwrites them); theme via tokens, not per-component edits. Setup lives in `components.json` + `$lib/utils.ts`.

## Icons — Lucide ONLY (hard rule)

**Every icon comes from [Lucide](https://lucide.dev/icons/) (`@lucide/svelte`), the same set shadcn-svelte ships with.** Import per-icon and render as a component: `import House from "@lucide/svelte/icons/house";` then `<House class="size-4" />`. They're SVGs — size with `size-*` (or width/height); they inherit `currentColor`. Icon names are kebab-case (e.g. `panel-left`, `chevron-down`, `arrow-up`); some are renamed (`home` → `house`). Browse at lucide.dev or `ls node_modules/@lucide/svelte/dist/icons/`.

- **NO other icon library, ever** (no `lineicons`, `@phosphor-icons/*`, etc.) and **no hand-rolled inline `<svg>` icons** in app components — find the closest Lucide glyph instead. Both were removed deliberately; don't reintroduce them.
- This is the icon set shadcn registry components already use, so newly `add`ed `ui/*` components need no icon rewrite. Currently used: dialog close (`x`), select (`check`, `chevron-down/up`), sidebar toggle (`panel-left`), settings (`settings`), composer (`pause`, `arrow-up`), worktree home (`house`).
- The floating titlebar icon button (the sidebar toggle) is `HeaderIconButton.svelte` (`.header-icon-btn`, which sizes its `svg`) — a fixed-position wrapper over `IconButton`; reuse it for any other floating titlebar icon. (The settings entry now lives as a sidebar-foot `Button`, not a floating icon.)

## Styling (Tailwind v4)

- **The interactive UI is shadcn primitives.** Buttons, inputs, textarea, dialog, collapsible are `ui/` components (Button/Input/Textarea/Dialog/Collapsible). Only app-specific layout that has no shadcn counterpart — sidebar rows, repo headers, chat message bubbles — is hand-styled in `app.css`.
- **One base palette drives everything (see `THEMING.md`).** Colors resolve from a semantic `--base-*` palette (`:root` in `app.css`): both the shadcn tokens (`--background`, `--primary`, `--border`, … in `.dark`) and the bespoke `--app-*` tokens are defined as `var(--base-*)`. So **change a color in ONE place — the `--base-*` var** (or a `[data-theme]` override block); never re-hardcode a hex in `.dark`, `--app-*`, or a component. A theme = overriding `--base-*` under `[data-theme="<id>"]`, selected via `stores.ts › theme` → `<html data-theme>`. Still NEVER reuse a shadcn token *name* for app styling — name collisions corrupt `ui/` components; that's why the bespoke layer uses the `--app-*` namespace.
- **App CSS lives in `@layer components`** (`app.css`) so Tailwind's `utilities` layer always wins for shadcn primitives. There are currently NO element selectors (the bare `button {}`/`input,textarea {}` rules were removed when the UI went all-shadcn) — if you add one, keep it in this layer or it bleeds onto `<button data-slot="button">`.
- Dark mode is on via `class="dark"` on `<html>` (`index.html`). For new UI, prefer shadcn primitives + Tailwind utilities/shadcn tokens (`bg-background`, `text-foreground`, `border-border`) over new `--app-*` vars.

## Conventions — TypeScript

- DO route every IPC call through `api.ts` with a generic-typed `invoke<T>()`; DON'T scatter raw `invoke("...")` / `listen()` in components.
- DO type every boundary explicitly (the `Inbound`/`Outbound` unions, `Worktree`); DON'T return bare `any` or untyped objects across IPC.
- DO confine each unavoidable cast to one line with a WHY comment (e.g. `(q as any).interrupt`); DON'T sprinkle untracked casts. Keep control flow explicit and greppable — prefer a named helper over an inline trick.
- DO keep the UI on the **neutral `AgentMessage` schema** (`shared/protocol.ts`) — NEVER parse a provider's raw message shape in the webview. Mapping native→neutral happens in the provider adapter (`sidecar/providers/<id>.ts`); `Message.svelte` branches on the neutral `type` (`assistant`/`tool_call`/`tool_result`/`system`/`turn_end`, plus the UI-only `user_local`/`error` bubbles) and renders nothing for an unknown type. Tool-label helpers for the loading footer live in `src/lib/agentMessage.ts`. Keep `??` fallbacks (`w.branch ?? '(detached)'`); a missing field must render nothing, never throw.
- DO write comments that explain WHY (the non-obvious invariant); DON'T add WHAT comments restating the code.

## Conventions — Svelte (v5)

- DO write **every NEW** component with runes (`$state`, `$derived`, `$props`, `$effect`) + snippets — never template a new component off a legacy one. Legacy syntax (`export let`, `$:`, `<slot>`) is **debt, not an equal option**: the target is 100% runes. When you edit a legacy file, convert the whole file to runes in that pass if it's small; otherwise match its existing mode for a minimal edit. NEVER mix runes and legacy in ONE component. Track progress in the migration list below.
- **Migration tracker.** The migration is **complete — every component (and `App.svelte`) is runes**: `App`, `Settings`, `SettingsAppearance`, `SettingsConnectors`, `ModelSelector`, `LoadingState`, `PermissionModal`, `QuestionModal`, `ScrollIndicator`, `HeaderIconButton`, `Header` (snippet props), `Worktrees`, `Composer`, `Chat`, `Collapsible`, `Message`, `Markdown`, `ToolActivity`, `ToolGroup`, and all `ui/*`. There is no remaining legacy syntax (`export let`/`$:`/`<slot>`/`on:`) anywhere — keep it that way; never reintroduce it.
- **Component shape is fixed — copy it, don't improvise.** Declare props with an **inline type**, never a separate `interface Props`: `let { foo, bar }: { foo: string; bar?: Snippet } = $props()`. (Only `ui/*` differ — they use the `WithElementRef`/`WithoutChildren` type helpers; match those when editing a `ui/*` file.) Bind native events with the lowercase `on*` form (`onclick`, `onkeydown`) — never legacy `on:click`; name your own callback props `onFoo` to mirror bits-ui (`onValueChange`, `onOpenChange`). Read stores reactively with `$store` auto-subscription in markup/`$derived`/`$effect`; reserve `get(store)` for one-shot **non-reactive** reads (onMount setup, inside an event handler). Order every component's `<script>`: imports → props → `$state` → `$derived` → `$effect` → functions, then markup.
- DO route all transcript writes through `stores.appendMessage(worktree, msg)` / `resetTranscript(worktree)` (they assign the stable `__key` and batch per worktree). DON'T mutate the `transcripts` map directly — `resetTranscript` also drops the un-flushed buffer so a recreated worktree can't inherit stale messages.
- DO render the user's own turn optimistically with `appendMessage(wt, { type: 'user_local', text })` before/alongside `api.sendUserTurn(wt, t)`. DON'T invent a new echo type — `user_local` is the UI-only "you" bubble, distinct from the SDK's own tool-result `user` messages.
- DO render any large/unbounded text (tool inputs, tool results, file reads) through `Collapsible.svelte` (truncates to `max`, default 2000 chars, with a reveal toggle). DON'T dump raw `<pre>{text}</pre>`.
- **State location is fixed by lifetime — don't improvise.** Cross-component or persisted state lives in `stores.ts` as a `writable` + **named mutator functions**; components call the mutators (`setStatus`, `setWorktreeModel`, …), not `.set()/.update()` inline. (The inline `.update()`s in `Worktrees` are legacy — add a mutator for new state.) Ephemeral single-component UI state (input text, open/closed flags) stays local (`$state`/`let`). Don't promote ephemeral state into a store or drill shared state through props. New per-worktree state is a `createWorktreeMap<T>` (+ `persistKey` if it persists), never a fresh `writable<Record<…>>` trio — that factory IS the template.
- **A no-op mutation must fire no subscribers.** When a mutator can be a no-op (clearing already-empty state, setting an unchanged value), return the **same map identity** instead of a fresh `{...m}` — copy the guard in `clearUnread`/`setActivity`/`clearSuggestions`/`setWorktreeSession` (`return m` when nothing changed). A blind `{...m}` re-render on every event is the bug this prevents; it's correctness + perf, not optional.
- **Persisted state follows ONE template** (every `trickshot.*` store in `stores.ts`): a `load()` that JSON-parses with a shape guard and falls back on error → `writable(load())` → a `.subscribe()` that writes back inside `try/catch` (swallow quota errors) under a `trickshot.<name>` key. Copy it exactly; never ship a persisted store that skips the validation or the quota guard.
- **Two error paths, one rule each — never cross them.** (a) An IPC **command** rejection (Rust returns `Err(String)`) → catch it and set a **local `error` state** in that component (the Worktrees pattern). (b) An **agent/sidecar stream** error (an `{kind:'error'}` Outbound, or a session `terminated`/`error`) → `appendMessage(wt, { type:'error', error })` so it lands in the transcript (the App.svelte pattern). The path is chosen by the error's *source*, not by convenience — don't push a command error into the transcript or swallow a stream error into local state.
- **NO TypeScript casts in markup expressions.** `as any` / `as Foo` belong only inside `<script>`. Never write a cast inside a `{...}` template expression — compute it in a `$derived` (or legacy `$:`) value or a `<script>` const first. This is a hard compile error: the Svelte template parser is not TypeScript.

## Conventions — Rust

- DO register every new command in BOTH its module (`agent.rs` / `worktree.rs`) AND the `tauri::generate_handler![]` list in `lib.rs` — unlisted commands are not callable from `invoke()`.
- DO keep the sidecar-spawn capability: the `binaries/agent` entry in `capabilities/default.json` (`shell:allow-spawn`, `sidecar:true`). The app uses `.spawn()`, not `.execute()`; dropping that entry breaks `start_session`.
- DO return `Result<_, String>` and `map_err(|e| e.to_string())` — errors propagate to the UI by convention, not exceptions.
- DO keep `Sessions` as `Mutex<HashMap<String, CommandChild>>` — one sidecar per worktree path, running concurrently. `start_session` is idempotent per worktree (holds the lock across the contains-key/spawn/insert so two calls can't double-spawn); the reader task removes the key on ANY loop exit; `stop_session` removes+kills. Lock via the poison-safe `Sessions::lock` helper, never `.lock().unwrap()`. Keep `lib.rs`'s `RunEvent::ExitRequested`/`Exit` handler that kills all sidecars on quit — without it you orphan ~279MB processes.
- DO keep the worktree dir scheme `../.<repo>-worktrees/<branch>` and the "base_ref cannot be applied to an existing branch" loud-fail in `create_worktree` if you touch it.

## Conventions — Testing

Test **pure, deterministic logic**; don't test I/O, UI, or the live agent loop. The bar is "branchy logic that would silently break" — parsers, reducers, native→neutral mappers, the transcript engine.

- DO colocate a `*.test.ts` next to the module and run it with `bun test`. The existing set IS the template: `transcript.test.ts` (batching/windowing/grouping), `agentEvents.test.ts` (the event reducer), `sidecar/providers/claude.test.ts` (the `claudeMapping` native→neutral conversion + `claudeSuggest`). Extend the matching file when you touch that logic; add a sibling `*.test.ts` for a new pure module.
- DO put Rust parser/helper tests in an inline `#[cfg(test)] mod tests` in the same file (see `worktree.rs`'s git status/diff parsers), run by `cargo test`.
- DON'T write tests for Svelte components, `api.ts` IPC plumbing, Rust command wiring, or anything that needs a running sidecar/`claude` binary — those are covered by the typecheck/clippy gates and the CI prod-build job, not unit tests.

## PERFORMANCE (first-class)

The hot path is bursty, data-dependent streaming (big tool results). Preserve these; they are load-bearing, not optional.

- **Batch transcript appends.** All appends go through `appendMessage(worktree, msg)`, which buffers per worktree and coalesces a burst into ONE `transcripts` store write per 16ms via `setTimeout` (across all concurrent worktrees). DON'T write the `transcripts` map per message from `onAgentEvent` — a 200-line tool-result burst must be one render, not 200. `setTimeout` (not `requestAnimationFrame`) is deliberate so backgrounded windows still flush.
- **Keep the `{#each}` identity-keyed.** Chat renders `renderedGroups` (the windowed tail `renderedMessages` collapsed so consecutive tool calls batch into one `ToolGroup` — see stores), keyed `(g.key)` where the key is the run's first `__key`; `ToolGroup`'s inner `{#each tools (m.__key)}` is keyed too. Messages are appended immutably, so this two-level identity keying still reconciles only new nodes (appending a tool call grows the open run and adds one row). Never switch to index keying or drop the key — it forces a re-diff per append.
- **Per-flush array copy (known tradeoff).** `flush()` rebuilds the `transcripts` map and `concat`s each touched worktree's batch — O(total transcript) per flush. Acceptable at the ~hundreds-of-messages ceiling; if you raise it, switch to in-place push + reassign (or windowing) FIRST.
- **Work in markup (known tradeoff).** `ToolActivity.svelte` stringifies a tool call's input via `const inputJson = $derived(JSON.stringify(m.input, null, 2))` — recomputed only when `m` changes, but still a full stringify per pass for the expandable input block. Acceptable now (the result is routed through `Collapsible`, so the DOM stays bounded); if profiling shows it hot, pre-stringify tool inputs upstream (e.g. into the rendered group) instead.
- **Bound the DOM.** Always send large tool I/O through `Collapsible` so the truncated slice (not the multi-KB blob) hits the DOM. The transcript is **windowed**: Chat mounts only the newest `RENDER_WINDOW` (300) messages via the `renderedMessages` derived, with a "N earlier messages hidden" banner above; older messages stay in the persisted transcript but out of the DOM. The store/`flush()` still hold the full list (a transcript only grows except on `resetTranscript`), so raise `RENDER_WINDOW` only after profiling — and switch `flush()` to in-place push first if you do (see below). True virtualization (variable-height rows under the custom transform scroll) is the next step if 300 isn't enough.
- **Rust relay does ZERO work per chunk.** In `agent.rs`, each `CommandEvent::Stdout` becomes one `agent-event` emit tagged `{ worktree, kind: "stdout", data: line }` — no JSON parse, no per-message transform, no clones beyond the unavoidable `String::from_utf8_lossy`. Parsing belongs in `api.ts` (which routes by `worktree`). Each worktree has its own reader task; heavy work there throttles that session's stream.
- **Serialize each payload once.** `core.ts`'s `emit()` stringifies one compact object per line (`JSON.stringify(o) + "\n"`) — never pretty-print (no `null, 2`) on the wire, never split one logical message across writes (the newline is the only framing). Rust relays the string verbatim; `api.ts` parses once. Don't add a parse-then-restringify layer anywhere.
- **Never block the sidecar loops.** In a provider, the `for await (...)` agent loop and the `makeQueue` `push()` (the input backpressure point) must stay O(1); map each native message to `AgentMessage` and `emit()` it without aggregating or serializing large state in the loop.
- **Measure before tuning** the 16ms window, virtualization threshold, or `Collapsible` `max` — profile a real heavy tool-result burst and a long multi-turn session, not a hello-world.

## Build / run

```
bun install            # do NOT pass --omit=optional / --no-optional (breaks the native CLI embed)
bun run build:sidecar  # REQUIRED after ANY sidecar/*.ts edit — compiles to src-tauri/binaries/agent-<rust-triple>
bun run dev            # tauri dev (frontend hot-reloads; sidecar does NOT)
bun run build          # release
bun run check          # svelte-check typecheck (webview, src/** only)
bun run check:sidecar  # tsc typecheck of the Bun sidecar + shared protocol — the half `check` does NOT cover (bun --compile doesn't typecheck)
bun run test           # bun test (TS unit tests); Rust units run via `cargo test` in src-tauri
bun run lint           # Biome lint + format check (TS/JS/JSON; `.svelte` is covered by svelte-check, not Biome)
bun run format         # Biome autofix + format
```

CI (`.github/workflows/ci.yml`) runs three jobs on every push/PR. **frontend:** `lint` + `check` + `check:sidecar` + `bun test` + `build:sidecar`. **rust:** `cargo fmt --check` + `cargo clippy -- -D warnings` (warnings fail) + `cargo test`. **build:** compiles the REAL sidecar + frontend + app crate together (no stubbed binary) so an externalBin/capability/prod-build break can't slip through. This is the safety net for the hand-mirrored protocol and the Rust core — keep `cargo fmt`-clean and Biome-clean before pushing. Biome's `noExplicitAny`/`noAssignInExpressions`/`noNonNullAssertion` are intentionally **off** (`biome.json`) because the codebase uses those idioms deliberately — don't re-enable without auditing the call sites. TS `noUncheckedIndexedAccess` is **on** (both tsconfigs): per-worktree `Record<string,…>` reads are `T | undefined`, so keep the `?? fallback`.

## Gotchas

- **Stale sidecar binary is the #1 trap.** Only the Vite/Svelte frontend hot-reloads. The Rust side spawns the compiled binary at `src-tauri/binaries/agent-<rust-target-triple>`, NOT `sidecar/core.ts`. Re-run `bun run build:sidecar` after every sidecar edit or you chase a phantom bug in stale logic.
- **Target-triple naming.** `tauri.conf.json` lists only the base name `binaries/agent`; the file on disk MUST carry the Rust target-triple suffix or Tauri's `sidecar()` won't resolve it.
- **`$bunfs` native-CLI embed.** `bun --compile` doesn't bundle the spawned native `claude` binary. Each `sidecar/agent.<platform>.ts` does `import binPath from '@anthropic-ai/claude-agent-sdk-<platform>/claude[.exe]' with { type: 'file' }` then `run(extractFromBunfs(binPath))` (note win-x64 uses `claude.exe`). Keep this OUT of `core.ts` (platform-agnostic). To add/change a platform, edit only the matching entrypoint + the case in `build-sidecar.sh`.
- **Auth uses the existing Claude Code login. There is NO API key in this app** — the embedded native `claude` binary handles auth. Don't add API-key plumbing.
- **Provider adapters.** The sidecar is provider-pluggable: `core.ts` is neutral transport; the agent loop + native→`AgentMessage` mapping live in `sidecar/providers/<id>.ts`, selected by `config.provider` from the session config (default `claude`). Adding a provider = a new adapter implementing `AgentProvider` and mapping to `AgentMessage` — DON'T put provider-specific logic in `core.ts` or the UI. A runtime needing a different native binary also needs its own `agent.<platform>.ts` embed.
- **Session config is ONE shared blob, not per-knob args/env.** All session start-up knobs (provider, resumeSessionId, permissionMode, systemPromptAppend, mcpServers, agents) live in the `SessionConfig` type in `shared/protocol.ts`, built in `stores.ts › ensureSession`, serialized by `api.startSession`, forwarded **verbatim** by Rust `start_session(worktree, config?)` as the `SESSION_CONFIG` env var, and parsed ONCE in `core.ts` into the `ProviderContext`. Because the type is shared by both TS ends and Rust treats the blob as opaque, **adding a session knob = a field on `SessionConfig` + reading it in the provider** — no Rust signature, no env-var plumbing, no `api.ts`/`core.ts` shape edits. Don't reintroduce per-knob command args or env vars. The only separate env var is `PROJECT_DIR` (= the worktree path, the sidecar's project dir).
- **Permission mode is per-worktree; `bypassPermissions` is the default.** `providers/claude.ts` ALWAYS wires `canUseTool` (so the mode can be flipped live), but the initial `permissionMode` comes from the session config (`config.permissionMode`, see the session-config gotcha) and defaults to `bypassPermissions`. Under bypass the SDK never calls `canUseTool`, so the Allow/Deny path stays silent — and the SDK *requires* `allowDangerouslySkipPermissions: true` for bypass, so the provider sets that flag when the initial mode is bypass (load-bearing; the SDK rejects bypass without it). Switch the mode per-worktree in the composer (`PermissionModeSelector.svelte`, persisted to `trickshot.permissionModeByWorktree`); `default`/`acceptEdits`/`plan` make the SDK call `canUseTool`, which emits a `permission_request` answered by `PermissionModal.svelte` → `replyPermission` → the `pendingPermissions` map. Live switches go through the `set_permission_mode` command (`q.setPermissionMode`).
- **Pinned config (Claude provider).** Model is `claude-opus-4-8`, systemPrompt is the `claude_code` preset (with an optional per-session `append` from `config.systemPromptAppend`, set in Settings → `trickshot.systemPromptAppend`), and `settingSources: ["user","project"]` is loaded so the agent reads the user's + repo's `.claude` config (CLAUDE.md, `.claude/commands` → slash commands surfaced via `q.supportedCommands()` → the `commands` event → the composer palette). All set in `providers/claude.ts`. Agent cwd comes from `PROJECT_DIR` (set by Rust `start_session`), read in `core.ts` and passed as `ctx.projectDir`, defaulting to `process.cwd()`. `@anthropic-ai/claude-agent-sdk` is pinned to an **exact** version in `package.json` (not a caret) — the embedded native CLI tracks it, so bump it deliberately, not via a silent minor.
- **CSP is set, not null.** `tauri.conf.json`'s `app.security.csp` is a restrictive policy (the webview is local-only — the sidecar process, not the webview, talks to the API). It's a tripwire: if you render agent/tool output as HTML/markdown, keep it escaped/sanitized. If you tighten the CSP further, re-verify the window renders with `bun run dev` (a wrong directive white-screens the app).
- **Don't close the prompt queue.** The `makeQueue` async-iterable in `providers/claude.ts` is intentionally never closed so the session stays open for multi-turn chat; user turns are `push()`ed in. Don't "fix" it to close after a turn.
- **Concurrent sessions are unbounded & heavy.** Each selected worktree runs its own sidecar (~279MB resident). There is no cap by design (Conductor-style), so many open worktrees = real RAM — add an LRU/cap in `start_session` if you need one. All sessions are killed on app quit by the `lib.rs` exit handler.
- **Persistence.** Repos, selected worktree, per-worktree model, per-worktree permission mode, per-worktree cost/usage total, theme, **transcript**, and **agent session id** persist to `localStorage` (keys `trickshot.*`). Chat survives restarts via TWO mechanisms that must both stay wired: the persisted transcript restores the *rendered* messages, and `start_session` (with `config.resumeSessionId`) resumes the SDK session by id to restore the agent's *context* — the SDK does NOT replay messages on resume, so neither alone is enough. The session id rides on every SDK message (`m.session_id`); App.svelte captures the latest. Transcripts are saved on a 600ms idle debounce (never mid-stream) and tolerate localStorage quota errors. Worktree lists are still repopulated from git (`list_worktrees`) on launch — git is the source of truth, not a persisted list.
- **macOS packaging:** the Bun binary needs JIT codesign entitlements before notarization; ship a `-baseline` Bun target for older x64 CPUs (see README + ARCHITECTURE Packaging).
