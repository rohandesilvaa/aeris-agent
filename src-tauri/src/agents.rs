//! Aeris's agent team: three specialists work on the latest request, a
//! reviewer checks their notes, and Aeris writes the final reply from them.

use crate::{
    claude_code::{self, ClaudeRequest, HostTool, WorkspaceHooks},
    plugins::PluginSet,
    models::Message,
};
use futures_util::future::join_all;
use std::path::{Path, PathBuf};

pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub role: &'static str,
    brief: &'static str,
    /// Whether this agent may search and read the web.
    web: bool,
}

pub const SPECIALISTS: [AgentSpec; 3] = [
    AgentSpec {
        id: "researcher",
        name: "Atlas",
        role: "research",
        brief: "Gather the facts, definitions, and context needed to answer the latest request. Flag anything you are unsure about instead of guessing.",
        web: true,
    },
    AgentSpec {
        id: "analyst",
        name: "Vega",
        role: "reasoning",
        brief: "Reason through the latest request step by step: work out the logic, the calculations, the trade-offs, or a concrete plan.",
        web: false,
    },
    AgentSpec {
        id: "creative",
        name: "Nova",
        role: "ideas",
        brief: "Offer the angles the others may miss: alternatives, examples, analogies, risks, and practical tips.",
        web: false,
    },
];

pub const CRITIC: AgentSpec = AgentSpec {
    id: "critic",
    name: "Argus",
    role: "review",
    brief: "Review the team's notes for the request. Point out factual errors, contradictions, weak reasoning, and important gaps, and say which points are the most reliable.",
    web: false,
};

/// Where model calls run: the Claude Code CLI on this Mac.
pub struct Backend {
    pub binary_path: String,
    pub model: String,
    /// An empty folder for runs that must not see any files.
    pub neutral_dir: PathBuf,
}

/// What a teammate's own reply may touch, and how the app shows and
/// approves that work.
#[derive(Clone, Copy)]
pub struct Workspace<'a> {
    /// The workspace folder, when the teammate has access to it.
    pub dir: Option<&'a Path>,
    pub hooks: &'a WorkspaceHooks<'a>,
    pub plugins: Option<&'a PluginSet>,
}

#[derive(Default)]
pub struct Completion {
    pub content: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub tokens_per_second: f64,
}

type ChunkSink<'a> = &'a (dyn Fn(String) + Sync);
type CancelCheck<'a> = &'a (dyn Fn() -> bool + Sync);

impl Backend {
    /// A model call with no access to the Mac. `web` allows web search.
    pub async fn complete(
        &self,
        system: &str,
        turns: &[Message],
        web: bool,
        on_chunk: ChunkSink<'_>,
        is_cancelled: CancelCheck<'_>,
    ) -> Result<Completion, String> {
        let tools = if web { claude_code::WEB_TOOLS } else { "" };
        self.call(system, turns, &self.neutral_dir, tools, None, &[], on_chunk, is_cancelled)
            .await
    }

    /// A teammate's own reply: in the workspace when it has one, otherwise
    /// with web search only, and with any tools the app itself provides.
    pub async fn work(
        &self,
        system: &str,
        turns: &[Message],
        workspace: Option<Workspace<'_>>,
        host_tools: &[HostTool<'_>],
        on_chunk: ChunkSink<'_>,
        is_cancelled: CancelCheck<'_>,
    ) -> Result<Completion, String> {
        self.call(system, turns, &self.neutral_dir, claude_code::WEB_TOOLS, workspace, host_tools, on_chunk, is_cancelled)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn call(
        &self,
        system: &str,
        turns: &[Message],
        neutral_dir: &Path,
        tools: &str,
        workspace: Option<Workspace<'_>>,
        host_tools: &[HostTool<'_>],
        on_chunk: ChunkSink<'_>,
        is_cancelled: CancelCheck<'_>,
    ) -> Result<Completion, String> {
        let outcome = claude_code::run(
            ClaudeRequest {
                binary_path: &self.binary_path,
                model: &self.model,
                system_prompt: system,
                prompt: claude_code::build_prompt(turns),
                // With workspace access the run starts in that folder;
                // otherwise in an empty one.
                cwd: workspace.and_then(|workspace| workspace.dir).unwrap_or(neutral_dir),
                tools,
                workspace: workspace.map(|workspace| workspace.hooks),
                in_workspace: workspace.is_some_and(|workspace| workspace.dir.is_some()),
                plugins: workspace.and_then(|workspace| workspace.plugins),
                host_tools,
            },
            on_chunk,
            is_cancelled,
        )
        .await?;
        Ok(Completion {
            content: outcome.content,
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            tokens_per_second: outcome.tokens_per_second,
        })
    }
}

pub enum TeamEvent {
    AgentStart(&'static str),
    AgentChunk(&'static str, String),
    AgentDone(&'static str),
    AgentError(&'static str, String),
    /// Text of the final reply as Aeris writes it.
    Reply(String),
}

#[derive(Default)]
pub struct TeamOutcome {
    pub reply: Completion,
    /// `(agent id, notes)` for every agent that produced notes, in run order.
    pub steps: Vec<(String, String)>,
}

pub(crate) fn turn(role: &str, content: String) -> Message {
    Message {
        id: String::new(),
        chat_id: String::new(),
        role: role.into(),
        content,
        created_at: 0,
        bot_id: String::new(),
    }
}

fn agent_system_prompt(spec: &AgentSpec, word_limit: u32, web: bool) -> String {
    let mut prompt = format!(
        "You are {}, the {} specialist on Aeris's internal agent team. Aeris is Rohan's personal AI assistant: the team prepares working notes and Aeris writes the final reply.\n{}\nWrite compact working notes for Aeris as short bullet points, at most {word_limit} words. Do not greet, do not address Rohan, and do not write the final answer.",
        spec.name, spec.role, spec.brief
    );
    if web {
        prompt.push_str(" Use web search when the request needs current information, and list the source URLs you relied on.");
    }
    prompt
}

fn notes_block(steps: &[(&AgentSpec, String)]) -> String {
    steps
        .iter()
        .map(|(spec, notes)| format!("## {} ({})\n{}", spec.name, spec.role, notes.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn reply_system_prompt(persona: &str, notes: &str) -> String {
    format!(
        "{persona}\n\nYour internal agent team prepared the notes below for Rohan's latest message. Use them to write one final reply in your own voice: keep what is correct and useful, fix what the reviewer flagged, and drop the rest. Do not mention the team or the notes unless Rohan asks about them.\n\n<team_notes>\n{notes}\n</team_notes>"
    )
}

async fn run_agent(
    backend: &Backend,
    spec: &'static AgentSpec,
    system: String,
    turns: &[Message],
    emit: &(dyn Fn(TeamEvent) + Sync),
    is_cancelled: CancelCheck<'_>,
) -> Result<String, String> {
    emit(TeamEvent::AgentStart(spec.id));
    let on_chunk = |chunk: String| emit(TeamEvent::AgentChunk(spec.id, chunk));
    let result = backend
        .complete(
            &system,
            turns,
            spec.web,
            &on_chunk,
            is_cancelled,
        )
        .await
        .and_then(|completion| {
            if completion.content.trim().is_empty() {
                Err("No notes returned.".to_string())
            } else {
                Ok(completion.content)
            }
        });
    match &result {
        Ok(_) => emit(TeamEvent::AgentDone(spec.id)),
        // A cancelled run is not a failure worth reporting.
        Err(_) if is_cancelled() => {}
        Err(message) => emit(TeamEvent::AgentError(spec.id, message.clone())),
    }
    result
}

/// Runs the whole team for the latest message in `history`.
pub async fn run_team(
    backend: &Backend,
    persona: &str,
    history: &[Message],
    workspace: Option<Workspace<'_>>,
    host_tools: &[HostTool<'_>],
    emit: &(dyn Fn(TeamEvent) + Sync),
    is_cancelled: CancelCheck<'_>,
) -> Result<TeamOutcome, String> {
    // A stopped run returns no reply; the caller checks for cancellation.
    let cancelled = TeamOutcome::default;
    let request = history
        .last()
        .map(|message| message.content.clone())
        .unwrap_or_default();

    // Phase 1: the specialists, all at once.
    let results = join_all(SPECIALISTS.iter().map(|spec| {
        run_agent(
            backend,
            spec,
            agent_system_prompt(spec, 160, spec.web),
            history,
            emit,
            is_cancelled,
        )
    }))
    .await;
    if is_cancelled() {
        return Ok(cancelled());
    }
    let mut last_error = String::new();
    let mut notes: Vec<(&AgentSpec, String)> = Vec::new();
    for (spec, result) in SPECIALISTS.iter().zip(results) {
        match result {
            Ok(content) => notes.push((spec, content)),
            Err(message) => last_error = message,
        }
    }
    if notes.is_empty() {
        return Err(format!("The agent team could not start: {last_error}"));
    }

    // Phase 2: the reviewer. Its failure does not stop the reply.
    let review_turns = [turn(
        "user",
        format!(
            "Rohan's latest request:\n{request}\n\nTeam notes:\n\n{}",
            notes_block(&notes)
        ),
    )];
    if let Ok(review) = run_agent(
        backend,
        &CRITIC,
        agent_system_prompt(&CRITIC, 120, false),
        &review_turns,
        emit,
        is_cancelled,
    )
    .await
    {
        notes.push((&CRITIC, review));
    }
    if is_cancelled() {
        return Ok(cancelled());
    }

    // Phase 3: Aeris writes the reply.
    let on_chunk = |chunk: String| emit(TeamEvent::Reply(chunk));
    let reply = backend
        .work(
            &reply_system_prompt(persona, &notes_block(&notes)),
            history,
            workspace,
            host_tools,
            &on_chunk,
            is_cancelled,
        )
        .await?;
    Ok(TeamOutcome {
        reply,
        steps: notes
            .into_iter()
            .map(|(spec, content)| (spec.id.to_string(), content))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_researcher_is_offered_web_search() {
        let web: Vec<_> = SPECIALISTS
            .iter()
            .chain([&CRITIC])
            .filter(|spec| spec.web)
            .map(|spec| spec.id)
            .collect();
        assert_eq!(web, ["researcher"]);
        assert!(agent_system_prompt(&SPECIALISTS[0], 160, true).contains("web search"));
        assert!(!agent_system_prompt(&SPECIALISTS[0], 160, false).contains("web search"));
    }

    #[test]
    fn reply_prompt_keeps_the_persona_and_labels_each_agent() {
        let notes = notes_block(&[
            (&SPECIALISTS[0], "  fact one  ".into()),
            (&CRITIC, "looks right".into()),
        ]);
        let prompt = reply_system_prompt("You are Aeris.", &notes);
        assert!(prompt.starts_with("You are Aeris."));
        assert!(prompt.contains("## Atlas (research)\nfact one"));
        assert!(prompt.contains("## Argus (review)\nlooks right"));
    }
}
