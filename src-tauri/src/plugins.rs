//! Plugins: outside tool servers (MCP) that teammates can use, such as a
//! notes app or a search service. Each is added here and passed to Claude
//! Code for a teammate's own replies; nothing is read from Claude Code's own
//! configuration.

use crate::{
    claude_code,
    database::{now_ms, DatabaseState},
    settings,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub id: String,
    /// Short name, used in tool names: lowercase letters, digits, - and _.
    pub name: String,
    /// `command` (a program run on this Mac) or `url` (a server over HTTP).
    pub kind: String,
    /// The command line, or the URL.
    pub target: String,
    /// `KEY=value` lines: environment variables for a command, headers for a URL.
    pub secrets: String,
    /// `off`, `ask` (approve each use), or `allow`.
    pub access: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub secrets: String,
    #[serde(default)]
    pub access: String,
}

/// The plugins switched on for a run, in the form Claude Code needs.
#[derive(Default)]
pub struct PluginSet {
    /// Server definitions keyed by plugin name.
    pub servers: Map<String, Value>,
    /// Tool-name prefixes that run without asking.
    pub allow: Vec<String>,
    /// Tool-name prefixes that need Rohan's approval each time.
    pub ask: Vec<String>,
    pub names: Vec<String>,
}

impl PluginSet {
    pub fn needs_approval(&self, tool: &str) -> bool {
        self.ask.iter().any(|prefix| tool.starts_with(prefix.as_str()))
    }
}

fn valid_name(name: &str) -> bool {
    (2..=30).contains(&name.len())
        && name != claude_code::HOST_SERVER
        && name
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-' || character == '_')
}

/// Splits a command line into arguments, honouring single and double quotes.
pub fn split_command(line: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for character in line.chars() {
        match quote {
            Some(open) if character == open => quote = None,
            Some(_) => current.push(character),
            None if character == '"' || character == '\'' => {
                quote = Some(character);
                started = true;
            }
            None if character.is_whitespace() => {
                if started || !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => current.push(character),
        }
    }
    if started || !current.is_empty() {
        arguments.push(current);
    }
    arguments
}

fn key_values(text: &str) -> Map<String, Value> {
    text.lines()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(key, _)| !key.trim().is_empty())
        .map(|(key, value)| (key.trim().to_string(), json!(value.trim())))
        .collect()
}

/// The server definition Claude Code expects for one plugin.
fn server_definition(plugin: &Plugin) -> Option<Value> {
    if plugin.kind == "url" {
        return Some(json!({ "type": "http", "url": plugin.target.trim(), "headers": key_values(&plugin.secrets) }));
    }
    let mut arguments = split_command(&plugin.target);
    if arguments.is_empty() {
        return None;
    }
    let command = arguments.remove(0);
    Some(json!({ "type": "stdio", "command": command, "args": arguments, "env": key_values(&plugin.secrets) }))
}

pub fn plugin_set(plugins: &[Plugin]) -> PluginSet {
    let mut set = PluginSet::default();
    for plugin in plugins.iter().filter(|plugin| plugin.access != "off") {
        let Some(definition) = server_definition(plugin) else {
            continue;
        };
        let prefix = format!("mcp__{}__", plugin.name);
        if plugin.access == "allow" {
            set.allow.push(prefix.trim_end_matches('_').to_string());
        } else {
            set.ask.push(prefix);
        }
        set.servers.insert(plugin.name.clone(), definition);
        set.names.push(plugin.name.clone());
    }
    set
}

pub fn all(state: &State<'_, DatabaseState>) -> Result<Vec<Plugin>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare("SELECT id, name, kind, target, secrets, access, created_at FROM plugins ORDER BY name")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Plugin {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                target: row.get(3)?,
                secrets: row.get(4)?,
                access: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_plugins(state: State<'_, DatabaseState>) -> Result<Vec<Plugin>, String> {
    all(&state)
}

#[tauri::command]
pub fn save_plugin(input: PluginInput, state: State<'_, DatabaseState>) -> Result<(), String> {
    let name = input.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err("Use a short name of lowercase letters, digits, - or _, such as notes or github.".into());
    }
    let target = input.target.trim().to_string();
    match input.kind.as_str() {
        "url" if target.starts_with("https://") || target.starts_with("http://") => {}
        "url" => return Err("The URL must start with https://.".into()),
        "command" if !split_command(&target).is_empty() => {}
        "command" => return Err("Enter the command that starts the plugin.".into()),
        _ => return Err("Choose whether the plugin is a command or a URL.".into()),
    }
    let access = if ["off", "ask", "allow"].contains(&input.access.as_str()) {
        input.access
    } else {
        "ask".to_string()
    };
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let taken: bool = connection
        .query_row(
            "SELECT COUNT(*) FROM plugins WHERE name = ?1 AND id != ?2",
            params![name, id],
            |row| row.get::<_, i64>(0).map(|count| count > 0),
        )
        .map_err(|error| error.to_string())?;
    if taken {
        return Err(format!("There is already a plugin named {name}."));
    }
    connection
        .execute(
            "INSERT INTO plugins (id, name, kind, target, secrets, access, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name = ?2, kind = ?3, target = ?4, secrets = ?5, access = ?6",
            params![id, name, input.kind, target, input.secrets.trim(), access, now_ms()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_plugin(plugin_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute("DELETE FROM plugins WHERE id = ?1", [plugin_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// What a connection test found.
#[derive(Debug, Serialize)]
pub struct PluginCheck {
    /// `connected`, `failed`, `needs-auth`, `pending`, or `unknown`.
    pub status: String,
    pub tools: Vec<String>,
}

/// Starts Claude Code with only this plugin to see whether it connects and
/// which tools it offers. No message is sent to the model.
#[tauri::command]
pub async fn test_plugin(plugin_id: String, app: AppHandle) -> Result<PluginCheck, String> {
    let database = app.state::<DatabaseState>();
    let plugin = all(&database)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or("That plugin no longer exists.")?;
    let definition = server_definition(&plugin).ok_or("The plugin has no command to run.")?;
    let saved = settings::load(&database);
    let neutral_dir = app
        .path()
        .app_data_dir()
        .map(|path| path.join("claude-workspace"))
        .map_err(|error| error.to_string())?;
    let (status, tools) =
        claude_code::probe_server(&saved.claude_binary_path, &neutral_dir, &plugin.name, definition).await?;
    Ok(PluginCheck { status, tools })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(name: &str, kind: &str, target: &str, access: &str) -> Plugin {
        Plugin {
            id: name.into(),
            name: name.into(),
            kind: kind.into(),
            target: target.into(),
            secrets: "API_KEY = abc123\nnot a pair\n".into(),
            access: access.into(),
            created_at: 0,
        }
    }

    #[test]
    fn splits_commands_with_quotes() {
        assert_eq!(split_command("npx -y @x/server '/Users/rohan/My Notes' --flag"), ["npx", "-y", "@x/server", "/Users/rohan/My Notes", "--flag"]);
        assert_eq!(split_command("  run   \"a b\"  \"\" "), ["run", "a b", ""]);
        assert!(split_command("   ").is_empty());
    }

    #[test]
    fn builds_server_definitions_and_access_rules() {
        let plugins = [
            plugin("notes", "command", "npx notes-server ~/Notes", "allow"),
            plugin("tracker", "url", "https://example.test/mcp", "ask"),
            plugin("unused", "command", "npx other", "off"),
        ];
        let set = plugin_set(&plugins);
        assert_eq!(set.names, ["notes", "tracker"]);
        assert_eq!(set.servers["notes"], json!({ "type": "stdio", "command": "npx", "args": ["notes-server", "~/Notes"], "env": { "API_KEY": "abc123" } }));
        assert_eq!(set.servers["tracker"], json!({ "type": "http", "url": "https://example.test/mcp", "headers": { "API_KEY": "abc123" } }));
        assert_eq!(set.allow, ["mcp__notes"]);
        assert!(set.needs_approval("mcp__tracker__create_issue"));
        assert!(!set.needs_approval("mcp__notes__read"));
    }

    #[test]
    fn plugin_names_are_kept_safe_for_tool_names() {
        assert!(valid_name("github") && valid_name("my_notes-2"));
        assert!(!valid_name("My Notes") && !valid_name("a") && !valid_name("team"));
    }
}
