use crate::models::{ChatSummary, LegacyMessage, Message};
use rusqlite::{params, Connection};
use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use uuid::Uuid;

pub struct DatabaseState(pub Mutex<Connection>);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn initialize(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_messages_chat_time
            ON messages(chat_id, created_at);",
    )
}

fn row_to_chat(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSummary> {
    Ok(ChatSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        prompt_tokens: row.get(4)?,
        completion_tokens: row.get(5)?,
    })
}

#[tauri::command]
pub fn list_chats(state: State<'_, DatabaseState>) -> Result<Vec<ChatSummary>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare("SELECT id, title, created_at, updated_at, prompt_tokens, completion_tokens FROM chats ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_chat)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_chat(
    title: Option<String>,
    state: State<'_, DatabaseState>,
) -> Result<ChatSummary, String> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now_ms();
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "New chat".into());
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, title, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(ChatSummary {
        id,
        title,
        created_at: timestamp,
        updated_at: timestamp,
        prompt_tokens: 0,
        completion_tokens: 0,
    })
}

#[tauri::command]
pub fn get_chat_messages(
    chat_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<Message>, String> {
    load_messages(&state, &chat_id)
}

pub fn load_messages(
    state: &State<'_, DatabaseState>,
    chat_id: &str,
) -> Result<Vec<Message>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare("SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id = ?1 ORDER BY created_at, rowid")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([chat_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                chat_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_chat(
    chat_id: String,
    title: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Chat title cannot be empty".into());
    }
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now_ms(), chat_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_chat(chat_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute("DELETE FROM chats WHERE id = ?1", [chat_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_chat(chat_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM messages WHERE chat_id = ?1", [&chat_id])
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE chats SET title = 'New chat', updated_at = ?1, prompt_tokens = 0, completion_tokens = 0 WHERE id = ?2",
        params![now_ms(), chat_id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_legacy_messages(
    chat_id: String,
    messages: Vec<LegacyMessage>,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let mut connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let start = now_ms();
    for (index, message) in messages.into_iter().enumerate() {
        if !matches!(message.role.as_str(), "user" | "assistant" | "system") {
            continue;
        }
        let id = message.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        transaction.execute(
            "INSERT OR IGNORE INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, chat_id, message.role, message.content, start + index as i64],
        ).map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE chats SET title = 'Imported conversation', updated_at = ?1 WHERE id = ?2",
            params![now_ms(), chat_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn insert_message(state: &State<'_, DatabaseState>, message: &Message) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection.execute(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![message.id, message.chat_id, message.role, message.content, message.created_at],
    ).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
            params![message.created_at, message.chat_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn finish_response(
    state: &State<'_, DatabaseState>,
    message: &Message,
    prompt_tokens: u32,
    completion_tokens: u32,
) -> Result<String, String> {
    let mut connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![message.id, message.chat_id, message.role, message.content, message.created_at],
    ).map_err(|error| error.to_string())?;
    let current_title: String = transaction
        .query_row(
            "SELECT title FROM chats WHERE id = ?1",
            [&message.chat_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let title = if current_title == "New chat" {
        transaction.query_row(
            "SELECT content FROM messages WHERE chat_id = ?1 AND role = 'user' ORDER BY created_at LIMIT 1",
            [&message.chat_id], |row| row.get::<_, String>(0),
        ).map(title_from_message).unwrap_or(current_title)
    } else {
        current_title
    };
    transaction.execute(
        "UPDATE chats SET title = ?1, updated_at = ?2, prompt_tokens = ?3, completion_tokens = ?4 WHERE id = ?5",
        params![title, message.created_at, prompt_tokens, completion_tokens, message.chat_id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(title)
}

fn title_from_message(content: String) -> String {
    let clean = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = clean.chars().take(42).collect::<String>();
    if clean.chars().count() > 42 {
        title.push('…');
    }
    if title.is_empty() {
        "New chat".into()
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_persists_messages_and_cascades_chat_deletes() {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection.execute(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat-1', 'Test', 1, 1)",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('msg-1', 'chat-1', 'user', 'Hello', 2)",
            [],
        ).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        connection
            .execute("DELETE FROM chats WHERE id = 'chat-1'", [])
            .unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn generated_titles_are_short_and_readable() {
        let title = title_from_message(
            "  Create   a polished X post about private local AI assistants that runs entirely offline  ".into(),
        );
        assert!(title.chars().count() <= 43);
        assert!(!title.contains("  "));
        assert!(title.ends_with('…'));
    }
}
