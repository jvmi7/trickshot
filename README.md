# trickshot

A desktop command center for **Claude Code** with **first-class git-worktree** support. Spin up isolated worktrees per task and run the real Claude Code CLI in each one — concurrently — from a single window, with git review, PRs, and project scripts wrapped around it.

Built as two processes: a **Tauri 2** Rust core and a **Svelte 5 / TypeScript** webview. The chat pane is the actual `claude` TUI on a per-worktree PTY — your own install, your own login, your own settings. There is no API key to manage and no agent runtime embedded in the app.

## What it does

### Repositories & git worktrees
- **Add any local git repo** to the sidebar (native folder picker). Its worktrees are read live from `git worktree list` — git is always the source of truth, never a stale cached list.
- **Create a worktree in one click**: type a branch name and press Enter (or let it auto-name one). trickshot runs `git worktree add` under `../.<repo>-worktrees/<branch>` (creating the branch if needed) and selects it.
- Worktrees let you run several tasks against the same repo in parallel, each on its own branch and working tree, with no stashing or branch-switching.

### Concurrent per-worktree Claude Code sessions
- **Selecting a worktree opens its chat** — there's no manual start/stop. Each worktree gets its own PTY running `claude`, resuming that worktree's newest session from Claude Code's own session store; sessions keep running when you switch, so you can hold multiple live chats at once.
- **It's the real CLI.** Slash commands, permission prompts, hooks, MCP connectors, model switching — everything works exactly as in your terminal, because it *is* your terminal. The app adds no config layer on top.
- **Background awareness**: busy/idle detection from the PTY's output flow drives the sidebar status dots, unread badges, and OS notifications when a backgrounded agent finishes.
- **Fleet overview**: with no worktree selected, a mission-control grid shows every workspace's status, diffstat, and unread count — click to jump.

### Git review, commits, and PRs
- A **Changes popover** (header ±) with per-file diffs, staging, commit, push, pull, and merge — plus AI-generated commit messages, branch names, and PR title/body via one-shot `claude -p` (the same binary as the chat).
- **Review queue**: comment on diff lines, then send them as ONE structured prompt into the chat ("fix these"); the PR panel's failing checks have the same "hand to the agent" action.
- **GitHub PRs** via your existing `gh` login: create, watch CI checks, merge.

### Project scripts
- Per-repo scripts in a committed `.trickshot/settings.json`: **setup** (on worktree create), named **run** scripts (header Run button, output in the Run tab), and **archive** (pre-archive cleanup). Each worktree gets a deterministic `$TRICKSHOT_PORT` block so parallel dev servers never collide.

### Workspaces
- **Archive** a workspace (removes the dir, keeps the branch) and **restore** it later from History — the conversation resumes, because Claude Code's session store is keyed by the worktree path and the path scheme is deterministic.
- A **shell terminal** popover per worktree, separate from the chat PTY.
- **⌘K command palette**, ⌘E compose popup (long prompts, bracketed-pasted into the CLI), ⌘1–9 workspace jumping, and a keyboard-shortcuts overlay (⌘/).

### Appearance
- A **Settings page** with themes (full palette swaps), fonts, terminal font size, and a "uniform type" TUI mode. Subscription usage (your Claude plan's 5-hour/weekly windows) shows in the header.

## Prerequisites

- **Rust** (stable) + the Tauri v2 system deps for your OS — https://v2.tauri.app/start/prerequisites/
- **Bun** ≥ 1.2.4 — https://bun.sh
- **git** on `PATH` (used for worktree commands)
- A **logged-in Claude Code CLI** on your `PATH`. The app has **no API-key plumbing** — it runs your own `claude` install with your existing authentication. Sign in once (run `claude`) and the app reuses it.
- Optional: **gh** (GitHub CLI), authenticated, for the PR panel.

## First-time setup

```bash
cd trickshot
bun install

# Generate app icons (Tauri requires these to exist). Provide any square PNG:
bunx @tauri-apps/cli icon path/to/icon-1024.png   # writes src-tauri/icons/*

bun run dev                      # launches the Tauri app (uses your Claude Code login)
```

## Using it

1. **+ Add repository** (bottom of the sidebar) → pick a git repo. Its worktrees populate from git.
2. **+** on a repo row → type a branch name, press **Enter** to create a worktree, or click any existing worktree row to select it.
3. Selecting a worktree **opens its Claude Code chat** — type straight into the TUI. Switch worktrees freely; each session keeps running.
4. **Settings** (bottom of the sidebar) opens the Appearance / Connectors page in place of the chat; pick a worktree again to return to its chat.

## Extending it

trickshot is also a clean foundation to build on — the seams are deliberate:

- **`src/lib/api.ts`** — the typed command + event surface. Import from here; don't call `invoke`/`listen` directly.
- **`src/lib/stores.ts`** — Svelte stores for session/worktree/UI state (with `session.ts` orchestration and the `persist.ts` template behind it).
- **`src/lib/components/`** — the feature components (terminal panes, git panel, fleet, settings, …).
- **`src/lib/types.ts`** — the app-side types (`Worktree`, `GitStatus`, the `ScriptEnvelope`/`TermEnvelope` event envelopes), each mirroring its Rust struct.
- **`src-tauri/src/`** — one Rust module per concern (terminal, worktree/git, scripts, github, generate, usage); the hand-mirrored seams are pinned by `src/lib/conformance.test.ts`.

## Checks

```bash
bun run check          # svelte-check typecheck (webview)
bun run test           # bun test (TS unit tests + conformance gates)
bun run lint           # Biome lint + format check (TS/JS/JSON)
bun run format         # Biome autofix + format
```

CI (`.github/workflows/ci.yml`) runs these plus a full app build, `cargo fmt --check`, `cargo clippy`, and `cargo test` on every push/PR — the safety net for the hand-mirrored command/envelope seams (see `CLAUDE.md` → SYNC RULE).

See `ARCHITECTURE.md` for the full end-to-end map and the Rust command reference.
