use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// One sidecar process per worktree, keyed by worktree path. Worktrees run
/// concurrently — each keeps its own live agent.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, CommandChild>>);

impl Sessions {
    /// Lock, recovering from poisoning. The map of children is plain data and
    /// is safe to use even if a thread panicked while holding the lock; without
    /// this, one panic-under-lock would brick the whole agent subsystem. The ONE
    /// way to lock `Sessions` — every caller (including the lib.rs exit handler)
    /// goes through here so the poison-recovery is never re-hand-rolled.
    pub(crate) fn lock(&self) -> MutexGuard<'_, HashMap<String, CommandChild>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Set `key` to `val` on a sidecar command when present (used for the always-set
/// optional knobs). Returns the command so calls chain off the builder.
fn env_opt(cmd: Command, key: &str, val: Option<&str>) -> Command {
    match val {
        Some(v) => cmd.env(key, v),
        None => cmd,
    }
}

/// Like `env_opt`, but also skips an empty string (for the JSON-blob / free-text
/// knobs where "" means "unset", not "set to empty").
fn env_nonempty(cmd: Command, key: &str, val: Option<&str>) -> Command {
    match val {
        Some(v) if !v.is_empty() => cmd.env(key, v),
        _ => cmd,
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
// Many optional knobs (resume, permission mode, system-prompt append, MCP
// servers, subagents, provider) ride in as separate Tauri command args.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn start_session(
    app: AppHandle,
    worktree: String,
    resume: Option<String>,
    permission_mode: Option<String>,
    system_prompt_append: Option<String>,
    mcp_servers: Option<String>,
    agents: Option<String>,
    provider: Option<String>,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    // Hold the lock across spawn+insert so two concurrent calls can't both pass
    // the "already running?" check and double-spawn. spawn() is synchronous and
    // never re-locks Sessions, so this can't deadlock.
    let mut map = state.lock();
    if map.contains_key(&worktree) {
        return Ok(());
    }

    let command = app
        .shell()
        .sidecar("agent")
        .map_err(|e| e.to_string())?
        .env("PROJECT_DIR", &worktree)
        // Which provider adapter the sidecar loads (see sidecar/providers).
        // Defaults to "claude" in the sidecar when unset.
        .env("AGENT_PROVIDER", provider.as_deref().unwrap_or("claude"));
    // Optional knobs, each forwarded as a sidecar env var. resume/permission_mode
    // are set whenever present; the JSON-blob / free-text knobs also skip "".
    //   RESUME_SESSION      — resume a prior agent session (restores its context)
    //   PERMISSION_MODE     — default/acceptEdits/plan/bypassPermissions (sidecar defaults to bypass)
    //   SYSTEM_PROMPT_APPEND — extra text appended to the preset system prompt
    //   MCP_SERVERS / AGENTS — JSON object strings the sidecar parses
    let command = env_opt(command, "RESUME_SESSION", resume.as_deref());
    let command = env_opt(command, "PERMISSION_MODE", permission_mode.as_deref());
    let command = env_nonempty(
        command,
        "SYSTEM_PROMPT_APPEND",
        system_prompt_append.as_deref(),
    );
    let command = env_nonempty(command, "MCP_SERVERS", mcp_servers.as_deref());
    let command = env_nonempty(command, "AGENTS", agents.as_deref());

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    // Capture this child's pid so the reader task can prove it still owns the map
    // entry before removing it on exit (see the identity-checked cleanup below).
    let pid = child.pid();
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
        // session never leaves a stale key that would block restarting it. Remove
        // ONLY if our child still owns the entry: a stop_session + start_session
        // race can replace it with a fresh child (different pid) before we reach
        // here, and an unconditional remove would orphan that live sidecar.
        if let Some(state) = handle.try_state::<Sessions>() {
            let mut map = state.lock();
            if map.get(&key).map(|c| c.pid()) == Some(pid) {
                map.remove(&key);
            }
        }
        let _ = handle.emit(
            "agent-event",
            AgentEvent {
                worktree: key,
                kind: "terminated".into(),
                data: exit_code,
            },
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

/// Kill a worktree's sidecar (no-op if it isn't running).
#[tauri::command]
pub fn stop_session(worktree: String, state: State<'_, Sessions>) -> Result<(), String> {
    if let Some(child) = state.lock().remove(&worktree) {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
