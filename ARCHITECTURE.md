# Architecture

End-to-end map. Two processes; the chat is the real Claude Code CLI on a PTY.

```
┌─ Webview (Svelte) ───────────────────────────────────────────────┐
│  components/  ──uses──>  lib/api.ts  ──>  invoke()      listen()   │
│       │                       (commands)        ▲ (script-event /  │
│       │                                        │  term-event)     │
└───────┼───────────────────────────────────────┼──────────────────┘
        │ Tauri IPC                              │ Tauri events
┌───────▼───────────────────────────────────────┴──────────────────┐
│  Rust core (src-tauri/src)                                        │
│   terminal.rs  PTYs per worktree: login shell + the claude slot   │
│                (Terminals: WorktreeMap of pty-key -> PTY)         │
│   agent.rs     latest_session_id (~/.claude scan)                 │
│   worktree.rs  pick_directory / list / create / remove + git      │
│   scripts.rs / github.rs / generate.rs / usage.rs  (see tables)   │
│   worktree_map.rs  shared WorktreeMap<T> + WorktreeEvent envelope │
│   lib.rs       registers plugins (dialog) + cmds                  │
└───────┬───────────────────────────────────────────────────────────┘
        │ spawns on a PTY
   the user's PATH `claude` CLI (TUI)  ──>  Anthropic API
```

There is **no app-managed agent process**: the chat pane renders the user's own
`claude` binary running interactively on a dedicated PTY, and one-shot AI text
generation (`generate.rs`) runs the same binary in print mode. Auth, model
choice, permissions, MCP connectors, and slash commands are all Claude Code's
own — the app adds no layer on top.

## The conversation flow

1. **Add a repo** → `pick_directory` (native dialog) adds it to the persisted `repos` list; `list_worktrees` populates its worktrees (git is the source of truth).
2. **Spin up a worktree** → `create_worktree(repo, branch)` runs `git worktree add` under `../.<repo>-worktrees/<branch>`; the UI selects the new worktree.
3. **Selecting a worktree = activating its chat** (no manual start/stop). Activation opens the worktree's FOCUSED chat's claude-slot PTY — `term_open(…, launch: "claude", resumeSessionId?/chat?/sessionId?)` — resuming the chat's stored session id (the default chat's first open adopts the newest from Claude Code's own session store via `latest_session_id`). Worktrees — and a worktree's chats — run **concurrently**; switching only changes which PTY is attached to the pane.
4. **User turns** are typed straight into the TUI. Features that hand text to the agent from **outside** the pane (git-panel review comments, "fix failing checks") go through `session.ts › submitTurnToChat` → bracketed-paste keystroke injection (`sendToCli`), then focus the terminal and raise a toast receipt.
5. **Busy/idle detection** comes from the PTY's output flow (`src/lib/cliActivity.ts`, wired in `terminal.ts › noteCliActivity`): data flowing = busy; a real burst ending fires the turn-end side-effects (sidebar dot, unread badge, git/usage refresh). The CLI exiting (`/exit`, crash) marks the session `stopped`; typing into the pane or re-activating the worktree revives it (no auto-respawn — a crash-looping CLI must not fork-bomb).

## The CLI chat surface (details)

- **One PTY per worktree per slot; MANY chat slots.** The shell terminal (header popover) and the claude chats are separate PTYs. A worktree can run several concurrent CLI chats (`stores.ts › chatSessionsByWorktree`, rendered as tabs or an n-up grid by `ClaudeTerminalPane` + `ClaudeTerminalCell`, layout in `chatLayout`): the DEFAULT chat's key is the bare `worktree + "\u0000claude"` (migration-safe), additional chats append `:<chat id>`. NUL can't occur in a filesystem path, so composite keys can't collide with a real worktree. The Rust `claude_key`/`CLAUDE_SLOT`/`DEFAULT_CHAT` (terminal.rs) and the TS `claudeTermKey()`/`DEFAULT_CHAT_ID` (lib/terminal.ts, stores.ts) are a hand-mirrored set — keep them in sync. Injected turns (review comments, ⌘E compose, "fix failing checks") land in the FOCUSED chat (`focusedChatByWorktree`).
- **Session identity is per chat.** The modern CLI's `--resume <id>` KEEPS the session id (`--fork-session` is opt-in), so each chat stores its id (`ChatSession.sessionId`, persisted) and resumes it forever. A brand-new chat is named deterministically at birth (`--session-id <app uuid>`); the DEFAULT chat's first open adopts the newest `.jsonl` in `~/.claude/projects/<encoded cwd>/` via `latest_session_id` — the migration path from the single-session era.
- **Archive/restore rides on the path.** Claude Code's session store is keyed by the worktree path, and the worktree path scheme is deterministic, so archiving a workspace (removing the dir, keeping the branch) and later restoring it recreates the same path — the conversation resumes without the app storing any chat state.
- **The binary is the user's own.** Rust resolves `claude` via the login shell (`command -v claude`, cached per app run) and exports the login PATH into the PTY; the webview only ever passes the whitelist name `"claude"`, never a command string (the run_script posture).

## Rust command reference (the UI hook points)

| Command | Args (camelCase from JS) | Returns | Notes |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Native folder picker |
| `repo_icon` | `repoPath` | `string \| null` | Repo favicon as a `data:` URI (bounded walk; an icon DECLARED by an `index.html`/`app.html` `<link rel="icon">` wins, else rank `favicon.*` anywhere + `icon.png/svg` in icon-ish dirs; ≤256KB); null when absent. Sidebar repo headers only |
| `home_dir` | — | `string` | The user's home directory (`$HOME`) — the sidebar Home workspace root |
| `list_worktrees` | `repoPath` | `Worktree[]` | First entry is main |
| `create_worktree` | `repoPath, branch, baseRef?` | `Worktree` | Creates branch if new; one-click primitive |
| `remove_worktree` | `repoPath, worktreePath, force` | `void` | Branch left intact |
| `worktree_status` | `worktreePath` | `GitStatus` | Parsed `git status --porcelain=v1 --branch` (branch, ahead/behind, changed files) |
| `worktree_diff` | `worktreePath, file?, base?` | `string` | Unified diff vs `base` (default HEAD); untracked files fall back to a `--no-index` all-add diff |
| `worktree_stage` / `worktree_unstage` | `worktreePath, paths` | `void` | Empty `paths` = all (`git add -A` / `git restore --staged .`) |
| `worktree_commit` | `worktreePath, message` | `string` | Commits staged changes (git stdout) |
| `worktree_push` | `worktreePath, setUpstream, force` | `string` | `setUpstream` pushes `-u origin <branch>`; `force` uses `--force-with-lease` (overwrite a stale remote, never a fresh one) |
| `worktree_merge` | `repoPath, branch` | `string` | Merges `branch` into the branch checked out at `repoPath` |
| `worktree_pull` | `worktreePath` | `string` | `git pull --rebase --autostash`; a conflict auto-aborts back to the pre-pull state and rejects |
| `worktree_move_to_branch` | `worktreePath, branch` | `string` | Recovery for commits stuck on a protected branch: creates `branch` at HEAD, switches to it, and rewinds the former branch to its upstream (`origin/<default>` fallback). Returns the new branch name |
| `get_usage` | `provider?` | `UsageInfo` | Subscription usage as provider-neutral labeled windows `{ windows: [{ label, utilization, resets_at }] }` (Claude maps its 5-hour + weekly windows). `provider` (default `"claude"`) is the dispatch point for future providers — unknown ids reject. See *Subscription usage* below |
| `check_auth` | `provider?` | `boolean` | Whether a login exists for the provider's account (local credential read only, no network; same keychain/file source as `get_usage`, same `provider` gate). `false` = definitively no credentials; ambiguous environment failures reject so the UI never false-alarms. Drives the first-run "sign in" notice |
| `get_scripts` | `repoPath` | `ScriptsConfig` | Parsed `scripts` section of the repo's `.trickshot/settings.json` (missing file → empty config). See *Project scripts* below |
| `run_script` | `repoPath, worktree, name` | `void` | Launches a script BY NAME (`"setup"` / `"archive"` / a run-script name) inside the worktree. The command string is always read from the settings file in Rust — the webview can never execute an arbitrary string. Output streams as `script-event`s |
| `run_script_blocking` | `repoPath, worktree, name` | `string` | Runs a script BY NAME to completion, returning stdout (Err = stderr). The awaited sibling of `run_script`, used for the archive hook (must finish before the worktree dir is deleted) |
| `stop_script` | `worktree` | `void` | Kills that worktree's running script (and its process group) |
| `pr_status` | `worktreePath` | `PrInfo \| null` | The current branch's PR + CI check rollup via `gh pr view` (null = no PR yet). Uses the user's existing `gh auth login` — no token plumbing (`src-tauri/src/github.rs`) |
| `pr_create` | `worktreePath, title, body, base?, draft` | `string` | `gh pr create` for the current (pushed) branch; returns the PR URL |
| `pr_merge` | `worktreePath` | `string` | `gh pr merge --squash` for the current branch's open PR (UI gates on green checks; gh enforces protections) |
| `generate_commit_message` | `worktreePath` | `string` | One-shot `claude -p` over the working diff (staged if any, else vs HEAD) → a conventional-commit message. Resolves the same PATH `claude` binary as the chat (`terminal::claude_cli`) — no API key (`src-tauri/src/generate.rs`) |
| `generate_pr_text` | `worktreePath, base?` | `PrText` | One-shot `claude -p` over the commits on HEAD beyond `base` (default: repo default branch) → `{ title, body }` for the Create-PR dialog |
| `generate_branch_name` | `worktreePath` | `string` | One-shot `claude -p` over the working diff → a slugged, `validate_branch`-safe branch name for the move-to-branch flow |
| `check_cli` | — | `boolean` | Whether the `claude` CLI resolves on the login shell's PATH (onboarding preflight; the binary sibling of `check_auth`'s credential probe) |
| `session_exists` | `worktree, sessionId, provider?` | `boolean` | Whether a session's transcript exists in the worktree's session store — the multi-chat open decision (existing → `--resume`; never-written → re-create under the same `--session-id`). Provider-gated |
| `term_open` | `worktree, rows, cols, launch?, resumeSessionId?, chat?, sessionId?` | `boolean` (spawned; false = already alive, the webview forces a repaint) | Opens (idempotent) a PTY, cwd = the worktree (`src-tauri/src/terminal.rs`). Default: the user's login shell. `launch: "claude"` runs the Claude Code CLI instead (optionally `--resume <resumeSessionId>` OR `--session-id <sessionId>` for a deterministically-named NEW session; both validated UUID-shaped, argv-only) on a chat-slot PTY keyed `worktree + "\u0000claude"` (+`:<chat>` for non-default chats, validated slug) — the chat surface (see *The CLI chat surface* above). `launch` is a fixed whitelist name; Rust resolves the binary via the login shell (`command -v claude`), never a command string from the webview (the run_script posture). Output streams as `term-event`s (`{ worktree: <pty key>, kind: "data" \| "exit", data }`, mirrored by the TS `TermEnvelope`); the webview side is xterm.js (`lib/terminal.ts` keeps one instance per key so scrollback survives tab switches) |
| `term_write` / `term_resize` | `worktree, data` / `worktree, rows, cols` | `void` | Keystrokes → PTY / fit-addon size → PTY |
| `term_close` | `worktree` | `void` | Kills that worktree's PTY (all PTYs are killed on app quit) |
| `save_attachment` | `data, ext` | `string` (absolute path) | Persists a pasted attachment (base64 clipboard bytes) to a time-stamped file under the OS temp dir (`trickshot-attachments/`), returning its path — the composer inserts that path into the prompt text, since a PTY carries only text and the CLI reads files by path. Extension sanitized to alphanumerics (default `png`) |
| `latest_session_id` | `worktree, provider?` | `string \| null` | The newest Claude Code session id for the worktree (newest `.jsonl` by mtime in `~/.claude/projects/<encoded cwd>/`; encoding = every non-alphanumeric byte → `-`). Resume FORKS a new session id, so every CLI open adopts this as the live thread. Provider-gated like `get_usage` (the session-store layout is Claude-specific) |
| `claude_config_overview` | — | `ClaudeOverview` | One scan of the user's global Claude Code config (`src-tauri/src/claude_config.rs`): raw `settings.json`/`settings.local.json`/`CLAUDE.md` texts (absent → null, reads capped at 1 MiB), `agents/*.md` + `commands/**/*.md` + `skills/*/SKILL.md` entry lists (names/paths only — bodies load lazily), the user-scope `mcpServers` object extracted from `~/.claude.json` (the REST of that file is dropped in Rust; it's CLI state), and the `projects/` session dirs. Powers the Settings › Global Claude tab |
| `read_claude_file` | `file` | `string` | One whitelisted file under `~/.claude`, by root-relative path: exactly `settings.json`/`settings.local.json`/`CLAUDE.md`, or a `.md` under `agents/`/`commands/`/`skills/`. Path components are validated (no `..`/absolute/backslash) AND the canonicalized result must stay under the canonicalized root (symlink-escape guard); 1 MiB cap |
| `write_claude_file` | `file, contents` | `void` | Writes ONE of exactly `settings.json` / `CLAUDE.md` (an exact whitelist, no prefix logic). `settings.json` must parse as JSON before the write (a typo must not brick the user's CLI); writes are atomic (tmp + rename) and `~/.claude` is created if missing so a first-ever CLAUDE.md works. Never touches `~/.claude.json` — the CLI rewrites that file constantly and a racing write could corrupt it |

**Subscription usage (`get_usage`, `src-tauri/src/usage.rs`).** A best-effort read of the account's usage windows for the header chip (`UsageIndicator.svelte`). The wire shape is provider-neutral (`UsageInfo { windows: [{ label, utilization, resets_at }] }`, `src/lib/types.ts`); the Claude probe (the only one today, gated by the commands' `provider` arg) reuses the **existing Claude Code login** — NO API key: it reads the OAuth access token from the macOS keychain (`security find-generic-password -s "Claude Code-credentials"`) or `~/.claude/.credentials.json`, then GETs the undocumented `api.anthropic.com/api/oauth/usage` endpoint with that bearer token and maps the response into "5-hour window" + "Weekly" windows. The reqwest client and `claude-code/<version>` UA are cached in `OnceLock` statics; the blocking credential read runs on `spawn_blocking`. The endpoint is aggressively rate-limited, so the webview throttles `refreshUsage()` (event-driven on launch / turn end, ≤ once per 90s) and the last value is persisted (`trickshot.usageLimits`) so the chip shows immediately on launch. Every failure path maps to `Err(String)`; a transient 401/429 leaves the last good value in place.

**Events.** Two worktree-tagged channels, both carrying the shared `WorktreeEvent { worktree, kind, data }` struct (`worktree_map.rs`): `script-event` (`started` | `stdout` | `stderr` | `exit`) and `term-event` (`data` | `exit`, where `worktree` is the PTY key — a worktree path or its claude-slot composite). Mirrored by the TS `ScriptEnvelope`/`TermEnvelope` (types.ts); the conformance test pins the seam. The frontend routes by `worktree`.

**Command threading.** Network- or subprocess-bound commands are `async fn` + `tauri::async_runtime::spawn_blocking` (every git command in `worktree.rs`, the `gh` calls in `github.rs`, the usage/auth probes, `run_script`/`stop_script`, `term_open`) so a slow remote can never freeze the main thread. Fast writes (`term_write`/`term_resize`) stay sync on purpose — a runtime hop per keystroke adds latency.

**Project scripts (`src-tauri/src/scripts.rs`).** Conductor-style per-repo scripts, declared in a repo-committed `.trickshot/settings.json` so a team shares one workflow:

```json
{
  "scripts": {
    "setup": "bun install && cp ../.env .env",
    "run": { "dev": "bun run dev --port $TRICKSHOT_PORT", "test": "bun test" },
    "archive": "docker compose down",
    "run_mode": "concurrent"
  }
}
```

- **setup** runs when a worktree is created (a fresh worktree only has git-tracked files — install deps, copy `.env`). **run** scripts (one string, or an object of named scripts) launch from the header Run button. **archive** runs before a workspace is archived (clean up resources living outside the worktree dir). `run_mode: "nonconcurrent"` makes starting a run script stop every other running script first (default `"concurrent"`).
- Scripts execute as `sh -lc <command>` with cwd = the worktree, in their **own process group** (stopping kills the whole tree, e.g. a dev server), with env: `TRICKSHOT_PORT` (the base of a per-worktree block of 10 ports, deterministically derived from the worktree path — use `$TRICKSHOT_PORT`…`+9` so parallel worktrees never collide), `TRICKSHOT_WORKSPACE_PATH`, `TRICKSHOT_ROOT_PATH` (the main repo), `TRICKSHOT_WORKSPACE_NAME`.
- One script per worktree: launching a new one replaces the old. All script processes (and PTYs) are killed on app quit by the lib.rs exit handler.
- Output events: a single `script-event` carrying `{ worktree, kind, data }`, where `kind` is `started` (data = script name) | `stdout` | `stderr` (one output line) | `exit` (data = status code, or null when killed). Routed by `lib/scriptEvents.ts` into the per-worktree `scriptRunByWorktree` store (16ms-batched output tail) and rendered by the ViewToggle "run" tab (`RunOutput.svelte`).

## Providers

The app is Claude-only today but keeps ONE deliberate dispatch seam: `src/lib/providers.ts` is the webview's provider DISPLAY registry (per-provider copy: sign-in banner text + usage footnote + auth-error matching), keyed by the worktree's provider id (`providerByWorktree`, default `claude`), and the account probes (`get_usage`/`check_auth`/`latest_session_id`) take a `provider` arg that rejects unknown ids instead of silently reporting Claude's numbers. A second provider means: its own CLI in the `term_open` launch whitelist, its own probe arms in `usage.rs`/`agent.rs`, and a registry entry — the UI stays provider-neutral.

## Packaging notes

- No external binaries ship with the app — the CLI is the user's own install, resolved from their login shell's PATH at runtime (`check_cli` is the onboarding preflight).
- Spawning happens in plain Rust (portable-pty + `std::process::Command`), so no Tauri shell capability is needed; the capability file only grants dialog.

## Boundaries (what's intentionally not here)

- Repos, the selected worktree, theme/font settings, the review queue, and archived-workspace history persist to `localStorage`. Chat history does NOT live in the app — it's Claude Code's own session store (`~/.claude/projects/…`), which also gives resume-on-reopen for free.
- The agent's configuration surface (model, permission mode, MCP connectors, slash commands, system prompt) is Claude Code's own — configure it with `claude config` / `claude mcp` / `~/.claude` / repo `CLAUDE.md`, not in the app. The Settings › Global Claude tab (`claude_config_overview`/`read_claude_file`/`write_claude_file`) VIEWS that config and edits exactly `~/.claude/settings.json` + the global `CLAUDE.md` in place — still Claude Code's own files, no app layer or cache on top.
- No cap on concurrent worktrees — each open worktree holds a PTY (cheap) and whatever the CLI itself uses.
- No `git` branch deletion on worktree removal, no dirty-state guards beyond the confirm dialogs.
- Worktree dir layout is fixed (`../.<repo>-worktrees/<branch>`); make it configurable as needed.
