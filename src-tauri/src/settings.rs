//! The few settings the backend needs when nobody is at the keyboard (a
//! routine running on schedule). The interface keeps them up to date.

use crate::database::DatabaseState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub claude_binary_path: String,
    pub claude_model: String,
    /// Aeris's instructions.
    pub persona_prompt: String,
    pub workspace_dir: String,
}

const KEY: &str = "app";

/// The saved settings, or the defaults if nothing was saved yet.
pub fn load(state: &State<'_, DatabaseState>) -> AppSettings {
    let Ok(connection) = state.0.lock() else {
        return AppSettings::default();
    };
    connection
        .query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn sync_settings(settings: AppSettings, state: State<'_, DatabaseState>) -> Result<(), String> {
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            [KEY, &value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}
