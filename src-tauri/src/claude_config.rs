//! The global Claude Code config surface (Settings › Global Claude): one scan
//! command summarizing what's set up under `~/.claude` (settings, global
//! CLAUDE.md, agents, commands, skills, projects — plus the user-scope MCP
//! servers, which live in `~/.claude.json`), a whitelisted file reader for the
//! viewer dialogs, and a writer restricted to exactly `settings.json` +
//! `CLAUDE.md`. This VIEWS Claude Code's own config in place — the app adds no
//! config layer of its own (see CLAUDE.md's gotchas), and it never writes
//! `~/.claude.json` (the CLI rewrites that state file constantly; a racing
//! write could corrupt it).

use std::path::{Path, PathBuf};

/// Reads are capped — nothing legitimate in scope is this big, and the
/// overview/viewer must not ship a runaway file to the webview.
const MAX_READ_BYTES: u64 = 1024 * 1024;

/// The only files the webview may WRITE, by exact relative path. No prefix
/// logic on purpose: the editable set is a whitelist, not a pattern.
const EDITABLE: &[&str] = &["settings.json", "CLAUDE.md"];

/// Top-level files readable by exact relative path.
const READABLE_EXACT: &[&str] = &["settings.json", "settings.local.json", "CLAUDE.md"];
/// Directories whose `.md` files are readable (agents/commands/skills).
const READABLE_DIRS: &[&str] = &["agents", "commands", "skills"];

#[derive(serde::Serialize)]
pub struct ClaudeEntry {
    /// Display name (file stem, or the relative path minus `.md` for nested
    /// command namespaces, or the skill's directory name).
    pub name: String,
    /// Root-relative path, valid as `read_claude_file`'s argument.
    pub file: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct ClaudeProject {
    /// The encoded project dir name (the encoding is lossy — display as-is).
    pub dir: String,
    pub sessions: usize,
    pub modified_ms: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct ClaudeOverview {
    /// The scanned root (`$HOME/.claude`), for display.
    pub root: String,
    /// Raw `settings.json` text (`None` = absent).
    pub settings: Option<String>,
    /// Raw `settings.local.json` text (read-only machine overrides).
    pub settings_local: Option<String>,
    /// Raw global `CLAUDE.md` text.
    pub claude_md: Option<String>,
    pub agents: Vec<ClaudeEntry>,
    pub commands: Vec<ClaudeEntry>,
    pub skills: Vec<ClaudeEntry>,
    /// Pretty-printed `mcpServers` object extracted from `~/.claude.json`
    /// (`None` when absent or empty). The rest of that file is dropped
    /// immediately — it's CLI state, not config to surface.
    pub mcp_servers: Option<String>,
    pub projects: Vec<ClaudeProject>,
}

/// `$HOME/.claude` (the `agent.rs` HOME-resolution posture).
fn claude_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude"))
}

fn modified_ms_of(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// File text if it exists, is a regular file, and fits the cap; `None`
/// otherwise (an absent optional file is data, not an error).
fn read_text_capped(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_READ_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Collect `.md` entries under `root/<sub>` (recursive, small fixed depth —
/// command namespaces nest one level; anything deeper is noise). Missing dir
/// → empty (the agent.rs scan posture). Sorted by name for a stable UI.
fn scan_md_entries(root: &Path, sub: &str) -> Vec<ClaudeEntry> {
    fn walk(dir: &Path, rel_prefix: &str, depth: u8, out: &mut Vec<ClaudeEntry>) {
        if depth > 3 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(fname) = path.file_name().and_then(|s| s.to_str()) else {
                continue; // non-UTF8 names are skipped silently
            };
            let rel = if rel_prefix.is_empty() {
                fname.to_string()
            } else {
                format!("{rel_prefix}/{fname}")
            };
            if path.is_dir() {
                walk(&path, &rel, depth + 1, out);
            } else if fname.ends_with(".md") {
                let Ok(meta) = entry.metadata() else { continue };
                out.push(ClaudeEntry {
                    name: rel.trim_end_matches(".md").to_string(),
                    file: rel,
                    size: meta.len(),
                    modified_ms: modified_ms_of(&meta),
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join(sub), "", 0, &mut out);
    for e in &mut out {
        e.file = format!("{sub}/{}", e.file);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Skills are one entry per `skills/<name>/SKILL.md`.
fn scan_skills(root: &Path) -> Vec<ClaudeEntry> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join("skills")) else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        let skill_md = entry.path().join("SKILL.md");
        let Ok(meta) = std::fs::metadata(&skill_md) else {
            continue;
        };
        out.push(ClaudeEntry {
            file: format!("skills/{name}/SKILL.md"),
            name,
            size: meta.len(),
            modified_ms: modified_ms_of(&meta),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One row per `projects/<encoded>` dir with its `.jsonl` session count.
fn scan_projects(root: &Path) -> Vec<ClaudeProject> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join("projects")) else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(dir) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        if !entry.path().is_dir() {
            continue;
        }
        let sessions = std::fs::read_dir(entry.path())
            .map(|it| {
                it.flatten()
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
                    .count()
            })
            .unwrap_or(0);
        let modified_ms = entry.metadata().ok().as_ref().and_then(modified_ms_of);
        out.push(ClaudeProject {
            dir,
            sessions,
            modified_ms,
        });
    }
    // Most recently touched first — the interesting ones.
    out.sort_by_key(|p| std::cmp::Reverse(p.modified_ms));
    out
}

/// Extract the user-scope `mcpServers` object from `~/.claude.json` text.
/// Pretty-printed for display; `None` when the file/key is absent, the JSON is
/// malformed, or the object is empty. Pure over the text so it's unit-testable.
fn extract_mcp_servers(claude_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(claude_json).ok()?;
    let servers = v.get("mcpServers")?;
    let obj = servers.as_object()?;
    if obj.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(servers).ok()
}

/// Validate a root-relative READ path: no absolute/backslash/NUL/dot-dot
/// segments, and it must be a whitelisted top-level file or a `.md` under
/// `agents/`/`commands/`/`skills/`. Returns the joined path (the caller
/// canonicalizes against the live root). Pure so it's unit-testable.
fn resolve_readable(root: &Path, file: &str) -> Result<PathBuf, String> {
    if file.is_empty()
        || file.contains('\0')
        || file.contains('\\')
        || file.starts_with('/')
        || file
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..")
    {
        return Err("invalid path".to_string());
    }
    let mut parts = file.split('/');
    let first = parts.next().unwrap_or("");
    let nested = parts.next().is_some();
    let allowed = (!nested && READABLE_EXACT.contains(&first))
        || (nested && READABLE_DIRS.contains(&first) && file.ends_with(".md"));
    if !allowed {
        return Err("path is not in the readable set".to_string());
    }
    Ok(root.join(file))
}

/// Validate a WRITE: exact whitelist membership, and `settings.json` must be
/// valid JSON (a typo must not brick the user's CLI). Pure so it's testable.
fn validate_write(file: &str, contents: &str) -> Result<(), String> {
    if !EDITABLE.contains(&file) {
        return Err(format!("only {EDITABLE:?} are editable"));
    }
    if file == "settings.json" {
        serde_json::from_str::<serde_json::Value>(contents)
            .map_err(|e| format!("settings.json is not valid JSON: {e}"))?;
    }
    Ok(())
}

/// Build the overview over a given root (+ the sibling `~/.claude.json` text).
/// Pure over its inputs so the scan is unit-testable on a temp dir.
fn build_overview(root: &Path, claude_json: Option<&str>) -> ClaudeOverview {
    ClaudeOverview {
        root: root.display().to_string(),
        settings: read_text_capped(&root.join("settings.json")),
        settings_local: read_text_capped(&root.join("settings.local.json")),
        claude_md: read_text_capped(&root.join("CLAUDE.md")),
        agents: scan_md_entries(root, "agents"),
        commands: scan_md_entries(root, "commands"),
        skills: scan_skills(root),
        mcp_servers: claude_json.and_then(extract_mcp_servers),
        projects: scan_projects(root),
    }
}

/// Everything set up in the user's global Claude Code config, one scan.
#[tauri::command]
pub async fn claude_config_overview() -> Result<ClaudeOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = claude_root()?;
        // ~/.claude.json sits BESIDE the root; read + drop everything but
        // `mcpServers` right here on the blocking thread (it can be large).
        let claude_json = root
            .parent()
            .map(|home| home.join(".claude.json"))
            .and_then(|p| read_text_capped(&p));
        Ok(build_overview(&root, claude_json.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read one whitelisted file under `~/.claude` (the viewer dialogs + editors).
#[tauri::command]
pub async fn read_claude_file(file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = claude_root()?;
        let path = resolve_readable(&root, &file)?;
        // Canonicalize BOTH ends so a symlinked entry can't escape the root.
        let canon = path.canonicalize().map_err(|e| e.to_string())?;
        let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
        if !canon.starts_with(&canon_root) {
            return Err("path escapes ~/.claude".to_string());
        }
        let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
        if meta.len() > MAX_READ_BYTES {
            return Err("file too large to display".to_string());
        }
        std::fs::read_to_string(&canon).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write `settings.json` or the global `CLAUDE.md` — atomically (tmp +
/// rename), creating `~/.claude` first so a first-ever CLAUDE.md works.
#[tauri::command]
pub async fn write_claude_file(file: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_write(&file, &contents)?;
        let root = claude_root()?;
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let target = root.join(&file);
        let tmp = root.join(format!("{file}.trickshot-tmp"));
        std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trickshot-cc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_readable_accepts_the_whitelist() {
        let root = Path::new("/tmp/x");
        for ok in [
            "settings.json",
            "settings.local.json",
            "CLAUDE.md",
            "agents/reviewer.md",
            "commands/ns/deploy.md",
            "skills/foo/SKILL.md",
        ] {
            assert!(
                resolve_readable(root, ok).is_ok(),
                "{ok} should be readable"
            );
        }
    }

    #[test]
    fn resolve_readable_rejects_escapes_and_out_of_scope_paths() {
        let root = Path::new("/tmp/x");
        for bad in [
            "",
            "/etc/passwd",
            "../secrets",
            "agents/../../etc/passwd.md",
            "agents/./x.md",
            "agents//x.md",
            "agents\\x.md",
            "daemon.log",
            "history.jsonl",
            "agents/notes.txt",
            "projects/foo/session.jsonl",
            "settings.json/extra",
            "CLAUDE.md.bak",
        ] {
            assert!(
                resolve_readable(root, bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn validate_write_is_an_exact_whitelist() {
        assert!(validate_write("CLAUDE.md", "# global").is_ok());
        assert!(validate_write("settings.json", "{\"model\":\"opus\"}").is_ok());
        for bad in [
            "settings.local.json",
            "agents/reviewer.md",
            "CLAUDE.md.bak",
            "../CLAUDE.md",
        ] {
            assert!(
                validate_write(bad, "x").is_err(),
                "{bad} should not be editable"
            );
        }
    }

    #[test]
    fn validate_write_rejects_broken_settings_json() {
        assert!(validate_write("settings.json", "{not json").is_err());
        // CLAUDE.md is free text — anything goes.
        assert!(validate_write("CLAUDE.md", "{not json").is_ok());
    }

    #[test]
    fn extract_mcp_servers_pulls_only_the_key() {
        let json = r#"{"projects":{"x":1},"mcpServers":{"linear":{"command":"npx"}}}"#;
        let out = extract_mcp_servers(json).unwrap();
        assert!(out.contains("linear"));
        assert!(!out.contains("projects"));
        assert_eq!(extract_mcp_servers(r#"{"mcpServers":{}}"#), None);
        assert_eq!(extract_mcp_servers(r#"{"other":1}"#), None);
        assert_eq!(extract_mcp_servers("not json"), None);
    }

    #[test]
    fn overview_scan_handles_a_missing_root() {
        let missing = std::env::temp_dir().join("trickshot-cc-definitely-missing");
        let o = build_overview(&missing, None);
        assert!(o.settings.is_none());
        assert!(o.claude_md.is_none());
        assert!(o.agents.is_empty());
        assert!(o.commands.is_empty());
        assert!(o.skills.is_empty());
        assert!(o.projects.is_empty());
        assert!(o.mcp_servers.is_none());
    }

    #[test]
    fn overview_scan_enumerates_planted_config() {
        let root = temp_root("scan");
        std::fs::write(root.join("settings.json"), "{\"model\":\"opus\"}").unwrap();
        std::fs::write(root.join("CLAUDE.md"), "# global memory").unwrap();
        std::fs::create_dir_all(root.join("agents")).unwrap();
        std::fs::write(root.join("agents/reviewer.md"), "agent").unwrap();
        std::fs::create_dir_all(root.join("commands/ns")).unwrap();
        std::fs::write(root.join("commands/top.md"), "cmd").unwrap();
        std::fs::write(root.join("commands/ns/deep.md"), "cmd").unwrap();
        std::fs::create_dir_all(root.join("skills/my-skill")).unwrap();
        std::fs::write(root.join("skills/my-skill/SKILL.md"), "skill").unwrap();
        std::fs::create_dir_all(root.join("projects/-a-b")).unwrap();
        std::fs::write(root.join("projects/-a-b/s1.jsonl"), "{}").unwrap();
        std::fs::write(root.join("projects/-a-b/s2.jsonl"), "{}").unwrap();

        let o = build_overview(&root, Some(r#"{"mcpServers":{"gh":{}}}"#));
        assert_eq!(o.settings.as_deref(), Some("{\"model\":\"opus\"}"));
        assert_eq!(o.claude_md.as_deref(), Some("# global memory"));
        assert_eq!(o.agents.len(), 1);
        assert_eq!(o.agents[0].file, "agents/reviewer.md");
        let mut cmd_names: Vec<&str> = o.commands.iter().map(|e| e.name.as_str()).collect();
        cmd_names.sort();
        assert_eq!(cmd_names, ["ns/deep", "top"]);
        assert_eq!(o.skills[0].name, "my-skill");
        assert_eq!(o.skills[0].file, "skills/my-skill/SKILL.md");
        assert_eq!(o.projects.len(), 1);
        assert_eq!(o.projects[0].sessions, 2);
        assert!(o.mcp_servers.as_deref().unwrap().contains("gh"));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
