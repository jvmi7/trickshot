// Protocol truth for the UI side. The wire unions (`Inbound`/`Outbound`/
// `AgentMessage`/`ModelInfo`) live in `shared/protocol.ts` and are imported by
// BOTH this file and the sidecar (`sidecar/core.ts`) so the two TS mirrors can't
// drift. This file re-exports them and adds the app-only types (`TranscriptMessage`,
// `Worktree`, `Repo`, the git-review `GitFileStatus`/`GitStatus`, the subscription
// `UsageWindow`/`UsageInfo`, and the `AgentEnvelope` event wrapper). The sidecar writes one JSON object per
// line to stdout; Rust relays each line as a worktree-tagged `agent-event` Tauri
// event; api.ts parses them.

export type {
  AgentMessage,
  ConnectorInfo,
  ConnectorTool,
  Inbound,
  McpStatusInfo,
  ModelInfo,
  ModelRating,
  Outbound,
  PermissionMode,
  Question,
  QuestionOption,
  SessionConfig,
  SlashCommandInfo,
  TurnUsage,
} from "../../shared/protocol";

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

/** Envelope for a worktree-tagged agent event on the `agent-event` channel
 *  (mirrors the Rust `AgentEvent` struct in agent.rs). */
export interface AgentEnvelope {
  worktree: string;
  kind: "stdout" | "stderr" | "error" | "terminated";
  data: string | null;
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
