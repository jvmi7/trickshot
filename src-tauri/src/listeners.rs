// Which localhost servers belong to which worktree: only processes ROOTED in
// what trickshot itself spawned (run scripts + PTY children) are considered.
// One cheap `ps` snapshot expands the roots to their full process trees
// (ppid descendants + process-group members), then ONE `lsof` restricted to
// exactly those pids finds the listening TCP sockets. Idle cost is a single
// `ps`; with no live roots there is no lsof at all — a system-wide socket
// sweep proved expensive enough to lag the whole app (the stuck-picker
// incident), so the scope here is deliberately narrow.

use std::collections::HashMap;
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::scripts::{script_pids, ScriptProcs};
use crate::terminal::{pty_pids, Terminals};

/// One listening socket attributed to a worktree (mirrored by the TS
/// `Listener` in types.ts).
#[derive(Serialize, Clone)]
pub struct Listener {
    pub worktree: String,
    pub pid: u32,
    pub port: u16,
    pub command: String,
}

/// Run lsof, tolerating its "exit 1 when nothing matched" convention.
fn lsof(args: &[&str]) -> Result<String, String> {
    // GUI-launched apps may not have /usr/sbin on PATH (where macOS keeps lsof).
    let out = Command::new("lsof")
        .args(args)
        .output()
        .or_else(|_| Command::new("/usr/sbin/lsof").args(args).output())
        .map_err(|e| format!("lsof failed to start: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `lsof -Fpcn` LISTEN output into (pid, command, port) rows, deduped
/// on (pid, port) — a dual-stack server listens on v4 and v6 separately.
fn parse_listen_output(raw: &str) -> Vec<(u32, String, u16)> {
    let mut rows: Vec<(u32, String, u16)> = Vec::new();
    let mut pid: Option<u32> = None;
    let mut command = String::new();
    for line in raw.lines() {
        match line.split_at(line.len().min(1)) {
            ("p", rest) => pid = rest.parse().ok(),
            ("c", rest) => command = rest.to_string(),
            ("n", rest) => {
                // Address forms: `*:5173`, `127.0.0.1:5173`, `[::1]:5173`.
                if let (Some(p), Some(port)) = (
                    pid,
                    rest.rsplit(':').next().and_then(|s| s.parse::<u16>().ok()),
                ) {
                    if !rows.iter().any(|(rp, _, rport)| *rp == p && *rport == port) {
                        rows.push((p, command.clone(), port));
                    }
                }
            }
            _ => {}
        }
    }
    rows
}

/// Parse `ps -axo pid=,ppid=,pgid=` rows.
fn parse_ps(raw: &str) -> Vec<(u32, u32, u32)> {
    raw.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((
                it.next()?.parse().ok()?,
                it.next()?.parse().ok()?,
                it.next()?.parse().ok()?,
            ))
        })
        .collect()
}

/// Expand the spawned roots to their full trees: pid → owning worktree for
/// every root, every member of a root's process GROUP (scripts run in their
/// own group — catches children whose parent link broke via a double-fork),
/// and every ppid-descendant, to a fixpoint.
fn expand_roots(procs: &[(u32, u32, u32)], roots: &[(String, u32)]) -> HashMap<u32, String> {
    let mut owner: HashMap<u32, String> = roots.iter().map(|(wt, p)| (*p, wt.clone())).collect();
    for (pid, _ppid, pgid) in procs {
        if !owner.contains_key(pid) {
            if let Some((wt, _)) = roots.iter().find(|(_, r)| r == pgid) {
                owner.insert(*pid, wt.clone());
            }
        }
    }
    loop {
        let mut changed = false;
        for (pid, ppid, _pgid) in procs {
            if !owner.contains_key(pid) {
                if let Some(wt) = owner.get(ppid).cloned() {
                    owner.insert(*pid, wt);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    owner
}

/// All listening TCP servers rooted in trickshot-spawned processes, tagged
/// with their owning worktree. One `ps` + at most one scoped `lsof`.
#[tauri::command]
pub async fn list_listeners(
    scripts: State<'_, ScriptProcs>,
    terms: State<'_, Terminals>,
) -> Result<Vec<Listener>, String> {
    let mut roots = script_pids(&scripts);
    roots.extend(pty_pids(&terms));
    tauri::async_runtime::spawn_blocking(move || {
        if roots.is_empty() {
            return Ok(Vec::new());
        }
        let ps_out = Command::new("ps")
            .args(["-axo", "pid=,ppid=,pgid="])
            .output()
            .map_err(|e| format!("ps failed to start: {e}"))?;
        let procs = parse_ps(&String::from_utf8_lossy(&ps_out.stdout));
        let owner = expand_roots(&procs, &roots);
        let pid_list = owner
            .keys()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let sweep = lsof(&[
            "-a",
            "-p",
            &pid_list,
            "-nP",
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fpcn",
        ])?;
        Ok(parse_listen_output(&sweep)
            .into_iter()
            .filter_map(|(pid, command, port)| {
                owner.get(&pid).map(|wt| Listener {
                    worktree: wt.clone(),
                    pid,
                    port,
                    command,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{expand_roots, parse_listen_output, parse_ps};

    #[test]
    fn parses_listen_rows_and_dedupes_dual_stack() {
        let raw = "p123\ncnode\nn*:5173\nn[::1]:5173\np456\ncbun\nn127.0.0.1:11280\n";
        let rows = parse_listen_output(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (123, "node".into(), 5173));
        assert_eq!(rows[1], (456, "bun".into(), 11280));
    }

    #[test]
    fn ignores_malformed_addresses() {
        assert!(parse_listen_output("p1\ncx\nnno-port-here\n").is_empty());
    }

    #[test]
    fn parses_ps_rows() {
        let rows = parse_ps("  1     0     1\n 42     1    42\nnot a row\n");
        assert_eq!(rows, vec![(1, 0, 1), (42, 1, 42)]);
    }

    #[test]
    fn expands_descendants_to_a_fixpoint() {
        // root 10 → 20 → 30 (grandchild), unrelated 99. Listed out of order so
        // only the fixpoint loop can close the chain.
        let procs = vec![(30, 20, 30), (20, 10, 10), (99, 1, 99), (10, 1, 10)];
        let owner = expand_roots(&procs, &[("wt".into(), 10)]);
        assert_eq!(owner.get(&10).map(String::as_str), Some("wt"));
        assert_eq!(owner.get(&20).map(String::as_str), Some("wt"));
        assert_eq!(owner.get(&30).map(String::as_str), Some("wt"));
        assert!(!owner.contains_key(&99));
    }

    #[test]
    fn expands_group_members_with_broken_parent_links() {
        // 55 was reparented to launchd (ppid 1) but kept the root's pgid.
        let procs = vec![(55, 1, 10)];
        let owner = expand_roots(&procs, &[("wt".into(), 10)]);
        assert_eq!(owner.get(&55).map(String::as_str), Some("wt"));
    }
}
