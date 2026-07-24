//! System output-volume control (the footer's volume slider). macOS-only by
//! nature: it shells `osascript` — the same "drive the system's own tool"
//! posture as git/`gh`, no audio crate, no persistent process. On other
//! platforms the spawn fails and the error string surfaces to the UI (which
//! simply hides the control after a failed probe).

use std::process::Command;

#[derive(serde::Serialize)]
pub struct VolumeInfo {
    /// Output volume percent (0–100).
    pub volume: u8,
    pub muted: bool,
}

/// Run one AppleScript expression and return its trimmed stdout.
fn osascript(expr: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(expr)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Parse `get volume settings` output — the reply is one line shaped like
/// `output volume:38, input volume:27, alert volume:100, output muted:false`.
/// A device with no software volume reports `missing value` → Err (the UI
/// hides the slider). Pure so it's unit-testable.
fn parse_volume_settings(raw: &str) -> Result<VolumeInfo, String> {
    let field = |name: &str| -> Option<&str> {
        raw.split(',')
            .map(str::trim)
            .find_map(|part| part.strip_prefix(name).and_then(|v| v.strip_prefix(':')))
    };
    let volume = field("output volume")
        .and_then(|v| v.trim().parse::<u8>().ok())
        .ok_or_else(|| "output volume unavailable on this device".to_string())?;
    let muted = field("output muted")
        .map(|v| v.trim() == "true")
        .unwrap_or(false);
    Ok(VolumeInfo {
        volume: volume.min(100),
        muted,
    })
}

/// The system output volume + mute state.
#[tauri::command]
pub async fn get_volume() -> Result<VolumeInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        parse_volume_settings(&osascript("get volume settings")?)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Set the system output volume (percent, clamped to 0–100). Setting a
/// volume also unmutes — matching the OS volume keys' behavior.
#[tauri::command]
pub async fn set_volume(volume: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v = volume.min(100);
        // Two statements in one osascript run: set + unmute (the numeric set
        // alone leaves a muted device silent at volume N).
        osascript(&format!(
            "set volume output volume {v}\nset volume output muted false"
        ))
        .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mute/unmute the system output.
#[tauri::command]
pub async fn set_muted(muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        osascript(&format!("set volume output muted {muted}")).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_volume_settings;

    #[test]
    fn parses_the_standard_settings_line() {
        let info = parse_volume_settings(
            "output volume:38, input volume:27, alert volume:100, output muted:false",
        )
        .unwrap();
        assert_eq!(info.volume, 38);
        assert!(!info.muted);

        let muted = parse_volume_settings(
            "output volume:100, input volume:0, alert volume:100, output muted:true",
        )
        .unwrap();
        assert_eq!(muted.volume, 100);
        assert!(muted.muted);
    }

    #[test]
    fn missing_value_is_an_error_not_a_zero() {
        // Some output devices (AirPlay, some DACs) have no software volume.
        assert!(parse_volume_settings(
            "output volume:missing value, input volume:27, alert volume:100, output muted:false"
        )
        .is_err());
        assert!(parse_volume_settings("").is_err());
        assert!(parse_volume_settings("not the settings line").is_err());
    }

    #[test]
    fn field_order_does_not_matter() {
        let info =
            parse_volume_settings("output muted:true, alert volume:100, output volume:7").unwrap();
        assert_eq!(info.volume, 7);
        assert!(info.muted);
    }
}
