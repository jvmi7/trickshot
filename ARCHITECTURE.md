# Architecture

End-to-end map of the MVP. Three processes, one event stream.

```
┌─ Webview (Svelte) ───────────────────────────────────────────────┐
│  components/  ──uses──>  lib/api.ts  ──>  invoke()      listen()   │
│       │                       (commands)        ▲ (agent-event)    │
└───────┼───────────────────────────────────────┼──────────────────┘
        │ Tauri IPC                              │ Tauri events
┌───────▼───────────────────────────────────────┴──────────────────┐
│  Rust core (src-tauri/src)                                        │
│   agent.rs    start_session / send_to_session / stop_session      │
│               (Sessions: HashMap of worktree -> sidecar)          │
│   worktree.rs pick_directory / list / create / remove_worktree    │
│   lib.rs      registers plugins (shell, dialog) + commands         │
└───────┬──────────────────────────────▲───────────────────────────┘
 stdin  │ (JSON lines)         stdout   │ (JSON lines, line-buffered)
┌───────▼──────────────────────────────┴───────────────────────────┐
│  One Bun sidecar PER WORKTREE                                     │
│   core.ts (neutral transport)  ──>  providers/<id>.ts (adapter)   │
│   providers/claude.ts: query({ prompt:<stream>, bypassPermissions})│
│   embeds + extracts the native Claude Code CLI (extractFromBunfs) │
└───────┬───────────────────────────────────────────────────────────┘
        │ spawns
   native `claude` binary  ──>  Anthropic API
```

The sidecar is split: **`core.ts` is a provider-neutral transport** (frames JSON, dispatches `Inbound` to the selected provider) and **`providers/<id>.ts` is the adapter** that runs the actual agent loop and maps its native events into the neutral `AgentMessage` schema. Selected via the `AGENT_PROVIDER` env (default `claude`). See *Providers* below.

## The conversation flow

1. **Add a repo** → `pick_directory` (native dialog) adds it to the persisted `repos` list; `list_worktrees` populates its worktrees (git is the source of truth).
2. **Spin up a worktree** → `create_worktree(repo, branch)` runs `git worktree add` under `../.<repo>-worktrees/<branch>`; the UI selects the new worktree.
3. **Selecting a worktree = activating its session** (no manual start/stop). `start_session(worktree)` spawns a sidecar with `PROJECT_DIR=<worktree>` if one isn't already running (idempotent). Worktrees run **concurrently** — each keeps its own sidecar; switching only changes the view.
4. **Events** → each sidecar's stdout line is emitted as one `agent-event` tagged `{ worktree, kind, data }`. `api.onAgentEvent` parses it and routes to that worktree's transcript → the selected transcript re-renders.
5. **User turn** → `sendUserTurn(worktree, text)` → `send_to_session` writes a `{kind:"user_turn"}` JSON line to that worktree's sidecar stdin → `core.ts` dispatches it to the provider's `pushTurn`, which (for Claude) pushes it into the SDK's streaming `prompt` iterable.
6. **Tool use** → the Claude provider runs `permissionMode: "bypassPermissions"`, so the SDK runs tools automatically and never calls `canUseTool` — no `permission_request` is emitted and the Allow/Deny modal stays dormant. The `permission_request`/`permission_reply` plumbing (`PermissionModal.svelte`, `replyPermission`, the `pendingPermissions` map in `providers/claude.ts`) is retained for when bypass is disabled.

## The sidecar protocol (`shared/protocol.ts`, imported by `src/lib/types.ts` + `sidecar/core.ts`)

Newline-delimited JSON, both directions, and **provider-neutral** (nothing here is Claude-specific). The wire unions (`Inbound`/`Outbound`/`AgentMessage`/`ModelInfo`) live in one shared module so the webview and sidecar can't drift; only the Rust `AgentEvent` envelope (`agent.rs`) and this table are mirrored by hand. See CLAUDE.md → SYNC RULE.

| Direction | `kind` | Payload |
|---|---|---|
| app → sidecar | `user_turn` | `{ text }` |
| app → sidecar | `permission_reply` | `{ id, behavior, message? }` — dormant (only when `canUseTool` is enabled) |
| app → sidecar | `set_model` | `{ model }` — switch the chat's model; sidecar confirms by re-emitting `models` |
| app → sidecar | `get_models` | — request a (re-)emit of `models`; the UI's resilient path since the ready-time broadcast can race the listener |
| app → sidecar | `interrupt` | — |
| sidecar → app | `ready` | — |
| sidecar → app | `session` | `{ id }` — the resumable session id, emitted once the provider knows it |
| sidecar → app | `message` | `{ message: AgentMessage }` — one neutral transcript event |
| sidecar → app | `permission_request` | `{ id, tool, input }` — dormant under `bypassPermissions` |
| sidecar → app | `models` | `{ models: {value,displayName,description?,meta?}[], current }` — catalog + current (on ready and after `set_model`); `meta` is provider-supplied comparison pips |
| sidecar → app | `error` | `{ error }` |

**`AgentMessage`** (the neutral transcript schema) `.type` is `system` | `assistant` (a prose chunk) | `tool_call` `{id,name,input}` | `tool_result` `{id,content,isError?}` | `turn_end`. Each provider adapter maps its native output into these; `Message.svelte` renders only these (plus the UI-only `user_local`/`error` bubbles). The UI is never exposed to a provider's raw message shape.

**Model switching:** each session starts on the provider's default model and emits `models` on ready. `ModelSelector.svelte` offers the catalog and renders each model's provider-supplied `meta` pips; picking one sends `set_model`. The current model is **per-worktree**, persisted to `localStorage` (`trickshot.modelByWorktree`) and re-applied on a session's `models` event when it differs from the default.

## Providers (model-provider adapters)

The sidecar is **provider-pluggable** so the app isn't baked into Claude:

- **`sidecar/providers/types.ts`** — the `AgentProvider` interface (`start`, `pushTurn`, `setModel`, `interrupt`, `publishModels`, `replyPermission`) + `ProviderContext` (`cliPath`, `projectDir`, `resumeSessionId`, `emit`).
- **`sidecar/providers/claude.ts`** — the only Claude-aware module: wraps the Claude Agent SDK and maps `SDKMessage` → `AgentMessage`. The Claude tier→pips heuristic lives here (not the UI).
- **`sidecar/providers/registry.ts`** — id → factory; `core.ts` selects via `AGENT_PROVIDER` (default `claude`), plumbed from Rust `start_session(provider?)`.

**Add a provider:** implement `AgentProvider` in `providers/<id>.ts`, map its native events to `AgentMessage`, register it. No protocol or UI change. (A runtime needing a different native binary also needs its own `agent.<platform>.ts` embed — the binary is provider-specific; the rest is not.)

## Rust command reference (the UI hook points)

| Command | Args (camelCase from JS) | Returns | Notes |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Native folder picker |
| `list_worktrees` | `repoPath` | `Worktree[]` | First entry is main |
| `create_worktree` | `repoPath, branch, baseRef?` | `Worktree` | Creates branch if new; one-click primitive |
| `remove_worktree` | `repoPath, worktreePath, force` | `void` | Branch left intact |
| `start_session` | `worktree, resume?, provider?` | `void` | Spawns a sidecar (cwd = worktree); idempotent. `resume` = a prior session id → `RESUME_SESSION` env. `provider` (default `claude`) → `AGENT_PROVIDER` env → which adapter the sidecar loads |
| `send_to_session` | `worktree, payload` (JSON string) | `void` | Writes a line to that worktree's sidecar stdin |
| `stop_session` | `worktree` | `void` | Kills that worktree's sidecar |

Events: a single `agent-event` carrying `{ worktree, kind, data }`, where `kind` is `stdout` (a protocol line) | `stderr` | `error` | `terminated`. The frontend routes by `worktree`.

## Why a Bun sidecar (and the one real gotcha)

The Agent SDK doesn't run in-process — it spawns a native Claude Code binary (shipped as per-platform optional npm deps). `bun build --compile` bundles your JS but **not** that child binary; at runtime `require.resolve` fails inside Bun's `$bunfs` virtual filesystem. The fix (SDK ≥ 0.3.144), in each `sidecar/agent.<platform>.ts`: `import binPath … with { type: "file" }` to embed it, `extractFromBunfs(binPath)` to self-extract at startup, and pass the result to `options.pathToClaudeCodeExecutable`. So the `claude` binary rides *inside* the sidecar — no second Tauri sidecar needed. There is one such sidecar **per active worktree**, running concurrently (each ~279MB resident).

## Packaging notes

- **Tauri sidecar naming:** the binary on disk must be suffixed with the **Rust target triple** (`agent-aarch64-apple-darwin`); `externalBin` lists the base name `binaries/agent`. You produce the suffixed files (the build script does this for the host).
- **macOS:** the Bun binary JIT-compiles → codesign with JIT entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`) before Tauri signs/notarizes the `.app`.
- **Capabilities:** spawning is gated by `shell:allow-spawn` (we call `.spawn()`, not `.execute()`). Pure-Rust spawns are largely ungated, but the capability is kept for correctness.

## MVP boundaries (what's intentionally not here)

- Repos, selected worktree, per-worktree **model**, **theme**, **transcript**, and **agent session id** all persist (localStorage). On launch the selected worktree's session is resumed by id (restores agent *context*) and its transcript is rehydrated (restores the *rendered* history) — resume does NOT replay messages, so these are two separate mechanisms. Worktree lists are still repopulated from git on launch.
- No streaming token-by-token rendering (messages arrive per neutral `AgentMessage`; a provider could emit finer-grained `assistant` chunks for that).
- No cap on concurrent sessions — each open worktree is its own ~279MB sidecar; add an LRU if that's too heavy.
- No `git` branch deletion on worktree removal, no dirty-state guards.
- Worktree dir layout is fixed (`../.<repo>-worktrees/<branch>`); make it configurable as needed.
