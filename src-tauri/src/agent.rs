use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::settings;

/// A live sidecar: its child handle plus a liveness flag. When a session is
/// superseded (a provider switch via `restart_session`) or stopped, the flag is
/// cleared so its reader task goes silent — it must NOT emit late events (a
/// trailing `terminated`/`models`/transcript line) that would clobber the
/// replacement session running under the same worktree key.
type Session = (Arc<AtomicBool>, CommandChild);

/// One sidecar process per worktree, keyed by worktree path. Worktrees run
/// concurrently — each keeps its own live agent.
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Session>>);

impl Sessions {
    /// Lock, recovering from poisoning. The map is plain data and is safe to use
    /// even if a thread panicked while holding the lock; without this, one
    /// panic-under-lock would brick the whole agent subsystem.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Session>> {
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

/// Spawn a sidecar for `worktree` and wire its reader task. The caller holds the
/// `Sessions` lock (passed as `map`) so the spawn+insert is atomic against
/// concurrent starts/restarts. `spawn()` is synchronous and never re-locks
/// `Sessions`, so holding the lock here can't deadlock.
fn spawn_session(
    app: &AppHandle,
    map: &mut HashMap<String, Session>,
    worktree: String,
    resume: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    let provider_id = provider.as_deref().unwrap_or("claude");

    let mut command = app
        .shell()
        .sidecar("agent")
        .map_err(|e| e.to_string())?
        .env("PROJECT_DIR", &worktree)
        // Which provider adapter the sidecar loads (see sidecar/providers).
        // Defaults to "claude" in the sidecar when unset.
        .env("AGENT_PROVIDER", provider_id);

    // GLM runs the SAME native binary against Z.ai's Anthropic-compatible
    // endpoint; the SDK has no base-url/key option, so we point the binary there
    // via env. Claude sessions get neither var (they use the Claude Code login).
    if provider_id == "glm" {
        let key = settings::zai_api_key().ok_or("Z.ai API key not set — add it in Settings")?;
        command = command
            .env("ANTHROPIC_BASE_URL", settings::zai_base_url())
            .env("ANTHROPIC_AUTH_TOKEN", key);
    }

    // Resume a prior agent session (restores its context) when the UI has a
    // persisted id for this worktree; the sidecar reads RESUME_SESSION.
    if let Some(id) = resume.as_deref() {
        command = command.env("RESUME_SESSION", id);
    }

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    let alive = Arc::new(AtomicBool::new(true));
    map.insert(worktree.clone(), (alive.clone(), child));

    let handle = app.clone();
    let key = worktree;
    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<String> = None;
        while let Some(event) = rx.recv().await {
            // Superseded (restarted) or stopped: go silent. A late line from a
            // dead sidecar must never reach the UI or the replacement's state.
            if !alive.load(Ordering::Relaxed) {
                return;
            }
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
        // Genuine exit (channel close / Terminated). If we were superseded/stopped
        // in the meantime, stay silent and leave the map to whoever replaced us.
        if !alive.load(Ordering::Relaxed) {
            return;
        }
        // Clean up + report `terminated` only if we're STILL the current session
        // for this key (a restart may have swapped in a new child under the same
        // key just as we exited — identity-check via the liveness Arc).
        let still_current = handle
            .try_state::<Sessions>()
            .map(|state| {
                let mut map = state.lock();
                let mine = map.get(&key).is_some_and(|(a, _)| Arc::ptr_eq(a, &alive));
                if mine {
                    map.remove(&key);
                }
                mine
            })
            .unwrap_or(false);
        if still_current {
            let _ = handle.emit(
                "agent-event",
                AgentEvent {
                    worktree: key,
                    kind: "terminated".into(),
                    data: exit_code,
                },
            );
        }
    });

    Ok(())
}

/// Start a sidecar for `worktree` (cwd = the worktree path). Idempotent: a
/// no-op if one is already running for that worktree.
#[tauri::command]
pub fn start_session(
    app: AppHandle,
    worktree: String,
    resume: Option<String>,
    provider: Option<String>,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    // Hold the lock across the contains-key check + spawn+insert so two concurrent
    // calls can't both pass the check and double-spawn.
    let mut map = state.lock();
    if map.contains_key(&worktree) {
        return Ok(());
    }
    spawn_session(&app, &mut map, worktree, resume, provider)
}

/// Restart `worktree`'s sidecar under a (possibly different) provider — the
/// model-provider switch path, since a provider is fixed for a sidecar's life.
/// Atomic under the lock: the old session is silenced + killed before the new one
/// is spawned, so the UI only ever sees the replacement's events.
#[tauri::command]
pub fn restart_session(
    app: AppHandle,
    worktree: String,
    resume: Option<String>,
    provider: Option<String>,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    let mut map = state.lock();
    if let Some((alive, child)) = map.remove(&worktree) {
        alive.store(false, Ordering::Relaxed);
        let _ = child.kill();
    }
    spawn_session(&app, &mut map, worktree, resume, provider)
}

/// Write a raw JSON line (built by the frontend) to a worktree's sidecar stdin.
#[tauri::command]
pub fn send_to_session(
    worktree: String,
    payload: String,
    state: State<'_, Sessions>,
) -> Result<(), String> {
    let mut map = state.lock();
    let session = map.get_mut(&worktree).ok_or("session not running")?;
    let mut bytes = payload.into_bytes();
    bytes.push(b'\n'); // sidecar reads stdin line-by-line
    session.1.write(&bytes).map_err(|e| e.to_string())
}

/// Kill a worktree's sidecar (no-op if it isn't running).
#[tauri::command]
pub fn stop_session(worktree: String, state: State<'_, Sessions>) -> Result<(), String> {
    if let Some((alive, child)) = state.lock().remove(&worktree) {
        // Silence the reader so its trailing `terminated` can't flap the UI.
        alive.store(false, Ordering::Relaxed);
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
