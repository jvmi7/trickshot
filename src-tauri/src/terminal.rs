// Integrated per-worktree terminal: a real PTY (portable-pty) running the
// user's shell with cwd = the worktree, streamed to the webview's xterm.js as
// `term-event`s ({ worktree, kind, data } — the terminal sibling of
// `agent-event`/`script-event`). One PTY per worktree, spawned lazily when the
// Terminal tab opens (`term_open` is idempotent) and killed on close/app quit.

use std::io::{Read, Write};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::worktree_map::{lock_ignore_poison, next_generation, WorktreeEvent, WorktreeMap};

/// PTY slot suffix for the dedicated Claude CLI terminal (the chat pane's CLI
/// mode — a SECOND PTY beside the worktree's shell terminal). NUL can never
/// occur in a filesystem path, so the composite key cannot collide with a real
/// worktree. Everything downstream (term_write/resize/close, the WorktreeEvent
/// envelope, the webview's xterm cache) treats the key as an opaque string, so
/// only `term_open` knows the split. Hand-mirrored by `claudeTermKey` in
/// src/lib/terminal.ts — keep the two in sync (see ARCHITECTURE.md).
pub(crate) const CLAUDE_SLOT: &str = "\u{0}claude";

/// The default chat's id. Its key stays the BARE claude slot so pre-multi-chat
/// PTYs/keys keep working (migration-safe); additional chats append `:<id>`.
/// Hand-mirrored by `DEFAULT_CHAT_ID` in src/lib/stores.ts.
const DEFAULT_CHAT: &str = "main";

/// The claude-slot PTY key for a worktree's chat. One worktree can run several
/// concurrent CLI chats (the tab/grid surface) — each gets its own PTY, keyed
/// `{worktree}\0claude` (default chat) or `{worktree}\0claude:{chat}`.
fn claude_key(worktree: &str, chat: Option<&str>) -> String {
    match chat {
        Some(id) if id != DEFAULT_CHAT => format!("{worktree}{CLAUDE_SLOT}:{id}"),
        _ => format!("{worktree}{CLAUDE_SLOT}"),
    }
}

/// Chat ids are app-generated slugs — validated anyway (defense in depth, the
/// session-id posture): short alphanumeric/dash only.
fn is_valid_chat_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The user's login shell (also the shell we ask for PATH/claude resolution).
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe"
        } else {
            "/bin/zsh"
        }
        .to_string()
    })
}

/// Which program a PTY runs. Parsed from the command's `launch` arg — the
/// webview picks from a FIXED whitelist and never passes a command string
/// (the same security posture as run_script: names in, commands resolved here).
#[derive(Clone, Copy, PartialEq, Debug)]
enum Launch {
    Shell,
    Claude,
}

fn parse_launch(launch: Option<&str>) -> Result<Launch, String> {
    match launch {
        None => Ok(Launch::Shell),
        Some("claude") => Ok(Launch::Claude),
        Some(other) => Err(format!("unknown launch target \"{other}\"")),
    }
}

/// A `--resume` session id is a UUID-shaped token; reject anything else so the
/// argv we build stays inert (defense in depth — it's argv-only, never a shell).
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-') // a leading dash would parse as a CLI flag
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Resolve the user's `claude` CLI (absolute path) + the login shell's $PATH,
/// once per app run. Finder-launched apps inherit a minimal PATH, so we ask the
/// LOGIN shell with fixed strings (no interpolation — nothing user-controlled
/// enters these commands). The PATH is exported into the CLI's PTY so claude's
/// own subprocesses (its Bash tool) see the user's real environment.
/// pub(crate): `generate.rs` reuses it to run one-shot `claude -p` generations
/// rather than re-resolving the binary.
pub(crate) fn claude_cli() -> Result<(String, String), String> {
    #[cfg(not(unix))]
    {
        return Err("CLI chat mode is not supported on this platform yet".to_string());
    }
    #[cfg(unix)]
    {
        static RESOLVED: OnceLock<Result<(String, String), String>> = OnceLock::new();
        RESOLVED
            .get_or_init(|| {
                let shell = default_shell();
                let run = |script: &str| -> Result<String, String> {
                    let out = std::process::Command::new(&shell)
                        .args(["-lc", script])
                        .output()
                        .map_err(|e| format!("failed to run login shell: {e}"))?;
                    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
                };
                let bin = run("command -v claude")?;
                if bin.is_empty() {
                    return Err(
                        "claude CLI not found on PATH — is Claude Code installed?".to_string()
                    );
                }
                let path = run("printf %s \"$PATH\"").unwrap_or_default();
                Ok((bin, path))
            })
            .clone()
    }
}

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

/// Whether the user's `claude` CLI resolves on the login shell's PATH — the
/// onboarding preflight (Welcome). Distinct from `check_auth` (credentials):
/// this answers "is the binary even installed?". Async + spawn_blocking: the
/// first call shells the login shell (OnceLock-cached after).
#[tauri::command]
pub async fn check_cli() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(claude_cli().is_ok()))
        .await
        .map_err(|e| e.to_string())?
}

/// Open (or no-op if already open) a PTY for `worktree`. By default it runs the
/// user's login shell with cwd = the worktree; `launch: "claude"` instead runs
/// the user's Claude Code CLI (optionally `--resume <resumeSessionId>`) on a
/// SEPARATE PTY keyed by the claude slot, so the shell terminal and the CLI
/// chat mode coexist. Output streams as `term-event`s tagged with the PTY key.
/// Async + spawn_blocking: spawning is a subprocess launch and must run off the
/// main thread.
// Command args mirror the IPC surface 1:1 (flat camelCase args from api.ts);
// bundling them into a struct would nest the wire shape for style points.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    worktree: String,
    rows: u16,
    cols: u16,
    launch: Option<String>,
    resume_session_id: Option<String>,
    chat: Option<String>,
    session_id: Option<String>,
) -> Result<bool, String> {
    let launch = parse_launch(launch.as_deref())?;
    if let Some(id) = &resume_session_id {
        if !is_valid_session_id(id) {
            return Err("invalid session id".to_string());
        }
    }
    // `session_id` = a DETERMINISTIC id for a NEW session (`--session-id`), so
    // the app knows a chat's transcript identity from birth — no store scan.
    if let Some(id) = &session_id {
        if !is_valid_session_id(id) {
            return Err("invalid session id".to_string());
        }
    }
    if let Some(id) = &chat {
        if !is_valid_chat_id(id) {
            return Err("invalid chat id".to_string());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Resolve the CLI BEFORE taking the map lock (first resolution shells a
        // login shell — don't stall every worktree's terminal behind it).
        let claude = match launch {
            Launch::Claude => Some(claude_cli()?),
            Launch::Shell => None,
        };
        let key = match launch {
            Launch::Claude => claude_key(&worktree, chat.as_deref()),
            Launch::Shell => worktree.clone(),
        };

        let state = app.state::<Terminals>();
        // Hold the lock across the spawn+insert (same double-spawn guard as
        // start_session).
        let mut map = state.lock();
        if map.contains_key(&key) {
            // Already alive — report it so the webview knows no fresh TUI
            // paint is coming (a reloaded webview must force a repaint).
            return Ok(false);
        }

        let pair = native_pty_system()
            .openpty(size(rows.max(2), cols.max(2)))
            .map_err(|e| e.to_string())?;

        let mut cmd = match &claude {
            Some((bin, login_path)) => {
                let mut c = CommandBuilder::new(bin);
                if let Some(id) = &resume_session_id {
                    c.arg("--resume");
                    c.arg(id); // argv-only, validated — never through a shell
                } else if let Some(id) = &session_id {
                    // A NEW session with an app-chosen id (multi-chat: each
                    // chat owns its transcript identity from birth).
                    c.arg("--session-id");
                    c.arg(id); // argv-only, validated — never through a shell
                }
                if !login_path.is_empty() {
                    c.env("PATH", login_path);
                }
                // The app's chats are TOP-LEVEL sessions. When the app itself
                // was launched from inside a Claude Code session (dev flow),
                // the CLI would inherit these markers, believe it's a child
                // session, and DISABLE transcript saving — which breaks
                // resume (latest_session_id/session_exists scan transcripts).
                c.env_remove("CLAUDECODE");
                c.env_remove("CLAUDE_CODE_CHILD_SESSION");
                c.env_remove("CLAUDE_CODE_ENTRYPOINT");
                // Cap the CLI at 256-color output (no COLORTERM = no
                // truecolor advertisement; FORCE_COLOR could re-force it).
                // Truecolor SGR bypasses xterm's palette entirely, which
                // would defeat the per-workspace MONOCHROME profile — at 256
                // colors every code the TUI emits routes through the theme's
                // extendedAnsi ramp (terminal.ts › themeColors). Claude-slot
                // only: the plain shell keeps the user's full color env.
                c.env_remove("COLORTERM");
                c.env_remove("FORCE_COLOR");
                c
            }
            None => {
                let mut c = CommandBuilder::new(default_shell());
                if !cfg!(windows) {
                    c.arg("-l"); // login shell, so the user's profile/PATH load
                }
                c
            }
        };
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
            key.clone(),
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
                                worktree: key.clone(),
                                kind: "data".into(),
                                data: Some(text),
                            },
                        );
                    }
                }
            }
            if let Some(state) = app.try_state::<Terminals>() {
                let mut map = state.lock();
                if map.get(&key).map(|s| s.generation) == Some(generation) {
                    map.remove(&key);
                }
            }
            let _ = app.emit(
                "term-event",
                WorktreeEvent {
                    worktree: key,
                    kind: "exit".into(),
                    data: None,
                },
            );
        });

        Ok(true)
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
    use super::{claude_key, drain_utf8, is_valid_session_id, parse_launch, Launch, CLAUDE_SLOT};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    #[test]
    fn launch_whitelist_accepts_only_known_targets() {
        assert_eq!(parse_launch(None), Ok(Launch::Shell));
        assert_eq!(parse_launch(Some("claude")), Ok(Launch::Claude));
        assert!(parse_launch(Some("bash")).is_err());
        assert!(parse_launch(Some("claude; rm -rf /")).is_err());
        assert!(parse_launch(Some("")).is_err());
    }

    #[test]
    fn session_id_validation_is_uuid_shaped() {
        assert!(is_valid_session_id("950d7012-475b-4df8-b483-86d4a55af760"));
        assert!(is_valid_session_id("abc_123.DEF-456"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("id with spaces"));
        assert!(!is_valid_session_id("--resume")); // dashes are fine, but…
        assert!(!is_valid_session_id("$(evil)"));
        assert!(!is_valid_session_id(&"x".repeat(129)));
    }

    #[test]
    fn claude_key_is_nul_suffixed_and_collision_free() {
        let key = claude_key("/some/worktree", None);
        assert_eq!(key, format!("/some/worktree{CLAUDE_SLOT}"));
        assert!(key.contains('\u{0}')); // NUL can't occur in a real path
        assert_ne!(key, "/some/worktree");
        // The default chat aliases to the bare slot (migration-safe)…
        assert_eq!(claude_key("/w", Some("main")), format!("/w{CLAUDE_SLOT}"));
        // …while additional chats get their own keys.
        assert_eq!(
            claude_key("/w", Some("a1b2c3")),
            format!("/w{CLAUDE_SLOT}:a1b2c3")
        );
        assert_ne!(claude_key("/w", Some("x")), claude_key("/w", Some("y")));
    }

    #[test]
    fn chat_id_validation_is_slug_shaped() {
        use super::is_valid_chat_id;
        assert!(is_valid_chat_id("main"));
        assert!(is_valid_chat_id("a1b2-c3"));
        assert!(!is_valid_chat_id(""));
        assert!(!is_valid_chat_id("has space"));
        assert!(!is_valid_chat_id(
            "way-too-long-to-be-an-app-generated-slug"
        ));
        assert!(!is_valid_chat_id("nul\u{0}byte"));
    }

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
