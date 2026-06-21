use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the running sidecar process so `send_to_agent` can write to its stdin.
#[derive(Default)]
pub struct AgentState(pub Mutex<Option<CommandChild>>);

/// Spawn the sidecar with cwd = `project_dir` (a repo or worktree path).
/// Replaces any already-running session.
#[tauri::command]
pub fn start_agent(
    app: AppHandle,
    project_dir: String,
    state: State<'_, AgentState>,
) -> Result<(), String> {
    // Tear down a previous session, if any.
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }

    // sidecar() returns Result<Command> — propagate failures.
    let command = app
        .shell()
        .sidecar("agent")
        .map_err(|e| e.to_string())?
        .env("PROJECT_DIR", project_dir);

    // spawn() -> (Receiver<CommandEvent>, CommandChild). stdout is line-buffered by default.
    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // One JSON object per event (newline stripped).
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = handle.emit("agent-stdout", line);
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = handle.emit("agent-stderr", line);
                }
                CommandEvent::Error(err) => {
                    let _ = handle.emit("agent-error", err);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = handle.emit("agent-terminated", payload.code);
                    if let Some(state) = handle.try_state::<AgentState>() {
                        *state.0.lock().unwrap() = None;
                    }
                    break;
                }
                // CommandEvent is #[non_exhaustive].
                _ => {}
            }
        }
    });

    Ok(())
}

/// Send a raw JSON line (built by the frontend) to the sidecar's stdin.
#[tauri::command]
pub fn send_to_agent(state: State<'_, AgentState>, payload: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let child = guard.as_mut().ok_or("agent not started")?;
    let mut bytes = payload.into_bytes();
    bytes.push(b'\n'); // sidecar reads stdin line-by-line
    child.write(&bytes).map_err(|e| e.to_string())
}

/// Kill the current sidecar process.
#[tauri::command]
pub fn stop_agent(state: State<'_, AgentState>) -> Result<(), String> {
    if let Some(child) = state.0.lock().unwrap().take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
