use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    /// The teammate this thread is with, or `group` for a group thread.
    pub bot_id: String,
    /// Teammate ids in a group thread, lead first. Empty for a direct thread.
    pub members: Vec<String>,
}

/// A named AI teammate with its own instructions and long-term memory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub instructions: String,
    pub memory: String,
    pub memory_enabled: bool,
    /// May read and write files and run commands in the workspace folder.
    pub workspace_enabled: bool,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotInput {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default = "enabled")]
    pub memory_enabled: bool,
    #[serde(default = "enabled")]
    pub workspace_enabled: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    /// Which teammate wrote an assistant message. Empty on user messages.
    #[serde(default)]
    pub bot_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    pub chat_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
    pub content: String,
    /// Aeris's instructions from Settings. Other teammates carry their own.
    #[serde(default)]
    pub persona_prompt: String,
    #[serde(default)]
    pub claude_binary_path: String,
    #[serde(default)]
    pub claude_model: String,
    /// Consult the specialist agents before replying.
    #[serde(default)]
    pub team_mode: bool,
    /// The workspace folder from Settings. Empty means the default folder.
    #[serde(default)]
    pub workspace_dir: String,
    /// A routine running on schedule: nobody can answer approvals.
    #[serde(default)]
    pub unattended: bool,
    /// For an unattended run, whether file writes go ahead without asking.
    #[serde(default)]
    pub unattended_writes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    pub message_id: String,
    pub agent: String,
    pub content: String,
    pub position: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeInfo {
    pub installed: bool,
    pub logged_in: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    pub whisper_binary_path: String,
    pub whisper_model_path: String,
    pub ffmpeg_path: String,
    pub language: String,
}

#[derive(Debug, Default, Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

impl StreamEvent {
    fn new(kind: &str, request_id: &str, chat_id: &str) -> Self {
        Self {
            kind: kind.into(),
            request_id: request_id.into(),
            chat_id: chat_id.into(),
            ..Self::default()
        }
    }

    pub fn chunk(request_id: &str, chat_id: &str, content: String) -> Self {
        Self {
            content: Some(content),
            ..Self::new("chunk", request_id, chat_id)
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
            prompt_tokens: Some(prompt),
            completion_tokens: Some(completion),
            tokens_per_second: Some(speed),
            ..Self::new("usage", request_id, chat_id)
        }
    }

    pub fn done(request_id: &str, chat_id: &str, title: String) -> Self {
        Self {
            title: Some(title),
            ..Self::new("done", request_id, chat_id)
        }
    }

    pub fn error(request_id: &str, chat_id: &str, message: String) -> Self {
        Self {
            message: Some(message),
            ..Self::new("error", request_id, chat_id)
        }
    }

    /// A teammate is starting a reply in a group thread.
    pub fn message(request_id: &str, chat_id: &str, message_id: &str, bot_id: &str) -> Self {
        Self {
            message_id: Some(message_id.into()),
            agent: Some(bot_id.into()),
            ..Self::new("message", request_id, chat_id)
        }
    }

    /// One teammate asking another for help. `status` is `start` (content is
    /// the question), `chunk`, `done`, or `error`.
    pub fn handoff(
        request_id: &str,
        chat_id: &str,
        bot_id: &str,
        status: &str,
        content: Option<String>,
    ) -> Self {
        Self {
            agent: Some(bot_id.into()),
            status: Some(status.into()),
            content,
            ..Self::new("handoff", request_id, chat_id)
        }
    }

    /// Something the teammate just did with a tool.
    pub fn tool(request_id: &str, chat_id: &str, tool: &str, summary: String) -> Self {
        Self {
            tool: Some(tool.into()),
            content: Some(summary),
            ..Self::new("tool", request_id, chat_id)
        }
    }

    /// A write or command waiting for Rohan's answer.
    pub fn approval(
        request_id: &str,
        chat_id: &str,
        approval_id: &str,
        tool: &str,
        summary: String,
        detail: String,
    ) -> Self {
        Self {
            approval_id: Some(approval_id.into()),
            tool: Some(tool.into()),
            content: Some(summary),
            message: Some(detail),
            ..Self::new("approval", request_id, chat_id)
        }
    }

    /// Progress from one member of the agent team. `status` is one of
    /// `start`, `chunk`, `done`, or `error`.
    pub fn agent(
        request_id: &str,
        chat_id: &str,
        agent: &str,
        status: &str,
        content: Option<String>,
    ) -> Self {
        Self {
            agent: Some(agent.into()),
            status: Some(status.into()),
            content,
            ..Self::new("agent", request_id, chat_id)
        }
    }
}
