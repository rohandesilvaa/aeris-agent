use crate::models::VoiceConfig;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::State;
use uuid::Uuid;

const VOICE_HOST: &str = "127.0.0.1";
const VOICE_PORT: u16 = 8092;

struct VoiceProcess {
    child: Child,
    binary_path: PathBuf,
    model_path: String,
}

#[derive(Default)]
pub struct VoiceServerState(Mutex<Option<VoiceProcess>>);

pub fn stop_managed_server(state: &VoiceServerState) {
    if let Ok(mut process) = state.0.lock() {
        if let Some(mut managed) = process.take() {
            let _ = managed.child.kill();
            let _ = managed.child.wait();
        }
    }
}

fn server_binary(cli_path: &str) -> PathBuf {
    Path::new(cli_path)
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("whisper-server")
}

async fn ensure_server(config: &VoiceConfig, state: &VoiceServerState) -> Result<(), String> {
    let binary_path = server_binary(&config.whisper_binary_path);
    if !binary_path.is_file() {
        return Err(format!(
            "whisper-server not found: {}. Install whisper.cpp or update the Whisper path in Settings.",
            binary_path.display()
        ));
    }
    if !Path::new(&config.whisper_model_path).is_file() {
        return Err(format!(
            "Whisper model not found: {}",
            config.whisper_model_path
        ));
    }
    let language = if config.language.trim().is_empty() {
        "en"
    } else {
        config.language.trim()
    };

    {
        let mut process = state.0.lock().map_err(|error| error.to_string())?;
        let reusable = if let Some(managed) = process.as_mut() {
            managed
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
                && managed.binary_path == binary_path
                && managed.model_path == config.whisper_model_path
        } else {
            false
        };

        if !reusable {
            if let Some(mut managed) = process.take() {
                let _ = managed.child.kill();
                let _ = managed.child.wait();
            }
            let child = Command::new(&binary_path)
                .arg("-m")
                .arg(&config.whisper_model_path)
                .arg("-l")
                .arg(language)
                .args([
                    "-ng",
                    "-nt",
                    "-nlp",
                    "-t",
                    "4",
                    "--host",
                    VOICE_HOST,
                    "--port",
                    &VOICE_PORT.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("Could not start whisper-server: {error}"))?;
            *process = Some(VoiceProcess {
                child,
                binary_path: binary_path.clone(),
                model_path: config.whisper_model_path.clone(),
            });
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://{VOICE_HOST}:{VOICE_PORT}/");
    for _ in 0..120 {
        if client
            .get(&url)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        {
            let mut process = state.0.lock().map_err(|error| error.to_string())?;
            if let Some(managed) = process.as_mut() {
                if let Some(status) = managed
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                {
                    process.take();
                    return Err(format!("whisper-server stopped during startup ({status})."));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("whisper-server took too long to load the English speech model.".into())
}

fn prepare_audio(
    audio_base64: String,
    mime_type: String,
    ffmpeg_path: String,
) -> Result<(PathBuf, PathBuf), String> {
    if !Path::new(&ffmpeg_path).is_file() {
        return Err(format!("ffmpeg not found: {ffmpeg_path}"));
    }
    let extension = if mime_type.contains("mp4") || mime_type.contains("m4a") {
        "m4a"
    } else if mime_type.contains("ogg") {
        "ogg"
    } else if mime_type.contains("wav") {
        "wav"
    } else {
        "webm"
    };
    let temp_dir = std::env::temp_dir().join(format!("aeris-voice-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let input_path = temp_dir.join(format!("input.{extension}"));
    let wav_path = temp_dir.join("speech.wav");

    let result = (|| {
        let audio = STANDARD
            .decode(audio_base64.trim())
            .map_err(|error| format!("Invalid microphone audio: {error}"))?;
        if audio.is_empty() || audio.len() > 25 * 1024 * 1024 {
            return Err("Voice recording is empty or too large.".to_string());
        }
        fs::write(&input_path, audio).map_err(|error| error.to_string())?;
        let ffmpeg = Command::new(ffmpeg_path)
            .args(["-y", "-loglevel", "error", "-i"])
            .arg(&input_path)
            .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
            .arg(&wav_path)
            .output()
            .map_err(|error| format!("Could not run ffmpeg: {error}"))?;
        if !ffmpeg.status.success() {
            return Err(format!(
                "Could not prepare microphone audio: {}",
                String::from_utf8_lossy(&ffmpeg.stderr).trim()
            ));
        }
        Ok((temp_dir.clone(), wav_path))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

#[tauri::command]
pub async fn prepare_voice_server(
    config: VoiceConfig,
    state: State<'_, VoiceServerState>,
) -> Result<(), String> {
    ensure_server(&config, &state).await
}

#[tauri::command]
pub async fn transcribe_audio(
    audio_base64: String,
    mime_type: String,
    config: VoiceConfig,
    state: State<'_, VoiceServerState>,
) -> Result<String, String> {
    let ffmpeg_path = config.ffmpeg_path.clone();
    let (temp_dir, wav_path) = tauri::async_runtime::spawn_blocking(move || {
        prepare_audio(audio_base64, mime_type, ffmpeg_path)
    })
    .await
    .map_err(|error| error.to_string())??;

    let result = async {
        ensure_server(&config, &state).await?;
        let audio = fs::read(&wav_path).map_err(|error| error.to_string())?;
        let part = Part::bytes(audio)
            .file_name("speech.wav")
            .mime_str("audio/wav")
            .map_err(|error| error.to_string())?;
        let form = Form::new()
            .part("file", part)
            .text("response_format", "json")
            .text("language", "en")
            .text("temperature", "0.0");
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|error| error.to_string())?
            .post(format!("http://{VOICE_HOST}:{VOICE_PORT}/inference"))
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("Could not reach local whisper-server: {error}"))?;
        let status = response.status();
        let body = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("Local transcription failed ({status}): {body}"));
        }
        let transcript = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.get("text")?.as_str().map(str::to_owned))
            .unwrap_or(body)
            .trim()
            .to_string();
        if transcript.is_empty() || transcript == "[BLANK_AUDIO]" {
            return Err("I couldn't hear any speech. Please try again.".to_string());
        }
        Ok(transcript)
    }
    .await;

    let _ = fs::remove_dir_all(temp_dir);
    result
}
