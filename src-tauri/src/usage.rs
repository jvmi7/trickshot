//! Claude subscription usage windows (the rolling ~5-hour session limit + the
//! weekly limit), read from the same undocumented OAuth endpoint the Claude Code
//! CLI's `/usage` command uses. There is NO API key in this app (see CLAUDE.md);
//! auth is the user's existing Claude Code login, so we reuse its OAuth token.
//!
//! This is a deliberately isolated, best-effort feature: the endpoint is
//! undocumented and aggressively rate-limited, so EVERY failure path maps to an
//! `Err(String)` the UI renders as "usage unavailable" rather than crashing, and
//! the caller (stores.ts) throttles refreshes instead of polling.

use std::process::Command;

use serde::{Deserialize, Serialize};

/// Undocumented endpoint behind the CLI's `/usage`. Returns the live subscription
/// window utilization for the authenticated Claude plan.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Required beta header; without it the endpoint rejects the OAuth token.
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Fallback User-Agent version if we can't read the installed `claude` version.
/// The endpoint rate-limits far more aggressively without a `claude-code/*` UA.
const UA_FALLBACK_VERSION: &str = "2.0.0";

/// One usage window (session or weekly). Mirrored field-for-field in `types.ts`
/// (`UsageWindow`); results stay snake_case per the boundary convention.
#[derive(Serialize, Deserialize, Default)]
pub struct UsageWindow {
    /// Percent of the window consumed (0–100), as returned by the endpoint.
    pub utilization: Option<f64>,
    /// ISO-8601 timestamp when this window resets.
    pub resets_at: Option<String>,
}

/// The subset of the `/usage` response the UI shows. Mirrored in `types.ts`
/// (`UsageInfo`). We capture only the two stable windows; the response carries
/// many other (often null) buckets we intentionally ignore.
#[derive(Serialize, Deserialize, Default)]
pub struct UsageInfo {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
}

/// Shape of the Claude Code credentials store (keychain item or file).
#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OauthTokens,
}

#[derive(Deserialize)]
struct OauthTokens {
    #[serde(rename = "accessToken")]
    access_token: String,
}

/// Why the credentials could not be read. `Missing` is the definitive
/// "no Claude Code login anywhere" signal (`check_auth` maps it to `false`);
/// `Other` is ambiguous (HOME unset, keychain spawn failure, unreadable file)
/// and must never be reported as logged-out.
enum CredError {
    Missing(String),
    Other(String),
}

impl CredError {
    fn message(self) -> String {
        match self {
            CredError::Missing(m) | CredError::Other(m) => m,
        }
    }
}

/// Read the OAuth access token from where the Claude Code login stores it.
/// macOS keeps the *live* (auto-refreshed) token in the login keychain — the
/// on-disk `~/.claude/.credentials.json` there is often stale — so prefer the
/// keychain and fall back to the file. Other platforms use the file directly.
fn read_access_token() -> Result<String, CredError> {
    let raw = read_credentials_json()?;
    // A store that exists but doesn't parse means the login is gone/incomplete,
    // not an environment problem — treat it as definitively logged-out.
    let creds: Credentials = serde_json::from_str(&raw)
        .map_err(|e| CredError::Missing(format!("could not parse Claude credentials: {e}")))?;
    Ok(creds.claude_ai_oauth.access_token)
}

#[cfg(target_os = "macos")]
fn read_credentials_json() -> Result<String, CredError> {
    // Live token: `security find-generic-password -s "Claude Code-credentials" -w`.
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .map_err(|e| CredError::Other(format!("failed to read keychain: {e}")))?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }
    // Fall back to the on-disk credentials if the keychain item is absent.
    read_credentials_file()
}

#[cfg(not(target_os = "macos"))]
fn read_credentials_json() -> Result<String, CredError> {
    read_credentials_file()
}

fn read_credentials_file() -> Result<String, CredError> {
    let home =
        std::env::var("HOME").map_err(|_| CredError::Other("HOME is not set".to_string()))?;
    let path = format!("{home}/.claude/.credentials.json");
    std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("could not read {path}: {e} (is Claude Code logged in?)");
        // Absent file = no login on this machine (definitive); any other io
        // error (permissions, etc.) is ambiguous.
        if e.kind() == std::io::ErrorKind::NotFound {
            CredError::Missing(msg)
        } else {
            CredError::Other(msg)
        }
    })
}

/// Whether a Claude Code login exists on this machine. `Ok(true)` = credentials
/// found (NOT a validity guarantee — an expired token still reports `true`;
/// the real check is the first authenticated call). `Ok(false)` = definitively
/// no credentials (keychain item absent AND no credentials file). `Err` =
/// ambiguous environment failure — the UI stays silent rather than showing a
/// false "not signed in" alarm. Local reads only; never hits the network.
#[tauri::command]
pub async fn check_auth() -> Result<bool, String> {
    match read_access_token() {
        Ok(_) => Ok(true),
        Err(CredError::Missing(_)) => Ok(false),
        Err(e) => Err(e.message()),
    }
}

/// Best-effort `claude-code/<version>` User-Agent. We try the installed CLI's
/// version and fall back to a constant — the endpoint only needs a `claude-code/*`
/// UA to avoid its stricter rate-limit bucket, not an exact match.
/// Parse the CLI's `--version` stdout into a bare version string. The output
/// looks like `"2.1.193 (Claude Code)"`, so we take the first whitespace-delimited
/// token. `None` when there is no token (empty / whitespace-only output).
fn parse_cli_version(stdout: &str) -> Option<String> {
    stdout.split_whitespace().next().map(|v| v.to_string())
}

fn user_agent() -> String {
    let version = Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_cli_version(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_else(|| UA_FALLBACK_VERSION.to_string());
    format!("claude-code/{version}")
}

/// Fetch the user's current subscription usage windows. Errors (no login,
/// expired token, rate limit, network) surface as `Err(String)` for the UI to
/// show as unavailable — never a panic. Marked async so the network call runs
/// off the main thread on Tauri's runtime.
#[tauri::command]
pub async fn get_usage() -> Result<UsageInfo, String> {
    let token = read_access_token().map_err(CredError::message)?;
    let client = reqwest::Client::new();
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::USER_AGENT, user_agent())
        .send()
        .await
        .map_err(|e| format!("usage request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // 401 = stale/expired token (re-login), 429 = rate limited (back off).
        return Err(format!("usage endpoint returned {status}"));
    }
    resp.json::<UsageInfo>()
        .await
        .map_err(|e| format!("could not parse usage response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::parse_cli_version;

    #[test]
    fn parses_first_token_as_version() {
        assert_eq!(
            parse_cli_version("2.1.193 (Claude Code)").as_deref(),
            Some("2.1.193")
        );
    }

    #[test]
    fn tolerates_a_bare_version_with_trailing_newline() {
        assert_eq!(parse_cli_version("2.0.0\n").as_deref(), Some("2.0.0"));
    }

    #[test]
    fn empty_or_whitespace_only_yields_none() {
        assert_eq!(parse_cli_version(""), None);
        assert_eq!(parse_cli_version("   \n  "), None);
    }
}
