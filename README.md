# trickshot

A Tauri v2 desktop shell around the **Claude Agent SDK**, with **one-click git worktree** support. The Rust backend spawns a Bun-compiled sidecar that runs the agent; the Svelte frontend renders the conversation and approves tool use. This is an **MVP scaffold** — the plumbing is complete and the UI is intentionally minimal so you can build on top of it.

## Prerequisites

- **Rust** (stable) + the Tauri v2 system deps for your OS — https://v2.tauri.app/start/prerequisites/
- **Bun** ≥ 1.2.4 — https://bun.sh
- **git** on `PATH` (used for worktree commands)
- An **`ANTHROPIC_API_KEY`** in your environment (or a cloud provider via `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`). Subscription (claude.ai) login is not permitted for third-party SDK apps without Anthropic pre-approval.

## First-time setup

```bash
cd trickshot
bun install                      # installs deps incl. the SDK's per-platform native CLI (optional deps)

# Generate app icons (Tauri requires these to exist). Provide any square PNG:
bunx @tauri-apps/cli icon path/to/icon-1024.png   # writes src-tauri/icons/*

# Build the sidecar for your host platform (re-run after editing sidecar/*.ts):
bun run build:sidecar            # -> src-tauri/binaries/agent-<target-triple>

export ANTHROPIC_API_KEY=sk-ant-...
bun run dev                      # launches the Tauri app
```

> ⚠️ Don't install with `--omit=optional` / `--no-optional`. The SDK ships the Claude Code CLI as per-platform **optional** dependencies; the sidecar embeds the matching one. Skipping them breaks the build with `Native CLI binary for <platform> not found`.

## Using it

1. **Choose folder…** (or paste a path) to select a git repo.
2. Type a branch name and hit **Create + Start** — this creates a worktree at `../.<repo>-worktrees/<branch>` *and* starts an agent session scoped to it (the one-click flow). Or **Start in main repo** / **Start** on an existing worktree.
3. Chat. When the agent wants to use a tool that needs permission, an **Allow/Deny** modal appears.

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
- **`src/lib/types.ts`** — the sidecar JSON protocol + `Worktree` shape.

See `ARCHITECTURE.md` for the full end-to-end map and the Rust command reference.
