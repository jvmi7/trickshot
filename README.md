# trickshot

A desktop GUI for the **Claude Agent SDK** with **first-class git-worktree** support. Run a Claude coding agent against any local repo, spin up isolated worktrees per task, and keep a live agent session running in each one — concurrently — from a single window.

Built as three processes over one event stream: a **Tauri 2** Rust core, a **Svelte 5 / TypeScript** webview, and a **Bun-compiled sidecar** that wraps `@anthropic-ai/claude-agent-sdk`. It authenticates through your existing **Claude Code login** — there is no API key to manage.

## What it does

### Repositories & git worktrees
- **Add any local git repo** to the sidebar (native folder picker). Its worktrees are read live from `git worktree list` — git is always the source of truth, never a stale cached list.
- **Create a worktree in one click**: type a branch name and press Enter. trickshot runs `git worktree add` under `../.<repo>-worktrees/<branch>` (creating the branch if needed) and selects it.
- Worktrees let you run several tasks against the same repo in parallel, each on its own branch and working tree, with no stashing or branch-switching.

### Concurrent per-worktree agent sessions
- **Selecting a worktree activates its agent session** — there's no manual start/stop. Each worktree runs **its own sidecar process**, and sessions keep running when you switch, so you can hold multiple live chats at once.
- The agent runs with Claude Code's system prompt and tools, in the worktree's directory, via the embedded native `claude` binary.
- Sessions are unbounded by design (Conductor-style); each is a real ~280MB process, so many open worktrees mean real RAM.

### The chat
- **Streaming responses** with Markdown rendering for assistant prose.
- **Tool activity, condensed**: consecutive tool calls collapse into a single expandable group; results fold into their call; large tool inputs/outputs are truncated with a reveal toggle so the transcript stays readable.
- **A live "what's happening" footer** while the agent works (current action + elapsed time), replaced on completion by an end-of-turn summary (e.g. *"Cooked in 17s · 4 steps"*).
- **Interrupt** a turn mid-flight from the composer.
- Transcripts are **windowed and batched** for performance, and **persist across restarts** (chat history is restored, and the agent's *context* resumes via the SDK session id).

### Model switching
- Pick the model **per worktree** from the in-chat selector; the catalog and provider-supplied comparison ratings come from the agent itself. Your choice is sticky per worktree across restarts. Default model: `claude-opus-4-8`.

### Connectors & tools (MCP)
- A dedicated **Connectors** tab in Settings shows **every MCP connector the agent can use**, its live status (`connected` / `needs-auth` / `failed` / `pending` / `disabled`), and the tools each one exposes (flagged read-only or destructive).
- **Enable or disable any connector live** — no restart — and **reconnect** failed ones; failure reasons are shown inline.
- Preferences are **global** (one set across every repo) and persisted, then re-applied automatically to each session as it starts. This is your visibility-and-control surface for "what is actually turned on."
- Note: connectors marked `needs-auth` (OAuth integrations) must be authorized in Claude Code itself — that browser flow can't be completed from the sidecar.

### Appearance
- A **Settings page** (opened from the sidebar foot, it replaces the chat pane) with **Appearance** and **Connectors** tabs.
- **Themes**: Terracotta (default), Ocean, Forest — each a full palette swap. **Fonts**: Sans Code (default), WenKai Mono, Comic Sans, IBM Plex Mono, Helvetica. Both persist.

### Tool permissions
- By default the agent runs with `bypassPermissions` — tools execute automatically without prompting. The full **Allow/Deny** approval modal is wired and becomes a real kill-switch the moment a non-bypass permission mode is used (see `ARCHITECTURE.md` → conversation flow).

### Persistence
Repos, the selected worktree, each worktree's model, theme, font, the rendered transcript, and the resumable agent session id all persist to `localStorage`. The worktree list itself is always re-read from git on launch.

## Prerequisites

- **Rust** (stable) + the Tauri v2 system deps for your OS — https://v2.tauri.app/start/prerequisites/
- **Bun** ≥ 1.2.4 — https://bun.sh
- **git** on `PATH` (used for worktree commands)
- A **logged-in Claude Code CLI**. This app has **no API-key plumbing** — the sidecar embeds the native `claude` binary, which uses your existing Claude Code authentication. Sign in once (e.g. `claude` / `claude login`) and the app reuses it. See `CLAUDE.md` → Gotchas (Auth).

## First-time setup

```bash
cd trickshot
bun install                      # installs deps incl. the SDK's per-platform native CLI (optional deps)

# Generate app icons (Tauri requires these to exist). Provide any square PNG:
bunx @tauri-apps/cli icon path/to/icon-1024.png   # writes src-tauri/icons/*

# Build the sidecar for your host platform (re-run after editing sidecar/*.ts):
bun run build:sidecar            # -> src-tauri/binaries/agent-<target-triple>

bun run dev                      # launches the Tauri app (uses your Claude Code login)
```

> ⚠️ Don't install with `--omit=optional` / `--no-optional`. The SDK ships the Claude Code CLI as per-platform **optional** dependencies; the sidecar embeds the matching one. Skipping them breaks the build with `Native CLI binary for <platform> not found`.

## Using it

1. **+ Add repository** (bottom of the sidebar) → pick a git repo. Its worktrees populate from git.
2. **+** on a repo row → type a branch name, press **Enter** to create a worktree, or click any existing worktree row to select it.
3. Selecting a worktree **starts its agent session**; type in the composer to chat. Switch worktrees freely — each session keeps running.
4. **Settings** (bottom of the sidebar) opens the Appearance / Connectors page in place of the chat; pick a worktree again to return to its chat.

## Release / cross-compilation

Bun's `--target` names differ from Rust target triples, and each `--target` must embed *its* platform's CLI binary (the `import … with { type: "file" }` is platform-specific — that's why there's one `sidecar/agent.<platform>.ts` per target). Per target:

```bash
bun build sidecar/agent.darwin-arm64.ts --compile --target=bun-darwin-arm64 \
  --outfile src-tauri/binaries/agent-aarch64-apple-darwin
# repeat for darwin-x64 / linux-x64 / linux-arm64 / win-x64 → matching Rust triples
```

Then `bun run build`. On macOS the Bun binary must be codesigned with JIT entitlements before Tauri signs/notarizes the `.app` (see `ARCHITECTURE.md` → Packaging). On x64 Linux/Windows, ship the `-baseline` Bun target for older CPUs.

## Extending it

trickshot is also a clean foundation to build on — the seams are deliberate:

- **`src/lib/api.ts`** — the typed command + event surface. Import from here; don't call `invoke`/`listen` directly.
- **`src/lib/stores.ts`** — Svelte stores for session/worktree/UI state.
- **`src/lib/components/`** — the feature components (chat, composer, settings, …).
- **`shared/protocol.ts`** — the provider-neutral, line-delimited JSON wire unions (`Inbound`/`Outbound`/`AgentMessage`/`ConnectorInfo`/`ModelInfo`), imported by **both** the webview (`src/lib/types.ts`) and the sidecar (`sidecar/core.ts`).
- **`sidecar/providers/`** — pluggable model-provider adapters (`claude.ts` is the first). Add a provider by implementing `AgentProvider` and mapping its native events to the neutral `AgentMessage` schema — no UI or protocol change. See `ARCHITECTURE.md` → Providers.
- **`src/lib/types.ts`** — the app-side protocol surface (`Worktree`, `Repo`, `AgentEnvelope`) + the re-exported wire types.

## Checks

```bash
bun run check          # svelte-check typecheck (webview)
bun run check:sidecar  # tsc typecheck of the Bun sidecar + shared protocol
bun run test           # bun test (TS unit tests)
bun run lint           # Biome lint + format check (TS/JS/JSON)
bun run format         # Biome autofix + format
```

CI (`.github/workflows/ci.yml`) runs these plus `bun run build:sidecar`, a full app build, `cargo fmt --check`, `cargo clippy`, and `cargo test` on every push/PR — the safety net for the hand-mirrored protocol (see `CLAUDE.md` → SYNC RULE).

See `ARCHITECTURE.md` for the full end-to-end map and the Rust command reference.
