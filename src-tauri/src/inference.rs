use crate::{
    database::{finish_response, insert_message, load_messages, now_ms, DatabaseState},
    models::{ChatRequest, Message, ServerConfig, StartResult, StreamEvent},
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};

pub const DEFAULT_AERIS_PERSONA: &str = r#"Your identity is Aeris. You are Rohan's private personal AI assistant.
This identity instruction overrides any model self-description learned during training. Never introduce yourself as LFM, Liquid Foundation Model, Liquid AI, a language-model family, or a generic chatbot.
If Rohan asks who or what you are, say that you are Aeris, Rohan's personal AI assistant. Mention the underlying LFM runtime only if he explicitly asks which model powers Aeris.
Your role is to help Rohan think, create, plan, learn, and complete practical work while protecting his privacy.
Be warm, capable, honest, and action-oriented. Prefer clear, concise answers unless Rohan asks for detail.
Match the language and tone Rohan uses. When he writes in Sinhala or romanized Sinhala, reply naturally in the same style and mix English technical terms where useful.
Remember that you run locally on Rohan's Mac. Never claim to have used a tool, accessed a file, remembered a fact, or completed an action unless the application actually provided that result.
Ask a question only when a missing answer would materially change the outcome. Otherwise make a sensible assumption and help immediately.
Address him as Rohan only when it feels natural, not in every response."#;

pub const DEFAULT_AERIS_IDENTITY_RESPONSE: &str = "I'm Aeris, Rohan's personal AI assistant. I run privately on Rohan's Mac to help him think, create, plan, learn, and get things done.";

#[derive(Default)]
pub struct ServerState(pub Mutex<Option<Child>>);

#[derive(Default)]
pub struct GenerationState(pub Mutex<HashSet<String>>);

fn port_is_open(host: &str, port: u16) -> bool {
    let Ok(address) = format!("{host}:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

#[tauri::command]
pub fn start_server(
    config: ServerConfig,
    state: State<'_, ServerState>,
) -> Result<StartResult, String> {
    if config.model_path.trim().is_empty() || !Path::new(&config.model_path).is_file() {
        return Err(format!("Model file not found: {}", config.model_path));
    }
    if port_is_open(&config.host, config.port) {
        return Ok(StartResult {
            pid: None,
            already_running: true,
        });
    }
    let mut process = state.0.lock().map_err(|_| "Could not lock server state")?;
    if let Some(child) = process.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Ok(StartResult {
                pid: Some(child.id()),
                already_running: true,
            });
        }
        *process = None;
    }
    let binary = if config.binary_path.trim().is_empty() {
        "llama-server"
    } else {
        config.binary_path.trim()
    };
    let child = Command::new(binary)
        .args([
            "-m",
            &config.model_path,
            "-c",
            &config.context_size.to_string(),
            "-np",
            "1",
            "-ngl",
            &config.gpu_layers.to_string(),
            "--host",
            &config.host,
            "--port",
            &config.port.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start llama-server at '{binary}': {error}"))?;
    let pid = child.id();
    *process = Some(child);
    Ok(StartResult {
        pid: Some(pid),
        already_running: false,
    })
}

#[tauri::command]
pub fn stop_server(state: State<'_, ServerState>) -> Result<bool, String> {
    let mut process = state.0.lock().map_err(|_| "Could not lock server state")?;
    let Some(mut child) = process.take() else {
        return Ok(false);
    };
    child
        .kill()
        .map_err(|error| format!("Could not stop llama-server: {error}"))?;
    let _ = child.wait();
    Ok(true)
}

#[tauri::command]
pub async fn check_server(config: ServerConfig) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1600))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("{}/health", config.base_url()))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn cancel_generation(
    request_id: String,
    state: State<'_, GenerationState>,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "Could not lock generation state")?
        .insert(request_id);
    Ok(())
}

fn is_cancelled(state: &State<'_, GenerationState>, request_id: &str) -> bool {
    state
        .0
        .lock()
        .map(|requests| requests.contains(request_id))
        .unwrap_or(true)
}

fn clear_cancellation(state: &State<'_, GenerationState>, request_id: &str) {
    if let Ok(mut requests) = state.0.lock() {
        requests.remove(request_id);
    }
}

fn is_identity_question(content: &str) -> bool {
    let normalized = content
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    matches!(
        normalized.as_str(),
        "who are you"
            | "what are you"
            | "what is your name"
            | "tell me who you are"
            | "are you lfm"
            | "oya kawda"
            | "oyaa kawda"
            | "ඔයා කවුද"
            | "ඔබ කවුද"
    )
}

#[tauri::command]
pub async fn stream_chat(
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    database: State<'_, DatabaseState>,
    generations: State<'_, GenerationState>,
) -> Result<(), String> {
    clear_cancellation(&generations, &request.request_id);
    let user_message = Message {
        id: request.user_message_id.clone(),
        chat_id: request.chat_id.clone(),
        role: "user".into(),
        content: request.content.trim().into(),
        created_at: now_ms(),
    };
    insert_message(&database, &user_message)?;
    let identity_response = bounded_setting(
        &request.identity_response,
        DEFAULT_AERIS_IDENTITY_RESPONSE,
        1_000,
    );
    if is_identity_question(&user_message.content) {
        let content = identity_response;
        let _ = on_event.send(StreamEvent::chunk(
            &request.request_id,
            &request.chat_id,
            content.clone(),
        ));
        let assistant_message = Message {
            id: request.assistant_message_id,
            chat_id: request.chat_id.clone(),
            role: "assistant".into(),
            content,
            created_at: now_ms(),
        };
        let prompt_tokens = user_message.content.split_whitespace().count() as u32;
        let completion_tokens = assistant_message.content.split_whitespace().count() as u32;
        let title = finish_response(
            &database,
            &assistant_message,
            prompt_tokens,
            completion_tokens,
        )?;
        let _ = on_event.send(StreamEvent::usage(
            &request.request_id,
            &request.chat_id,
            prompt_tokens,
            completion_tokens,
            0.0,
        ));
        let _ = on_event.send(StreamEvent::done(
            &request.request_id,
            &request.chat_id,
            title,
        ));
        return Ok(());
    }
    let history = load_messages(&database, &request.chat_id)?;
    let persona_prompt = bounded_setting(&request.persona_prompt, DEFAULT_AERIS_PERSONA, 8_000);
    let mut api_messages = vec![json!({ "role": "system", "content": persona_prompt })];
    api_messages.extend(
        history
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("{}/v1/chat/completions", request.config.base_url()))
        .json(&json!({
            "model": "local-model",
            "messages": api_messages,
            "stream": true,
            "stream_options": { "include_usage": true },
            "temperature": 0.5,
            "min_p": 0.15
        }))
        .send()
        .await
        .map_err(|error| {
            let message = format!("Could not reach the local model: {error}");
            let _ = on_event.send(StreamEvent::error(
                &request.request_id,
                &request.chat_id,
                message.clone(),
            ));
            message
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let message = format!("Model request failed ({status}): {detail}");
        let _ = on_event.send(StreamEvent::error(
            &request.request_id,
            &request.chat_id,
            message.clone(),
        ));
        return Err(message);
    }

    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut assistant_content = String::new();
    let mut prompt_tokens = 0_u32;
    let mut completion_tokens = 0_u32;
    let mut speed = 0_f64;

    while let Some(item) = stream.next().await {
        if is_cancelled(&generations, &request.request_id) {
            break;
        }
        let bytes = item.map_err(|error| error.to_string())?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer[..newline].trim().to_string();
            buffer.drain(..=newline);
            if !line.starts_with("data:") || line == "data: [DONE]" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<Value>(line[5..].trim()) else {
                continue;
            };
            if let Some(content) = payload
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
            {
                if !content.is_empty() {
                    assistant_content.push_str(content);
                    let _ = on_event.send(StreamEvent::chunk(
                        &request.request_id,
                        &request.chat_id,
                        content.into(),
                    ));
                }
            }
            if let Some(usage) = payload.get("usage") {
                prompt_tokens = usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                completion_tokens = usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                speed = payload
                    .pointer("/timings/predicted_per_second")
                    .and_then(Value::as_f64)
                    .unwrap_or_else(|| {
                        completion_tokens as f64 / started.elapsed().as_secs_f64().max(0.001)
                    });
                let _ = on_event.send(StreamEvent::usage(
                    &request.request_id,
                    &request.chat_id,
                    prompt_tokens,
                    completion_tokens,
                    speed,
                ));
            }
        }
    }

    let cancelled = is_cancelled(&generations, &request.request_id);
    clear_cancellation(&generations, &request.request_id);
    if assistant_content.is_empty() {
        if cancelled {
            return Ok(());
        }
        let message = "The model returned an empty response.".to_string();
        let _ = on_event.send(StreamEvent::error(
            &request.request_id,
            &request.chat_id,
            message.clone(),
        ));
        return Err(message);
    }
    if completion_tokens == 0 {
        completion_tokens = assistant_content.split_whitespace().count() as u32;
        speed = completion_tokens as f64 / started.elapsed().as_secs_f64().max(0.001);
    }
    let assistant_message = Message {
        id: request.assistant_message_id,
        chat_id: request.chat_id.clone(),
        role: "assistant".into(),
        content: assistant_content,
        created_at: now_ms(),
    };
    let title = finish_response(
        &database,
        &assistant_message,
        prompt_tokens,
        completion_tokens,
    )?;
    let _ = on_event.send(StreamEvent::usage(
        &request.request_id,
        &request.chat_id,
        prompt_tokens,
        completion_tokens,
        speed,
    ));
    let _ = on_event.send(StreamEvent::done(
        &request.request_id,
        &request.chat_id,
        title,
    ));
    Ok(())
}

fn bounded_setting(value: &str, fallback: &str, max_chars: usize) -> String {
    let selected = if value.trim().is_empty() {
        fallback
    } else {
        value.trim()
    };
    selected.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::{bounded_setting, is_identity_question};

    #[test]
    fn detects_common_identity_questions() {
        assert!(is_identity_question("Who are you?"));
        assert!(is_identity_question("WHAT IS YOUR NAME"));
        assert!(is_identity_question("oya kawda?"));
        assert!(is_identity_question("ඔයා කවුද?"));
    }

    #[test]
    fn leaves_regular_questions_for_the_model() {
        assert!(!is_identity_question("Who are you helping today?"));
        assert!(!is_identity_question("Write an X post for me"));
    }

    #[test]
    fn persona_settings_use_fallbacks_and_limits() {
        assert_eq!(
            bounded_setting("  Custom persona  ", "Default", 100),
            "Custom persona"
        );
        assert_eq!(bounded_setting("   ", "Default", 100), "Default");
        assert_eq!(bounded_setting("123456", "Default", 4), "1234");
    }
}
