use crate::models::{AgentStep, Bot, BotInput, ChatSummary, Message};
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

/// The built-in Bot. Its instructions come from the persona in Settings.
pub const AERIS_BOT_ID: &str = "aeris";

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
            ON messages(chat_id, created_at);
         CREATE TABLE IF NOT EXISTS agent_steps (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            agent TEXT NOT NULL,
            content TEXT NOT NULL,
            PRIMARY KEY (message_id, position)
         );
         CREATE TABLE IF NOT EXISTS bots (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            instructions TEXT NOT NULL DEFAULT '',
            memory TEXT NOT NULL DEFAULT '',
            memory_enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO bots (id, name, title, description, created_at)
            VALUES ('aeris', 'Aeris', 'Personal assistant', 'Helps with anything: thinking, planning, writing, and learning.', 0);",
    )?;
    // Chats created before Bots existed belong to Aeris.
    let has_bot_column: bool = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chats') WHERE name = 'bot_id'",
        [],
        |row| row.get::<_, i64>(0).map(|count| count > 0),
    )?;
    if !has_bot_column {
        connection.execute_batch("ALTER TABLE chats ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'aeris';")?;
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            instructions TEXT NOT NULL,
            created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS routines (
            id TEXT PRIMARY KEY,
            bot_id TEXT NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            schedule TEXT NOT NULL,
            time TEXT NOT NULL,
            weekday INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            allow_writes INTEGER NOT NULL DEFAULT 0,
            chat_id TEXT,
            last_run INTEGER,
            last_status TEXT NOT NULL DEFAULT '',
            next_run INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            target TEXT NOT NULL,
            secrets TEXT NOT NULL DEFAULT '',
            access TEXT NOT NULL DEFAULT 'ask',
            created_at INTEGER NOT NULL
         );",
    )?;
    for (table, column, definition) in [
        ("chats", "members", "TEXT NOT NULL DEFAULT ''"),
        ("messages", "bot_id", "TEXT NOT NULL DEFAULT ''"),
    ] {
        let exists: bool = connection.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
            [],
            |row| row.get::<_, i64>(0).map(|count| count > 0),
        )?;
        if !exists {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition};"))?;
        }
    }
    let has_workspace_column: bool = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('bots') WHERE name = 'workspace_enabled'",
        [],
        |row| row.get::<_, i64>(0).map(|count| count > 0),
    )?;
    if !has_workspace_column {
        connection.execute_batch(
            "ALTER TABLE bots ADD COLUMN workspace_enabled INTEGER NOT NULL DEFAULT 1;",
        )?;
    }
    // Aeris leads the team now; rename the role it was first created with.
    connection.execute(
        "UPDATE bots SET title = 'Chief of staff', description = 'Keeps the big picture and helps with anything.'
         WHERE id = 'aeris' AND title = 'Personal assistant'",
        [],
    )?;
    Ok(())
}

const BOT_COLUMNS: &str =
    "id, name, title, description, instructions, memory, memory_enabled, created_at, workspace_enabled";

fn row_to_bot(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: row.get(0)?,
        name: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        instructions: row.get(4)?,
        memory: row.get(5)?,
        memory_enabled: row.get(6)?,
        created_at: row.get(7)?,
        workspace_enabled: row.get(8)?,
    })
}

fn limited(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

#[tauri::command]
pub fn list_bots(state: State<'_, DatabaseState>) -> Result<Vec<Bot>, String> {
    all_bots(&state)
}

pub fn all_bots(state: &State<'_, DatabaseState>) -> Result<Vec<Bot>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare(&format!("SELECT {BOT_COLUMNS} FROM bots ORDER BY created_at"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_bot)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn load_bot(state: &State<'_, DatabaseState>, bot_id: &str) -> Result<Bot, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .query_row(
            &format!("SELECT {BOT_COLUMNS} FROM bots WHERE id = ?1"),
            [bot_id],
            row_to_bot,
        )
        .map_err(|error| format!("Bot not found: {error}"))
}

/// The Bot a chat belongs to, falling back to Aeris if that Bot is gone.
pub fn load_chat_bot(state: &State<'_, DatabaseState>, chat_id: &str) -> Result<Bot, String> {
    let bot_id: String = {
        let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
        connection
            .query_row("SELECT bot_id FROM chats WHERE id = ?1", [chat_id], |row| {
                row.get(0)
            })
            .map_err(|error| format!("Chat not found: {error}"))?
    };
    load_bot(state, &bot_id).or_else(|_| load_bot(state, AERIS_BOT_ID))
}

pub fn save_bot_memory(
    state: &State<'_, DatabaseState>,
    bot_id: &str,
    memory: &str,
) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "UPDATE bots SET memory = ?1 WHERE id = ?2",
            params![memory, bot_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_bot(input: BotInput, state: State<'_, DatabaseState>) -> Result<Bot, String> {
    let name = limited(&input.name, 40);
    if name.is_empty() {
        return Err("Give the Bot a name.".into());
    }
    let bot = Bot {
        id: Uuid::new_v4().to_string(),
        name,
        title: limited(&input.title, 60),
        description: limited(&input.description, 600),
        instructions: limited(&input.instructions, 8_000),
        memory: limited(&input.memory, 6_000),
        memory_enabled: input.memory_enabled,
        workspace_enabled: input.workspace_enabled,
        created_at: now_ms(),
    };
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            &format!("INSERT INTO bots ({BOT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"),
            params![
                bot.id,
                bot.name,
                bot.title,
                bot.description,
                bot.instructions,
                bot.memory,
                bot.memory_enabled,
                bot.created_at,
                bot.workspace_enabled
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(bot)
}

#[tauri::command]
pub fn update_bot(
    bot_id: String,
    input: BotInput,
    state: State<'_, DatabaseState>,
) -> Result<Bot, String> {
    {
        let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
        // Aeris keeps its name and takes its instructions from the persona
        // setting, so only its memory can be edited here.
        if bot_id == AERIS_BOT_ID {
            connection
                .execute(
                    "UPDATE bots SET memory = ?1, memory_enabled = ?2, workspace_enabled = ?3 WHERE id = ?4",
                    params![
                        limited(&input.memory, 6_000),
                        input.memory_enabled,
                        input.workspace_enabled,
                        bot_id
                    ],
                )
                .map_err(|error| error.to_string())?;
        } else {
            let name = limited(&input.name, 40);
            if name.is_empty() {
                return Err("Give the Bot a name.".into());
            }
            connection
                .execute(
                    "UPDATE bots SET name = ?1, title = ?2, description = ?3, instructions = ?4, memory = ?5, memory_enabled = ?6, workspace_enabled = ?7 WHERE id = ?8",
                    params![
                        name,
                        limited(&input.title, 60),
                        limited(&input.description, 600),
                        limited(&input.instructions, 8_000),
                        limited(&input.memory, 6_000),
                        input.memory_enabled,
                        input.workspace_enabled,
                        bot_id
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    load_bot(&state, &bot_id)
}

#[tauri::command]
pub fn delete_bot(bot_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    if bot_id == AERIS_BOT_ID {
        return Err("Aeris can't be deleted.".into());
    }
    let mut connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM chats WHERE bot_id = ?1", [&bot_id])
        .map_err(|error| error.to_string())?;
    // Take the teammate out of its groups; a group left with one member goes.
    let groups: Vec<(String, String)> = {
        let mut statement = transaction
            .prepare("SELECT id, members FROM chats WHERE members != ''")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
    };
    for (chat_id, stored) in groups {
        let members = split_members(&stored);
        if !members.contains(&bot_id) {
            continue;
        }
        let remaining: Vec<String> = members.into_iter().filter(|id| id != &bot_id).collect();
        if remaining.len() < 2 {
            transaction
                .execute("DELETE FROM chats WHERE id = ?1", [&chat_id])
                .map_err(|error| error.to_string())?;
        } else {
            transaction
                .execute(
                    "UPDATE chats SET members = ?1 WHERE id = ?2",
                    params![remaining.join(","), chat_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction
        .execute("DELETE FROM routines WHERE bot_id = ?1", [&bot_id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM bots WHERE id = ?1", [&bot_id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn row_to_chat(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatSummary> {
    Ok(ChatSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        prompt_tokens: row.get(4)?,
        completion_tokens: row.get(5)?,
        bot_id: row.get(6)?,
        members: split_members(&row.get::<_, String>(7)?),
    })
}

/// The id stored as a group thread's `bot_id`.
pub const GROUP_BOT_ID: &str = "group";

fn split_members(stored: &str) -> Vec<String> {
    stored
        .split(',')
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// A group thread's teammates, lead first. Empty for a direct thread.
pub fn chat_members(state: &State<'_, DatabaseState>, chat_id: &str) -> Result<Vec<String>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .query_row("SELECT members FROM chats WHERE id = ?1", [chat_id], |row| {
            row.get::<_, String>(0)
        })
        .map(|stored| split_members(&stored))
        .map_err(|error| format!("Chat not found: {error}"))
}

#[tauri::command]
pub fn create_group(
    title: String,
    members: Vec<String>,
    state: State<'_, DatabaseState>,
) -> Result<ChatSummary, String> {
    let title = limited(&title, 60);
    if title.is_empty() {
        return Err("Give the group a name.".into());
    }
    let mut unique: Vec<String> = Vec::new();
    for member in members {
        if !member.contains(',') && !unique.contains(&member) {
            unique.push(member);
        }
    }
    if !(2..=6).contains(&unique.len()) {
        return Err("A group needs two to six teammates.".into());
    }
    let chat = ChatSummary {
        id: Uuid::new_v4().to_string(),
        title,
        created_at: now_ms(),
        updated_at: now_ms(),
        prompt_tokens: 0,
        completion_tokens: 0,
        bot_id: GROUP_BOT_ID.into(),
        members: unique,
    };
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "INSERT INTO chats (id, title, created_at, updated_at, bot_id, members) VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            params![chat.id, chat.title, chat.created_at, chat.bot_id, chat.members.join(",")],
        )
        .map_err(|error| error.to_string())?;
    Ok(chat)
}

#[tauri::command]
pub fn list_chats(state: State<'_, DatabaseState>) -> Result<Vec<ChatSummary>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare("SELECT id, title, created_at, updated_at, prompt_tokens, completion_tokens, bot_id, members FROM chats ORDER BY updated_at DESC")
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
    bot_id: Option<String>,
    state: State<'_, DatabaseState>,
) -> Result<ChatSummary, String> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now_ms();
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "New chat".into());
    let bot_id = bot_id.unwrap_or_else(|| AERIS_BOT_ID.into());
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "INSERT INTO chats (id, title, created_at, updated_at, bot_id) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![id, title, timestamp, bot_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(ChatSummary {
        id,
        title,
        created_at: timestamp,
        updated_at: timestamp,
        prompt_tokens: 0,
        completion_tokens: 0,
        bot_id,
        members: Vec::new(),
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
        .prepare("SELECT id, chat_id, role, content, created_at, bot_id FROM messages WHERE chat_id = ?1 ORDER BY created_at, rowid")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([chat_id], |row| {
            Ok(Message {
                id: row.get(0)?,
                chat_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
                bot_id: row.get(5)?,
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

/// Stores the working notes each agent produced for an assistant message.
pub fn save_agent_steps(
    state: &State<'_, DatabaseState>,
    message_id: &str,
    steps: &[(String, String)],
) -> Result<(), String> {
    let mut connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (position, (agent, content)) in steps.iter().enumerate() {
        transaction
            .execute(
                "INSERT OR REPLACE INTO agent_steps (message_id, position, agent, content) VALUES (?1, ?2, ?3, ?4)",
                params![message_id, position as u32, agent, content],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_agent_steps(
    chat_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<AgentStep>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare(
            "SELECT s.message_id, s.agent, s.content, s.position
             FROM agent_steps s JOIN messages m ON m.id = s.message_id
             WHERE m.chat_id = ?1 ORDER BY m.created_at, s.position",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([chat_id], |row| {
            Ok(AgentStep {
                message_id: row.get(0)?,
                agent: row.get(1)?,
                content: row.get(2)?,
                position: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn insert_message(state: &State<'_, DatabaseState>, message: &Message) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection.execute(
        "INSERT INTO messages (id, chat_id, role, content, created_at, bot_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message.id, message.chat_id, message.role, message.content, message.created_at, message.bot_id],
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
        "INSERT INTO messages (id, chat_id, role, content, created_at, bot_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message.id, message.chat_id, message.role, message.content, message.created_at, message.bot_id],
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
    fn older_databases_gain_bots_and_keep_their_chats_with_aeris() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0);
             INSERT INTO chats (id, title, created_at, updated_at) VALUES ('old', 'Old chat', 1, 1);",
        ).unwrap();
        initialize(&connection).unwrap();
        initialize(&connection).unwrap(); // running twice must be harmless
        let bot_id: String = connection
            .query_row("SELECT bot_id FROM chats WHERE id = 'old'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(bot_id, AERIS_BOT_ID);
        let bots: i64 = connection
            .query_row("SELECT COUNT(*) FROM bots", [], |row| row.get(0))
            .unwrap();
        assert_eq!(bots, 1);
    }

    #[test]
    fn agent_steps_are_removed_with_their_message() {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection.execute_batch(
            "INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat-1', 'Test', 1, 1);
             INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ('msg-1', 'chat-1', 'assistant', 'Hi', 2);
             INSERT INTO agent_steps (message_id, position, agent, content) VALUES ('msg-1', 0, 'researcher', 'notes');
             DELETE FROM messages WHERE id = 'msg-1';",
        ).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM agent_steps", [], |row| row.get(0))
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
