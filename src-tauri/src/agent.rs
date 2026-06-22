use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// One sidecar process per worktree, keyed by worktree path. Worktrees run
/// concurrently — each keeps its own live agent.
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, CommandChild>>);

impl Sessions {
    /// Lock, recovering from poisoning. The map of children is plain data and
    /// is safe to use even if a thread panicked while holding the lock; without
    /// this, one panic-under-lock would brick the whole agent subsystem.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, CommandChild>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Event relayed from a worktree's sidecar to the webview, tagged with the
/// worktree it belongs to so the UI can route it to the right transcript.
/// Emitted on a single `agent-event` channel.
#[derive(Clone, Serialize)]
struct AgentEvent {
    worktree: String,
    /// "stdout" | "stderr" | "error" | "terminated"
    kind: String,
    data: Option<String>,
}

/// Start a sidecar for `worktree` (cwd = the worktree path). Idempotent: a
/// no-op if one is already running for that worktree.
#[tauri::command]
pub fn start_session(
    app: AppHandle,
    worktree: String,
    resume: Option<String>,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    // Hold the lock across spawn+insert so two concurrent calls can't both pass
    // the "already running?" check and double-spawn. spawn() is synchronous and
    // never re-locks Sessions, so this can't deadlock.
    let mut map = state.lock();
    if map.contains_key(&worktree) {
        return Ok(());
    }

    let mut command = app
        .shell()
        .sidecar("agent")
        .map_err(|e| e.to_string())?
        .env("PROJECT_DIR", &worktree);
    // Resume a prior agent session (restores its context) when the UI has a
    // persisted id for this worktree; the sidecar reads RESUME_SESSION.
    if let Some(id) = resume.as_deref() {
        command = command.env("RESUME_SESSION", id);
    }

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    map.insert(worktree.clone(), child);
    drop(map);

    let handle = app.clone();
    let key = worktree;
    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<String> = None;
        while let Some(event) = rx.recv().await {
            let evt = match event {
                CommandEvent::Stdout(bytes) => AgentEvent {
                    worktree: key.clone(),
                    kind: "stdout".into(),
                    data: Some(String::from_utf8_lossy(&bytes).to_string()),
                },
                CommandEvent::Stderr(bytes) => AgentEvent {
                    worktree: key.clone(),
                    kind: "stderr".into(),
                    data: Some(String::from_utf8_lossy(&bytes).to_string()),
                },
                CommandEvent::Error(err) => AgentEvent {
                    worktree: key.clone(),
                    kind: "error".into(),
                    data: Some(err),
                },
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code.map(|c| c.to_string());
                    break;
                }
                // CommandEvent is #[non_exhaustive].
                _ => continue,
            };
            let _ = handle.emit("agent-event", evt);
        }
        // Clean up on ANY loop exit (Terminated OR channel close), so a dead
        // session never leaves a stale key that would block restarting it.
        if let Some(state) = handle.try_state::<Sessions>() {
            state.lock().remove(&key);
        }
        let _ = handle.emit(
            "agent-event",
            AgentEvent { worktree: key, kind: "terminated".into(), data: exit_code },
        );
    });

    Ok(())
}

/// Write a raw JSON line (built by the frontend) to a worktree's sidecar stdin.
#[tauri::command]
pub fn send_to_session(
    worktree: String,
    payload: String,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    let mut map = state.lock();
    let child = map.get_mut(&worktree).ok_or("session not running")?;
    let mut bytes = payload.into_bytes();
    bytes.push(b'\n'); // sidecar reads stdin line-by-line
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Kill a worktree's sidecar (no-op if it isn't running).
#[tauri::command]
pub fn stop_session(worktree: String, state: State<'_, Sessions>) -> Result<(), String> {
    if let Some(child) = state.lock().remove(&worktree) {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
