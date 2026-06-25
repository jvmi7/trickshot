mod agent;
mod worktree;

use agent::Sessions;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            agent::start_session,
            agent::send_to_session,
            agent::stop_session,
            agent::notify,
            worktree::pick_directory,
            worktree::list_worktrees,
            worktree::create_worktree,
            worktree::remove_worktree,
            worktree::worktree_status,
            worktree::worktree_diff,
            worktree::worktree_stage,
            worktree::worktree_unstage,
            worktree::worktree_commit,
            worktree::worktree_push,
            worktree::worktree_merge,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill all sidecars when the app quits so we don't orphan the
            // (large) per-worktree agent processes.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<Sessions>() {
                    let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    for (_, child) in map.drain() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
