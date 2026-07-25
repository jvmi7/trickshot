//! Opening URLs in the system browser — the webview can't `window.open` its
//! way out of the Tauri shell, so ⌘-clicked terminal links and the PR link
//! hop through this one command. macOS `open` (the git/`gh`/osascript
//! "drive the system's tool" posture); scheme-whitelisted so a crafted
//! escape sequence in terminal output can't launch arbitrary handlers.

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links open externally".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("open")
            .arg(&url)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("the system opener refused the URL".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
