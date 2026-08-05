use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub model_path: String,
    pub binary_path: String,
    pub context_size: u32,
    pub gpu_layers: u32,
    pub host: String,
    pub port: u16,
}

impl ServerConfig {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub pid: Option<u32>,
    pub already_running: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMessage {
    pub id: Option<String>,
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub chat_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub content: String,
    pub config: ServerConfig,
    pub persona_prompt: String,
    pub identity_response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl StreamEvent {
    pub fn chunk(request_id: &str, chat_id: &str, content: String) -> Self {
        Self {
            kind: "chunk".into(),
            request_id: request_id.into(),
            chat_id: chat_id.into(),
            content: Some(content),
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            title: None,
            message: None,
        }
    }

    pub fn usage(
        request_id: &str,
        chat_id: &str,
        prompt: u32,
        completion: u32,
        speed: f64,
    ) -> Self {
        Self {
            kind: "usage".into(),
            request_id: request_id.into(),
            chat_id: chat_id.into(),
            content: None,
            prompt_tokens: Some(prompt),
            completion_tokens: Some(completion),
            tokens_per_second: Some(speed),
            title: None,
            message: None,
        }
    }

    pub fn done(request_id: &str, chat_id: &str, title: String) -> Self {
        Self {
            kind: "done".into(),
            request_id: request_id.into(),
            chat_id: chat_id.into(),
            content: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            title: Some(title),
            message: None,
        }
    }

    pub fn error(request_id: &str, chat_id: &str, message: String) -> Self {
        Self {
            kind: "error".into(),
            request_id: request_id.into(),
            chat_id: chat_id.into(),
            content: None,
            prompt_tokens: None,
            completion_tokens: None,
            tokens_per_second: None,
            title: None,
            message: Some(message),
        }
    }
}
