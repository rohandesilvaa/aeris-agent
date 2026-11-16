use crate::{
    agents::{self, Backend, Completion, TeamEvent, Workspace},
    claude_code::{HostTool, ToolRequest, ToolUse, WorkspaceHooks},
    database::{
        all_bots, chat_members, finish_response, insert_message, load_bot, load_chat_bot,
        load_messages, now_ms, save_agent_steps, save_bot_memory, DatabaseState, AERIS_BOT_ID,
    },
    memory,
    models::{Bot, ChatRequest, Message, StreamEvent},
    plugins,
    skills::{self, Skill},
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    future::Future,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

const DEFAULT_AERIS_PERSONA: &str = r#"Your name is Aeris. You are the chief of staff on Rohan's private AI team in the Aeris Bot app.
You help Rohan think, plan, create, learn, and finish practical work, and you keep the bigger picture across everything he is doing.
Be warm, capable, honest, and action-oriented. Prefer clear, concise answers unless Rohan asks for detail.
Match the language and tone Rohan uses. When he writes in Sinhala or romanized Sinhala, reply naturally in the same style and mix in English technical terms where useful.
Ask a question only when a missing answer would materially change the outcome. Otherwise make a sensible assumption and help immediately.
Address him as Rohan only when it feels natural, not in every reply."#;

const RUNTIME_PROMPT: &str = "You run on Claude through the Claude Code CLI on Rohan's Mac. Chats and memory are stored on his Mac, and your replies are generated on Anthropic's servers. You can search and read the web when current information would help, and you cite the pages you relied on as Markdown links. You never claim to have done something the app did not actually do.";

const NO_WORKSPACE_PROMPT: &str = "You cannot read or change files or run commands.";

const RESPONSE_FORMATTING_PROMPT: &str = r#"Format responses in clean Markdown when structure improves readability.
Use short headings for distinct sections, bullet or numbered lists for steps, fenced code blocks with a language tag for code, and GitHub-Flavored Markdown tables for genuine comparisons or tabular data.
Keep simple answers simple. Do not force headings or tables when a short paragraph is clearer. Never output raw HTML for visual formatting."#;

/// The saved step that lists what a teammate did with its tools.
const ACTIONS_STEP: &str = "actions";
/// Saved steps for help from another teammate are named `handoff:<bot id>`.
const HANDOFF_STEP: &str = "handoff";
const ASK_TEAMMATE: &str = "ask_teammate";
const USE_SKILL: &str = "use_skill";

fn workspace_prompt(dir: &Path) -> String {
    format!(
        "You have a workspace folder on Rohan's Mac at {}, shared with his other teammates. You can read, create, and edit files there and run shell commands in it; files outside it are off limits. Rohan is asked to approve every file write and every command before it happens. If he declines one, do not try another way: ask him what he would like instead. Say that something is done only after the tool result confirms it, and name the files you created or changed.",
        dir.display()
    )
}

/// Aeris's built-in instructions, shown in Settings as the starting point.
#[tauri::command]
pub fn default_persona() -> &'static str {
    DEFAULT_AERIS_PERSONA
}

/// Writes and commands waiting for Rohan's answer: approval id to the
/// request it belongs to and the way to deliver the answer.
#[derive(Default)]
pub struct ApprovalState(Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>);

#[tauri::command]
pub fn answer_approval(
    approval_id: String,
    allow: bool,
    state: State<'_, ApprovalState>,
) -> Result<(), String> {
    let pending = state
        .0
        .lock()
        .map_err(|_| "Could not lock approvals")?
        .remove(&approval_id);
    if let Some((_, answer)) = pending {
        let _ = answer.send(allow);
    }
    Ok(())
}

/// Resolves the workspace folder (the default one when `configured` is
/// empty) and makes sure it exists.
fn workspace_dir(configured: &str) -> Result<PathBuf, String> {
    let configured = configured.trim();
    let dir = if configured.is_empty() {
        let home = env::var_os("HOME").ok_or("Could not find the home folder.")?;
        PathBuf::from(home).join("Aeris Bot Workspace")
    } else {
        PathBuf::from(configured)
    };
    if !dir.is_absolute() || dir.parent().is_none() {
        return Err("The workspace must be a full path to a folder, not the whole disk.".into());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the workspace folder: {error}"))?;
    Ok(dir)
}

/// The workspace folder teammates work in, created if it is missing.
#[tauri::command]
pub fn workspace_path(configured: String) -> Result<String, String> {
    workspace_dir(&configured).map(|dir| dir.display().to_string())
}

#[tauri::command]
pub fn open_workspace(configured: String) -> Result<(), String> {
    let dir = workspace_dir(&configured)?;
    std::process::Command::new("/usr/bin/open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the workspace folder: {error}"))
}

/// Request ids the user asked to stop.
#[derive(Default)]
pub struct GenerationState(pub Mutex<HashSet<String>>);

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

fn is_cancelled(state: &GenerationState, request_id: &str) -> bool {
    state
        .0
        .lock()
        .map(|requests| requests.contains(request_id))
        .unwrap_or(true)
}

/// An empty folder for runs that must not see any of Rohan's files.
fn neutral_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("claude-workspace"))
        .map_err(|error| error.to_string())
}

fn bounded_setting(value: &str, fallback: &str, max_chars: usize) -> String {
    let selected = if value.trim().is_empty() {
        fallback
    } else {
        value.trim()
    };
    selected.chars().take(max_chars).collect()
}

fn role_of(bot: &Bot) -> &str {
    if bot.title.is_empty() {
        "teammate"
    } else {
        &bot.title
    }
}

/// Who this teammate is: Aeris uses the instructions from Settings, every
/// other teammate uses the profile Rohan wrote for it.
fn identity_prompt(bot: &Bot, aeris_instructions: &str) -> String {
    if bot.id == AERIS_BOT_ID {
        return bounded_setting(aeris_instructions, DEFAULT_AERIS_PERSONA, 8_000);
    }
    let mut prompt = format!(
        "Your name is {}. You are one of the teammates on Rohan's private AI team in the Aeris Bot app.",
        bot.name
    );
    if !bot.title.is_empty() {
        prompt.push_str(&format!(" Your role: {}.", bot.title));
    }
    if !bot.description.is_empty() {
        prompt.push_str(&format!(
            "\nWhat you are responsible for: {}",
            bot.description
        ));
    }
    if !bot.instructions.is_empty() {
        prompt.push_str(&format!("\n\nHow you work:\n{}", bot.instructions));
    }
    prompt.push_str("\n\nStay within your role. Match the language and tone Rohan uses; when he writes in Sinhala or romanized Sinhala, reply the same way.");
    prompt
}

/// How this reply is being made, which changes what the teammate is told.
#[derive(Clone, Copy, Default)]
struct Setting<'a> {
    workspace: Option<&'a Path>,
    /// The teammate may use `ask_teammate`.
    can_ask: bool,
    /// The teammates in the group thread this reply belongs to.
    group: Option<&'a [&'a Bot]>,
    /// Saved procedures the teammate can load with `use_skill`.
    skills: &'a [Skill],
    /// Names of the plugins switched on for this reply.
    plugins: &'a [String],
    /// Set for a routine running on schedule; the value says whether file
    /// writes go ahead without asking.
    routine: Option<bool>,
}

fn system_prompt(bot: &Bot, aeris_instructions: &str, team: &[Bot], setting: Setting<'_>) -> String {
    let mut prompt = identity_prompt(bot, aeris_instructions);
    let others: Vec<String> = team
        .iter()
        .filter(|teammate| teammate.id != bot.id)
        .map(|teammate| {
            format!(
                "- {} ({}): {}",
                teammate.name,
                role_of(teammate),
                teammate.description
            )
        })
        .collect();
    if !others.is_empty() {
        prompt.push_str("\n\nRohan's other teammates:\n");
        prompt.push_str(&others.join("\n"));
        if setting.can_ask {
            prompt.push_str("\nWhen a request, or part of it, falls within a teammate's responsibility, ask that teammate with the ask_teammate tool instead of doing their job yourself. Then give Rohan the result and say who helped. Answer directly only what is outside every teammate's role, or small talk and quick follow-ups.");
        }
    }
    if let Some(members) = setting.group {
        let names: Vec<String> = members
            .iter()
            .map(|member| {
                if member.id == bot.id {
                    format!("{} (you)", member.name)
                } else {
                    format!("{} ({})", member.name, role_of(member))
                }
            })
            .collect();
        prompt.push_str(&format!(
            "\n\nThis is a group thread with Rohan and these teammates: {}. Each message is labelled with who wrote it. Reply only as yourself, from your own role, and do not repeat what a teammate has already said in this thread.",
            names.join(", ")
        ));
    }
    if !setting.skills.is_empty() {
        prompt.push_str("\n\nSkills are procedures Rohan saved. Before a task that one of them covers, or when he names one, load it with the use_skill tool and follow it:\n");
        let listed: Vec<String> = setting
            .skills
            .iter()
            .map(|skill| format!("- {}: {}", skill.name, skill.description))
            .collect();
        prompt.push_str(&listed.join("\n"));
    }
    if !setting.plugins.is_empty() {
        prompt.push_str(&format!(
            "\n\nRohan connected these plugins, and their tools are yours to use when a request needs them: {}. Some plugin tools ask Rohan for approval first; if he declines, do not try another way.",
            setting.plugins.join(", ")
        ));
    }
    if let Some(writes_allowed) = setting.routine {
        prompt.push_str("\n\nThis is a scheduled routine running while Rohan is away. Nobody can answer questions or approve anything, so finish with what you have and report what you did and what you could not do. Shell commands will not run.");
        prompt.push_str(if writes_allowed {
            " File writes in the workspace go ahead without asking."
        } else {
            " File writes will not go ahead either."
        });
    }
    prompt.push_str("\n\n");
    prompt.push_str(RUNTIME_PROMPT);
    prompt.push(' ');
    match setting.workspace {
        Some(dir) => prompt.push_str(&workspace_prompt(dir)),
        None => prompt.push_str(NO_WORKSPACE_PROMPT),
    }
    prompt.push_str("\n\n");
    prompt.push_str(RESPONSE_FORMATTING_PROMPT);
    if bot.memory_enabled && !bot.memory.trim().is_empty() {
        prompt.push_str(&memory::prompt_block(&bot.memory));
    }
    prompt
}

/// Who answers a message in a group thread: every member Rohan mentioned with
/// `@name`, in the order mentioned, or the lead when nobody was mentioned.
fn pick_responders<'a>(members: &[&'a Bot], text: &str) -> Vec<&'a Bot> {
    let text = text.to_lowercase();
    let mut mentioned: Vec<(usize, &Bot)> = members
        .iter()
        .filter_map(|member| {
            text.find(&format!("@{}", member.name.to_lowercase()))
                .map(|position| (position, *member))
        })
        .collect();
    mentioned.sort_by_key(|(position, _)| *position);
    if mentioned.is_empty() {
        return members.first().copied().into_iter().collect();
    }
    mentioned.into_iter().map(|(_, member)| member).collect()
}

/// The group thread as one teammate sees it: every message labelled with its
/// author, then a note that it is this teammate's turn.
fn group_turns(history: &[Message], me: &Bot, team: &[Bot]) -> Vec<Message> {
    let mut turns: Vec<Message> = history
        .iter()
        .map(|message| {
            let speaker = if message.role == "user" {
                "Rohan".to_string()
            } else if message.bot_id == me.id {
                format!("{} (you)", me.name)
            } else {
                team.iter()
                    .find(|bot| bot.id == message.bot_id)
                    .map(|bot| bot.name.clone())
                    .unwrap_or_else(|| "A teammate".to_string())
            };
            agents::turn(&speaker, message.content.clone())
        })
        .collect();
    turns.push(agents::turn(
        "user",
        format!(
            "It is your turn in the group thread, {}. Reply to Rohan's latest message, taking into account what has been said since.",
            me.name
        ),
    ));
    turns
}

fn boxed<'a, T>(future: impl Future<Output = T> + Send + 'a) -> BoxFuture<'a, T> {
    Box::pin(future)
}

/// What a teammate needs in order to ask another teammate for help.
struct Handoffs<'a> {
    backend: &'a Backend,
    team: &'a [Bot],
    asker: &'a Bot,
    aeris_instructions: &'a str,
    request_id: &'a str,
    chat_id: &'a str,
    on_event: &'a Channel<StreamEvent>,
    generations: &'a GenerationState,
    /// `(teammate id, question, answer)` for each completed handoff.
    log: &'a Mutex<Vec<(String, String, String)>>,
}

/// The `ask_teammate` tool: runs the other teammate once, with its own
/// instructions and memory, and returns its answer to the asker.
async fn ask_teammate(handoffs: &Handoffs<'_>, arguments: Value) -> Result<String, String> {
    let wanted = arguments
        .get("teammate")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let question = arguments
        .get("request")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let Some(teammate) = handoffs
        .team
        .iter()
        .find(|bot| bot.id != handoffs.asker.id && bot.name.to_lowercase() == wanted)
    else {
        let names: Vec<&str> = handoffs
            .team
            .iter()
            .filter(|bot| bot.id != handoffs.asker.id)
            .map(|bot| bot.name.as_str())
            .collect();
        return Err(format!(
            "There is no teammate with that name. The teammates are: {}.",
            names.join(", ")
        ));
    };
    if question.is_empty() {
        return Err("Say what you need from the teammate.".into());
    }

    let (request_id, chat_id) = (handoffs.request_id, handoffs.chat_id);
    let send = |status: &str, content: Option<String>| {
        let _ = handoffs.on_event.send(StreamEvent::handoff(
            request_id,
            chat_id,
            &teammate.id,
            status,
            content,
        ));
    };
    send("start", Some(question.clone()));
    let mut system = system_prompt(
        teammate,
        handoffs.aeris_instructions,
        handoffs.team,
        Setting::default(),
    );
    system.push_str(&format!(
        "\n\n{} ({}) is asking for your help with something Rohan needs. Answer {} directly and completely enough to pass on, in at most 250 words.",
        handoffs.asker.name,
        role_of(handoffs.asker),
        handoffs.asker.name
    ));
    let turns = [agents::turn(
        "user",
        format!("{} asks: {question}", handoffs.asker.name),
    )];
    let on_chunk = |chunk: String| send("chunk", Some(chunk));
    let cancelled = || is_cancelled(handoffs.generations, request_id);
    let answer = handoffs
        .backend
        .complete(&system, &turns, true, &on_chunk, &cancelled)
        .await;
    match answer {
        Ok(completion) if !completion.content.trim().is_empty() => {
            send("done", None);
            if let Ok(mut log) = handoffs.log.lock() {
                log.push((teammate.id.clone(), question, completion.content.clone()));
            }
            Ok(completion.content)
        }
        Ok(_) => {
            send("error", Some("No answer came back.".into()));
            Err(format!("{} did not answer.", teammate.name))
        }
        Err(message) => {
            send("error", Some(message.clone()));
            Err(format!("{} could not answer: {message}", teammate.name))
        }
    }
}

#[tauri::command]
pub async fn stream_chat(
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
    app: AppHandle,
    database: State<'_, DatabaseState>,
    generations: State<'_, GenerationState>,
    approvals: State<'_, ApprovalState>,
) -> Result<(), String> {
    let (request_id, chat_id) = (request.request_id.as_str(), request.chat_id.as_str());
    if let Ok(mut stopped) = generations.0.lock() {
        stopped.remove(request_id);
    }
    let outcome = answer_message(&request, &on_event, &app, &database, &generations, &approvals).await;
    // Whatever happened, forget the stop request and any unanswered approval.
    if let Ok(mut stopped) = generations.0.lock() {
        stopped.remove(request_id);
    }
    if let Ok(mut pending) = approvals.0.lock() {
        pending.retain(|_, (owner, _)| owner != request_id);
    }
    match outcome {
        Ok(Some(title)) => {
            let _ = on_event.send(StreamEvent::done(request_id, chat_id, title));
            Ok(())
        }
        // Stopped before anything was written.
        Ok(None) => Ok(()),
        Err(message) => {
            let _ = on_event.send(StreamEvent::error(request_id, chat_id, message.clone()));
            Err(message)
        }
    }
}

/// Stores Rohan's message and has each responding teammate reply in turn.
/// Returns the thread title once at least one reply is saved.
pub(crate) async fn answer_message(
    request: &ChatRequest,
    on_event: &Channel<StreamEvent>,
    app: &AppHandle,
    database: &State<'_, DatabaseState>,
    generations: &GenerationState,
    approvals: &ApprovalState,
) -> Result<Option<String>, String> {
    let (request_id, chat_id) = (request.request_id.as_str(), request.chat_id.as_str());
    let user_message = Message {
        id: request.user_message_id.clone(),
        chat_id: request.chat_id.clone(),
        role: "user".into(),
        content: request.content.trim().into(),
        created_at: now_ms(),
        bot_id: String::new(),
    };
    insert_message(database, &user_message)?;

    let team = all_bots(database)?;
    let saved_skills = skills::all(database)?;
    let plugin_set = plugins::plugin_set(&plugins::all(database)?);
    let member_ids = chat_members(database, chat_id)?;
    let members: Vec<&Bot> = member_ids
        .iter()
        .filter_map(|id| team.iter().find(|bot| &bot.id == id))
        .collect();
    let in_group = !member_ids.is_empty();
    let direct_bot;
    let responders: Vec<&Bot> = if in_group {
        pick_responders(&members, &user_message.content)
    } else {
        direct_bot = load_chat_bot(database, chat_id)?;
        vec![&direct_bot]
    };
    if responders.is_empty() {
        return Err("This group has no teammates left.".into());
    }

    let backend = Backend {
        binary_path: request.claude_binary_path.clone(),
        model: request.claude_model.clone(),
        neutral_dir: neutral_dir(app)?,
    };
    let cancel_requested = || is_cancelled(generations, request_id);
    let mut title = None;

    for (index, bot) in responders.iter().copied().enumerate() {
        if cancel_requested() {
            break;
        }
        let message_id = if index == 0 {
            request.assistant_message_id.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        if in_group {
            let _ = on_event.send(StreamEvent::message(request_id, chat_id, &message_id, &bot.id));
        }
        let history = load_messages(database, chat_id)?;
        let turns = if in_group {
            group_turns(&history, bot, &team)
        } else {
            history
        };

        // Workspace access: tool work is shown in the thread as it happens,
        // and every write or command waits for Rohan's answer.
        let workspace_folder = if bot.workspace_enabled {
            Some(workspace_dir(&request.workspace_dir)?)
        } else {
            None
        };
        let actions = Mutex::new(Vec::<String>::new());
        let on_tool = |used: ToolUse| {
            let _ = on_event.send(StreamEvent::tool(
                request_id,
                chat_id,
                &used.tool,
                used.summary.clone(),
            ));
            if let Ok(mut actions) = actions.lock() {
                actions.push(used.summary);
            }
        };
        let approve = |question: ToolRequest| -> BoxFuture<'static, bool> {
            if request.unattended {
                // Nobody is there to ask: writes follow the routine's own
                // setting and commands never run.
                let allowed = request.unattended_writes && matches!(question.tool.as_str(), "Write" | "Edit");
                return Box::pin(async move { allowed });
            }
            let approval_id = Uuid::new_v4().to_string();
            let (answer, answered) = oneshot::channel();
            match approvals.0.lock() {
                Ok(mut pending) => {
                    pending.insert(approval_id.clone(), (request_id.to_string(), answer));
                }
                Err(_) => return Box::pin(async { false }),
            }
            let _ = on_event.send(StreamEvent::approval(
                request_id,
                chat_id,
                &approval_id,
                &question.tool,
                question.summary,
                question.detail,
            ));
            // No answer (the run was stopped) counts as "don't allow".
            Box::pin(async move { answered.await.unwrap_or(false) })
        };
        let hooks = WorkspaceHooks {
            on_tool: &on_tool,
            approve: &approve,
        };
        let workspace = Some(Workspace {
            dir: workspace_folder.as_deref(),
            hooks: &hooks,
            plugins: (!plugin_set.names.is_empty()).then_some(&plugin_set),
        });

        // Handoffs: a teammate can ask any other teammate for help.
        let handoff_log = Mutex::new(Vec::new());
        let handoffs = Handoffs {
            backend: &backend,
            team: &team,
            asker: bot,
            aeris_instructions: &request.persona_prompt,
            request_id,
            chat_id,
            on_event,
            generations,
            log: &handoff_log,
        };
        let handoffs_ref = &handoffs;
        let ask = move |arguments: Value| boxed(ask_teammate(handoffs_ref, arguments));
        let can_ask = team.len() > 1;
        let (skills_ref, actions_ref) = (&saved_skills, &actions);
        let use_skill = move |arguments: Value| {
            boxed(async move {
                let wanted = arguments
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase();
                let Some(skill) = skills_ref.iter().find(|skill| skill.name.to_lowercase() == wanted) else {
                    let names: Vec<&str> = skills_ref.iter().map(|skill| skill.name.as_str()).collect();
                    return Err(format!("There is no skill with that name. The skills are: {}.", names.join(", ")));
                };
                let line = format!("Used the skill \"{}\"", skill.name);
                let _ = on_event.send(StreamEvent::tool(request_id, chat_id, "Skill", line.clone()));
                if let Ok(mut actions) = actions_ref.lock() {
                    actions.push(line);
                }
                Ok(format!("# {}\n\n{}", skill.name, skill.instructions))
            })
        };
        let mut host_tools: Vec<HostTool<'_>> = if can_ask {
            vec![HostTool {
                name: ASK_TEAMMATE,
                description: "Ask another teammate for help and get their answer back. Use it when part of the request belongs to that teammate's role.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "teammate": { "type": "string", "description": "The teammate's name." },
                        "request": { "type": "string", "description": "What you need from them, with the context they need to answer." }
                    },
                    "required": ["teammate", "request"]
                }),
                call: &ask,
            }]
        } else {
            Vec::new()
        };
        if !saved_skills.is_empty() {
            host_tools.push(HostTool {
                name: USE_SKILL,
                description: "Load one of Rohan's saved skills (a procedure) so you can follow it.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "name": { "type": "string", "description": "The skill's name." } },
                    "required": ["name"]
                }),
                call: &use_skill,
            });
        }

        let system = system_prompt(
            bot,
            &request.persona_prompt,
            &team,
            Setting {
                workspace: workspace_folder.as_deref(),
                can_ask,
                group: in_group.then_some(members.as_slice()),
                skills: &saved_skills,
                plugins: &plugin_set.names,
                routine: request.unattended.then_some(request.unattended_writes),
            },
        );

        // Specialists are for direct threads; a group already has its team.
        let (reply, mut steps): (Completion, Vec<(String, String)>) = if request.team_mode && !in_group {
            let emit = |event: TeamEvent| {
                let _ = on_event.send(match event {
                    TeamEvent::AgentStart(agent) => {
                        StreamEvent::agent(request_id, chat_id, agent, "start", None)
                    }
                    TeamEvent::AgentChunk(agent, chunk) => {
                        StreamEvent::agent(request_id, chat_id, agent, "chunk", Some(chunk))
                    }
                    TeamEvent::AgentDone(agent) => {
                        StreamEvent::agent(request_id, chat_id, agent, "done", None)
                    }
                    TeamEvent::AgentError(agent, message) => {
                        StreamEvent::agent(request_id, chat_id, agent, "error", Some(message))
                    }
                    TeamEvent::Reply(chunk) => StreamEvent::chunk(request_id, chat_id, chunk),
                });
            };
            let outcome = agents::run_team(
                &backend,
                &system,
                &turns,
                workspace,
                &host_tools,
                &emit,
                &cancel_requested,
            )
            .await?;
            (outcome.reply, outcome.steps)
        } else {
            let on_chunk = |chunk: String| {
                let _ = on_event.send(StreamEvent::chunk(request_id, chat_id, chunk));
            };
            let reply = backend
                .work(
                    &system,
                    &turns,
                    workspace,
                    &host_tools,
                    &on_chunk,
                    &cancel_requested,
                )
                .await?;
            (reply, Vec::new())
        };
        if reply.content.is_empty() {
            if cancel_requested() {
                break;
            }
            return Err(format!("{} returned an empty reply.", bot.name));
        }

        if let Ok(actions) = actions.lock() {
            if !actions.is_empty() {
                steps.push((ACTIONS_STEP.to_string(), actions.join("\n")));
            }
        }
        if let Ok(log) = handoff_log.lock() {
            for (teammate_id, question, answer) in log.iter() {
                steps.push((
                    format!("{HANDOFF_STEP}:{teammate_id}"),
                    json!({ "question": question, "answer": answer }).to_string(),
                ));
            }
        }
        let assistant_message = Message {
            id: message_id,
            chat_id: request.chat_id.clone(),
            role: "assistant".into(),
            content: reply.content,
            created_at: now_ms(),
            bot_id: bot.id.clone(),
        };
        title = Some(finish_response(
            database,
            &assistant_message,
            reply.prompt_tokens,
            reply.completion_tokens,
        )?);
        save_agent_steps(database, &assistant_message.id, &steps)?;
        let _ = on_event.send(StreamEvent::usage(
            request_id,
            chat_id,
            reply.prompt_tokens,
            reply.completion_tokens,
            reply.tokens_per_second,
        ));
        remember(
            app,
            request,
            bot,
            &user_message.content,
            &assistant_message.content,
        );
    }
    Ok(title)
}

/// Revises the teammate's long-term memory in the background after a reply.
/// It never delays or fails the chat: any problem leaves the memory as it was.
fn remember(app: &AppHandle, request: &ChatRequest, bot: &Bot, user: &str, reply: &str) {
    if !bot.memory_enabled {
        return;
    }
    let app = app.clone();
    let (bot_id, binary_path) = (bot.id.clone(), request.claude_binary_path.clone());
    let (user, reply) = (user.to_string(), reply.to_string());
    tauri::async_runtime::spawn(async move {
        let Ok(neutral_dir) = neutral_dir(&app) else {
            return;
        };
        // Memory upkeep always uses the small model to spare the plan's limits.
        let backend = Backend {
            binary_path,
            model: "haiku".into(),
            neutral_dir,
        };
        let database = app.state::<DatabaseState>();
        let Ok(current) = load_bot(&database, &bot_id) else {
            return;
        };
        let turns = [agents::turn(
            "user",
            memory::update_request(&current.memory, &user, &reply),
        )];
        let ignore_chunk = |_: String| {};
        let never_cancelled = || false;
        let Ok(completion) = backend
            .complete(
                &memory::system_prompt(&current.name),
                &turns,
                false,
                &ignore_chunk,
                &never_cancelled,
            )
            .await
        else {
            return;
        };
        if let Some(updated) = memory::accept_update(&completion.content) {
            let _ = save_bot_memory(&database, &bot_id, &updated);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str, name: &str, title: &str) -> Bot {
        Bot {
            id: id.into(),
            name: name.into(),
            title: title.into(),
            description: format!("{name} description"),
            instructions: format!("{name} instructions"),
            memory: String::new(),
            memory_enabled: true,
            workspace_enabled: true,
            created_at: 0,
        }
    }

    fn team() -> Vec<Bot> {
        vec![
            bot(AERIS_BOT_ID, "Aeris", "Chief of staff"),
            bot("b1", "Guru", "Lesson planner"),
            bot("b2", "Quill", "Writer"),
        ]
    }

    #[test]
    fn settings_fall_back_and_respect_limits() {
        assert_eq!(bounded_setting("  Custom  ", "Default", 100), "Custom");
        assert_eq!(bounded_setting("   ", "Default", 100), "Default");
        assert_eq!(bounded_setting("123456", "Default", 4), "1234");
    }

    #[test]
    fn aeris_uses_settings_instructions_and_knows_the_team() {
        let team = team();
        let prompt = system_prompt(&team[0], "", &team, Setting::default());
        assert!(prompt.starts_with("Your name is Aeris."));
        assert!(prompt.contains("- Guru (Lesson planner): Guru description"));
        assert!(!prompt.contains("- Aeris"));
        assert!(!prompt.contains("ask_teammate"));
        assert!(system_prompt(&team[0], "Be brief.", &team, Setting::default()).starts_with("Be brief."));
    }

    #[test]
    fn teammates_are_told_about_handoffs_only_when_they_can_ask() {
        let team = team();
        let asking = Setting { can_ask: true, ..Setting::default() };
        assert!(system_prompt(&team[1], "", &team, asking).contains("ask_teammate tool"));
        assert!(!system_prompt(&team[1], "", &team, Setting::default()).contains("ask_teammate tool"));
    }

    #[test]
    fn other_teammates_use_their_own_profile_and_memory() {
        let mut guru = bot("b1", "Guru", "Lesson planner");
        guru.memory = "- Rohan teaches Grade 10 ICT".into();
        let prompt = system_prompt(&guru, "Be brief.", &[], Setting::default());
        assert!(prompt.contains("Your name is Guru."));
        assert!(prompt.contains("Guru instructions"));
        assert!(prompt.contains("<memory>\n- Rohan teaches Grade 10 ICT\n</memory>"));
        assert!(!prompt.contains("Be brief."));
        guru.memory_enabled = false;
        assert!(!system_prompt(&guru, "", &[], Setting::default()).contains("<memory>"));
    }

    #[test]
    fn the_prompt_says_whether_there_is_a_workspace() {
        let guru = bot("b1", "Guru", "Lesson planner");
        let without = system_prompt(&guru, "", &[], Setting::default());
        assert!(without.contains("You cannot read or change files or run commands."));
        let dir = Path::new("/Users/rohan/Aeris Bot Workspace");
        let with = system_prompt(&guru, "", &[], Setting { workspace: Some(dir), ..Setting::default() });
        assert!(with.contains("workspace folder on Rohan's Mac at /Users/rohan/Aeris Bot Workspace"));
        assert!(with.contains("approve every file write and every command"));
        assert!(!with.contains("You cannot read or change files"));
    }

    #[test]
    fn skills_and_routine_rules_are_spelled_out() {
        let guru = bot("b1", "Guru", "Lesson planner");
        let skills = [Skill {
            id: "s1".into(),
            name: "Lesson notes".into(),
            description: "Use for a new lesson.".into(),
            instructions: "1. Ask for the topic.".into(),
            created_at: 0,
        }];
        let prompt = system_prompt(&guru, "", &[], Setting { skills: &skills, routine: Some(false), ..Setting::default() });
        assert!(prompt.contains("- Lesson notes: Use for a new lesson."));
        assert!(!prompt.contains("1. Ask for the topic."));
        assert!(prompt.contains("scheduled routine") && prompt.contains("File writes will not go ahead either."));
        assert!(!system_prompt(&guru, "", &[], Setting::default()).contains("scheduled routine"));
    }

    #[test]
    fn workspace_must_be_a_real_folder_path() {
        assert!(workspace_dir("/").is_err());
        assert!(workspace_dir("relative/folder").is_err());
    }

    #[test]
    fn group_messages_go_to_mentioned_teammates_or_the_lead() {
        let team = team();
        let members: Vec<&Bot> = team.iter().collect();
        let names = |text: &str| -> Vec<&str> {
            pick_responders(&members, text).into_iter().map(|bot| bot.name.as_str()).collect()
        };
        assert_eq!(names("What should we do this week?"), ["Aeris"]);
        assert_eq!(names("@quill draft it, then @Guru check the facts"), ["Quill", "Guru"]);
        assert_eq!(names("thanks @GURU"), ["Guru"]);
    }

    #[test]
    fn group_thread_is_labelled_for_the_teammate_reading_it() {
        let team = team();
        let message = |role: &str, bot_id: &str, content: &str| Message {
            id: String::new(),
            chat_id: String::new(),
            role: role.into(),
            content: content.into(),
            created_at: 0,
            bot_id: bot_id.into(),
        };
        let history = [
            message("user", "", "Plan the lesson"),
            message("assistant", "b1", "Here is a plan"),
            message("assistant", "b2", "Here is a draft"),
        ];
        let turns = group_turns(&history, &team[2], &team);
        let speakers: Vec<&str> = turns.iter().map(|turn| turn.role.as_str()).collect();
        assert_eq!(speakers, ["Rohan", "Guru", "Quill (you)", "user"]);
        assert!(turns[3].content.contains("your turn in the group thread, Quill"));
        let members: Vec<&Bot> = team.iter().collect();
        let prompt = system_prompt(&team[2], "", &team, Setting { group: Some(&members), ..Setting::default() });
        assert!(prompt.contains("group thread with Rohan and these teammates: Aeris (Chief of staff), Guru (Lesson planner), Quill (you)"));
    }
}
