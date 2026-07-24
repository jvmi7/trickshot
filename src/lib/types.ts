// The app-side types for the UI: the git objects (`Worktree`, `Repo`,
// `GitFileStatus`/`GitStatus`), the subscription `UsageWindow`/`UsageInfo`,
// project scripts, PR shapes, and the worktree-tagged event envelopes
// (`ScriptEnvelope`/`TermEnvelope`). Each mirrors its Rust struct
// field-for-field (snake_case results — see CLAUDE.md boundary casing).

/** A git worktree as reported by the worktree commands. `is_bare` marks a bare
 *  entry (no working files — can't host an agent; openRepository skips it). */
export interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  locked: boolean;
  is_bare: boolean;
}

/** A git repository the user has added to the sidebar (persisted). */
export interface Repo {
  path: string;
  name: string;
}

/** One changed path in a worktree (mirrors the Rust `FileStatus`). `index` and
 *  `worktree` are the staged/unstaged sides of `git status`'s XY code. */
export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  /** Per-file lines added/removed vs HEAD (null for untracked/binary files). */
  insertions: number | null;
  deletions: number | null;
}

/** A worktree's working-tree status (mirrors the Rust `WorktreeStatus`). */
export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  /** Whether the branch has an upstream; ahead/behind are only meaningful when
   *  true. False = unpublished branch. */
  has_upstream: boolean;
  /** The repo default branch (from origin/HEAD), or null when unknown. */
  default_branch: string | null;
  /** Commits on HEAD beyond origin/<default_branch> (0 when unknown) — whether
   *  a PR has anything to propose. */
  ahead_of_default: number;
  /** Lines added/removed vs HEAD (staged + unstaged tracked changes). */
  insertions: number;
  deletions: number;
  files: GitFileStatus[];
}

/** One subscription usage window (mirrors the Rust `UsageWindow`). Provider-
 *  neutral: the Rust probe maps its provider-specific response into labeled
 *  windows (for Claude: "5-hour window" + "Weekly") and the UI renders whatever
 *  arrives. `utilization` is a percent (0–100). */
export interface UsageWindow {
  label: string;
  utilization: number | null;
  resets_at: string | null;
}

/** Subscription usage from the `get_usage` command (mirrors the Rust
 *  `UsageInfo`): an ordered list of windows, most immediate first. */
export interface UsageInfo {
  windows: UsageWindow[];
}

/** One named run script from `.trickshot/settings.json` (mirrors the Rust
 *  `RunScript`). */
export interface RunScriptInfo {
  name: string;
  command: string;
}

/** A repo's project-scripts config (mirrors the Rust `ScriptsConfig`): the
 *  setup/archive hooks + the Run button's named scripts. */
export interface ScriptsConfig {
  setup: string | null;
  run: RunScriptInfo[];
  archive: string | null;
  run_mode: "concurrent" | "nonconcurrent";
}

/** One CI check on a PR (mirrors the Rust `PrCheck`), normalized from GitHub's
 *  CheckRun/StatusContext shapes. */
export interface PrCheck {
  name: string;
  status: "pass" | "fail" | "pending" | "skipped";
  link: string | null;
}

/** The current branch's PR + check rollup (mirrors the Rust `PrInfo`). */
export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  base: string;
  is_draft: boolean;
  checks: PrCheck[];
}

/** A generated pull-request title + body (mirrors the Rust `PrText`). */
export interface PrText {
  title: string;
  body: string;
}

/** System output volume + mute state (mirrors the Rust `VolumeInfo`). */
export interface VolumeInfo {
  volume: number;
  muted: boolean;
}

/** One file in the global Claude Code config scan (mirrors the Rust
 *  `ClaudeEntry`). `file` is root-relative and valid as `readClaudeFile`'s
 *  argument. */
export interface ClaudeEntry {
  name: string;
  file: string;
  size: number;
  modified_ms: number | null;
}

/** One `~/.claude/projects/<encoded>` session dir (mirrors the Rust
 *  `ClaudeProject`). The dir-name encoding is lossy — display as-is. */
export interface ClaudeProject {
  dir: string;
  sessions: number;
  modified_ms: number | null;
}

/** Everything set up in the user's global Claude Code config (mirrors the Rust
 *  `ClaudeOverview`) — the Settings › Global Claude tab's data. Raw file texts
 *  are `null` when absent; `mcp_servers` is the pretty-printed `mcpServers`
 *  object extracted from `~/.claude.json` (`null` = none configured). */
export interface ClaudeOverview {
  root: string;
  settings: string | null;
  settings_local: string | null;
  claude_md: string | null;
  agents: ClaudeEntry[];
  commands: ClaudeEntry[];
  skills: ClaudeEntry[];
  mcp_servers: string | null;
  projects: ClaudeProject[];
}

/** Envelope for a worktree-tagged script event on the `script-event` channel
 *  (mirrors the Rust `ScriptEvent` struct in scripts.rs — the scripts sibling
 *  of `AgentEnvelope`). `data` is the script name for `started`, an output line
 *  for `stdout`/`stderr`, and the status code (or null) for `exit`. */
export interface ScriptEnvelope {
  worktree: string;
  kind: "started" | "stdout" | "stderr" | "exit";
  data: string | null;
}

/** Envelope for a worktree-tagged terminal event on the `term-event` channel
 *  (mirrors the Rust `TermEvent` struct in terminal.rs). `data` is a raw PTY
 *  output chunk for `data`, null for `exit`. */
export interface TermEnvelope {
  worktree: string;
  kind: "data" | "exit";
  data: string | null;
}
