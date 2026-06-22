# trickshot

A Tauri v2 desktop shell around the **Claude Agent SDK**, with **one-click git worktree** support. The Rust backend spawns a Bun-compiled sidecar that runs the agent; the Svelte frontend renders the conversation and approves tool use. This is an **MVP scaffold** — the plumbing is complete and the UI is intentionally minimal so you can build on top of it.

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

1. **+ Add repository** (bottom of the sidebar) opens a native folder picker; choose a git repo. Its worktrees populate from `git worktree list` (git is the source of truth).
2. **+** on a repo row creates a worktree: type a branch name and press **Enter** → `git worktree add` under `../.<repo>-worktrees/<branch>`, then the new worktree is selected. Or click any existing worktree row to select it.
3. **Selecting a worktree activates its agent session** (no manual start/stop) — each selected worktree runs its own sidecar concurrently, so you can switch between live chats. Type in the composer to chat.

> Tools run automatically: the sidecar uses `permissionMode: "bypassPermissions"`, so the agent never pauses for approval and the Allow/Deny modal stays dormant. The permission plumbing is retained for when bypass is disabled — see `ARCHITECTURE.md` → conversation flow.

## Release / cross-compilation

Bun's `--target` names differ from Rust target triples, and each `--target` must embed *its* platform's CLI binary (the `import … with { type: "file" }` is platform-specific — that's why there's one `sidecar/agent.<platform>.ts` per target). Per target:

```bash
bun build sidecar/agent.darwin-arm64.ts --compile --target=bun-darwin-arm64 \
  --outfile src-tauri/binaries/agent-aarch64-apple-darwin
# repeat for darwin-x64 / linux-x64 / linux-arm64 / win-x64 → matching Rust triples
```

Then `bun run build`. On macOS the Bun binary must be codesigned with JIT entitlements before Tauri signs/notarizes the `.app` (see `ARCHITECTURE.md` → Packaging). On x64 Linux/Windows, ship the `-baseline` Bun target for older CPUs.

## Where to build your UI

- **`src/lib/api.ts`** — the typed command + event surface. Import from here; don't call `invoke`/`listen` directly.
- **`src/lib/stores.ts`** — Svelte stores for session/worktree state.
- **`src/lib/components/`** — minimal components to replace/extend.
- **`shared/protocol.ts`** — the provider-neutral, line-delimited JSON wire unions (`Inbound`/`Outbound`/`AgentMessage`/`ModelInfo`), imported by **both** the webview (`src/lib/types.ts`) and the sidecar (`sidecar/core.ts`).
- **`sidecar/providers/`** — pluggable model-provider adapters (`claude.ts` is the first). Add a provider by implementing `AgentProvider` and mapping its native events to the neutral `AgentMessage` schema — no UI or protocol change. See `ARCHITECTURE.md` → Providers.
- **`src/lib/types.ts`** — the app-side protocol surface (`Worktree`, `Repo`, `AgentEnvelope`) + the re-exported wire types.

## Checks

```bash
bun run check     # svelte-check typecheck
bun run lint      # Biome lint + format check (TS/JS/JSON)
bun run format    # Biome autofix + format
```

CI (`.github/workflows/ci.yml`) runs these plus `bun run build:sidecar`, `cargo fmt --check`, and `cargo clippy` on every push/PR — the safety net for the hand-mirrored protocol (see `CLAUDE.md` → SYNC RULE).

See `ARCHITECTURE.md` for the full end-to-end map and the Rust command reference.
