// The shared per-worktree plumbing that agent.rs, scripts.rs, and terminal.rs
// all need: a poison-safe worktree-keyed process map, the `{ worktree, kind,
// data }` event envelope every per-worktree channel (`agent-event` /
// `script-event` / `term-event`) emits, and the generation counter that lets a
// detached reader/waiter prove it still owns its map entry. ONE home so the
// three modules can't drift into three near-identical copies (they used to:
// two pid compares + one generation counter).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

/// One entry per worktree, keyed by worktree path. Worktrees run concurrently —
/// each keeps its own live process (sidecar / script / PTY).
pub struct WorktreeMap<T>(Mutex<HashMap<String, T>>);

// Manual impl: #[derive(Default)] would needlessly bound T: Default.
impl<T> Default for WorktreeMap<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T> WorktreeMap<T> {
    /// Lock, recovering from poisoning. The map of children is plain data and
    /// is safe to use even if a thread panicked while holding the lock; without
    /// this, one panic-under-lock would brick that whole subsystem. The ONE
    /// way to lock a worktree map — every caller (including the lib.rs exit
    /// handler) goes through here so the poison-recovery is never re-hand-rolled.
    pub fn lock(&self) -> MutexGuard<'_, HashMap<String, T>> {
        lock_ignore_poison(&self.0)
    }
}

/// The same poison recovery for a standalone Mutex (the per-entry writer/child
/// locks that item-level state holds outside the map).
pub fn lock_ignore_poison<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Event relayed from a worktree's process to the webview, tagged with the
/// worktree it belongs to so the UI can route it to the right consumer. The
/// ONE envelope shape for `agent-event`, `script-event`, and `term-event`
/// (mirrored by the TS `AgentEnvelope`/`ScriptEnvelope`/`TermEnvelope`; the
/// conformance test pins the seam). Field order is the wire order — keep
/// worktree, kind, data.
#[derive(Clone, Serialize)]
pub struct WorktreeEvent {
    pub worktree: String,
    /// Per channel: agent "stdout" | "stderr" | "error" | "terminated";
    /// script "started" | "stdout" | "stderr" | "exit"; term "data" | "exit".
    pub kind: String,
    pub data: Option<String>,
}

/// A per-spawn generation stamp: strictly increasing across ALL spawns (every
/// module, every worktree) so a respawn at the same key never reuses a stamp.
/// This is the identity check a detached reader/waiter uses before removing
/// "its" map entry — stronger than a pid compare, which can alias on pid reuse.
pub fn next_generation() -> u64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    GENERATION.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::{next_generation, WorktreeEvent, WorktreeMap};

    #[test]
    fn generations_are_unique_and_increasing() {
        let a = next_generation();
        let b = next_generation();
        assert!(b > a);
    }

    #[test]
    fn map_locks_and_stores_per_worktree() {
        let map: WorktreeMap<u32> = WorktreeMap::default();
        map.lock().insert("/wt".into(), 7);
        assert_eq!(map.lock().get("/wt"), Some(&7));
    }

    #[test]
    fn envelope_serializes_in_wire_order() {
        // The webview parses { worktree, kind, data } — pin the exact JSON.
        let evt = WorktreeEvent {
            worktree: "/wt".into(),
            kind: "stdout".into(),
            data: Some("x".into()),
        };
        assert_eq!(
            serde_json::to_string(&evt).unwrap(),
            r#"{"worktree":"/wt","kind":"stdout","data":"x"}"#
        );
    }
}
