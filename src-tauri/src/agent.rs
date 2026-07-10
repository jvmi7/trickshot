use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::worktree_map::{lock_ignore_poison, next_generation, WorktreeEvent, WorktreeMap};

/// One live sidecar session. The child sits behind its own Arc'd lock so
/// stdin writes happen WITHOUT holding the Sessions map lock — one
/// backpressured sidecar must not stall every other worktree's send. `Option`
/// because CommandChild::kill consumes self: killing takes the child out,
/// leaving a tombstone any in-flight writer sees as "session not running".
/// `generation` disambiguates a respawned session at the same key so a stale
/// reader task can't clean up its successor.
pub(crate) struct SessionEntry {
    child: Arc<Mutex<Option<CommandChild>>>,
    generation: u64,
}

impl SessionEntry {
    /// Take and kill the child (no-op if already killed). pub(crate): the
    /// lib.rs exit handler kills all sidecars on quit through this too.
    pub(crate) fn kill(&self) {
        if let Some(child) = lock_ignore_poison(&self.child).take() {
            let _ = child.kill();
        }
    }
}

/// One sidecar process per worktree (poison-safe lock via WorktreeMap).
pub type Sessions = WorktreeMap<SessionEntry>;

/// Start a sidecar for `worktree` (cwd = the worktree path). Idempotent: a
/// no-op if one is already running for that worktree.
///
/// All start-up knobs (provider, resume, permission mode, system-prompt append,
/// MCP servers, subagents) ride in ONE opaque JSON blob (`config`, the app's
/// `SessionConfig`) forwarded verbatim as the `SESSION_CONFIG` env var. Rust does
/// not parse or enumerate the fields — the sidecar does that once in core.ts — so
/// adding a knob never touches this signature. `PROJECT_DIR` (the worktree path,
/// = the sidecar's project dir) stays a separate env var.
#[tauri::command]
pub fn start_session(
    app: AppHandle,
    worktree: String,
    config: Option<String>,
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
    // Forward the session config blob verbatim (skip an empty/absent one so the
    // sidecar falls back to its own defaults).
    if let Some(cfg) = config.as_deref().filter(|c| !c.is_empty()) {
        command = command.env("SESSION_CONFIG", cfg);
    }

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;
    // Stamp this spawn so the reader task can prove it still owns the map entry
    // before removing it on exit (see the identity-checked cleanup below).
    let generation = next_generation();
    map.insert(
        worktree.clone(),
        SessionEntry {
            child: Arc::new(Mutex::new(Some(child))),
            generation,
        },
    );
    drop(map);

    let handle = app.clone();
    let key = worktree;
    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<String> = None;
        while let Some(event) = rx.recv().await {
            let evt = match event {
                CommandEvent::Stdout(bytes) => WorktreeEvent {
                    worktree: key.clone(),
                    kind: "stdout".into(),
                    data: Some(String::from_utf8_lossy(&bytes).to_string()),
                },
                CommandEvent::Stderr(bytes) => WorktreeEvent {
                    worktree: key.clone(),
                    kind: "stderr".into(),
                    data: Some(String::from_utf8_lossy(&bytes).to_string()),
                },
                CommandEvent::Error(err) => WorktreeEvent {
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
        // ONLY if our spawn still owns the entry: a stop_session + start_session
        // race can replace it with a fresh child (different generation) before we
        // reach here, and an unconditional remove would orphan that live sidecar.
        if let Some(state) = handle.try_state::<Sessions>() {
            let mut map = state.lock();
            if map.get(&key).map(|e| e.generation) == Some(generation) {
                map.remove(&key);
            }
        }
        let _ = handle.emit(
            "agent-event",
            WorktreeEvent {
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
    // Clone the entry's Arc under a brief map lock, then write OUTSIDE it: a
    // blocking (backpressured) stdin write must only stall THIS worktree's
    // sends, never the whole fleet.
    let child = {
        let map = state.lock();
        map.get(&worktree)
            .ok_or("session not running")?
            .child
            .clone()
    };
    let mut guard = lock_ignore_poison(&child);
    let child = guard.as_mut().ok_or("session not running")?;
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
    let entry = state.lock().remove(&worktree);
    if let Some(entry) = entry {
        entry.kill();
    }
    Ok(())
}

/// Kill every sidecar (the lib.rs exit handler — without this the app quit
/// would orphan the ~279MB-resident per-worktree agent processes).
pub(crate) fn kill_all(state: &Sessions) {
    for (_, entry) in state.lock().drain() {
        entry.kill();
    }
}
