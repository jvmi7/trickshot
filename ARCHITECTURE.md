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

The sidecar is split: **`core.ts` is a provider-neutral transport** (frames JSON, dispatches `Inbound` to the selected provider) and **`providers/<id>.ts` is the adapter** that runs the actual agent loop and maps its native events into the neutral `AgentMessage` schema. Selected via `config.provider` from the `SESSION_CONFIG` blob (default `claude`). See *Providers* below.

## The conversation flow

1. **Add a repo** → `pick_directory` (native dialog) adds it to the persisted `repos` list; `list_worktrees` populates its worktrees (git is the source of truth).
2. **Spin up a worktree** → `create_worktree(repo, branch)` runs `git worktree add` under `../.<repo>-worktrees/<branch>`; the UI selects the new worktree.
3. **Selecting a worktree = activating its session** (no manual start/stop). `start_session(worktree)` spawns a sidecar with `PROJECT_DIR=<worktree>` if one isn't already running (idempotent). Worktrees run **concurrently** — each keeps its own sidecar; switching only changes the view.
4. **Events** → each sidecar's stdout line is emitted as one `agent-event` tagged `{ worktree, kind, data }`. `api.onAgentEvent` parses it and routes to that worktree's transcript → the selected transcript re-renders.
5. **User turn** → `sendUserTurn(worktree, text)` → `send_to_session` writes a `{kind:"user_turn"}` JSON line to that worktree's sidecar stdin → `core.ts` dispatches it to the provider's `pushTurn`, which (for Claude) pushes it into the SDK's streaming `prompt` iterable.
6. **Tool use** → the permission mode is **per-worktree**, defaulting to `bypassPermissions` (silent tool use, the historical default; the provider sets the SDK-required `allowDangerouslySkipPermissions: true` when starting in bypass). The provider ALWAYS wires `canUseTool`, so when the mode is `default`/`acceptEdits`/`plan` (chosen at start or switched live) the SDK calls it, emitting a `permission_request`; `PermissionModal.svelte` shows Allow/Deny and `replyPermission` resolves it via the `pendingPermissions` map in `providers/claude.ts`. The mode is chosen in the composer (`PermissionModeSelector.svelte`), applied at session start via the `PERMISSION_MODE` env, and switched live via `set_permission_mode` (`q.setPermissionMode`).

## The sidecar protocol (`shared/protocol.ts`, imported by `src/lib/types.ts` + `sidecar/core.ts`)

Newline-delimited JSON, both directions, and **provider-neutral** (nothing here is Claude-specific). The wire unions (`Inbound`/`Outbound`/`AgentMessage`/`ModelInfo`) live in one shared module so the webview and sidecar can't drift; only the Rust `AgentEvent` envelope (`agent.rs`) and this table are mirrored by hand. See CLAUDE.md → SYNC RULE.

| Direction | `kind` | Payload |
|---|---|---|
| app → sidecar | `user_turn` | `{ text }` |
| app → sidecar | `permission_reply` | `{ id, behavior, message? }` — answers a `permission_request` (active when the mode isn't `bypassPermissions`) |
| app → sidecar | `question_reply` | `{ id, answers }` — answers a `question_request`; `answers[i]` is the chosen option labels for question `i` |
| app → sidecar | `set_model` | `{ model }` — switch the chat's model; sidecar confirms by re-emitting `models` |
| app → sidecar | `set_permission_mode` | `{ mode }` — switch tool-permission mode live (`default`/`acceptEdits`/`plan`/`bypassPermissions`) |
| app → sidecar | `get_models` | — request a (re-)emit of `models`; the UI's resilient path since the ready-time broadcast can race the listener |
| app → sidecar | `get_connectors` | — request a (re-)emit of `connectors` (resilient, mirrors `get_models`) |
| app → sidecar | `toggle_connector` | `{ name, enabled }` — enable/disable an MCP connector live; sidecar confirms by re-emitting `connectors` |
| app → sidecar | `reconnect_connector` | `{ name }` — reconnect an MCP connector (e.g. after a failure / needs-auth) |
| app → sidecar | `get_commands` | — request a (re-)emit of `commands` (available slash commands) |
| app → sidecar | `interrupt` | — |
| app → sidecar | `set_mcp_servers` | `{ servers }` — replace live MCP servers (opaque config blob); sidecar re-emits `mcp_status` after |
| app → sidecar | `suggest` | `{ conversation }` — ask the provider to generate suggested next user replies for the recent-conversation text; answered async by `suggestions`. A separate cheap one-shot call (Claude: Haiku, no tools), NOT the main agent loop |
| sidecar → app | `ready` | — |
| sidecar → app | `suggestions` | `{ suggestions: string[] }` — suggested next user replies (answer to `suggest`); empty = none. Shown as pick-to-send chips above the composer (`Suggestions.svelte`) with a "type your own" option |
| sidecar → app | `commands` | `{ commands: {name,description}[] }` — available slash commands (on ready and after `get_commands`) |
| sidecar → app | `mcp_status` | `{ servers: {name,status}[] }` — MCP server connection statuses (on ready and after `set_mcp_servers`) |
| sidecar → app | `notification` | `{ message, notificationType? }` — agent wants attention (from the Notification hook); the app raises an OS notification for a backgrounded worktree |
| sidecar → app | `session` | `{ id }` — the resumable session id, emitted once the provider knows it |
| sidecar → app | `message` | `{ message: AgentMessage }` — one neutral transcript event |
| sidecar → app | `permission_request` | `{ id, tool, input }` — emitted by `canUseTool` when the mode isn't `bypassPermissions`; answered by `permission_reply` |
| sidecar → app | `question_request` | `{ id, questions }` — the agent asks structured multiple-choice questions (Claude: via the `ask_user` tool); `QuestionModal.svelte` answers with `question_reply` |
| sidecar → app | `models` | `{ models: {value,displayName,description?,meta?}[], current }` — catalog + current (on ready and after `set_model`); `meta` is provider-supplied comparison pips |
| sidecar → app | `connectors` | `{ servers: {name,status,scope?,error?,tools:{name,description?,readOnly?,destructive?}[]}[] }` — MCP connectors + their tools/status (on ready and after a toggle/reconnect) |
| sidecar → app | `error` | `{ error }` |

**`AgentMessage`** (the neutral transcript schema) `.type` is `system` | `assistant` (a prose chunk) | `tool_call` `{id,name,input}` | `tool_result` `{id,content,isError?}` | `turn_end` `{usage?}` (the turn's token/cost figures — `TurnUsage`, all fields optional; `costUsd` is a client-side estimate). `assistant`/`tool_call`/`tool_result` also carry an optional `parentId` — set when the message came from a subagent (the spawning `Agent` tool-call id, forwarded via `forwardSubagentText`), so `Message.svelte` nests/indents it. Each provider adapter maps its native output into these; `Message.svelte` renders only these (plus the UI-only `user_local`/`error` bubbles). The UI is never exposed to a provider's raw message shape. `turn_end` isn't rendered as a bubble — App.svelte consumes it to flip status to ready, refresh the subscription-usage windows, and (for the on-screen chat) request suggested next replies.

**Model switching:** each session starts on the provider's default model and emits `models` on ready. `ModelSelector.svelte` offers the catalog and renders each model's provider-supplied `meta` pips; picking one sends `set_model`. The current model is **per-worktree**, persisted to `localStorage` (`trickshot.modelByWorktree`) and re-applied on a session's `models` event when it differs from the default.

**Connectors (MCP servers):** each session emits `connectors` on ready (and after a toggle/reconnect). The **Settings page** (`Settings.svelte`, opened from the button at the foot of the sidebar) shows every connector's status + tools and lets you enable/disable/reconnect them live (`toggle_connector`/`reconnect_connector` → the SDK's `toggleMcpServer`/`reconnectMcpServer`). Control is **global** (one set of preferences for every repo/session), persisted to `localStorage` (`trickshot.connectorPrefs.global`). The SDK's toggle is a live control it does not remember across sessions, so the preference is **re-applied on each session's `connectors` event** (App.svelte) and a UI toggle applies live to every currently-running session. Per-tool muting of built-in tools (Bash/WebFetch) is out of scope — it needs the construction-time `disallowedTools` option + a session restart.

## Providers (model-provider adapters)

The sidecar is **provider-pluggable** so the app isn't baked into Claude:

- **`sidecar/providers/types.ts`** — the `AgentProvider` interface (`start`, `pushTurn`, `setModel`, `interrupt`, `publishModels`, `publishConnectors`, `toggleConnector`, `reconnectConnector`, `replyPermission`) + `ProviderContext` (`cliPath`, `projectDir`, `resumeSessionId`, `permissionMode`, `emit`).
- **`sidecar/providers/claude.ts`** — the only Claude-aware module: wraps the Claude Agent SDK and maps `SDKMessage` → `AgentMessage`. The Claude tier→pips heuristic lives here (not the UI).
- **`sidecar/providers/registry.ts`** — id → factory; `core.ts` selects via `config.provider` parsed from the `SESSION_CONFIG` blob (default `claude`).

**Add a provider:** implement `AgentProvider` in `providers/<id>.ts`, map its native events to `AgentMessage`, register it. No protocol or UI change. (A runtime needing a different native binary also needs its own `agent.<platform>.ts` embed — the binary is provider-specific; the rest is not.)

## Rust command reference (the UI hook points)

| Command | Args (camelCase from JS) | Returns | Notes |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Native folder picker |
| `list_worktrees` | `repoPath` | `Worktree[]` | First entry is main |
| `create_worktree` | `repoPath, branch, baseRef?` | `Worktree` | Creates branch if new; one-click primitive |
| `remove_worktree` | `repoPath, worktreePath, force` | `void` | Branch left intact |
| `worktree_status` | `worktreePath` | `GitStatus` | Parsed `git status --porcelain=v1 --branch` (branch, ahead/behind, changed files) |
| `worktree_diff` | `worktreePath, file?, base?` | `string` | Unified diff vs `base` (default HEAD); untracked files fall back to a `--no-index` all-add diff |
| `worktree_stage` / `worktree_unstage` | `worktreePath, paths` | `void` | Empty `paths` = all (`git add -A` / `git restore --staged .`) |
| `worktree_commit` | `worktreePath, message` | `string` | Commits staged changes (git stdout) |
| `worktree_push` | `worktreePath, setUpstream` | `string` | `setUpstream` pushes `-u origin <branch>` |
| `worktree_merge` | `repoPath, branch` | `string` | Merges `branch` into the branch checked out at `repoPath` |
| `start_session` | `worktree, config?` (JSON string) | `void` | Spawns a sidecar (cwd = worktree); idempotent. `config` is the app's `SessionConfig` blob (`provider`/`resumeSessionId`/`permissionMode`/`systemPromptAppend`/`mcpServers`/`agents`), forwarded verbatim as the `SESSION_CONFIG` env var; the sidecar parses it once in `core.ts`. Rust never enumerates the fields, so a new session knob doesn't touch this command. `PROJECT_DIR` (= worktree) is set separately |
| `send_to_session` | `worktree, payload` (JSON string) | `void` | Writes a line to that worktree's sidecar stdin |
| `stop_session` | `worktree` | `void` | Kills that worktree's sidecar |
| `notify` | `title, body` | `void` | Shows a desktop notification (tauri-plugin-notification) |

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
