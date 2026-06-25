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

/// Read the OAuth access token from where the Claude Code login stores it.
/// macOS keeps the *live* (auto-refreshed) token in the login keychain — the
/// on-disk `~/.claude/.credentials.json` there is often stale — so prefer the
/// keychain and fall back to the file. Other platforms use the file directly.
fn read_access_token() -> Result<String, String> {
    let raw = read_credentials_json()?;
    let creds: Credentials =
        serde_json::from_str(&raw).map_err(|e| format!("could not parse Claude credentials: {e}"))?;
    Ok(creds.claude_ai_oauth.access_token)
}

#[cfg(target_os = "macos")]
fn read_credentials_json() -> Result<String, String> {
    // Live token: `security find-generic-password -s "Claude Code-credentials" -w`.
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("failed to read keychain: {e}"))?;
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
fn read_credentials_json() -> Result<String, String> {
    read_credentials_file()
}

fn read_credentials_file() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    let path = format!("{home}/.claude/.credentials.json");
    std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {path}: {e} (is Claude Code logged in?)"))
}

/// Best-effort `claude-code/<version>` User-Agent. We try the installed CLI's
/// version and fall back to a constant — the endpoint only needs a `claude-code/*`
/// UA to avoid its stricter rate-limit bucket, not an exact match.
fn user_agent() -> String {
    let version = Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .and_then(|s| {
            // Output looks like "2.1.193 (Claude Code)"; take the first token.
            s.split_whitespace().next().map(|v| v.to_string())
        })
        .unwrap_or_else(|| UA_FALLBACK_VERSION.to_string());
    format!("claude-code/{version}")
}

/// Fetch the user's current subscription usage windows. Errors (no login,
/// expired token, rate limit, network) surface as `Err(String)` for the UI to
/// show as unavailable — never a panic. Marked async so the network call runs
/// off the main thread on Tauri's runtime.
#[tauri::command]
pub async fn get_usage() -> Result<UsageInfo, String> {
    let token = read_access_token()?;
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
