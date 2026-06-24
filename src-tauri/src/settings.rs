//! Secure storage for the Z.ai (GLM provider) credentials.
//!
//! The Claude provider needs no key — it uses the existing Claude Code login (see
//! CLAUDE.md). The GLM provider talks to Z.ai's API, which DOES require a key, so
//! this is the one place the app stores a secret. It lives in the OS keychain (via
//! `keyring`), never in localStorage, and is NEVER handed back to the webview:
//! `start_session` reads it here directly when spawning a `glm` sidecar (agent.rs),
//! and `get_zai_settings` reports only whether a key is present.

use keyring::Entry;
use serde::Serialize;

const SERVICE: &str = "trickshot";
const KEY_ACCOUNT: &str = "zai_api_key";
const URL_ACCOUNT: &str = "zai_base_url";
/// Z.ai's Anthropic-compatible endpoint — the default when none is stored.
const DEFAULT_BASE_URL: &str = "https://api.z.ai/api/anthropic";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

/// The stored Z.ai API key, or None if unset/empty. Read by `start_session`.
pub fn zai_api_key() -> Option<String> {
    match entry(KEY_ACCOUNT).ok()?.get_password() {
        Ok(k) if !k.is_empty() => Some(k),
        _ => None,
    }
}

/// The stored base URL, or the Z.ai default if unset.
pub fn zai_base_url() -> String {
    entry(URL_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// What the Settings UI sees: the base URL + whether a key is stored. The key
/// itself is NEVER returned to the webview.
#[derive(Serialize)]
pub struct ZaiSettings {
    base_url: String,
    key_present: bool,
}

#[tauri::command]
pub fn get_zai_settings() -> ZaiSettings {
    ZaiSettings {
        base_url: zai_base_url(),
        key_present: zai_api_key().is_some(),
    }
}

/// Store (or clear, when empty) the Z.ai API key and/or base URL. A `None` field
/// is left unchanged; an empty string clears it. Args arrive camelCase from JS
/// (`apiKey`/`baseUrl`) and Tauri maps them to these snake_case params.
#[tauri::command]
pub fn set_zai_settings(api_key: Option<String>, base_url: Option<String>) -> Result<(), String> {
    if let Some(key) = api_key {
        let e = entry(KEY_ACCOUNT)?;
        if key.is_empty() {
            let _ = e.delete_credential();
        } else {
            e.set_password(&key).map_err(|x| x.to_string())?;
        }
    }
    if let Some(url) = base_url {
        let e = entry(URL_ACCOUNT)?;
        if url.is_empty() {
            let _ = e.delete_credential();
        } else {
            e.set_password(&url).map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}
