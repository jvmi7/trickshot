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
}

/// Run `git -C <repo> <args...>`, returning stdout or a stderr-derived error.
fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
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

        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            }
        }

        if let Some(path) = path {
            result.push(Worktree {
                path,
                branch,
                head,
                is_main: first,
                locked,
            });
            first = false;
        }
    }

    Ok(result)
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

    let repo = Path::new(&repo_path);
    let repo_name = repo.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
    let parent = repo
        .parent()
        .ok_or("repository path has no parent directory")?;

    // Preserve slashes as nested directories (avoids feature/foo vs feature-foo
    // collisions); `git worktree add` creates intermediate parent dirs.
    let wt_base = parent.join(format!(".{repo_name}-worktrees"));
    let wt_dir = wt_base.join(&branch);
    // Defense in depth: keep the worktree inside its base dir as an explicit,
    // enforced invariant — not an emergent side effect of git's ref validation.
    // (Lexical check; `validate_branch` already rejected the `..`/absolute cases
    // that `starts_with` alone wouldn't catch.)
    if !wt_dir.starts_with(&wt_base) {
        return Err("refusing to create a worktree outside the worktrees directory".into());
    }
    let wt_path = wt_dir.to_string_lossy().to_string();

    // Does the branch already exist?
    let branch_exists = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .status()
        .map_err(|e| format!("failed to run git: {e}"))?
        .success();

    if branch_exists {
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
/// upstream, and the list of changed files.
#[derive(Serialize)]
pub struct WorktreeStatus {
    pub branch: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    /// Lines added/removed vs HEAD (staged + unstaged tracked changes).
    pub insertions: i32,
    pub deletions: i32,
    pub files: Vec<FileStatus>,
}

/// Insertions/deletions vs HEAD (`git diff HEAD --shortstat`). Best-effort: a
/// repo with no commits (no HEAD) or any git error yields (0, 0).
fn diff_shortstat(worktree_path: &str) -> (i32, i32) {
    let Ok(out) = git(worktree_path, &["diff", "HEAD", "--shortstat"]) else {
        return (0, 0);
    };
    // e.g. ` 3 files changed, 12 insertions(+), 4 deletions(-)`
    let (mut ins, mut del) = (0, 0);
    for part in out.split(',') {
        let p = part.trim();
        let Some(n) = p.split_whitespace().next().and_then(|t| t.parse::<i32>().ok()) else {
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

/// Parsed `git status --porcelain=v1 --branch` for a worktree.
#[tauri::command]
pub fn worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    let out = git(&worktree_path, &["status", "--porcelain=v1", "--branch"])?;
    let mut files = Vec::new();
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // `## main...origin/main [ahead 1, behind 2]` (or just `## main`).
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

    let (insertions, deletions) = diff_shortstat(&worktree_path);
    Ok(WorktreeStatus {
        branch,
        ahead,
        behind,
        insertions,
        deletions,
        files,
    })
}

/// `git diff --no-index <null> <file>` — an all-addition diff for an untracked
/// file. `--no-index` exits 1 when the files differ (the normal case here), so
/// treat 0/1 as success and only >1 as a real error.
fn git_no_index_diff(repo: &str, file: &str) -> Result<String, String> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["diff", "--no-index", "--", null, file])
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
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let diff = git(&worktree_path, &refs)?;
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
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(&worktree_path, &refs)?;
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
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(&worktree_path, &refs)?;
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
pub fn worktree_push(worktree_path: String, set_upstream: bool) -> Result<String, String> {
    if set_upstream {
        let branch = git(&worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        git(&worktree_path, &["push", "-u", "origin", &branch])
    } else {
        git(&worktree_path, &["push"])
    }
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
    use super::validate_branch;

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
}
