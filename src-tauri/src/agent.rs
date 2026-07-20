//! Agent-adjacent commands: the Claude Code session-store scan that powers
//! resume (`latest_session_id`) and the OS-notification bridge (`notify`).
//! The chat itself runs in the CLI on a PTY (see `terminal.rs`) — there is no
//! app-managed agent process.

use tauri::AppHandle;

/// Show a desktop notification (used to surface backgrounded-worktree activity
/// while the user is focused elsewhere).
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Encode a worktree path the way Claude Code names its per-project session
/// dir under `~/.claude/projects/`: every non-alphanumeric byte becomes `-`
/// (verified against the live store — e.g. `/a/b.c` → `-a-b-c`). Pure so it's
/// unit-testable.
fn encode_claude_project_dir(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The newest session id in `dir` by file mtime (session transcripts are
/// `<session-id>.jsonl`). `None` when the dir doesn't exist or holds no
/// sessions — not an error. Pure over a directory path so it's unit-testable.
fn newest_session_in(dir: &std::path::Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<(std::time::SystemTime, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if newest.as_ref().is_none_or(|(t, _)| mtime > *t) {
            newest = Some((mtime, stem.to_string()));
        }
    }
    newest.map(|(_, id)| id)
}

/// The most recent Claude Code session id for a worktree — the resume target
/// when (re)opening its CLI chat. Resuming FORKS a new session id, so any
/// remembered id goes stale the moment the CLI runs; the newest `.jsonl` in
/// the project's session dir is the live thread. Provider-gated like
/// `get_usage`/`check_auth`: the session store layout is Claude-specific.
#[tauri::command]
pub async fn latest_session_id(
    worktree: String,
    provider: Option<String>,
) -> Result<Option<String>, String> {
    crate::usage::ensure_known_provider(provider.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        let dir = std::path::PathBuf::from(home)
            .join(".claude")
            .join("projects")
            .join(encode_claude_project_dir(&worktree));
        Ok(newest_session_in(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{encode_claude_project_dir, newest_session_in};

    #[test]
    fn encodes_every_non_alphanumeric_byte_as_dash() {
        assert_eq!(
            encode_claude_project_dir("/Users/me/proj.name"),
            "-Users-me-proj-name"
        );
        // `/.` produces a double dash (verified against the live store, e.g.
        // `…/gamma-interview/.claude/…` → `…-gamma-interview--claude-…`).
        assert_eq!(
            encode_claude_project_dir("/a/.claude/worktrees/x_1"),
            "-a--claude-worktrees-x-1"
        );
        assert_eq!(encode_claude_project_dir("plain123"), "plain123");
    }

    #[test]
    fn newest_session_scan_picks_latest_jsonl_and_ignores_noise() {
        let dir = std::env::temp_dir().join(format!("trickshot-scan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("older.jsonl"), "{}").unwrap();
        std::fs::write(dir.join("not-a-session.txt"), "x").unwrap();
        // Ensure a strictly newer mtime on the second file (fs mtime
        // granularity can be 1s on some filesystems).
        let newer = dir.join("newer.jsonl");
        std::fs::write(&newer, "{}").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        let f = std::fs::File::options().write(true).open(&newer).unwrap();
        f.set_modified(later).unwrap();

        assert_eq!(newest_session_in(&dir).as_deref(), Some("newer"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn newest_session_scan_handles_missing_or_empty_dir() {
        let missing = std::env::temp_dir().join("trickshot-scan-definitely-missing");
        assert_eq!(newest_session_in(&missing), None);
        let empty =
            std::env::temp_dir().join(format!("trickshot-scan-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(newest_session_in(&empty), None);
        std::fs::remove_dir_all(&empty).unwrap();
    }
}
