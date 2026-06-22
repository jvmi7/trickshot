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
│  One Bun sidecar PER WORKTREE (sidecar/core.ts)                   │
│   query({ prompt: <stream>, bypassPermissions })                  │
│   embeds + extracts the native Claude Code CLI (extractFromBunfs) │
└───────┬───────────────────────────────────────────────────────────┘
        │ spawns
   native `claude` binary  ──>  Anthropic API
```

## The conversation flow

1. **Add a repo** → `pick_directory` (native dialog) adds it to the persisted `repos` list; `list_worktrees` populates its worktrees (git is the source of truth).
2. **Spin up a worktree** → `create_worktree(repo, branch)` runs `git worktree add` under `../.<repo>-worktrees/<branch>`; the UI selects the new worktree.
3. **Selecting a worktree = activating its session** (no manual start/stop). `start_session(worktree)` spawns a sidecar with `PROJECT_DIR=<worktree>` if one isn't already running (idempotent). Worktrees run **concurrently** — each keeps its own sidecar; switching only changes the view.
4. **Events** → each sidecar's stdout line is emitted as one `agent-event` tagged `{ worktree, kind, data }`. `api.onAgentEvent` parses it and routes to that worktree's transcript → the selected transcript re-renders.
5. **User turn** → `sendUserTurn(worktree, text)` → `send_to_session` writes a `{kind:"user_turn"}` JSON line to that worktree's sidecar stdin → pushed into its streaming `prompt` iterable.
6. **Tool use** → `core.ts` runs `permissionMode: "bypassPermissions"`, so the SDK runs tools automatically and never calls `canUseTool` — no `permission_request` is emitted and the Allow/Deny modal stays dormant. The `permission_request`/`permission_reply` plumbing (`PermissionModal.svelte`, `replyPermission`, the `pendingPermissions` map in `core.ts`) is retained for when bypass is disabled: set `permissionMode: "default"` and restore the `canUseTool` callback in `core.ts` to re-enable the round-trip.

## The sidecar protocol (`src/lib/types.ts` ↔ `sidecar/core.ts`)

Newline-delimited JSON, both directions.

| Direction | `kind` | Payload |
|---|---|---|
| app → sidecar | `user_turn` | `{ text }` |
| app → sidecar | `permission_reply` | `{ id, behavior, message? }` — dormant (only when `canUseTool` is enabled) |
| app → sidecar | `interrupt` | — |
| sidecar → app | `ready` | — |
| sidecar → app | `message` | `{ message: SDKMessage }` (pass-through) |
| sidecar → app | `permission_request` | `{ id, tool, input }` — dormant under `bypassPermissions` |
| sidecar → app | `error` | `{ error }` |

`SDKMessage.type` is one of `system` (init), `assistant`, `user` (tool results), `result`, plus internal types the UI ignores. `Message.svelte` branches on it.

## Rust command reference (the UI hook points)

| Command | Args (camelCase from JS) | Returns | Notes |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Native folder picker |
| `list_worktrees` | `repoPath` | `Worktree[]` | First entry is main |
| `create_worktree` | `repoPath, branch, baseRef?` | `Worktree` | Creates branch if new; one-click primitive |
| `remove_worktree` | `repoPath, worktreePath, force` | `void` | Branch left intact |
| `start_session` | `worktree` | `void` | Spawns a sidecar for that worktree; idempotent (no-op if already running) |
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

- Repos + selected worktree persist (localStorage); **transcripts are in-memory only** (not persisted across restarts). Worktree lists are repopulated from git on launch.
- No streaming token-by-token rendering (messages arrive per SDK message; add `partial_assistant` handling for finer granularity).
- No cap on concurrent sessions — each open worktree is its own ~279MB sidecar; add an LRU if that's too heavy.
- No `git` branch deletion on worktree removal, no dirty-state guards.
- Worktree dir layout is fixed (`../.<repo>-worktrees/<branch>`); make it configurable as needed.
