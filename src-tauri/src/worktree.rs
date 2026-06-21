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
    if branch.is_empty() {
        return Err("branch name is required".into());
    }

    let repo = Path::new(&repo_path);
    let repo_name = repo
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo");
    let parent = repo
        .parent()
        .ok_or("repository path has no parent directory")?;

    // Preserve slashes as nested directories (avoids feature/foo vs feature-foo
    // collisions); `git worktree add` creates intermediate parent dirs.
    let wt_dir = parent
        .join(format!(".{repo_name}-worktrees"))
        .join(&branch);
    let wt_path = wt_dir.to_string_lossy().to_string();

    // Does the branch already exist?
    let branch_exists = Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .status()
        .map_err(|e| format!("failed to run git: {e}"))?
        .success();

    if branch_exists {
        // base_ref has no meaning for an already-existing branch; fail loudly
        // rather than silently ignoring it.
        if base_ref.is_some() {
            return Err("base_ref cannot be applied to an existing branch".into());
        }
        git(&repo_path, &["worktree", "add", &wt_path, &branch])?;
    } else {
        let base = base_ref.unwrap_or_else(|| "HEAD".to_string());
        git(&repo_path, &["worktree", "add", "-b", &branch, &wt_path, &base])?;
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
    args.push(&worktree_path);
    git(&repo_path, &args)?;
    Ok(())
}
