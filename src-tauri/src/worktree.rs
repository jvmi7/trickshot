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
#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
    let out = git(&repo_path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_list(&out))
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
pub fn create_worktree(
    repo_path: String,
    branch: String,
    base_ref: Option<String>,
) -> Result<Worktree, String> {
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
}

/// Remove a worktree (its branch is left intact).
#[tauri::command]
pub fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--"); // terminate options; the path can't be parsed as a flag
    args.push(&worktree_path);
    git(&repo_path, &args)?;
    Ok(())
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
        });
    }

    (branch, ahead, behind, has_upstream, files)
}

/// The repo's default branch from `origin/HEAD` ("origin/main" → "main").
/// Local-only lookup (no network); None when origin/HEAD is unset.
fn default_branch(worktree_path: &str) -> Option<String> {
    let out = git(
        worktree_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()?;
    out.trim().strip_prefix("origin/").map(str::to_string)
}

/// Commits on HEAD beyond `origin/<default>` (0 when the ref is unknown).
fn ahead_of(worktree_path: &str, default: &str) -> i32 {
    git(
        worktree_path,
        &["rev-list", "--count", &format!("origin/{default}..HEAD")],
    )
    .ok()
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0)
}

/// Parsed `git status --porcelain=v1 --branch` for a worktree.
#[tauri::command]
pub fn worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    let out = git(&worktree_path, &["status", "--porcelain=v1", "--branch"])?;
    let (branch, ahead, behind, has_upstream, files) = parse_status(&out);
    let (insertions, deletions) = diff_shortstat(&worktree_path);
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
}

/// Sync a worktree's branch with its upstream: `git pull --rebase --autostash`
/// (rebases local commits onto the remote tip; autostash carries uncommitted
/// work across). Conflicts abort the rebase back to the pre-pull state and
/// surface as an Err — nothing is left mid-rebase for the UI to manage.
#[tauri::command]
pub fn worktree_pull(worktree_path: String) -> Result<String, String> {
    match git(&worktree_path, &["pull", "--rebase", "--autostash"]) {
        Ok(out) => Ok(out),
        Err(e) => {
            // Best-effort: never strand the worktree mid-rebase.
            let _ = git(&worktree_path, &["rebase", "--abort"]);
            Err(e)
        }
    }
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
pub fn worktree_diff(
    worktree_path: String,
    file: Option<String>,
    base: Option<String>,
) -> Result<String, String> {
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
}

/// Stage paths (`git add`); with an empty list, stage everything (`git add -A`).
#[tauri::command]
pub fn worktree_stage(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<String> = vec!["add".into()];
    if paths.is_empty() {
        args.push("-A".into());
    } else {
        args.push("--".into());
        args.extend(paths);
    }
    git(&worktree_path, &args)?;
    Ok(())
}

/// Unstage paths (`git restore --staged`); with an empty list, unstage all.
#[tauri::command]
pub fn worktree_unstage(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<String> = vec!["restore".into(), "--staged".into()];
    if paths.is_empty() {
        args.push(".".into());
    } else {
        args.push("--".into());
        args.extend(paths);
    }
    git(&worktree_path, &args)?;
    Ok(())
}

/// Commit the staged changes. Returns git's stdout; a "nothing to commit" or
/// other failure propagates as an Err for the UI to surface.
#[tauri::command]
pub fn worktree_commit(worktree_path: String, message: String) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("commit message is required".into());
    }
    git(&worktree_path, &["commit", "-m", message])
}

/// Push the current branch. With `set_upstream`, push `-u origin <branch>` so a
/// brand-new branch is tracked (and GitHub prints its create-PR link on stderr).
#[tauri::command]
pub fn worktree_push(
    worktree_path: String,
    set_upstream: bool,
    force: bool,
) -> Result<String, String> {
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
}

/// Merge `branch` into the branch currently checked out at `repo_path` (the main
/// worktree). Conflicts/failures surface as an Err with git's stderr.
#[tauri::command]
pub fn worktree_merge(repo_path: String, branch: String) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch is required".into());
    }
    git(&repo_path, &["merge", "--no-ff", branch])
}

#[cfg(test)]
mod tests {
    use super::{parse_shortstat, parse_status, parse_worktree_list, validate_branch};

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
