// Integrated per-worktree terminal: a real PTY (portable-pty) running the
// user's shell with cwd = the worktree, streamed to the webview's xterm.js as
// `term-event`s ({ worktree, kind, data } — the terminal sibling of
// `agent-event`/`script-event`). One PTY per worktree, spawned lazily when the
// Terminal tab opens (`term_open` is idempotent) and killed on close/app quit.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::worktree_map::{lock_ignore_poison, next_generation, WorktreeEvent, WorktreeMap};

/// One live PTY session. `generation` disambiguates a respawned session at the
/// same key so a stale reader thread can't clean up its successor (the same
/// identity check as agent.rs/scripts.rs). The writer sits behind its own
/// Arc'd lock so keystrokes are written WITHOUT holding the Terminals map lock
/// — one flow-controlled PTY must not stall every worktree's terminal.
pub(crate) struct TermSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    generation: u64,
}

/// One PTY per worktree (poison-safe lock via WorktreeMap).
pub type Terminals = WorktreeMap<TermSession>;

/// Kill every PTY (the lib.rs exit handler).
pub(crate) fn kill_all(state: &Terminals) {
    for (_, mut s) in state.lock().drain() {
        let _ = s.child.kill();
    }
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Drain the decodable prefix of `carry` as a String, leaving an incomplete
/// trailing UTF-8 sequence in place for the next chunk. Returns None when the
/// buffer holds only an incomplete tail. Genuinely invalid bytes (binary
/// spew) decode lossily rather than stalling the stream. Pure, unit-tested —
/// the fix for multi-byte chars split across PTY reads rendering as ��.
fn drain_utf8(carry: &mut Vec<u8>) -> Option<String> {
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let s = s.to_string();
            carry.clear();
            Some(s)
        }
        // error_len() == None means "unexpected end": a valid-so-far sequence
        // is cut off at the buffer end — emit the prefix, keep the tail.
        Err(e) if e.error_len().is_none() && e.valid_up_to() > 0 => {
            let s = String::from_utf8_lossy(&carry[..e.valid_up_to()]).into_owned();
            carry.drain(..e.valid_up_to());
            Some(s)
        }
        Err(e) if e.error_len().is_none() => None,
        Err(_) => {
            let s = String::from_utf8_lossy(carry).into_owned();
            carry.clear();
            Some(s)
        }
    }
}

/// Open (or no-op if already open) a PTY for `worktree`, running the user's
/// login shell with cwd = the worktree. Output streams as `term-event`s.
/// Async + spawn_blocking: spawning the shell is a subprocess launch and must
/// run off the main thread.
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    worktree: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Terminals>();
        // Hold the lock across the spawn+insert (same double-spawn guard as
        // start_session).
        let mut map = state.lock();
        if map.contains_key(&worktree) {
            return Ok(());
        }

        let pair = native_pty_system()
            .openpty(size(rows.max(2), cols.max(2)))
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(windows) {
                "powershell.exe"
            } else {
                "/bin/zsh"
            }
            .to_string()
        });
        let mut cmd = CommandBuilder::new(&shell);
        if !cfg!(windows) {
            cmd.arg("-l"); // login shell, so the user's profile/PATH load
        }
        cmd.cwd(&worktree);
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave); // the child owns the slave side now
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Stamp this spawn so the reader thread can prove it still owns the map
        // entry before removing it on EOF (see the identity-checked cleanup below).
        let generation = next_generation();

        map.insert(
            worktree.clone(),
            TermSession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                generation,
            },
        );
        drop(map);

        // Reader thread: relay chunks with a UTF-8 carry. A multi-byte character
        // split across two reads must NOT be decoded lossily per chunk — TUIs
        // paint long runs of 3-byte box-drawing chars (─), so chunk boundaries
        // routinely land mid-character and per-chunk decoding renders �� garbage.
        // Keep the incomplete trailing sequence and prepend it to the next read.
        // On EOF the shell exited — clean up (only if we still own the entry) and
        // emit the final `exit`.
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        carry.extend_from_slice(&buf[..n]);
                        let Some(text) = drain_utf8(&mut carry) else {
                            continue; // only an incomplete tail so far — wait for more bytes
                        };
                        let _ = app.emit(
                            "term-event",
                            WorktreeEvent {
                                worktree: worktree.clone(),
                                kind: "data".into(),
                                data: Some(text),
                            },
                        );
                    }
                }
            }
            if let Some(state) = app.try_state::<Terminals>() {
                let mut map = state.lock();
                if map.get(&worktree).map(|s| s.generation) == Some(generation) {
                    map.remove(&worktree);
                }
            }
            let _ = app.emit(
                "term-event",
                WorktreeEvent {
                    worktree,
                    kind: "exit".into(),
                    data: None,
                },
            );
        });

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write user keystrokes to a worktree's PTY. Deliberately sync (a runtime hop
/// per keystroke would add latency); the write happens OUTSIDE the map lock so
/// a flow-controlled PTY only stalls its own worktree's keystrokes.
#[tauri::command]
pub fn term_write(
    worktree: String,
    data: String,
    state: State<'_, Terminals>,
) -> Result<(), String> {
    let writer = {
        let map = state.lock();
        map.get(&worktree)
            .ok_or("terminal not open")?
            .writer
            .clone()
    };
    let result = lock_ignore_poison(&writer).write_all(data.as_bytes());
    result.map_err(|e| e.to_string())
}

/// Resize a worktree's PTY (the webview's fit addon drives this).
#[tauri::command]
pub fn term_resize(
    worktree: String,
    rows: u16,
    cols: u16,
    state: State<'_, Terminals>,
) -> Result<(), String> {
    let map = state.lock();
    let session = map.get(&worktree).ok_or("terminal not open")?;
    session
        .master
        .resize(size(rows.max(2), cols.max(2)))
        .map_err(|e| e.to_string())
}

/// Kill a worktree's PTY (no-op if none). The reader thread sees EOF and emits
/// the final `exit` event.
#[tauri::command]
pub fn term_close(worktree: String, state: State<'_, Terminals>) -> Result<(), String> {
    let session = state.lock().remove(&worktree);
    if let Some(mut session) = session {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::drain_utf8;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    #[test]
    fn utf8_carry_survives_split_multibyte() {
        // "──" is six bytes; split mid-character like a chunked PTY read would.
        let bytes = "──".as_bytes();
        let mut carry = bytes[..4].to_vec(); // first char + 1 byte of the second
        let first = drain_utf8(&mut carry).expect("prefix should decode");
        assert_eq!(first, "─");
        assert_eq!(carry.len(), 1); // the split byte stays carried
        carry.extend_from_slice(&bytes[4..]);
        assert_eq!(drain_utf8(&mut carry).as_deref(), Some("─"));
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_carry_waits_on_tail_only() {
        // Only the first byte of a 3-byte char: nothing to emit yet.
        let mut carry = "─".as_bytes()[..1].to_vec();
        assert_eq!(drain_utf8(&mut carry), None);
        assert_eq!(carry.len(), 1);
    }

    #[test]
    fn utf8_carry_passes_ascii_straight_through() {
        let mut carry = b"plain ascii".to_vec();
        assert_eq!(drain_utf8(&mut carry).as_deref(), Some("plain ascii"));
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_carry_flushes_invalid_bytes_lossily() {
        // 0xFF can never start a UTF-8 sequence — binary spew must not stall.
        let mut carry = vec![b'a', 0xFF, b'b'];
        let out = drain_utf8(&mut carry).expect("must flush");
        assert!(out.starts_with('a') && out.ends_with('b'));
        assert!(carry.is_empty());
    }

    /// End-to-end PTY mechanics — the exact write/read path term_write /
    /// the reader thread use: spawn a shell on a PTY, type a command in via
    /// the master writer, read the echo back. Uses plain /bin/sh (no user rc
    /// files) so it's deterministic on CI.
    #[test]
    #[cfg(unix)]
    fn pty_write_read_roundtrip() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn sh on pty");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // "Keystrokes": a command whose output can't appear from the echo of
        // the input itself (computed), then exit so the reader sees EOF.
        writer
            .write_all(b"echo PTY_OK_$((40+2))\rexit\r")
            .expect("write keystrokes");

        let mut out = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let _ = child.wait();
        assert!(out.contains("PTY_OK_42"), "pty echo missing, got: {out:?}");
    }
}
