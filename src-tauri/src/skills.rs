//! Skills: saved procedures any teammate can load before doing a task they
//! cover. One library is shared by the whole team.

use crate::{
    agents::{self, Backend},
    database::{load_messages, now_ms, DatabaseState},
    settings,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    /// When to use it, in a sentence. Teammates see this before loading it.
    pub description: String,
    pub instructions: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub instructions: String,
}

/// A skill proposed from a finished thread, for Rohan to review and save.
#[derive(Debug, Serialize, PartialEq)]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub instructions: String,
}

fn limited(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

pub fn all(state: &State<'_, DatabaseState>) -> Result<Vec<Skill>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare("SELECT id, name, description, instructions, created_at FROM skills ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Skill {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                instructions: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_skills(state: State<'_, DatabaseState>) -> Result<Vec<Skill>, String> {
    all(&state)
}

#[tauri::command]
pub fn save_skill(input: SkillInput, state: State<'_, DatabaseState>) -> Result<Skill, String> {
    let name = limited(&input.name, 60);
    let instructions = limited(&input.instructions, 12_000);
    if name.is_empty() {
        return Err("Give the skill a name.".into());
    }
    if instructions.is_empty() {
        return Err("Write the steps the skill should follow.".into());
    }
    let skill = Skill {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        name,
        description: limited(&input.description, 300),
        instructions,
        created_at: now_ms(),
    };
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let taken: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM skills WHERE name = ?1 COLLATE NOCASE AND id != ?2",
            params![skill.name, skill.id],
            |row| row.get::<_, i64>(0).map(|count| count > 0),
        )
        .map_err(|error| error.to_string())?;
    if taken {
        return Err(format!("There is already a skill named {}.", skill.name));
    }
    connection
        .execute(
            "INSERT INTO skills (id, name, description, instructions, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = ?2, description = ?3, instructions = ?4",
            params![skill.id, skill.name, skill.description, skill.instructions, skill.created_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(skill)
}

#[tauri::command]
pub fn delete_skill(skill_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute("DELETE FROM skills WHERE id = ?1", [skill_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

const DRAFT_PROMPT: &str = r#"You turn a finished piece of work into a reusable skill: a procedure a teammate can follow to do the same kind of task again.
Read the conversation and reply with only a JSON object with these string fields:
- "name": a short title of at most five words.
- "description": one sentence saying when to use the skill.
- "instructions": the procedure, written as instructions to a teammate: numbered steps, the rules for decisions that came up, and the format the result must have. Replace the specifics of this one conversation with placeholders in [square brackets], and keep every preference Rohan stated."#;

/// Pulls the skill out of the model's reply, which should be a JSON object
/// but may arrive wrapped in a code fence or a sentence.
pub fn parse_draft(reply: &str) -> Option<SkillDraft> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    let value: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let field = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let draft = SkillDraft {
        name: field("name"),
        description: field("description"),
        instructions: field("instructions"),
    };
    (!draft.name.is_empty() && !draft.instructions.is_empty()).then_some(draft)
}

/// Drafts a skill from a thread so a process that worked can be reused.
#[tauri::command]
pub async fn draft_skill(chat_id: String, app: AppHandle) -> Result<SkillDraft, String> {
    let database = app.state::<DatabaseState>();
    let saved = settings::load(&database);
    let history = load_messages(&database, &chat_id)?;
    if history.is_empty() {
        return Err("This thread has nothing to turn into a skill yet.".into());
    }
    let recent = &history[history.len().saturating_sub(12)..];
    let transcript: Vec<String> = recent
        .iter()
        .map(|message| {
            let speaker = if message.role == "user" { "Rohan" } else { "Teammate" };
            let text: String = message.content.chars().take(2_000).collect();
            format!("{speaker}: {text}")
        })
        .collect();
    let backend = Backend {
        binary_path: saved.claude_binary_path,
        model: saved.claude_model,
        neutral_dir: app
            .path()
            .app_data_dir()
            .map(|path| path.join("claude-workspace"))
            .map_err(|error| error.to_string())?,
    };
    let turns = [agents::turn("user", transcript.join("\n\n"))];
    let completion = backend
        .complete(DRAFT_PROMPT, &turns, false, &|_| {}, &|| false)
        .await?;
    parse_draft(&completion.content)
        .ok_or_else(|| "Could not turn this thread into a skill. Try writing it yourself.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_draft_even_when_it_is_wrapped() {
        let reply = "Here it is:\n```json\n{\"name\": \"Lesson notes\", \"description\": \"Use for a new lesson.\", \"instructions\": \"1. Ask for the topic.\"}\n```";
        assert_eq!(
            parse_draft(reply),
            Some(SkillDraft {
                name: "Lesson notes".into(),
                description: "Use for a new lesson.".into(),
                instructions: "1. Ask for the topic.".into(),
            })
        );
    }

    #[test]
    fn rejects_replies_without_a_usable_skill() {
        assert_eq!(parse_draft("I could not find a process."), None);
        assert_eq!(parse_draft(r#"{"name": "", "instructions": "steps"}"#), None);
        assert_eq!(parse_draft(r#"{"name": "X"}"#), None);
    }
}
