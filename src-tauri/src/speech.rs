//! Reading replies aloud with the macOS `say` command. The web view only
//! exposes a fixed set of voices, so downloaded Premium and Enhanced voices
//! are reachable only this way.

use serde::Serialize;
use std::{process::Stdio, sync::Mutex};
use tauri::State;
use tokio::{io::AsyncWriteExt, process::Command, sync::oneshot};

const SAY: &str = "/usr/bin/say";

/// Holds the way to stop whatever is being read right now.
#[derive(Default)]
pub struct SpeechState(Mutex<Option<oneshot::Sender<()>>>);

#[derive(Debug, Serialize, PartialEq)]
pub struct SystemVoice {
    pub name: String,
    pub locale: String,
}

/// Parses one line of `say -v ?`, such as
/// `Ava (Premium)       en_US    # Hello! My name is Ava.`
fn parse_voice(line: &str) -> Option<SystemVoice> {
    let (listing, _sample) = line.split_once('#')?;
    let listing = listing.trim_end();
    let (name, locale) = listing.rsplit_once(char::is_whitespace)?;
    let name = name.trim();
    if name.is_empty() || !locale.contains('_') {
        return None;
    }
    Some(SystemVoice {
        name: name.to_string(),
        locale: locale.to_string(),
    })
}

#[tauri::command]
pub async fn list_voices() -> Result<Vec<SystemVoice>, String> {
    let output = Command::new(SAY)
        .args(["-v", "?"])
        .output()
        .await
        .map_err(|error| format!("Could not list macOS voices: {error}"))?;
    let mut voices: Vec<SystemVoice> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_voice)
        .collect();
    voices.dedup();
    Ok(voices)
}

/// Reads `text` aloud and resolves when it ends: `true` if it finished,
/// `false` if it was stopped or replaced by something newer.
#[tauri::command]
pub async fn speak(
    text: String,
    voice: String,
    state: State<'_, SpeechState>,
) -> Result<bool, String> {
    let (stop, stopped) = oneshot::channel();
    // Replacing the sender drops the old one, which stops the earlier reading.
    *state.0.lock().map_err(|_| "Could not lock speech state")? = Some(stop);

    let mut command = Command::new(SAY);
    if !voice.trim().is_empty() {
        command.args(["-v", voice.trim()]);
    }
    let mut child = command
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start the macOS voice: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    tokio::select! {
        status = child.wait() => Ok(status.map(|status| status.success()).unwrap_or(false)),
        _ = stopped => {
            let _ = child.kill().await;
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn stop_speaking(state: State<'_, SpeechState>) {
    if let Ok(mut current) = state.0.lock() {
        if let Some(stop) = current.take() {
            let _ = stop.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_premium_and_bracketed_voice_names() {
        let voice = |name: &str, locale: &str| Some(SystemVoice { name: name.into(), locale: locale.into() });
        assert_eq!(parse_voice("Ava (Premium)       en_US    # Hello! My name is Ava."), voice("Ava (Premium)", "en_US"));
        assert_eq!(parse_voice("Samantha (English (US)) en_US    # Hello! My name is Samantha."), voice("Samantha (English (US))", "en_US"));
        assert_eq!(parse_voice("Daniel              en_GB    # Hello! My name is Daniel."), voice("Daniel", "en_GB"));
        assert_eq!(parse_voice("not a voice line"), None);
    }
}
