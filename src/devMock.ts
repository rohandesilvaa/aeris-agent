import { mockIPC } from "@tauri-apps/api/mocks";

// Simulated backend for designing the interface in a plain browser
// (`pnpm dev`, then open the Vite URL). Never loaded inside the Tauri app.

type Sink = { onmessage: (event: Record<string, unknown>) => void };

const NOTES: Record<string, string> = {
  researcher: "- Tauri apps pair a Rust core with a web frontend.\n- Commands cross the bridge as JSON over IPC.\n- **Channels** stream data back without polling.",
  analyst: "- Step 1: the webview calls `invoke`.\n- Step 2: Rust runs the command on its async runtime.\n- Step 3: results return as a promise or a channel event.",
  creative: "- Think of it as a waiter between kitchen and table.\n- Risk: large payloads slow the bridge, so stream them.\n- Tip: keep secrets on the Rust side.",
  critic: "- Most reliable: the invoke and channel flow.\n- Gap: nobody mentioned permissions in `capabilities`.\n- The waiter analogy is fine for a short answer.",
};
const REPLY = "Tauri connects your interface to Rust through a small message bridge.\n\n1. The webview calls `invoke(\"command\")` with JSON arguments.\n2. Rust runs the matching command and returns a result.\n3. For long work, Rust streams events back over a **channel**.\n\n| Direction | Tool |\n|---|---|\n| UI to Rust | `invoke` |\n| Rust to UI | Channel events |\n\nKeep secrets on the Rust side, and list each command in `capabilities`.";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamWords(text: string, send: (chunk: string) => void, delay: number) {
  for (const word of text.split(/(?<=\s)/)) {
    send(word);
    await wait(delay);
  }
}

export function installDevMock() {
  const now = Date.now();
  const bots = [
    { id: "aeris", name: "Aeris", title: "Chief of staff", description: "Keeps the big picture and helps with anything.", instructions: "", memory: "- Rohan teaches Grade 10 ICT in Sinhala medium\n- Prefers short bullet-point answers", memoryEnabled: true, workspaceEnabled: true, createdAt: 0 },
    { id: "bot-guru", name: "Guru", title: "Lesson planner", description: "Plans Grade 10 ICT lessons and notes for Sinhala-medium classes.", instructions: "Write lesson notes as short bullet points.", memory: "", memoryEnabled: true, workspaceEnabled: true, createdAt: 1 },
  ];
  const chats = [
    { id: "chat-1", title: "How Tauri talks to Rust", createdAt: now, updatedAt: now, promptTokens: 1840, completionTokens: 320, botId: "aeris", members: [] as string[] },
    { id: "chat-2", title: "Plan my week around three priorities", createdAt: now - 1, updatedAt: now - 1, promptTokens: 0, completionTokens: 0, botId: "aeris", members: [] as string[] },
    { id: "chat-3", title: "Sinhala ICT lesson ideas", createdAt: now - 2, updatedAt: now - 2, promptTokens: 0, completionTokens: 0, botId: "bot-guru", members: [] as string[] },
  ];
  const messages = [
    { id: "m1", chatId: "chat-1", role: "user", content: "Explain how Tauri talks to Rust", createdAt: now },
    { id: "m2", chatId: "chat-1", role: "assistant", content: REPLY, createdAt: now + 1 },
  ];
  const skills: Array<Record<string, any>> = [
    { id: "skill-1", name: "Lesson notes", description: "Use when Rohan asks for notes for a new lesson.", instructions: "1. Ask for the topic if it is missing.\n2. Write objectives, key points, one activity, three questions.", createdAt: now },
  ];
  const routines: Array<Record<string, any>> = [
    { id: "routine-1", botId: "aeris", title: "Morning plan", prompt: "List today's three most important tasks.", schedule: "weekdays", time: "07:30", weekday: 0, enabled: true, allowWrites: false, chatId: null, lastRun: null, lastStatus: "", nextRun: now + 3_600_000 },
  ];
  const plugins: Array<Record<string, any>> = [
    { id: "plugin-1", name: "notes", kind: "command", target: "npx -y notes-server ~/Notes", secrets: "", access: "ask", createdAt: now },
  ];
  const waiting = new Map<string, (allow: boolean) => void>();
  mockIPC(async (command, payload) => {
    const args = (payload ?? {}) as Record<string, any>;
    switch (command) {
      case "list_chats": return [...chats];
      case "create_chat": { const chat = { ...chats[1], id: `chat-${Math.random()}`, title: "New chat", botId: args.botId ?? "aeris", members: [] }; chats.unshift(chat); return chat; }
      case "create_group": { const chat = { ...chats[1], id: `group-${Math.random()}`, title: args.title, botId: "group", members: args.members as string[] }; chats.unshift(chat); return { ...chat }; }
      case "list_bots": return bots.map((bot) => ({ ...bot }));
      case "create_bot": { const bot = { ...args.input, id: `bot-${Math.random()}`, createdAt: Date.now() }; bots.push(bot); return { ...bot }; }
      case "update_bot": { const bot = bots.find((item) => item.id === args.botId)!; Object.assign(bot, args.botId === "aeris" ? { memory: args.input.memory, memoryEnabled: args.input.memoryEnabled } : args.input); return { ...bot }; }
      case "delete_bot": { bots.splice(bots.findIndex((item) => item.id === args.botId), 1); return null; }
      case "get_chat_messages": return args.chatId === "chat-1" ? messages : [];
      case "get_agent_steps": return args.chatId === "chat-1"
        ? Object.entries(NOTES).map(([agent, content], position) => ({ messageId: "m2", agent, content, position }))
        : [];
      case "workspace_path": return args.configured || "/Users/rohan/Aeris Bot Workspace";
      case "open_workspace": return null;
      case "answer_approval": waiting.get(args.approvalId)?.(args.allow); waiting.delete(args.approvalId); return null;
      case "list_plugins": return plugins.map((plugin) => ({ ...plugin }));
      case "save_plugin": { const plugin = { createdAt: Date.now(), ...args.input, id: args.input.id ?? `plugin-${Math.random()}` }; const at = plugins.findIndex((item) => item.id === plugin.id); if (at >= 0) plugins[at] = plugin; else plugins.push(plugin); return null; }
      case "delete_plugin": plugins.splice(plugins.findIndex((item) => item.id === args.pluginId), 1); return null;
      case "test_plugin": await wait(1200); return { status: "connected", tools: ["list_notes", "add_note"] };
      case "list_skills": return skills.map((skill) => ({ ...skill }));
      case "save_skill": { const skill = { ...args.input, id: args.input.id ?? `skill-${Math.random()}`, createdAt: Date.now() }; const at = skills.findIndex((item) => item.id === skill.id); if (at >= 0) skills[at] = skill; else skills.push(skill); return { ...skill }; }
      case "delete_skill": skills.splice(skills.findIndex((item) => item.id === args.skillId), 1); return null;
      case "draft_skill": await wait(1200); return { name: "Explain a concept", description: "Use when Rohan asks how something works.", instructions: "1. Say what it is in one sentence.\n2. Give three numbered steps.\n3. End with a small table of [the key terms]." };
      case "list_routines": return routines.map((routine) => ({ ...routine }));
      case "save_routine": { const routine = { chatId: null, lastRun: null, lastStatus: "", nextRun: Date.now() + 3_600_000, ...args.input, id: args.input.id ?? `routine-${Math.random()}` }; const at = routines.findIndex((item) => item.id === routine.id); if (at >= 0) routines[at] = routine; else routines.push(routine); return null; }
      case "delete_routine": routines.splice(routines.findIndex((item) => item.id === args.routineId), 1); return null;
      case "run_routine_now": { const routine = routines.find((item) => item.id === args.routineId); if (routine) { routine.lastStatus = "Done"; routine.lastRun = Date.now(); routine.chatId = "chat-2"; } return null; }
      case "sync_settings": return null;
      case "list_voices": return [{ name: "Ava (Premium)", locale: "en_US" }, { name: "Samantha", locale: "en_US" }, { name: "Daniel", locale: "en_GB" }];
      case "speak": await wait(3000); return true;
      case "stop_speaking": return null;
      case "default_persona": return "Your name is Aeris. You are the chief of staff on Rohan's private AI team in the Aeris Bot app.";
      case "check_claude_code": return { installed: true, loggedIn: true, path: "/usr/local/bin/claude", message: "Claude Code ready" };
      case "stream_chat": {
        const { request, onEvent } = args as { request: Record<string, any>; onEvent: Sink };
        const base = { requestId: request.requestId, chatId: request.chatId };
        const emit = (event: Record<string, unknown>) => onEvent.onmessage({ ...base, ...event });
        const thread = chats.find((chat) => chat.id === request.chatId);
        if (thread?.members.length) {
          // Group thread: mentioned teammates answer in order, else the lead.
          const text = String(request.content).toLowerCase();
          const mentioned = thread.members.filter((id) => text.includes(`@${bots.find((bot) => bot.id === id)?.name.toLowerCase()}`));
          const responders = mentioned.length ? mentioned : [thread.members[0]];
          for (const [index, botId] of responders.entries()) {
            const messageId = index === 0 ? request.assistantMessageId : `m-${Math.random()}`;
            emit({ type: "message", messageId, agent: botId });
            await wait(600);
            await streamWords(`Here is my part, as ${bots.find((bot) => bot.id === botId)?.name}: start with what a network is, then LAN and WAN.`, (content) => emit({ type: "chunk", content }), 45);
          }
          emit({ type: "done", title: thread.title });
          return null;
        }
        if (/ask|guru/i.test(String(request.content)) && request.chatId !== "chat-3") {
          await wait(400);
          emit({ type: "handoff", agent: "bot-guru", status: "start", content: "Rohan needs a three-point outline for the first networks lesson." });
          await streamWords("- What a network is\n- LAN and WAN\n- A cable-making activity", (content) => emit({ type: "handoff", agent: "bot-guru", status: "chunk", content }), 60);
          emit({ type: "handoff", agent: "bot-guru", status: "done" });
        }
        if (request.teamMode) {
          const run = async (agent: string) => {
            emit({ type: "agent", agent, status: "start" });
            await streamWords(NOTES[agent], (content) => emit({ type: "agent", agent, status: "chunk", content }), 55);
            emit({ type: "agent", agent, status: "done" });
          };
          await wait(400);
          await Promise.all(["researcher", "analyst", "creative"].map(run));
          await run("critic");
        }
        // A message that mentions a file shows the workspace flow.
        if (/file|save|write/i.test(String(request.content))) {
          await wait(500);
          emit({ type: "tool", tool: "Glob", content: "Looked for files matching notes/*.md" });
          await wait(500);
          const approvalId = `approval-${Math.random()}`;
          emit({ type: "approval", approvalId, tool: "Write", content: "Write the file notes/networks.md", message: "# Networks\n\n- LAN: one building\n- WAN: many places" });
          const allowed = await new Promise<boolean>((resolve) => waiting.set(approvalId, resolve));
          emit({ type: "tool", tool: "Write", content: allowed ? "Wrote notes/networks.md" : "Not allowed: Wrote notes/networks.md" });
        }
        await wait(500);
        await streamWords(REPLY, (content) => emit({ type: "chunk", content }), 45);
        emit({ type: "usage", promptTokens: 2100, completionTokens: 180, tokensPerSecond: 42.5 });
        emit({ type: "done", title: String(request.content).slice(0, 42) });
        return null;
      }
      default: return null;
    }
  });
}
