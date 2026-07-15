// One-shot AI text generation for the git workflow: a commit message from the
// working diff, and a PR title/body from the commit range. Runs the user's
// `claude` CLI once in print mode (`-p`) — the SAME binary the CLI-first chat
// resolves (`terminal::claude_cli`), so it needs no API key and no sidecar
// (~279MB) spawn. Deliberately claude-specific, matching terminal.rs; a
// provider-neutral version would route a one-shot query through the sidecar
// adapter instead. JSON-free stdin/stdout, with pure output-cleaning helpers
// split out so they're unit-testable without invoking the model.

use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::terminal::claude_cli;
use crate::worktree::{default_branch, git};

/// A generated pull-request title + body (mirrors the TS `PrText`).
#[derive(Serialize)]
pub struct PrText {
    pub title: String,
    pub body: String,
}

/// Cap the diff/log we feed the model so a huge change can't blow the prompt
/// (mirrors DiffView's 2000-line render ceiling as the mental model).
const MAX_CONTEXT_LINES: usize = 2000;

/// Truncate `text` to at most `MAX_CONTEXT_LINES` lines, marking the cut so the
/// model knows the context is partial.
fn cap_context(text: &str) -> String {
    let mut lines = text.lines();
    let head: Vec<&str> = lines.by_ref().take(MAX_CONTEXT_LINES).collect();
    let mut out = head.join("\n");
    if lines.next().is_some() {
        out.push_str("\n… (diff truncated)");
    }
    out
}

/// Run `claude -p` once with `prompt` piped on stdin, cwd = the worktree, and the
/// login-shell PATH exported. Print mode + text output + an empty tool allowlist
/// keep it non-interactive and confined to reasoning over the piped context (no
/// file reads, no network). Returns trimmed stdout.
fn run_claude(worktree_path: &str, prompt: &str) -> Result<String, String> {
    let (bin, path) = claude_cli()?;
    let mut child = Command::new(&bin)
        .args(["-p", "--output-format", "text", "--allowedTools", ""])
        .current_dir(worktree_path)
        .env("PATH", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run claude: {e}"))?;

    // Write the prompt then drop stdin (EOF) so claude starts generating.
    child
        .stdin
        .take()
        .ok_or("failed to open claude stdin")?
        .write_all(prompt.as_bytes())
        .map_err(|e| format!("failed to send prompt to claude: {e}"))?;

    let out = child
        .wait_with_output()
        .map_err(|e| format!("claude did not complete: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "claude exited without output".into()
        } else {
            err
        });
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Err("claude returned no text".into());
    }
    Ok(text)
}

/// Strip the wrapping the model sometimes adds around a one-shot answer: a
/// fenced ``` block and a "Commit message:" / "Here's…:" preamble line. Pure so
/// the peeling rules are unit-testable.
fn clean_commit_message(raw: &str) -> String {
    let mut s = raw.trim();
    // Peel a single surrounding ``` fence (with or without a language tag).
    if let Some(rest) = s.strip_prefix("```") {
        if let Some(end) = rest.rfind("```") {
            // Drop the first line (the ```lang marker) up to the closing fence.
            let inner = &rest[..end];
            s = inner
                .split_once('\n')
                .map(|(_, b)| b)
                .unwrap_or(inner)
                .trim();
        }
    }
    // Drop a leading meta line like "Commit message:" / "Here is the commit…:".
    if let Some((first, rest)) = s.split_once('\n') {
        let f = first.trim().to_lowercase();
        if (f.starts_with("commit message") || f.starts_with("here"))
            && f.ends_with(':')
            && !rest.trim().is_empty()
        {
            s = rest.trim();
        }
    }
    s.to_string()
}

/// Split a generated PR blob into (title, body): first non-empty line is the
/// title (leading "# "/"Title:" stripped), the remainder is the body. Pure.
fn split_pr_text(raw: &str) -> PrText {
    let cleaned = clean_commit_message(raw); // reuse fence/preamble peeling
    let mut lines = cleaned.lines();
    let title = lines
        .by_ref()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_start_matches("Title:")
        .trim()
        .to_string();
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    PrText { title, body }
}

/// Generate a commit message from the working diff (staged if anything is
/// staged, else everything vs HEAD). Errors if there is nothing to describe.
#[tauri::command]
pub async fn generate_commit_message(worktree_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let staged = git(&worktree_path, &["diff", "--cached", "--stat"])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let diff_args: &[&str] = if staged {
            &["diff", "--cached"]
        } else {
            &["diff", "HEAD"]
        };
        let diff = git(&worktree_path, diff_args)?;
        if diff.trim().is_empty() {
            return Err("no changes to describe — stage or make changes first".into());
        }
        let prompt = format!(
            "Write a git commit message for the following diff. Use the \
             conventional-commits style (e.g. `fix:`, `feat:`, `refactor:`). The \
             subject line must be imperative and about 72 characters or less; add \
             a short body only if it genuinely helps. Output ONLY the commit \
             message — no code fences, no preamble.\n\n{}",
            cap_context(&diff)
        );
        Ok(clean_commit_message(&run_claude(&worktree_path, &prompt)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Generate a PR title + body from the commits on HEAD over `base` (default: the
/// repo's default branch). Errors if there are no commits to propose.
#[tauri::command]
pub async fn generate_pr_text(
    worktree_path: String,
    base: Option<String>,
) -> Result<PrText, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .or_else(|| default_branch(&worktree_path))
            .unwrap_or_else(|| "HEAD".to_string());

        let log_range = format!("{base}..HEAD");
        let log = git(
            &worktree_path,
            &["log", log_range.as_str(), "--pretty=format:- %s%n%b"],
        )
        .unwrap_or_default();
        if log.trim().is_empty() {
            return Err(format!(
                "no commits on HEAD beyond {base} — commit your changes first"
            ));
        }
        // `base...HEAD` (three-dot) diffs against the merge base — what the PR
        // will actually show — matching `gh pr create`.
        let diff_range = format!("{base}...HEAD");
        let diff = git(&worktree_path, &["diff", diff_range.as_str()]).unwrap_or_default();

        let prompt = format!(
            "Write a pull-request title and description for these changes. Output \
             the title on the FIRST line (imperative, concise, no `#` prefix), \
             then a blank line, then a markdown body summarizing what changed and \
             why. Output ONLY the title and body — no code fences, no preamble.\n\n\
             Commits:\n{}\n\nDiff:\n{}",
            cap_context(&log),
            cap_context(&diff)
        );
        Ok(split_pr_text(&run_claude(&worktree_path, &prompt)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{cap_context, clean_commit_message, split_pr_text};

    #[test]
    fn clean_strips_fence_and_lang() {
        let raw = "```\nfix: handle empty diff\n```";
        assert_eq!(clean_commit_message(raw), "fix: handle empty diff");
        let tagged = "```text\nfeat: add thing\n\nmore detail\n```";
        assert_eq!(
            clean_commit_message(tagged),
            "feat: add thing\n\nmore detail"
        );
    }

    #[test]
    fn clean_strips_preamble_line() {
        let raw = "Commit message:\nfix: the bug";
        assert_eq!(clean_commit_message(raw), "fix: the bug");
        let here = "Here is the commit message:\nfeat: x";
        assert_eq!(clean_commit_message(here), "feat: x");
    }

    #[test]
    fn clean_leaves_a_plain_message_untouched() {
        let raw = "refactor: split the parser\n\nWhy: it was doing too much.";
        assert_eq!(clean_commit_message(raw), raw);
    }

    #[test]
    fn split_pr_takes_first_line_as_title() {
        let raw = "Add commit generation\n\nThis adds a one-shot call.\n\n- detail";
        let pr = split_pr_text(raw);
        assert_eq!(pr.title, "Add commit generation");
        assert_eq!(pr.body, "This adds a one-shot call.\n\n- detail");
    }

    #[test]
    fn split_pr_strips_heading_and_title_label() {
        assert_eq!(
            split_pr_text("# Fix flaky test\n\nbody").title,
            "Fix flaky test"
        );
        assert_eq!(
            split_pr_text("Title: Fix flaky test\n\nbody").title,
            "Fix flaky test"
        );
    }

    #[test]
    fn cap_context_marks_truncation() {
        let many = (0..3000)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let capped = cap_context(&many);
        assert!(capped.ends_with("… (diff truncated)"));
        assert!(capped.lines().count() <= super::MAX_CONTEXT_LINES + 1);
        // A small input is returned verbatim (no marker).
        assert_eq!(cap_context("a\nb"), "a\nb");
    }
}
