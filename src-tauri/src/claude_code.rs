use crate::{
    models::{ClaudeCodeInfo, Message},
    plugins::PluginSet,
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

/// Read-only web access, for runs that must not touch the Mac.
pub const WEB_TOOLS: &str = "WebSearch,WebFetch";

/// Everything a teammate with workspace access can use. Reading inside the
/// workspace and the web run freely; writes and commands need approval.
const WORKSPACE_TOOLS: &str = "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch";
const WORKSPACE_AUTO_ALLOWED: &str = "Read,Glob,Grep,WebSearch,WebFetch";
/// Without this rule Claude Code runs shell commands it judges read-only
/// without asking. Every command must go through Rohan.
const ASK_FOR_EVERY_COMMAND: &str = r#"{"permissions":{"ask":["Bash"]}}"#;
const NEEDS_APPROVAL: [&str; 3] = ["Bash", "Write", "Edit"];
const DECLINED: &str = "Rohan declined this action. Do not try another way to do it; ask him what he would like instead.";

/// Something a teammate did with a tool, in words for the thread.
pub struct ToolUse {
    pub tool: String,
    pub summary: String,
}

/// Something a teammate wants to do that needs Rohan's approval first.
pub struct ToolRequest {
    pub tool: String,
    pub summary: String,
    pub detail: String,
}

pub type ApproveFn<'a> = dyn Fn(ToolRequest) -> BoxFuture<'static, bool> + Sync + 'a;

/// Gives a run access to the workspace folder it starts in.
pub struct WorkspaceHooks<'a> {
    pub on_tool: &'a (dyn Fn(ToolUse) + Sync),
    pub approve: &'a ApproveFn<'a>,
}

/// A tool the app itself answers. Claude Code reaches it over the same
/// stdin/stdout channel it uses for permission questions.
pub struct HostTool<'a> {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
    pub call: &'a HostToolFn<'a>,
}

pub type HostToolFn<'a> = dyn Fn(Value) -> BoxFuture<'a, Result<String, String>> + Sync + 'a;

/// The name Claude Code knows the app's tool server by.
pub const HOST_SERVER: &str = "team";

pub struct ClaudeRequest<'a, 't> {
    pub binary_path: &'a str,
    pub model: &'a str,
    pub system_prompt: &'a str,
    pub prompt: String,
    /// The folder Claude Code runs in.
    pub cwd: &'a Path,
    /// `WEB_TOOLS`, or an empty string for no tools. Ignored when
    /// `workspace` is set, which brings its own tool set.
    pub tools: &'a str,
    /// How tool work is shown and approved. Present for a teammate's own
    /// reply, absent for runs that have no tools needing approval.
    pub workspace: Option<&'a WorkspaceHooks<'a>>,
    /// Run in the workspace folder with the file and command tools.
    pub in_workspace: bool,
    pub plugins: Option<&'a PluginSet>,
    /// A separate lifetime: tools hold callbacks whose futures borrow from
    /// the caller, which must not be tied to the request's own borrows.
    pub host_tools: &'a [HostTool<'t>],
}

fn text_field<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A path as Rohan would say it: relative to the workspace when inside it.
fn short_path(path: &str, cwd: &Path) -> String {
    Path::new(path)
        .strip_prefix(cwd)
        .map(|relative| relative.display().to_string())
        .unwrap_or_else(|_| path.to_string())
}

fn preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max_chars).collect::<String>())
}

/// Splits a plugin tool name such as `mcp__notes__read_note` into the plugin
/// (`notes`) and the action in words (`read note`).
fn plugin_tool(tool: &str) -> Option<(&str, String)> {
    let (plugin, action) = tool.strip_prefix("mcp__")?.split_once("__")?;
    Some((plugin, action.replace('_', " ")))
}

pub fn describe_use(tool: &str, input: &Value, cwd: &Path) -> String {
    let path = short_path(text_field(input, "file_path"), cwd);
    match tool {
        "Bash" => format!("Ran `{}`", preview(text_field(input, "command"), 120)),
        "Write" => format!("Wrote {path}"),
        "Edit" => format!("Edited {path}"),
        "Read" => format!("Read {path}"),
        "Glob" => format!("Looked for files matching {}", text_field(input, "pattern")),
        "Grep" => format!("Searched files for \"{}\"", preview(text_field(input, "pattern"), 80)),
        "WebSearch" => format!("Searched the web for \"{}\"", preview(text_field(input, "query"), 100)),
        "WebFetch" => format!("Read {}", preview(text_field(input, "url"), 100)),
        other => match plugin_tool(other) {
            Some((plugin, action)) => format!("Used {plugin}: {action}"),
            None => format!("Used {other}"),
        },
    }
}

pub fn describe_request(tool: &str, input: &Value, cwd: &Path) -> ToolRequest {
    let path = short_path(text_field(input, "file_path"), cwd);
    let (summary, detail) = match tool {
        "Bash" => (
            "Run a command".to_string(),
            text_field(input, "command").to_string(),
        ),
        "Write" => (
            format!("Write the file {path}"),
            preview(text_field(input, "content"), 600),
        ),
        "Edit" => (
            format!("Edit the file {path}"),
            format!(
                "Replace:\n{}\n\nWith:\n{}",
                preview(text_field(input, "old_string"), 280),
                preview(text_field(input, "new_string"), 280)
            ),
        ),
        other => {
            let summary = match plugin_tool(other) {
                Some((plugin, action)) => format!("Use the plugin {plugin}: {action}"),
                None => format!("Use {other}"),
            };
            let detail = serde_json::to_string_pretty(input).unwrap_or_default();
            (summary, preview(&detail, 600))
        }
    };
    ToolRequest {
        tool: tool.to_string(),
        summary,
        detail,
    }
}

pub const LOGIN_HINT: &str =
    "Claude Code is not logged in. Open Terminal, run `claude auth login`, then retry.";

pub struct ClaudeOutcome {
    pub content: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub tokens_per_second: f64,
}

pub fn resolve_binary(configured: &str) -> Result<PathBuf, String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("Claude Code CLI not found: {configured}"))
        };
    }
    let mut candidates = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Claude Code CLI not found. Install Claude Code or set its path in Settings.".to_string()
        })
}

/// When Aeris itself was launched from inside a Claude Code session (for
/// example `tauri dev` started by an agent), drop that session's variables so
/// the CLI uses Rohan's own login instead of the host session's credentials.
fn base_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    if env::var_os("CLAUDECODE").is_some() {
        for (key, _) in env::vars_os() {
            let name = key.to_string_lossy();
            let host_session_var = (name.starts_with("CLAUDE") && name != "CLAUDE_CONFIG_DIR")
                || name == "ANTHROPIC_AUTH_TOKEN"
                || name == "ANTHROPIC_BASE_URL";
            if host_session_var {
                command.env_remove(&key);
            }
        }
    }
    command.kill_on_drop(true);
    command
}

#[tauri::command]
pub async fn check_claude_code(binary_path: String) -> ClaudeCodeInfo {
    let binary = match resolve_binary(&binary_path) {
        Ok(binary) => binary,
        Err(message) => {
            return ClaudeCodeInfo {
                installed: false,
                logged_in: false,
                path: None,
                message,
            }
        }
    };
    let path = Some(binary.display().to_string());
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        base_command(&binary)
            .args(["auth", "status"])
            .stdin(Stdio::null())
            .output(),
    )
    .await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return ClaudeCodeInfo {
                installed: false,
                logged_in: false,
                path,
                message: format!("Could not run Claude Code: {error}"),
            }
        }
        Err(_) => {
            return ClaudeCodeInfo {
                installed: true,
                logged_in: false,
                path,
                message: "Claude Code did not answer the login check in time.".into(),
            }
        }
    };
    let logged_in = serde_json::from_slice::<Value>(&output.stdout)
        .ok()
        .and_then(|status| status.get("loggedIn")?.as_bool())
        .unwrap_or(output.status.success());
    ClaudeCodeInfo {
        installed: true,
        logged_in,
        path,
        message: if logged_in {
            "Claude Code ready".into()
        } else {
            LOGIN_HINT.into()
        },
    }
}

/// Claude Code's print mode takes one prompt, so earlier turns are replayed
/// as a transcript ahead of the latest user message.
pub fn build_prompt(history: &[Message]) -> String {
    let Some((latest, earlier)) = history.split_last() else {
        return String::new();
    };
    if earlier.is_empty() {
        return latest.content.clone();
    }
    let mut prompt = String::from("Conversation so far, oldest first:\n\n");
    for message in earlier {
        prompt.push_str(&format!(
            "<message role=\"{}\">\n{}\n</message>\n\n",
            message.role, message.content
        ));
    }
    prompt.push_str("Continue this conversation by replying to the latest user message:\n\n");
    prompt.push_str(&latest.content);
    prompt
}

/// Accumulates the reply from Claude Code's `stream-json` output lines.
#[derive(Default)]
pub struct StreamParser {
    pub content: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub error: Option<String>,
    /// Set once Claude Code reports the turn is over.
    pub finished: bool,
    /// Tool calls seen since the last drain, as `(tool, input)`.
    pub tool_uses: Vec<(String, Value)>,
    seen_tool_ids: HashSet<String>,
}

impl StreamParser {
    fn collect_tool_uses(&mut self, payload: &Value) {
        let Some(blocks) = payload.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let id = text_field(block, "id").to_string();
            if self.seen_tool_ids.insert(id) {
                self.tool_uses.push((
                    text_field(block, "name").to_string(),
                    block.get("input").cloned().unwrap_or(Value::Null),
                ));
            }
        }
    }

    fn append(&mut self, text: &str) -> Option<String> {
        if text.is_empty() {
            return None;
        }
        self.content.push_str(text);
        Some(text.to_string())
    }

    fn paragraph_break(&mut self) -> Option<String> {
        if self.content.is_empty() || self.content.ends_with('\n') {
            None
        } else {
            self.append("\n\n")
        }
    }

    /// Feeds one output line and returns any new text to show immediately.
    pub fn feed(&mut self, line: &str) -> Option<String> {
        let payload = serde_json::from_str::<Value>(line.trim()).ok()?;
        match payload.get("type").and_then(Value::as_str)? {
            "stream_event" => {
                let event = payload.get("event")?;
                match event.get("type").and_then(Value::as_str)? {
                    "content_block_start"
                        if event.pointer("/content_block/type").and_then(Value::as_str)
                            == Some("text") =>
                    {
                        self.paragraph_break()
                    }
                    "content_block_delta"
                        if event.pointer("/delta/type").and_then(Value::as_str)
                            == Some("text_delta") =>
                    {
                        let text = event.pointer("/delta/text").and_then(Value::as_str)?;
                        self.append(text)
                    }
                    _ => None,
                }
            }
            // Complete messages repeat text already streamed as deltas; only
            // use them when partial streaming produced nothing for that text.
            "assistant" => {
                if payload.get("error").is_some_and(|error| !error.is_null()) {
                    return None;
                }
                self.collect_tool_uses(&payload);
                let text = payload
                    .pointer("/message/content")
                    .and_then(Value::as_array)?
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                if text.trim().is_empty() || self.content.trim_end().ends_with(text.trim_end()) {
                    return None;
                }
                let separator = self.paragraph_break().unwrap_or_default();
                self.append(&text).map(|added| separator + &added)
            }
            "result" => {
                self.finished = true;
                if let Some(usage) = payload.get("usage") {
                    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                    self.prompt_tokens = (count("input_tokens")
                        + count("cache_creation_input_tokens")
                        + count("cache_read_input_tokens"))
                        as u32;
                    self.completion_tokens = count("output_tokens") as u32;
                }
                let result = payload
                    .get("result")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if payload.get("is_error").and_then(Value::as_bool) == Some(true) {
                    self.error = Some(if result.contains("Not logged in") {
                        LOGIN_HINT.to_string()
                    } else if result.is_empty() {
                        "Claude Code reported an error.".to_string()
                    } else {
                        format!("Claude Code error: {result}")
                    });
                    return None;
                }
                if self.content.is_empty() {
                    return self.append(result);
                }
                None
            }
            _ => None,
        }
    }
}

/// A question Claude Code asks the app: `(request id, request body)`.
fn parse_control_request(line: &str) -> Option<(String, Value)> {
    let mut payload = serde_json::from_str::<Value>(line.trim()).ok()?;
    if payload.get("type").and_then(Value::as_str) != Some("control_request") {
        return None;
    }
    let request_id = text_field(&payload, "request_id").to_string();
    Some((request_id, payload.get_mut("request")?.take()))
}

fn control_response(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response }
    })
    .to_string()
}

fn permission_decision(input: Value, allowed: bool) -> Value {
    if allowed {
        json!({ "behavior": "allow", "updatedInput": input })
    } else {
        json!({ "behavior": "deny", "message": DECLINED })
    }
}

/// Answers one message of the tool protocol (MCP) for the app's own tools.
async fn answer_tool_message(message: &Value, tools: &[HostTool<'_>]) -> Value {
    let result = match text_field(message, "method") {
        "initialize" => json!({
            "protocolVersion": message.pointer("/params/protocolVersion").cloned().unwrap_or_else(|| json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": HOST_SERVER, "version": "1.0.0" }
        }),
        "tools/list" => json!({
            "tools": tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema
            })).collect::<Vec<_>>()
        }),
        "tools/call" => {
            let name = message.pointer("/params/name").and_then(Value::as_str).unwrap_or_default();
            let arguments = message.pointer("/params/arguments").cloned().unwrap_or(Value::Null);
            let outcome = match tools.iter().find(|tool| tool.name == name) {
                Some(tool) => (tool.call)(arguments).await,
                None => Err(format!("There is no tool named {name}.")),
            };
            match outcome {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
            }
        }
        _ => json!({}),
    };
    json!({ "jsonrpc": "2.0", "id": message.get("id").cloned().unwrap_or(Value::Null), "result": result })
}

/// Starts Claude Code with a single tool server and reports whether it
/// connected and which tools it offers: `(status, tool names)`. The process
/// is stopped as soon as it reports its start-up state, before any reply.
pub async fn probe_server(
    binary_path: &str,
    cwd: &Path,
    name: &str,
    definition: Value,
) -> Result<(String, Vec<String>), String> {
    let binary = resolve_binary(binary_path)?;
    std::fs::create_dir_all(cwd).map_err(|error| error.to_string())?;
    let mut servers = serde_json::Map::new();
    servers.insert(name.to_string(), definition);
    let mut child = base_command(&binary)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--setting-sources",
            "",
            "--tools",
            "",
            "--mcp-config",
            &json!({ "mcpServers": servers }).to_string(),
        ])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Claude Code: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Claude Code stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Claude Code stdout unavailable")?;
    // Claude Code reports its start-up state once the first message arrives.
    let first_message = json!({ "type": "user", "message": { "role": "user", "content": "ok" } });
    let _ = stdin.write_all(format!("{first_message}\n").as_bytes()).await;
    let mut lines = BufReader::new(stdout).lines();
    let prefix = format!("mcp__{name}__");
    let found = tokio::time::timeout(Duration::from_secs(45), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if payload.get("subtype").and_then(Value::as_str) != Some("init") {
                continue;
            }
            let status = payload
                .get("mcp_servers")
                .and_then(Value::as_array)
                .and_then(|listed| listed.iter().find(|server| text_field(server, "name") == name))
                .map(|server| text_field(server, "status").to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let tools = payload
                .get("tools")
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(Value::as_str)
                        .filter_map(|tool| tool.strip_prefix(&prefix))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            return Some((status, tools));
        }
        None
    })
    .await;
    let _ = child.kill().await;
    match found {
        Ok(Some(result)) => Ok(result),
        Ok(None) => Err("Claude Code stopped before reporting on the plugin.".into()),
        Err(_) => Err("The plugin did not answer within 45 seconds.".into()),
    }
}

async fn until_cancelled(is_cancelled: &(dyn Fn() -> bool + Sync)) {
    while !is_cancelled() {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

pub async fn run(
    request: ClaudeRequest<'_, '_>,
    on_chunk: &(dyn Fn(String) + Sync),
    is_cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<ClaudeOutcome, String> {
    let binary = resolve_binary(request.binary_path)?;
    std::fs::create_dir_all(request.cwd).map_err(|error| error.to_string())?;

    let mut command = base_command(&binary);
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--setting-sources",
            "",
            "--system-prompt",
            request.system_prompt,
        ])
        .current_dir(request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut allowed: Vec<String> = Vec::new();
    if request.in_workspace {
        // Restricted mode keeps the file tools inside the workspace folder.
        command.args([
            "--restricted",
            "--settings",
            ASK_FOR_EVERY_COMMAND,
            "--tools",
            WORKSPACE_TOOLS,
        ]);
        allowed.push(WORKSPACE_AUTO_ALLOWED.to_string());
    } else {
        command.args(["--tools", request.tools]);
        if !request.tools.is_empty() {
            allowed.push(request.tools.to_string());
        }
    }
    if request.workspace.is_some() {
        // Permission questions come to this app over stdin/stdout.
        command.args(["--permission-prompt-tool", "stdio"]);
    }
    // Only the servers named here are used; Claude Code's own configuration
    // is ignored (`--strict-mcp-config` is always passed above).
    let mut servers = request
        .plugins
        .map(|plugins| plugins.servers.clone())
        .unwrap_or_default();
    if let Some(plugins) = request.plugins {
        allowed.extend(plugins.allow.iter().cloned());
    }
    if !request.host_tools.is_empty() {
        servers.insert(HOST_SERVER.to_string(), json!({ "type": "sdk", "name": HOST_SERVER }));
        allowed.extend(
            request
                .host_tools
                .iter()
                .map(|tool| format!("mcp__{HOST_SERVER}__{}", tool.name)),
        );
    }
    if !servers.is_empty() {
        command.args(["--mcp-config", &json!({ "mcpServers": servers }).to_string()]);
    }
    if !allowed.is_empty() {
        command.args(["--allowedTools", &allowed.join(",")]);
    }
    let model = request.model.trim();
    if !model.is_empty() {
        command.args(["--model", model]);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Claude Code: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Claude Code stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Claude Code stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("Claude Code stderr unavailable")?;
    let stderr_reader = tauri::async_runtime::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    // Stdin stays open after the prompt so approvals can be answered on it.
    let first_message = json!({
        "type": "user",
        "message": { "role": "user", "content": request.prompt }
    });
    stdin
        .write_all(format!("{first_message}\n").as_bytes())
        .await
        .map_err(|error| format!("Could not send the message to Claude Code: {error}"))?;

    let started = Instant::now();
    let mut parser = StreamParser::default();
    let mut lines = BufReader::new(stdout).lines();
    let mut cancelled = false;
    while !parser.finished {
        let line = tokio::select! {
            line = lines.next_line() => line,
            _ = until_cancelled(is_cancelled) => {
                cancelled = true;
                break;
            }
        };
        let line = match line {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => return Err(format!("Could not read Claude Code output: {error}")),
        };
        if let Some((request_id, control)) = parse_control_request(&line) {
            // Both kinds of question wait on something outside this loop (an
            // answer from Rohan, or another teammate), so stay stoppable.
            let answer = async {
                match (text_field(&control, "subtype"), request.workspace) {
                    ("can_use_tool", Some(hooks)) => {
                        let tool = text_field(&control, "tool_name").to_string();
                        let input = control.get("input").cloned().unwrap_or(Value::Null);
                        let allowed =
                            (hooks.approve)(describe_request(&tool, &input, request.cwd)).await;
                        // Reported only now, so the thread never says "Ran"
                        // for something that was not allowed to run.
                        let summary = describe_use(&tool, &input, request.cwd);
                        (hooks.on_tool)(ToolUse {
                            summary: if allowed { summary } else { format!("Not allowed: {summary}") },
                            tool,
                        });
                        permission_decision(input, allowed)
                    }
                    ("can_use_tool", None) => permission_decision(Value::Null, false),
                    ("mcp_message", _) => {
                        let message = control.get("message").cloned().unwrap_or(Value::Null);
                        json!({ "mcp_response": answer_tool_message(&message, request.host_tools).await })
                    }
                    _ => json!({}),
                }
            };
            let response = tokio::select! {
                response = answer => response,
                _ = until_cancelled(is_cancelled) => {
                    cancelled = true;
                    break;
                }
            };
            stdin
                .write_all(format!("{}\n", control_response(&request_id, response)).as_bytes())
                .await
                .map_err(|error| format!("Could not answer Claude Code: {error}"))?;
            continue;
        }
        if let Some(chunk) = parser.feed(&line) {
            on_chunk(chunk);
        }
        for (tool, input) in parser.tool_uses.drain(..) {
            // Writes and commands are reported when Rohan answers, above.
            // The app's own tools report their progress themselves, and
            // plugin tools that ask first are reported with the answer.
            if NEEDS_APPROVAL.contains(&tool.as_str())
                || tool.starts_with(&format!("mcp__{HOST_SERVER}__"))
                || request.plugins.is_some_and(|plugins| plugins.needs_approval(&tool))
            {
                continue;
            }
            if let Some(hooks) = request.workspace {
                (hooks.on_tool)(ToolUse {
                    summary: describe_use(&tool, &input, request.cwd),
                    tool,
                });
            }
        }
    }
    if cancelled {
        let _ = child.kill().await;
    }
    // Closing stdin tells Claude Code there is nothing more to do.
    drop(stdin);
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let stderr_text = stderr_reader.await.unwrap_or_default();

    if !cancelled {
        if let Some(error) = parser.error.take() {
            return Err(error);
        }
        if !status.success() && parser.content.is_empty() {
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("Claude Code exited with {status}.")
            } else {
                format!("Claude Code failed: {detail}")
            });
        }
    }

    let mut completion_tokens = parser.completion_tokens;
    if completion_tokens == 0 {
        completion_tokens = parser.content.split_whitespace().count() as u32;
    }
    Ok(ClaudeOutcome {
        tokens_per_second: completion_tokens as f64 / started.elapsed().as_secs_f64().max(0.001),
        content: parser.content,
        prompt_tokens: parser.prompt_tokens,
        completion_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> Message {
        Message {
            id: "id".into(),
            chat_id: "chat".into(),
            role: role.into(),
            content: content.into(),
            created_at: 0,
            bot_id: String::new(),
        }
    }

    #[test]
    fn single_message_prompt_is_sent_as_is() {
        assert_eq!(build_prompt(&[message("user", "Hello")]), "Hello");
    }

    #[test]
    fn earlier_turns_are_replayed_before_the_latest_message() {
        let prompt = build_prompt(&[
            message("user", "My name is Rohan"),
            message("assistant", "Hi Rohan"),
            message("user", "What is my name?"),
        ]);
        assert!(prompt.contains("<message role=\"user\">\nMy name is Rohan\n</message>"));
        assert!(prompt.contains("<message role=\"assistant\">\nHi Rohan\n</message>"));
        assert!(prompt.ends_with("What is my name?"));
    }

    #[test]
    fn streams_text_deltas_without_duplicating_the_full_message() {
        let mut parser = StreamParser::default();
        let delta = |text: &str| {
            format!(
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"{text}"}}}}}}"#
            )
        };
        assert_eq!(parser.feed(&delta("Hello ")).as_deref(), Some("Hello "));
        assert_eq!(parser.feed(&delta("Rohan")).as_deref(), Some("Rohan"));
        let full = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello Rohan"}]}}"#;
        assert_eq!(parser.feed(full), None);
        let result = r#"{"type":"result","is_error":false,"result":"Hello Rohan","usage":{"input_tokens":3,"cache_read_input_tokens":10,"output_tokens":4}}"#;
        assert_eq!(parser.feed(result), None);
        assert_eq!(parser.content, "Hello Rohan");
        assert_eq!(parser.prompt_tokens, 13);
        assert_eq!(parser.completion_tokens, 4);
        assert!(parser.error.is_none());
    }

    #[test]
    fn separates_text_blocks_from_different_turns() {
        let mut parser = StreamParser::default();
        parser.feed(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Searching."}}}"#);
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}"#;
        assert_eq!(parser.feed(start).as_deref(), Some("\n\n"));
        parser.feed(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}"#);
        assert_eq!(parser.content, "Searching.\n\nDone.");
    }

    #[test]
    fn falls_back_to_complete_messages_when_no_deltas_arrive() {
        let mut parser = StreamParser::default();
        let full = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Full reply"}]}}"#;
        assert_eq!(parser.feed(full).as_deref(), Some("Full reply"));
    }

    #[test]
    fn login_failures_become_a_clear_error() {
        let mut parser = StreamParser::default();
        let failed = r#"{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]}}"#;
        assert_eq!(parser.feed(failed), None);
        let result = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(parser.feed(result), None);
        assert!(parser.content.is_empty());
        assert_eq!(parser.error.as_deref(), Some(LOGIN_HINT));
    }

    #[test]
    fn reads_permission_requests_and_answers_them() {
        let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls -la"}}}"#;
        let (id, control) = parse_control_request(line).unwrap();
        assert_eq!((id.as_str(), text_field(&control, "tool_name")), ("req-1", "Bash"));
        let input = control.get("input").cloned().unwrap();
        let allowed = control_response(&id, permission_decision(input.clone(), true));
        assert!(allowed.contains(r#""behavior":"allow""#) && allowed.contains(r#""request_id":"req-1""#));
        assert!(control_response(&id, permission_decision(input, false)).contains(r#""behavior":"deny""#));
        assert!(parse_control_request(r#"{"type":"assistant"}"#).is_none());
    }

    #[test]
    fn serves_the_apps_own_tools_over_the_tool_protocol() {
        fn echo<'a>(arguments: Value) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async move { Ok(format!("asked {}", text_field(&arguments, "teammate"))) })
        }
        let tools = [HostTool { name: "ask_teammate", description: "Ask".into(), input_schema: json!({}), call: &echo }];
        let answer = |message: Value| tauri::async_runtime::block_on(answer_tool_message(&message, &tools));
        let listed = answer(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
        assert_eq!(listed.pointer("/result/tools/0/name").and_then(Value::as_str), Some("ask_teammate"));
        let called = answer(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "ask_teammate", "arguments": { "teammate": "Guru" } } }));
        assert_eq!(called.pointer("/result/content/0/text").and_then(Value::as_str), Some("asked Guru"));
        let missing = answer(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "nope" } }));
        assert_eq!(missing.pointer("/result/isError"), Some(&json!(true)));
    }

    #[test]
    fn describes_tool_work_relative_to_the_workspace() {
        let cwd = Path::new("/Users/rohan/Aeris Bot Workspace");
        let write = json!({ "file_path": "/Users/rohan/Aeris Bot Workspace/notes/plan.md", "content": "hello" });
        assert_eq!(describe_use("Write", &write, cwd), "Wrote notes/plan.md");
        let request = describe_request("Write", &write, cwd);
        assert_eq!(request.summary, "Write the file notes/plan.md");
        assert_eq!(request.detail, "hello");
        let command = describe_request("Bash", &json!({ "command": "ls -la" }), cwd);
        assert_eq!((command.summary.as_str(), command.detail.as_str()), ("Run a command", "ls -la"));
    }

    #[test]
    fn describes_plugin_tools_by_plugin_and_action() {
        let cwd = Path::new("/tmp");
        let input = json!({ "title": "Plan" });
        assert_eq!(describe_use("mcp__notes__create_note", &input, cwd), "Used notes: create note");
        let request = describe_request("mcp__notes__create_note", &input, cwd);
        assert_eq!(request.summary, "Use the plugin notes: create note");
        assert!(request.detail.contains("\"title\": \"Plan\""));
    }

    #[test]
    fn collects_each_tool_call_once_and_marks_the_end() {
        let mut parser = StreamParser::default();
        let call = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#;
        parser.feed(call);
        parser.feed(call);
        assert_eq!(parser.tool_uses.len(), 1);
        assert!(!parser.finished);
        parser.feed(r#"{"type":"result","is_error":false,"result":"done"}"#);
        assert!(parser.finished);
    }

    #[test]
    fn ignores_lines_that_are_not_json() {
        let mut parser = StreamParser::default();
        assert_eq!(parser.feed("not json"), None);
        assert_eq!(parser.feed(""), None);
    }
}
