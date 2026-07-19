// GitHub PR integration via the `gh` CLI (the user's existing `gh auth login`,
// same no-API-key philosophy as the Claude login). Two commands: read the
// current branch's PR (+ its check rollup) and create one. Shelling `gh`
// mirrors worktree.rs shelling `git`; JSON parsing is split into pure
// functions so it's unit-testable without a network.

use std::process::Command;

use serde::Serialize;

/// One CI check on a PR, normalized from GitHub's two shapes (CheckRun /
/// StatusContext) into a single `status`: "pass" | "fail" | "pending" | "skipped".
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct PrCheck {
    pub name: String,
    pub status: String,
    pub link: Option<String>,
}

/// The current branch's PR, with its check rollup (for the Checks panel).
#[derive(Serialize, Debug)]
pub struct PrInfo {
    pub number: i64,
    pub title: String,
    pub url: String,
    /// "OPEN" | "MERGED" | "CLOSED"
    pub state: String,
    pub base: String,
    pub is_draft: bool,
    pub checks: Vec<PrCheck>,
}

/// Run `gh -C <dir> <args…>` (via cwd), returning stdout or a stderr-derived error.
fn gh(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("gh")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run gh (is the GitHub CLI installed?): {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(if err.is_empty() { out } else { err });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Normalize one statusCheckRollup entry. GitHub interleaves two shapes:
/// CheckRun (`status`/`conclusion`) and StatusContext (`state`).
fn parse_check(v: &serde_json::Value) -> Option<PrCheck> {
    let name = v["name"]
        .as_str()
        .or_else(|| v["context"].as_str())?
        .to_string();
    let link = v["detailsUrl"]
        .as_str()
        .or_else(|| v["targetUrl"].as_str())
        .map(str::to_string);
    let status = match (
        v["conclusion"].as_str(),
        v["state"].as_str(),
        v["status"].as_str(),
    ) {
        (Some("SUCCESS"), _, _) | (_, Some("SUCCESS"), _) => "pass",
        (Some("FAILURE"), _, _)
        | (Some("TIMED_OUT"), _, _)
        | (Some("CANCELLED"), _, _)
        | (_, Some("FAILURE"), _)
        | (_, Some("ERROR"), _) => "fail",
        (Some("SKIPPED"), _, _) | (Some("NEUTRAL"), _, _) => "skipped",
        // No conclusion yet (queued / in progress) or a PENDING status context.
        _ => "pending",
    }
    .to_string();
    Some(PrCheck { name, status, link })
}

/// Parse `gh pr view --json …` output into a PrInfo. Pure, unit-tested.
fn parse_pr_view(raw: &str) -> Result<PrInfo, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("unexpected gh output: {e}"))?;
    let checks = v["statusCheckRollup"]
        .as_array()
        .map(|arr| arr.iter().filter_map(parse_check).collect())
        .unwrap_or_default();
    Ok(PrInfo {
        number: v["number"].as_i64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["url"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("").to_string(),
        base: v["baseRefName"].as_str().unwrap_or("").to_string(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        checks,
    })
}

/// The current branch's PR with its check rollup, or None when the branch has
/// no PR yet (gh's "no pull requests found" failure is that, not an error).
/// Async: `gh` does a network round-trip; keep it off the main thread.
#[tauri::command]
pub async fn pr_status(worktree_path: String) -> Result<Option<PrInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match gh(
            &worktree_path,
            &[
                "pr",
                "view",
                "--json",
                "number,title,url,state,baseRefName,isDraft,statusCheckRollup",
            ],
        ) {
            Ok(raw) => parse_pr_view(&raw).map(Some),
            Err(e) if e.contains("no pull requests found") => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a PR for the worktree's current branch (`gh pr create`). The branch
/// must already be pushed (the UI pushes first). Returns the PR URL.
///
/// Preflights turn gh's cryptic GraphQL failures into actionable guidance:
/// a PR from the repo's DEFAULT branch (it would be its own base) and a
/// branch with zero commits over the base both fail fast with a plain
/// explanation — the two states a "commit-less workspace + main worktree"
/// user lands in.
#[tauri::command]
pub async fn pr_create(
    worktree_path: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: bool,
) -> Result<String, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("PR title is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let head = crate::worktree::git(&worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        let base_arg = base.as_deref().map(str::trim).filter(|b| !b.is_empty());

        // Best-effort default-branch probe (needs gh auth; skip preflights on failure).
        let default_branch = gh(
            &worktree_path,
            &[
                "repo",
                "view",
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name",
            ],
        )
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

        if !default_branch.is_empty() {
            let target = base_arg.unwrap_or(&default_branch);
            if head == target {
                return Err(format!(
                    "you're on {head:?} — the PR's base branch. Create a worktree \
                     branch, commit your changes there, and open the PR from it."
                ));
            }
            // Zero commits over the base = nothing to propose (uncommitted
            // changes don't count). Best-effort: skip when the ref is unknown.
            if let Ok(count) = crate::worktree::git(
                &worktree_path,
                &["rev-list", "--count", &format!("origin/{target}..HEAD")],
            ) {
                if count.trim() == "0" {
                    return Err(format!(
                        "no commits on {head:?} beyond origin/{target} — commit your \
                         changes first (a PR ships commits, not the working tree)."
                    ));
                }
            }
        }

        let mut args: Vec<&str> = vec![
            "pr", "create", "--title", &title, "--body", &body, "--head", &head,
        ];
        if let Some(b) = base_arg {
            args.push("--base");
            args.push(b);
        }
        if draft {
            args.push("--draft");
        }
        gh(&worktree_path, &args).map(|out| out.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge the current branch's open PR (`gh pr merge --squash`). The UI gates
/// this on an OPEN, non-draft PR with no failing checks; gh enforces the rest
/// (review requirements, protections) and its stderr propagates on refusal.
/// Squash matches the repo's PR-per-feature history (one commit per PR).
#[tauri::command]
pub async fn pr_merge(worktree_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gh(&worktree_path, &["pr", "merge", "--squash"]).map(|out| out.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{parse_pr_view, PrCheck};

    #[test]
    fn parses_pr_with_mixed_check_shapes() {
        let raw = r#"{
            "number": 12,
            "title": "Add scripts",
            "url": "https://github.com/o/r/pull/12",
            "state": "OPEN",
            "baseRefName": "main",
            "isDraft": true,
            "statusCheckRollup": [
                { "name": "frontend", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci/1" },
                { "name": "rust", "status": "IN_PROGRESS", "conclusion": null, "detailsUrl": "https://ci/2" },
                { "context": "deploy/preview", "state": "FAILURE", "targetUrl": "https://ci/3" }
            ]
        }"#;
        let pr = parse_pr_view(raw).unwrap();
        assert_eq!(pr.number, 12);
        assert_eq!(pr.state, "OPEN");
        assert_eq!(pr.base, "main");
        assert!(pr.is_draft);
        assert_eq!(
            pr.checks,
            vec![
                PrCheck {
                    name: "frontend".into(),
                    status: "pass".into(),
                    link: Some("https://ci/1".into())
                },
                PrCheck {
                    name: "rust".into(),
                    status: "pending".into(),
                    link: Some("https://ci/2".into())
                },
                PrCheck {
                    name: "deploy/preview".into(),
                    status: "fail".into(),
                    link: Some("https://ci/3".into())
                },
            ]
        );
    }

    #[test]
    fn parses_pr_without_checks() {
        let raw = r#"{ "number": 3, "title": "t", "url": "u", "state": "MERGED",
                       "baseRefName": "main", "isDraft": false, "statusCheckRollup": null }"#;
        let pr = parse_pr_view(raw).unwrap();
        assert!(pr.checks.is_empty());
        assert_eq!(pr.state, "MERGED");
    }

    #[test]
    fn cancelled_and_skipped_normalize() {
        let raw = r#"{ "number": 1, "title": "t", "url": "u", "state": "OPEN",
                       "baseRefName": "main", "isDraft": false, "statusCheckRollup": [
            { "name": "a", "status": "COMPLETED", "conclusion": "CANCELLED" },
            { "name": "b", "status": "COMPLETED", "conclusion": "SKIPPED" }
        ] }"#;
        let pr = parse_pr_view(raw).unwrap();
        assert_eq!(pr.checks[0].status, "fail");
        assert_eq!(pr.checks[1].status, "skipped");
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(parse_pr_view("nope").is_err());
    }
}
