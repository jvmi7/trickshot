use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    /// The porcelain `bare` attribute: a bare entry has no working files, so it
    /// can't host an agent session (openRepository skips it at add time).
    pub is_bare: bool,
}

/// Build `git -C <repo> <args...>` as a Command. The ONE place the `-C <repo>` +
/// program setup lives; callers that need custom exit-code handling (a status-only
/// probe, a `--no-index` diff) build on this, while the common
/// stdout-or-stderr-error case goes through `git`. Generic over the arg element so
/// a `&[&str]` literal or an owned `Vec<String>` both work without a collect.
fn git_command<S: AsRef<str>>(repo: &str, args: &[S]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(args.iter().map(|a| AsRef::<str>::as_ref(a)));
    cmd
}

/// Run `git -C <repo> <args...>`, returning stdout or a stderr-derived error.
/// pub(crate): github.rs's PR preflights reuse this rather than forking a
/// second git runner.
pub(crate) fn git<S: AsRef<str>>(repo: &str, args: &[S]) -> Result<String, String> {
    let output = git_command(repo, args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Validate a user-supplied branch name before it flows into a filesystem path
/// AND a git ref. Path containment must not depend on git's incidental ref rules:
/// reject leading `-` (option injection), absolute paths, `..` segments, and
/// control chars up front. git's own `check-ref-format` still applies on top.
fn validate_branch(branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err("branch name is required".into());
    }
    if branch.starts_with('-') {
        return Err("branch name cannot start with '-'".into());
    }
    if branch.starts_with('/') || branch.starts_with('\\') {
        return Err("branch name cannot be an absolute path".into());
    }
    if branch.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("branch name cannot contain '..'".into());
    }
    if branch.chars().any(|c| c.is_control()) {
        return Err("branch name cannot contain control characters".into());
    }
    Ok(())
}

/// Native folder picker. Returns the chosen absolute path (or None if cancelled).
/// Marked async so it runs off the main thread, where blocking_pick_folder is safe.
#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// List worktrees via `git worktree list --porcelain`. The first entry is the main worktree.
/// Async + spawn_blocking (like every command below that shells git): a sync
/// command runs on the main thread, and even a "fast" git subprocess would
/// freeze the UI for its duration — network round-trips (push/pull/merge)
/// would freeze it for seconds. Same shape as github.rs's `gh` commands.
#[tauri::command]
pub async fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = git(&repo_path, &["worktree", "list", "--porcelain"])?;
        Ok(parse_worktree_list(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Parse `git worktree list --porcelain` output (blank-line-separated blocks of
/// `worktree <path>` / `HEAD <sha>` / `branch <ref>` / `locked` / `bare` lines).
fn parse_worktree_list(out: &str) -> Vec<Worktree> {
    let mut result = Vec::new();
    let mut first = true;

    for block in out.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }
        let mut path: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut head: Option<String> = None;
        let mut locked = false;
        let mut is_bare = false;

        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            } else if line == "bare" {
                is_bare = true;
            }
        }

        if let Some(path) = path {
            result.push(Worktree {
                path,
                branch,
                head,
                is_main: first,
                locked,
                is_bare,
            });
            first = false;
        }
    }

    result
}

/// Derive (and containment-check) the worktree directory for `branch` under the
/// sibling `.<repo-name>-worktrees/` dir. Containment is an explicit, enforced
/// invariant — not an emergent side effect of git's ref validation. (Lexical
/// check; `validate_branch` already rejected the `..`/absolute cases that
/// `starts_with` alone wouldn't catch.)
fn worktree_path_for(repo_path: &str, branch: &str) -> Result<String, String> {
    let repo = Path::new(repo_path);
    let repo_name = repo.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
    let parent = repo
        .parent()
        .ok_or("repository path has no parent directory")?;

    // Preserve slashes as nested directories (avoids feature/foo vs feature-foo
    // collisions); `git worktree add` creates intermediate parent dirs.
    let wt_base = parent.join(format!(".{repo_name}-worktrees"));
    let wt_dir = wt_base.join(branch);
    if !wt_dir.starts_with(&wt_base) {
        return Err("refusing to create a worktree outside the worktrees directory".into());
    }
    Ok(wt_dir.to_string_lossy().to_string())
}

/// Whether `refs/heads/<branch>` already exists in the repo (a status-only probe).
fn branch_exists(repo: &str, branch: &str) -> Result<bool, String> {
    Ok(git_command(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .status()
    .map_err(|e| format!("failed to run git: {e}"))?
    .success())
}

/// Create a worktree (and the branch, if new) under a sibling
/// `.<repo-name>-worktrees/<branch>` directory. This is the one-click primitive.
#[tauri::command]
pub async fn create_worktree(
    repo_path: String,
    branch: String,
    base_ref: Option<String>,
) -> Result<Worktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = branch.trim().to_string();
        validate_branch(&branch)?;

        let wt_path = worktree_path_for(&repo_path, &branch)?;

        if branch_exists(&repo_path, &branch)? {
            // base_ref has no meaning for an already-existing branch; fail loudly
            // rather than silently ignoring it.
            if base_ref.is_some() {
                return Err("base_ref cannot be applied to an existing branch".into());
            }
            // `--` terminates options so a value can never be parsed as a git flag.
            git(&repo_path, &["worktree", "add", &wt_path, "--", &branch])?;
        } else {
            let base = base_ref.unwrap_or_else(|| "HEAD".to_string());
            git(
                &repo_path,
                &["worktree", "add", "-b", &branch, &wt_path, "--", &base],
            )?;
        }

        // Read HEAD from the new worktree (not the main repo) so it reflects `base_ref`.
        let head = git(&wt_path, &["rev-parse", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());

        Ok(Worktree {
            path: wt_path,
            branch: Some(branch),
            head,
            is_main: false,
            locked: false,
            is_bare: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a worktree (its branch is left intact).
#[tauri::command]
pub async fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push("--"); // terminate options; the path can't be parsed as a flag
        args.push(&worktree_path);
        git(&repo_path, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Git review (status / diff / stage / commit / push / merge) ----

/// One changed path in a worktree, mirroring `git status --porcelain=v1`'s
/// two-char XY code: `index` is the staged side, `worktree` the unstaged side.
#[derive(Serialize)]
pub struct FileStatus {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub staged: bool,
    /// Per-file lines added/removed vs HEAD (from `--numstat`). None for
    /// untracked files (numstat doesn't see them) and binary files (`-`).
    pub insertions: Option<i32>,
    pub deletions: Option<i32>,
}

/// A worktree's working-tree status: current branch, ahead/behind counts vs its
/// upstream, and the list of changed files — plus the branch-state facts the
/// UI's stateful git buttons key off (upstream existence, the repo's default
/// branch, commits over it).
#[derive(Serialize)]
pub struct WorktreeStatus {
    pub branch: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    /// Whether the branch has an upstream (`## br...origin/br`); ahead/behind
    /// are only meaningful when true. False = unpublished branch.
    pub has_upstream: bool,
    /// The repo default branch (from `origin/HEAD`), e.g. "main". None when
    /// there's no origin or the ref is unset — the UI falls back to permissive
    /// buttons rather than guessing.
    pub default_branch: Option<String>,
    /// Commits on HEAD beyond `origin/<default_branch>` (0 when unknown) —
    /// whether there is anything a PR could propose.
    pub ahead_of_default: i32,
    /// Lines added/removed vs HEAD (staged + unstaged tracked changes).
    pub insertions: i32,
    pub deletions: i32,
    pub files: Vec<FileStatus>,
}

/// Parse a `git diff --shortstat` line into (insertions, deletions). Pure (no git
/// invocation) so it's unit-testable; `diff_shortstat` wraps it with the git call.
/// e.g. ` 3 files changed, 12 insertions(+), 4 deletions(-)` → (12, 4). A line with
/// only one side (or an empty/`0 files changed` line) leaves the other at 0.
fn parse_shortstat(out: &str) -> (i32, i32) {
    let (mut ins, mut del) = (0, 0);
    for part in out.split(',') {
        let p = part.trim();
        let Some(n) = p
            .split_whitespace()
            .next()
            .and_then(|t| t.parse::<i32>().ok())
        else {
            continue;
        };
        if p.contains("insertion") {
            ins = n;
        } else if p.contains("deletion") {
            del = n;
        }
    }
    (ins, del)
}

/// Insertions/deletions vs HEAD (`git diff HEAD --shortstat`). Best-effort: a
/// repo with no commits (no HEAD) or any git error yields (0, 0).
fn diff_shortstat(worktree_path: &str) -> (i32, i32) {
    let Ok(out) = git(worktree_path, &["diff", "HEAD", "--shortstat"]) else {
        return (0, 0);
    };
    parse_shortstat(&out)
}

/// Resolve a `--numstat` path cell to the post-change path. Renames arrive as
/// either `old => new` or the bracket form `dir/{old => new}/file`; keep the
/// destination.
fn numstat_path(cell: &str) -> String {
    if let (Some(open), Some(close)) = (cell.find('{'), cell.find('}')) {
        if let Some(arrow) = cell[open..close].find(" => ") {
            let new_mid = &cell[open + arrow + 4..close];
            let mut p = format!("{}{}{}", &cell[..open], new_mid, &cell[close + 1..]);
            // A rename INTO the tree root leaves a leading "/" artifact
            // (`{old => }/file` → "/file"); normalize doubled slashes too.
            p = p.replace("//", "/");
            return p.trim_start_matches('/').to_string();
        }
    }
    if let Some(pos) = cell.find(" => ") {
        return cell[pos + 4..].to_string();
    }
    cell.to_string()
}

/// Parse `git diff --numstat` output into (path → (insertions, deletions)).
/// Binary files report `-\t-` and are omitted (the UI shows them unbadged).
/// Pure so it's unit-testable; `worktree_status` folds it into the file list.
fn parse_numstat(out: &str) -> std::collections::HashMap<String, (i32, i32)> {
    let mut map = std::collections::HashMap::new();
    for line in out.lines() {
        let mut cols = line.splitn(3, '\t');
        let (Some(ins), Some(del), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let (Ok(ins), Ok(del)) = (ins.trim().parse::<i32>(), del.trim().parse::<i32>()) else {
            continue; // binary: "-\t-"
        };
        map.insert(numstat_path(path), (ins, del));
    }
    map
}

/// Parse `git status --porcelain=v1 --branch` output into (branch, ahead, behind,
/// has_upstream, files). Pure (no git invocation) so it's unit-testable;
/// `worktree_status` wraps it with the git call and folds in the diffstat.
fn parse_status(out: &str) -> (Option<String>, i32, i32, bool, Vec<FileStatus>) {
    let mut files = Vec::new();
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut has_upstream = false;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // `## main...origin/main [ahead 1, behind 2]` (or just `## main`).
            // The `...` marks a configured upstream.
            has_upstream = rest.contains("...");
            let name = rest
                .split("...")
                .next()
                .unwrap_or(rest)
                .split_whitespace()
                .next()
                .unwrap_or("");
            if !name.is_empty() {
                branch = Some(name.to_string());
            }
            if let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) {
                for part in rest[open + 1..close].split(',') {
                    let p = part.trim();
                    if let Some(n) = p.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = p.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let x = &line[0..1];
        let y = &line[1..2];
        let mut path = line[3..].to_string();
        // Renames/copies report `orig -> new`; keep the new path.
        if let Some(pos) = path.find(" -> ") {
            path = path[pos + 4..].to_string();
        }
        files.push(FileStatus {
            path,
            index: x.to_string(),
            worktree: y.to_string(),
            staged: x != " " && x != "?",
            // Filled from --numstat by worktree_status (None = untracked/binary).
            insertions: None,
            deletions: None,
        });
    }

    (branch, ahead, behind, has_upstream, files)
}

/// Pick a default branch name from the probe results, most-authoritative first:
/// `origin/HEAD` if set, then a well-known remote branch that exists, then a
/// well-known local branch. Pure (takes booleans, does no git I/O) so the
/// fallback ORDER is unit-testable; `default_branch` supplies the probes.
fn pick_default_branch(
    origin_head: Option<&str>,
    origin_main: bool,
    origin_master: bool,
    local_main: bool,
    local_master: bool,
) -> Option<String> {
    if let Some(name) = origin_head.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(name.to_string());
    }
    if origin_main || local_main {
        return Some("main".to_string());
    }
    if origin_master || local_master {
        return Some("master".to_string());
    }
    None
}

/// The repo's default branch. Prefers `origin/HEAD` ("origin/main" → "main"),
/// but that local ref is frequently unset (never written by `git init` + remote
/// add, and not always after a clone), so it falls back to a well-known remote
/// branch (origin/main|master) and finally a local one. Local-only (no network);
/// None only when nothing resolves. Keeping this permissive is what lets the PR
/// UI's `ahead_of_default` gate show the Create-PR button (see `ahead_of`).
/// pub(crate): `generate.rs` reuses it to pick a PR base when none is given.
pub(crate) fn default_branch(worktree_path: &str) -> Option<String> {
    let origin_head = git(
        worktree_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .map(|s| s.trim().trim_start_matches("origin/").to_string())
    .filter(|s| !s.is_empty());

    pick_default_branch(
        origin_head.as_deref(),
        ref_exists(worktree_path, "refs/remotes/origin/main"),
        ref_exists(worktree_path, "refs/remotes/origin/master"),
        ref_exists(worktree_path, "refs/heads/main"),
        ref_exists(worktree_path, "refs/heads/master"),
    )
}

/// Whether a fully-qualified ref resolves in the repo (a status-only probe).
fn ref_exists(worktree_path: &str, full_ref: &str) -> bool {
    git_command(
        worktree_path,
        &["show-ref", "--verify", "--quiet", full_ref],
    )
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

/// Commits on HEAD beyond the default branch. Tries the remote-tracking ref
/// `origin/<default>` first (what a PR would actually diff against), then falls
/// back to the local `<default>` when the remote ref was never fetched — so a
/// never-pushed branch still reports a truthful count. 0 when neither resolves.
fn ahead_of(worktree_path: &str, default: &str) -> i32 {
    let count = |range: String| -> Option<i32> {
        git(worktree_path, &["rev-list", "--count", &range])
            .ok()
            .and_then(|s| s.trim().parse().ok())
    };
    count(format!("origin/{default}..HEAD"))
        .or_else(|| count(format!("{default}..HEAD")))
        .unwrap_or(0)
}

/// Parsed `git status --porcelain=v1 --branch` for a worktree. Async: this
/// spawns FOUR git subprocesses — far too much work for the main thread.
#[tauri::command]
pub async fn worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // `--untracked-files=all` lists individual files inside a new/untracked
        // directory instead of collapsing it to `newdir/` — the UI needs each file.
        let out = git(
            &worktree_path,
            &[
                "status",
                "--porcelain=v1",
                "--branch",
                "--untracked-files=all",
            ],
        )?;
        let (branch, ahead, behind, has_upstream, mut files) = parse_status(&out);
        let (insertions, deletions) = diff_shortstat(&worktree_path);
        // Per-file ± counts (best-effort; untracked/binary files stay None).
        let numstat = git(&worktree_path, &["diff", "HEAD", "--numstat"])
            .map(|o| parse_numstat(&o))
            .unwrap_or_default();
        for f in &mut files {
            if let Some(&(ins, del)) = numstat.get(&f.path) {
                f.insertions = Some(ins);
                f.deletions = Some(del);
            }
        }
        let default = default_branch(&worktree_path);
        let ahead_of_default = default
            .as_deref()
            .map_or(0, |d| ahead_of(&worktree_path, d));
        Ok(WorktreeStatus {
            branch,
            ahead,
            behind,
            has_upstream,
            default_branch: default,
            ahead_of_default,
            insertions,
            deletions,
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sync a worktree's branch with its upstream: `git pull --rebase --autostash`
/// (rebases local commits onto the remote tip; autostash carries uncommitted
/// work across). Conflicts abort the rebase back to the pre-pull state and
/// surface as an Err — nothing is left mid-rebase for the UI to manage.
#[tauri::command]
pub async fn worktree_pull(worktree_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match git(&worktree_path, &["pull", "--rebase", "--autostash"]) {
            Ok(out) => Ok(out),
            Err(e) => {
                // Best-effort: never strand the worktree mid-rebase.
                let _ = git(&worktree_path, &["rebase", "--abort"]);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git diff --no-index <null> <file>` — an all-addition diff for an untracked
/// file. `--no-index` exits 1 when the files differ (the normal case here), so
/// treat 0/1 as success and only >1 as a real error.
fn git_no_index_diff(repo: &str, file: &str) -> Result<String, String> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let output = git_command(repo, &["diff", "--no-index", "--", null, file])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    match output.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }
}

/// Unified diff of uncommitted changes vs `base` (default `HEAD`), optionally
/// scoped to one file. Falls back to an untracked-file diff when the tracked
/// diff is empty for a specific file (i.e. the file is new and unstaged).
#[tauri::command]
pub async fn worktree_diff(
    worktree_path: String,
    file: Option<String>,
    base: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = base.unwrap_or_else(|| "HEAD".to_string());
        let mut args: Vec<String> = vec!["diff".into(), base];
        if let Some(f) = &file {
            args.push("--".into());
            args.push(f.clone());
        }
        let diff = git(&worktree_path, &args)?;
        if diff.trim().is_empty() {
            if let Some(f) = &file {
                return git_no_index_diff(&worktree_path, f);
            }
        }
        Ok(diff)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stage paths (`git add`); with an empty list, stage everything (`git add -A`).
#[tauri::command]
pub async fn worktree_stage(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["add".into()];
        if paths.is_empty() {
            args.push("-A".into());
        } else {
            args.push("--".into());
            args.extend(paths);
        }
        git(&worktree_path, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unstage paths (`git restore --staged`); with an empty list, unstage all.
#[tauri::command]
pub async fn worktree_unstage(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["restore".into(), "--staged".into()];
        if paths.is_empty() {
            args.push(".".into());
        } else {
            args.push("--".into());
            args.extend(paths);
        }
        git(&worktree_path, &args)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commit the staged changes. Returns git's stdout; a "nothing to commit" or
/// other failure propagates as an Err for the UI to surface.
#[tauri::command]
pub async fn worktree_commit(worktree_path: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err("commit message is required".into());
        }
        git(&worktree_path, &["commit", "-m", message])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Push the current branch. With `set_upstream`, push `-u origin <branch>` so a
/// brand-new branch is tracked (and GitHub prints its create-PR link on stderr).
#[tauri::command]
pub async fn worktree_push(
    worktree_path: String,
    set_upstream: bool,
    force: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec!["push".into()];
        // --force-with-lease, never bare --force: overwrites the remote only if it
        // still is what we last fetched — a diverged-but-stale remote (rebase,
        // amend, stale twin push) is replaced; anything pushed since is protected.
        if force {
            args.push("--force-with-lease".into());
        }
        if set_upstream {
            let branch = git(&worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
                .trim()
                .to_string();
            args.extend(["-u".into(), "origin".into(), branch]);
        }
        git(&worktree_path, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge `branch` into the branch currently checked out at `repo_path` (the main
/// worktree). Conflicts/failures surface as an Err with git's stderr.
#[tauri::command]
pub async fn worktree_merge(repo_path: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("branch is required".into());
        }
        git(&repo_path, &["merge", "--no-ff", branch])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move the current branch's commits onto a NEW branch, then rewind the current
/// branch back to its upstream — the recovery for "committed to a protected
/// branch that won't accept a direct push". Creates `branch` at HEAD, switches
/// to it (so the existing push/PR commands then operate on it), and force-updates
/// the former branch to its upstream (`origin/<default>` as a fallback) so it's
/// clean again. Nothing is lost — the commits ride to the new branch (and remain
/// in the reflog). Returns the new branch name. Requires a clean-enough tree; any
/// uncommitted edits are carried across the switch by git.
#[tauri::command]
pub async fn worktree_move_to_branch(
    worktree_path: String,
    branch: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let branch = branch.trim().to_string();
        validate_branch(&branch)?;
        if branch_exists(&worktree_path, &branch)? {
            return Err(format!("branch \"{branch}\" already exists"));
        }
        let current = git(&worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        if current == branch {
            return Err("already on that branch".into());
        }

        // Where to rewind the former branch to: its own upstream, else the
        // remote default branch. None → leave it (commits stay safe on `branch`).
        let target = git(
            &worktree_path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| default_branch(&worktree_path).map(|d| format!("origin/{d}")));

        // Create + switch to the new branch at the current commit.
        git(&worktree_path, &["switch", "-c", &branch])?;

        // Rewind the former branch to its upstream (best-effort; only when the ref
        // resolves and the branch isn't checked out in another worktree).
        if current != "HEAD" && current != branch {
            if let Some(target) = target {
                let full = if target.contains('/') {
                    format!("refs/remotes/{target}")
                } else {
                    format!("refs/heads/{target}")
                };
                if ref_exists(&worktree_path, &full) {
                    let _ = git(&worktree_path, &["branch", "-f", &current, &target]);
                }
            }
        }
        Ok(branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        parse_numstat, parse_shortstat, parse_status, parse_worktree_list, pick_default_branch,
        validate_branch, worktree_path_for,
    };

    // ---- parse_worktree_list (git worktree list --porcelain) ----

    #[test]
    fn worktree_list_parses_main_and_linked() {
        let out = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                   worktree /repo-worktrees/feat\nHEAD def456\nbranch refs/heads/feat\nlocked\n";
        let wts = parse_worktree_list(out);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_main && !wts[0].is_bare && !wts[0].locked);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(!wts[1].is_main && wts[1].locked);
        assert_eq!(wts[1].path, "/repo-worktrees/feat");
    }

    #[test]
    fn worktree_list_marks_a_bare_entry() {
        // A bare repo's own entry carries the `bare` attribute and no branch —
        // it has no working files, so the add flow must not activate it.
        let out = "worktree /srv/repo.git\nbare\n\n\
                   worktree /srv/checkout\nHEAD abc\nbranch refs/heads/main\n";
        let wts = parse_worktree_list(out);
        assert!(wts[0].is_bare && wts[0].is_main);
        assert!(!wts[1].is_bare);
    }

    #[test]
    fn accepts_ordinary_names() {
        for ok in ["feature", "feature/foo", "fix-123", "user.name/wip", "v2.0"] {
            assert!(validate_branch(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn rejects_option_injection() {
        // A leading '-' would be parsed by git as a flag, not a branch/commit-ish.
        assert!(validate_branch("--force").is_err());
        assert!(validate_branch("-b").is_err());
    }

    #[test]
    fn rejects_path_escape() {
        // These would otherwise let the worktree dir escape its base.
        assert!(validate_branch("/etc/passwd").is_err()); // absolute -> Path::join replaces base
        assert!(validate_branch("..").is_err());
        assert!(validate_branch("../evil").is_err());
        assert!(validate_branch("a/../../b").is_err());
        assert!(validate_branch("\\abs").is_err());
    }

    #[test]
    fn rejects_control_chars_and_empty() {
        assert!(validate_branch("").is_err());
        assert!(validate_branch("a\nb").is_err());
        assert!(validate_branch("a\0b").is_err());
    }

    // ---- worktree_path_for (the containment guard) ----

    #[test]
    fn worktree_path_lands_under_the_sibling_base() {
        let p = worktree_path_for("/home/u/repo", "feat").unwrap();
        assert_eq!(p, "/home/u/.repo-worktrees/feat");
        // Slashes nest as directories (feature/foo vs feature-foo stay distinct).
        let nested = worktree_path_for("/home/u/repo", "feature/foo").unwrap();
        assert_eq!(nested, "/home/u/.repo-worktrees/feature/foo");
    }

    #[test]
    fn worktree_path_rejects_an_absolute_branch() {
        // Path::join with an absolute path REPLACES the base entirely — the
        // starts_with check is what catches it. (This is the case the lexical
        // guard covers itself; `..`/control chars are validate_branch's job,
        // which create_worktree runs first — see rejects_path_escape above.)
        assert!(worktree_path_for("/home/u/repo", "/etc/passwd").is_err());
    }

    #[test]
    fn worktree_path_guard_pairs_with_validate_branch() {
        // The security invariant is the PAIR: every branch create_worktree
        // accepts must resolve inside the base. Sweep the validate_branch
        // corpus and assert containment holds for everything it lets through.
        for b in ["feature", "feature/foo", "fix-123", "user.name/wip", "v2.0"] {
            assert!(validate_branch(b).is_ok());
            let p = worktree_path_for("/home/u/repo", b).unwrap();
            assert!(
                p.starts_with("/home/u/.repo-worktrees/"),
                "{b:?} escaped: {p}"
            );
        }
    }

    // ---- parse_shortstat (git diff --shortstat) ----

    #[test]
    fn shortstat_parses_both_sides() {
        let line = " 3 files changed, 12 insertions(+), 4 deletions(-)";
        assert_eq!(parse_shortstat(line), (12, 4));
    }

    #[test]
    fn shortstat_parses_insertions_only() {
        // A new-file-only / additions-only change reports no deletions clause.
        assert_eq!(parse_shortstat(" 1 file changed, 7 insertions(+)"), (7, 0));
    }

    #[test]
    fn shortstat_parses_deletions_only() {
        assert_eq!(parse_shortstat(" 1 file changed, 5 deletions(-)"), (0, 5));
    }

    #[test]
    fn shortstat_handles_singular_units() {
        // git uses the singular "insertion(+)"/"deletion(-)" for a count of 1 —
        // the `contains("insertion")`/`contains("deletion")` match must still hit.
        assert_eq!(
            parse_shortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)"),
            (1, 1)
        );
    }

    #[test]
    fn shortstat_empty_or_garbage_is_zero() {
        // Empty output (no HEAD / no changes) and unparseable text both yield (0, 0).
        assert_eq!(parse_shortstat(""), (0, 0));
        assert_eq!(parse_shortstat("not a shortstat line"), (0, 0));
    }

    // ---- parse_numstat (git diff --numstat) ----

    #[test]
    fn numstat_parses_counts_and_skips_binary() {
        let out = "12\t4\tsrc/a.rs\n0\t7\tREADME.md\n-\t-\tlogo.png\n";
        let m = parse_numstat(out);
        assert_eq!(m.get("src/a.rs"), Some(&(12, 4)));
        assert_eq!(m.get("README.md"), Some(&(0, 7)));
        assert!(!m.contains_key("logo.png")); // binary → omitted
    }

    #[test]
    fn numstat_keeps_rename_destination() {
        // Plain and bracketed rename forms both resolve to the new path.
        let m = parse_numstat("1\t1\told.rs => new.rs\n2\t0\tsrc/{a => b}/f.rs\n");
        assert_eq!(m.get("new.rs"), Some(&(1, 1)));
        assert_eq!(m.get("src/b/f.rs"), Some(&(2, 0)));
    }

    #[test]
    fn numstat_empty_or_garbage_is_empty() {
        assert!(parse_numstat("").is_empty());
        assert!(parse_numstat("not a numstat line").is_empty());
    }

    // ---- pick_default_branch (the origin/HEAD fallback order) ----

    #[test]
    fn default_branch_prefers_origin_head() {
        // origin/HEAD wins even when it disagrees with the well-known names.
        let d = pick_default_branch(Some("develop"), true, false, true, false);
        assert_eq!(d.as_deref(), Some("develop"));
    }

    #[test]
    fn default_branch_falls_back_to_remote_then_local() {
        // origin/HEAD unset → a well-known remote branch, then a local one.
        assert_eq!(
            pick_default_branch(None, true, false, false, false).as_deref(),
            Some("main")
        );
        assert_eq!(
            pick_default_branch(None, false, false, true, false).as_deref(),
            Some("main")
        );
        assert_eq!(
            pick_default_branch(None, false, true, false, false).as_deref(),
            Some("master")
        );
        // main outranks master when both exist.
        assert_eq!(
            pick_default_branch(None, false, true, true, false).as_deref(),
            Some("main")
        );
    }

    #[test]
    fn default_branch_none_when_nothing_resolves() {
        // An empty origin/HEAD string must NOT be treated as a real name.
        assert!(pick_default_branch(Some(""), false, false, false, false).is_none());
        assert!(pick_default_branch(None, false, false, false, false).is_none());
    }

    // ---- parse_status (git status --porcelain=v1 --branch) ----

    #[test]
    fn status_parses_branch_with_ahead_behind() {
        let out = "## main...origin/main [ahead 1, behind 2]\n";
        let (branch, ahead, behind, has_upstream, files) = parse_status(out);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!((ahead, behind), (1, 2));
        assert!(has_upstream); // `...origin/main` present
        assert!(files.is_empty());
    }

    #[test]
    fn status_parses_branch_without_upstream() {
        // A branch with no upstream has no `...origin/...` and no `[...]` clause.
        let (branch, ahead, behind, has_upstream, _) = parse_status("## feature/foo\n");
        assert_eq!(branch.as_deref(), Some("feature/foo"));
        assert_eq!((ahead, behind), (0, 0));
        assert!(!has_upstream); // no `...` → unpublished branch
    }

    #[test]
    fn status_parses_ahead_only() {
        let (_, ahead, behind, _, _) = parse_status("## main...origin/main [ahead 3]\n");
        assert_eq!((ahead, behind), (3, 0));
    }

    #[test]
    fn status_classifies_staged_and_unstaged() {
        // XY codes: `M ` staged, ` M` unstaged, `MM` both, `??` untracked.
        let out = "## main\nM  staged.rs\n M unstaged.rs\nMM both.rs\n?? new.rs\n";
        let (_, _, _, _, files) = parse_status(out);
        assert_eq!(files.len(), 4);

        let staged = &files[0];
        assert_eq!(staged.path, "staged.rs");
        assert!(staged.staged);

        let unstaged = &files[1];
        assert_eq!(unstaged.path, "unstaged.rs");
        assert!(!unstaged.staged); // index side is a space → unstaged

        assert!(files[2].staged); // `MM` → staged side is `M`

        let untracked = &files[3];
        assert_eq!(untracked.path, "new.rs");
        assert!(!untracked.staged); // `?` index is explicitly NOT staged
    }

    #[test]
    fn status_keeps_rename_destination() {
        // A rename reports `orig -> new`; we keep the destination path.
        let (_, _, _, _, files) = parse_status("## main\nR  old.rs -> new.rs\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.rs");
        assert!(files[0].staged);
    }

    #[test]
    fn status_empty_yields_no_branch_no_files() {
        let (branch, ahead, behind, has_upstream, files) = parse_status("");
        assert!(branch.is_none());
        assert_eq!((ahead, behind), (0, 0));
        assert!(!has_upstream);
        assert!(files.is_empty());
    }
}
