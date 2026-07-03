// Conductor-style project scripts: a repo-committed `.trickshot/settings.json`
// declares a `setup` script (run when a worktree is created), named `run`
// scripts (launched from the header Run button), and an `archive` script (run
// before a workspace is archived). Scripts execute inside the worktree with a
// per-worktree port block (`TRICKSHOT_PORT`…`+9`) so parallel worktrees can run
// side-by-side. Output streams to the webview as `script-event` events, the
// scripts-channel sibling of agent.rs's `agent-event` (same envelope shape).
//
// SECURITY: the webview passes only a script NAME; the command string is always
// read from the repo's settings file on disk here — the frontend can never
// execute an arbitrary string via this module.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// One named run script (the Run button's menu entries), in file order.
#[derive(Serialize, Clone)]
pub struct RunScript {
    pub name: String,
    pub command: String,
}

/// Parsed `scripts` section of `.trickshot/settings.json`. A missing file or
/// section yields the empty default — having no scripts is not an error.
#[derive(Serialize, Clone, Default)]
pub struct ScriptsConfig {
    pub setup: Option<String>,
    pub run: Vec<RunScript>,
    pub archive: Option<String>,
    /// "concurrent" (default) lets every worktree run at once; "nonconcurrent"
    /// stops any other running script first (Conductor's run_mode semantics).
    pub run_mode: String,
}

/// One running script process per worktree, keyed by worktree path. Mirrors
/// agent.rs's `Sessions` (same poison-safe lock rationale).
#[derive(Default)]
pub struct ScriptProcs(Mutex<HashMap<String, Child>>);

impl ScriptProcs {
    pub(crate) fn lock(&self) -> MutexGuard<'_, HashMap<String, Child>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Event relayed from a worktree's script to the webview on the `script-event`
/// channel — the scripts sibling of agent.rs's `AgentEvent` (mirrored by the TS
/// `ScriptEnvelope`; the conformance test pins the seam).
#[derive(Clone, Serialize)]
struct ScriptEvent {
    worktree: String,
    /// "started" | "stdout" | "stderr" | "exit"
    kind: String,
    data: Option<String>,
}

/// Parse the `scripts` section from a repo's `.trickshot/settings.json` text.
/// Pure (no I/O) so it's unit-testable; `load_scripts` wraps it with the read.
/// `run` accepts either one string (a single unnamed script, surfaced as "run")
/// or an object of name → command, preserving file order.
fn parse_scripts(raw: &str) -> Result<ScriptsConfig, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid .trickshot/settings.json: {e}"))?;
    let scripts = &v["scripts"];
    let mut cfg = ScriptsConfig {
        run_mode: "concurrent".into(),
        ..Default::default()
    };
    if scripts.is_null() {
        return Ok(cfg);
    }
    cfg.setup = scripts["setup"].as_str().map(str::to_string);
    cfg.archive = scripts["archive"].as_str().map(str::to_string);
    if let Some(mode) = scripts["run_mode"].as_str() {
        if mode == "nonconcurrent" {
            cfg.run_mode = "nonconcurrent".into();
        }
    }
    match &scripts["run"] {
        serde_json::Value::String(cmd) => cfg.run.push(RunScript {
            name: "run".into(),
            command: cmd.clone(),
        }),
        serde_json::Value::Object(map) => {
            for (name, cmd) in map {
                if let Some(c) = cmd.as_str() {
                    cfg.run.push(RunScript {
                        name: name.clone(),
                        command: c.to_string(),
                    });
                }
            }
        }
        _ => {}
    }
    Ok(cfg)
}

/// Read + parse a repo's scripts config. Missing file → the empty default.
fn load_scripts(repo_path: &str) -> Result<ScriptsConfig, String> {
    let path = Path::new(repo_path)
        .join(".trickshot")
        .join("settings.json");
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_scripts(&raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ScriptsConfig {
            run_mode: "concurrent".into(),
            ..Default::default()
        }),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

/// The repo's scripts config (for the Run button menu / setup-script probe).
#[tauri::command]
pub fn get_scripts(repo_path: String) -> Result<ScriptsConfig, String> {
    load_scripts(&repo_path)
}

/// Deterministic per-worktree port block: 10 consecutive ports starting at
/// `TRICKSHOT_PORT`, derived from the worktree path so it's stable across
/// launches with no allocation state. Range 10000–59990, stepping by 10.
fn port_base(worktree: &str) -> u16 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    worktree.hash(&mut h);
    10_000 + ((h.finish() % 5_000) as u16) * 10
}

/// Resolve `name` against the repo's config: the reserved names "setup" and
/// "archive" map to those scripts; anything else must be a named run script.
fn resolve_script(cfg: &ScriptsConfig, name: &str) -> Result<(String, bool), String> {
    // (command, is_run_script)
    match name {
        "setup" => cfg
            .setup
            .clone()
            .map(|c| (c, false))
            .ok_or("no setup script configured".into()),
        "archive" => cfg
            .archive
            .clone()
            .map(|c| (c, false))
            .ok_or("no archive script configured".into()),
        _ => cfg
            .run
            .iter()
            .find(|r| r.name == name)
            .map(|r| (r.command.clone(), true))
            .ok_or_else(|| format!("no run script named {name:?}")),
    }
}

/// Build the `sh -lc <command>` invocation every script runs as: cwd = the
/// worktree, the TRICKSHOT_* env (a deterministic per-worktree port block +
/// path/name context), piped output, own process group (so stopping kills the
/// whole tree). The ONE place the script environment is defined — both the
/// streaming `run_script` and the awaited `run_script_blocking` use it.
fn script_command(repo_path: &str, worktree: &str, command: &str) -> Command {
    let base = port_base(worktree);
    let wt_name = Path::new(worktree)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cmd = Command::new("sh");
    cmd.args(["-lc", command])
        .current_dir(worktree)
        .env("TRICKSHOT_PORT", base.to_string())
        .env("TRICKSHOT_WORKSPACE_PATH", worktree)
        .env("TRICKSHOT_ROOT_PATH", repo_path)
        .env("TRICKSHOT_WORKSPACE_NAME", &wt_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group so kill_script can signal the shell AND its children.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

/// Kill a script process AND its children: the shell we spawned is its own
/// process group (see `script_command`'s `process_group(0)`), so signal the
/// whole group first, then reap. Best-effort — a dead process is the desired
/// end state. pub(crate): the lib.rs exit handler drains ScriptProcs through
/// this too.
pub(crate) fn kill_script(mut child: Child) {
    #[cfg(unix)]
    {
        // `kill -- -<pid>` signals the process GROUP (the shell + everything it
        // spawned). Plain child.kill() would orphan a dev server started by the
        // script. Shelling out avoids a libc dependency for one syscall.
        let _ = Command::new("kill")
            .args(["--", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Launch a script by NAME for a worktree. The command string comes from the
/// repo's `.trickshot/settings.json` (never the webview). One script per
/// worktree — starting a new one stops the old; `run_mode: "nonconcurrent"`
/// additionally stops every other worktree's script first. Output streams as
/// `script-event`s; the exit is a final `exit` event with the status code.
#[tauri::command]
pub fn run_script(
    app: AppHandle,
    repo_path: String,
    worktree: String,
    name: String,
    state: State<'_, ScriptProcs>,
) -> Result<(), String> {
    let cfg = load_scripts(&repo_path)?;
    let (command, is_run) = resolve_script(&cfg, &name)?;

    {
        let mut map = state.lock();
        // Replace this worktree's running script.
        if let Some(old) = map.remove(&worktree) {
            kill_script(old);
        }
        // nonconcurrent: only one RUN script anywhere — stop the others too.
        if is_run && cfg.run_mode == "nonconcurrent" {
            for (_, old) in map.drain() {
                kill_script(old);
            }
        }
    }

    let mut cmd = script_command(&repo_path, &worktree, &command);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn script: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    state.lock().insert(worktree.clone(), child);

    let _ = app.emit(
        "script-event",
        ScriptEvent {
            worktree: worktree.clone(),
            kind: "started".into(),
            data: Some(name),
        },
    );

    // One reader thread per stream, relaying lines verbatim (zero per-line work,
    // matching the agent.rs relay rule). A third waiter thread reaps the exit.
    fn relay(app: AppHandle, worktree: String, kind: &'static str, stream: impl Read + Send) {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let _ = app.emit(
                "script-event",
                ScriptEvent {
                    worktree: worktree.clone(),
                    kind: kind.into(),
                    data: Some(line),
                },
            );
        }
    }
    if let Some(out) = stdout {
        let (app2, wt2) = (app.clone(), worktree.clone());
        std::thread::spawn(move || relay(app2, wt2, "stdout", out));
    }
    if let Some(err) = stderr {
        let (app2, wt2) = (app.clone(), worktree.clone());
        std::thread::spawn(move || relay(app2, wt2, "stderr", err));
    }

    // Waiter: poll for exit WITHOUT holding a &mut into the map (stop_script
    // needs the entry). try_wait via the map under short lock windows.
    std::thread::spawn(move || {
        let code: Option<i32> = loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let Some(procs) = app.try_state::<ScriptProcs>() else {
                break None;
            };
            let mut map = procs.lock();
            match map.get_mut(&worktree) {
                // Replaced by a newer script (different pid) — this waiter is done;
                // the new script's own waiter owns the exit event.
                Some(c) if c.id() != pid => return,
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => {
                        map.remove(&worktree);
                        break status.code();
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        map.remove(&worktree);
                        break None;
                    }
                },
                // stop_script removed it — it already emitted the exit event.
                None => return,
            }
        };
        let _ = app.emit(
            "script-event",
            ScriptEvent {
                worktree,
                kind: "exit".into(),
                data: code.map(|c| c.to_string()),
            },
        );
    });

    Ok(())
}

/// Run a script BY NAME to COMPLETION and return its stdout — the awaited
/// sibling of `run_script`, for hooks that must finish before the caller
/// proceeds (the archive script runs before the worktree dir is deleted).
/// Not tracked in ScriptProcs (nothing to stop from the UI); a failure maps
/// to Err with the script's stderr. Async so the (blocking) wait runs off
/// the main thread.
#[tauri::command]
pub async fn run_script_blocking(
    repo_path: String,
    worktree: String,
    name: String,
) -> Result<String, String> {
    let cfg = load_scripts(&repo_path)?;
    let (command, _) = resolve_script(&cfg, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = script_command(&repo_path, &worktree, &command)
            .output()
            .map_err(|e| format!("failed to run script: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stop a worktree's running script (no-op if none). Emits the final `exit`
/// event itself — the waiter thread sees the entry gone and stays silent.
#[tauri::command]
pub fn stop_script(
    app: AppHandle,
    worktree: String,
    state: State<'_, ScriptProcs>,
) -> Result<(), String> {
    if let Some(child) = state.lock().remove(&worktree) {
        kill_script(child);
        let _ = app.emit(
            "script-event",
            ScriptEvent {
                worktree,
                kind: "exit".into(),
                data: None,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_scripts, port_base};

    #[test]
    fn parses_full_config() {
        let raw = r#"{
            "scripts": {
                "setup": "bun install",
                "run": { "dev": "bun run dev", "test": "bun test" },
                "archive": "docker compose down",
                "run_mode": "nonconcurrent"
            }
        }"#;
        let cfg = parse_scripts(raw).unwrap();
        assert_eq!(cfg.setup.as_deref(), Some("bun install"));
        assert_eq!(cfg.archive.as_deref(), Some("docker compose down"));
        assert_eq!(cfg.run_mode, "nonconcurrent");
        assert_eq!(cfg.run.len(), 2);
        assert_eq!(cfg.run[0].name, "dev");
        assert_eq!(cfg.run[0].command, "bun run dev");
    }

    #[test]
    fn run_accepts_a_single_string() {
        let cfg = parse_scripts(r#"{ "scripts": { "run": "npm start" } }"#).unwrap();
        assert_eq!(cfg.run.len(), 1);
        assert_eq!(cfg.run[0].name, "run");
        assert_eq!(cfg.run[0].command, "npm start");
    }

    #[test]
    fn missing_scripts_section_is_empty_default() {
        let cfg = parse_scripts("{}").unwrap();
        assert!(cfg.setup.is_none());
        assert!(cfg.archive.is_none());
        assert!(cfg.run.is_empty());
        assert_eq!(cfg.run_mode, "concurrent");
    }

    #[test]
    fn bad_run_mode_falls_back_to_concurrent() {
        let cfg = parse_scripts(r#"{ "scripts": { "run_mode": "sometimes" } }"#).unwrap();
        assert_eq!(cfg.run_mode, "concurrent");
    }

    #[test]
    fn invalid_json_is_an_error() {
        assert!(parse_scripts("not json").is_err());
    }

    #[test]
    fn port_base_is_stable_and_in_range() {
        let a = port_base("/tmp/wt-a");
        assert_eq!(a, port_base("/tmp/wt-a")); // deterministic
        assert!((10_000..60_000).contains(&a));
        assert_eq!(a % 10, 0); // block-aligned so +0..+9 stays inside the block
    }

    // ---- live process behavior (spawn/env/group-kill) ----

    #[test]
    fn script_env_reaches_the_command() {
        // The TRICKSHOT_* env is the script contract; run a real `sh -lc` and
        // read it back. Uses the temp dir as both repo and worktree.
        let dir = std::env::temp_dir();
        let dir = dir.to_string_lossy();
        let out =
            super::script_command(&dir, &dir, "echo $TRICKSHOT_PORT $TRICKSHOT_WORKSPACE_NAME")
                .output()
                .expect("spawn sh");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut parts = stdout.split_whitespace();
        let port: u16 = parts.next().expect("port").parse().expect("numeric port");
        assert_eq!(port, super::port_base(&dir));
        assert!(parts.next().is_some()); // workspace name present
    }

    use std::io::BufRead;

    #[test]
    fn kill_script_kills_the_whole_process_group() {
        // Spawn a shell whose CHILD outlives it unless the group is signalled:
        // the script prints the grandchild's pid, then sleeps. After
        // kill_script, that pid must be gone — this is the "Stop kills the dev
        // server, not just the shell" guarantee.
        let dir = std::env::temp_dir();
        let dir = dir.to_string_lossy();
        let mut cmd = super::script_command(&dir, &dir, "sleep 30 & echo $!; sleep 30");
        let mut child = cmd.spawn().expect("spawn sh");
        // Read the grandchild pid off the first stdout line.
        let stdout = child.stdout.take().expect("stdout piped");
        let mut line = String::new();
        std::io::BufReader::new(stdout)
            .read_line(&mut line)
            .expect("read pid line");
        let grandchild: i32 = line.trim().parse().expect("pid");

        super::kill_script(child);
        // Poll briefly: signal delivery is async but fast.
        let mut alive = true;
        for _ in 0..20 {
            alive = unsafe { libc_kill_probe(grandchild) };
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!alive, "grandchild sleep survived the group kill");
    }

    /// `kill -0`-style liveness probe via the `kill` binary (no libc dep, same
    /// approach as kill_script itself).
    unsafe fn libc_kill_probe(pid: i32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
