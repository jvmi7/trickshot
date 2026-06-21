# Architecture

End-to-end map of the MVP. Three processes, one event stream.

```
┌─ Webview (Svelte) ───────────────────────────────────────────────┐
│  components/  ──uses──>  lib/api.ts  ──>  invoke()      listen()   │
│       │                       (commands)        ▲ (agent-stdout)   │
└───────┼───────────────────────────────────────┼──────────────────┘
        │ Tauri IPC                              │ Tauri events
┌───────▼───────────────────────────────────────┴──────────────────┐
│  Rust core (src-tauri/src)                                        │
│   agent.rs    start_agent / send_to_agent / stop_agent            │
│   worktree.rs pick_directory / list / create / remove_worktree    │
│   lib.rs      registers plugins (shell, dialog) + commands         │
└───────┬──────────────────────────────▲───────────────────────────┘
 stdin  │ (JSON lines)         stdout   │ (JSON lines, line-buffered)
┌───────▼──────────────────────────────┴───────────────────────────┐
│  Sidecar (Bun-compiled, sidecar/core.ts)                          │
│   query({ prompt: <stream>, options.canUseTool })                 │
│   embeds + extracts the native Claude Code CLI (extractFromBunfs) │
└───────┬───────────────────────────────────────────────────────────┘
        │ spawns
   native `claude` binary  ──>  Anthropic API
```

## The conversation flow

1. **Pick a repo** → `pick_directory` (native dialog) or a manual path field sets `repoPath`.
2. **One-click worktree** → `create_worktree(repo, branch)` runs `git worktree add` under `../.<repo>-worktrees/<branch>` and returns the path; the UI immediately calls `start_agent(path)`.
3. **`start_agent`** spawns the sidecar with `PROJECT_DIR=<path>` (→ the agent's `cwd`), and pumps the sidecar's stdout: each line is emitted as a Tauri `agent-stdout` event.
4. **`api.onAgentEvent`** parses each line into an `Outbound` and updates stores → components re-render.
5. **User turn** → `sendUserTurn(text)` → `send_to_agent` writes a `{kind:"user_turn"}` JSON line to the sidecar's stdin → pushed into the streaming `prompt` iterable → the SDK processes it.
6. **Tool permission** → the SDK's `canUseTool` emits `{kind:"permission_request"}`; the UI shows the modal; `replyPermission` writes `{kind:"permission_reply"}` back; the sidecar resolves the pending promise.

## The sidecar protocol (`src/lib/types.ts` ↔ `sidecar/core.ts`)

Newline-delimited JSON, both directions.

| Direction | `kind` | Payload |
|---|---|---|
| app → sidecar | `user_turn` | `{ text }` |
| app → sidecar | `permission_reply` | `{ id, behavior, message? }` |
| app → sidecar | `interrupt` | — |
| sidecar → app | `ready` | — |
| sidecar → app | `message` | `{ message: SDKMessage }` (pass-through) |
| sidecar → app | `permission_request` | `{ id, tool, input }` |
| sidecar → app | `error` | `{ error }` |

`SDKMessage.type` is one of `system` (init), `assistant`, `user` (tool results), `result`, plus internal types the UI ignores. `Message.svelte` branches on it.

## Rust command reference (the UI hook points)

| Command | Args (camelCase from JS) | Returns | Notes |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Native folder picker |
| `list_worktrees` | `repoPath` | `Worktree[]` | First entry is main |
| `create_worktree` | `repoPath, branch, baseRef?` | `Worktree` | Creates branch if new; one-click primitive |
| `remove_worktree` | `repoPath, worktreePath, force` | `void` | Branch left intact |
| `start_agent` | `projectDir` | `void` | Spawns sidecar; replaces any running one |
| `send_to_agent` | `payload` (JSON string) | `void` | Writes a line to sidecar stdin |
| `stop_agent` | — | `void` | Kills the sidecar |

Events: `agent-stdout` (protocol lines), `agent-stderr`, `agent-error`, `agent-terminated` (exit code).

## Why a Bun sidecar (and the one real gotcha)

The Agent SDK doesn't run in-process — it spawns a native Claude Code binary (shipped as per-platform optional npm deps). `bun build --compile` bundles your JS but **not** that child binary; at runtime `require.resolve` fails inside Bun's `$bunfs` virtual filesystem. The fix (SDK ≥ 0.3.144), in each `sidecar/agent.<platform>.ts`: `import binPath … with { type: "file" }` to embed it, `extractFromBunfs(binPath)` to self-extract at startup, and pass the result to `options.pathToClaudeCodeExecutable`. So the `claude` binary rides *inside* the sidecar — no second Tauri sidecar needed.

## Packaging notes

- **Tauri sidecar naming:** the binary on disk must be suffixed with the **Rust target triple** (`agent-aarch64-apple-darwin`); `externalBin` lists the base name `binaries/agent`. You produce the suffixed files (the build script does this for the host).
- **macOS:** the Bun binary JIT-compiles → codesign with JIT entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`) before Tauri signs/notarizes the `.app`.
- **Capabilities:** spawning is gated by `shell:allow-spawn` (we call `.spawn()`, not `.execute()`). Pure-Rust spawns are largely ungated, but the capability is kept for correctness.

## MVP boundaries (what's intentionally not here)

- No session persistence/history across app restarts (transcript lives in a store).
- No streaming token-by-token rendering (messages arrive per SDK message; add `partial_assistant` handling for finer granularity).
- No multi-session tabs (one active sidecar at a time).
- No `git` branch deletion on worktree removal, no dirty-state guards.
- Worktree dir layout is fixed (`../.<repo>-worktrees/<branch>`); make it configurable as needed.
