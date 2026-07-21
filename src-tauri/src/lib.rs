mod agent;
mod generate;
mod github;
mod scripts;
mod terminal;
mod usage;
mod worktree;
mod worktree_map;

use scripts::ScriptProcs;
use tauri::{Manager, RunEvent};
use terminal::Terminals;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScriptProcs::default())
        .manage(Terminals::default())
        .invoke_handler(tauri::generate_handler![
            agent::latest_session_id,
            worktree::pick_directory,
            worktree::repo_icon,
            worktree::home_dir,
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
            worktree::worktree_pull,
            worktree::worktree_move_to_branch,
            scripts::get_scripts,
            scripts::run_script,
            scripts::run_script_blocking,
            scripts::stop_script,
            github::pr_status,
            github::pr_create,
            github::pr_merge,
            generate::generate_commit_message,
            generate::generate_pr_text,
            generate::generate_branch_name,
            terminal::check_cli,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            usage::get_usage,
            usage::check_auth,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill all running scripts and PTYs when the app quits so we don't
            // orphan a dev server a run script started or a claude CLI on a PTY.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<ScriptProcs>() {
                    scripts::kill_all(&state);
                }
                if let Some(state) = app_handle.try_state::<Terminals>() {
                    terminal::kill_all(&state);
                }
            }
        });
}
