//! Long-term memory for a Bot: a short bullet list of durable facts that is
//! carried into every chat with that Bot and revised after each reply.

const MAX_MEMORY_CHARS: usize = 2_500;
const NO_CHANGE: &str = "NO_CHANGE";

pub fn system_prompt(bot_name: &str) -> String {
    format!(
        "You maintain the long-term memory of {bot_name}, one of Rohan's AI teammates. The memory holds only durable things worth knowing in future conversations: Rohan's stable preferences, facts about him and his projects, decisions that were made, and one-line summaries of finished work. It never holds small talk, one-off questions, or anything already recorded.\nYou are given the current memory and the latest exchange. If nothing durable was learned, reply with exactly {NO_CHANGE}. Otherwise reply with the complete updated memory as short bullet points, at most 200 words, merging new facts in and replacing lines that are now out of date. Output only the bullet points."
    )
}

pub fn update_request(current: &str, user: &str, reply: &str) -> String {
    let current = if current.trim().is_empty() {
        "(empty)"
    } else {
        current.trim()
    };
    let reply: String = reply.chars().take(2_000).collect();
    format!("Current memory:\n{current}\n\nLatest exchange:\nRohan: {user}\n\nReply: {reply}")
}

/// Returns the new memory text, or `None` when the model reported no change
/// or returned something that should not replace the stored memory.
pub fn accept_update(output: &str) -> Option<String> {
    let cleaned = output.trim().trim_matches('`').trim();
    if cleaned.is_empty() || cleaned.contains(NO_CHANGE) || cleaned.chars().count() > MAX_MEMORY_CHARS {
        return None;
    }
    Some(cleaned.to_string())
}

/// The section appended to a Bot's system prompt.
pub fn prompt_block(memory: &str) -> String {
    format!(
        "\n\nYour memory from earlier conversations with Rohan is below. Use it when it is relevant and do not recite it. For anything that may have changed, ask or check instead of relying on it.\n<memory>\n{}\n</memory>",
        memory.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_memory_when_nothing_durable_was_learned() {
        assert_eq!(accept_update("NO_CHANGE"), None);
        assert_eq!(accept_update("  NO_CHANGE.\n"), None);
        assert_eq!(accept_update(""), None);
    }

    #[test]
    fn accepts_bullets_and_rejects_runaway_output() {
        assert_eq!(
            accept_update("```\n- Rohan teaches Grade 10 ICT\n```").as_deref(),
            Some("- Rohan teaches Grade 10 ICT")
        );
        assert_eq!(accept_update(&"x".repeat(MAX_MEMORY_CHARS + 1)), None);
    }

    #[test]
    fn update_request_marks_empty_memory_and_trims_long_replies() {
        let request = update_request("  ", "hi", &"a".repeat(5_000));
        assert!(request.contains("Current memory:\n(empty)"));
        assert!(request.len() < 2_200);
    }
}
