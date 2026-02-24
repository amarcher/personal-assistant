# Multi-Agent Mission Control — Architecture Plan

## The Core Idea

A **web-based dashboard** (the "mission control") backed by a **coordinator service** that manages multiple Claude Agent SDK sessions. The coordinator queues their requests for your input, groups them by project context to keep you in flow, and communicates via both visual artifacts and voice.

## System Components

```
┌─────────────────────────────────────────────────────┐
│                   Mission Control UI                 │
│  (Next.js app — task cards, artifacts, voice I/O)   │
└──────────────┬──────────────────────┬───────────────┘
               │ WebSocket            │ Audio stream
               ▼                      ▼
┌──────────────────────────┐  ┌──────────────────────┐
│    Coordinator Service   │  │   Voice Gateway      │
│  (Node.js / Agent SDK)   │  │  (Deepgram STT +     │
│                          │◄─┤   ElevenLabs TTS)    │
│  - Flow queue manager    │  └──────────────────────┘
│  - Context grouping      │
│  - Input routing         │
│  - Session persistence   │
└──────┬───┬───┬───────────┘
       │   │   │
       ▼   ▼   ▼
    ┌────┐┌────┐┌────┐
    │ A1 ││ A2 ││ A3 │  ← Claude Agent SDK sessions
    │    ││    ││    │    (each in its own git worktree,
    │    ││    ││    │     working on a specific project)
    └────┘└────┘└────┘
```

---

## 1. Coordinator Service (the brain)

**Tech:** Node.js + `@anthropic-ai/claude-agent-sdk`

This is the single "orchestrator agent." Its responsibilities:

- **Spawn & manage sub-agents** via the Agent SDK's `query()` function, each with their own session ID for persistence
- **Intercept `AskUserQuestion` calls** from sub-agents via hooks (`PreToolUse` on `AskUserQuestion`) — instead of blocking, these get queued
- **Flow queue** — a priority queue that groups pending questions by project. When you're answering questions about `tabbit`, it surfaces all tabbit questions together before switching context to `superbowl-squares`
- **Context enrichment** — before surfacing a question to you, the coordinator can attach artifacts: screenshots, diffs, file snippets, or rendered component previews

### Key Data Model

```typescript
interface PendingInput {
  id: string;
  agentSessionId: string;
  project: string;           // e.g., "tabbit-rabbit-reboot"
  question: string;          // from sub-agent's AskUserQuestion
  options?: Option[];        // if the sub-agent provided choices
  artifacts: Artifact[];     // screenshots, diffs, previews
  priority: number;          // urgency / age-based
  createdAt: Date;
}

interface Artifact {
  type: 'screenshot' | 'diff' | 'code' | 'preview-url' | 'image';
  content: string;           // inline content or URL
  label: string;
}
```

---

## 2. Mission Control UI (the dashboard)

**Tech:** Next.js, WebSocket for real-time updates

### Key Views

- **Flow Queue** — Cards grouped by project, showing pending questions with visual artifacts inline. You answer in order; the UI keeps you in one project context until its queue drains before switching.
- **Agent Status Board** — Live view of what each sub-agent is working on, its progress (via task lists), and whether it's blocked waiting for you.
- **Artifact Viewer** — Side panel that renders diffs, screenshots, component previews, or whatever context the sub-agent attached.
- **Voice Mode Toggle** — Switch between text and voice interaction per-question or globally.

---

## 3. Voice Gateway

**Tech:** Deepgram Nova-3 (STT) + ElevenLabs Flash v2.5 (TTS)

Two modes of operation:

### Coordinator Voice
The coordinator itself summarizes sub-agent questions and speaks them to you. *"Hey, the agent working on tabbit needs to know whether you want OAuth or magic links for the new auth flow. It's built out the routes for both — want to see the diff?"* Your verbal response gets transcribed and the coordinator translates it into a structured answer for the sub-agent.

### Agent Voice
A sub-agent's question is synthesized directly (optionally with a different voice per project/agent for quick recognition). Your response goes back through the coordinator for interpretation.

### Interpreter Layer
The coordinator acts as an **interpreter** — it hears your casual verbal answer (*"yeah just do magic links, keep it simple"*) and converts it to an actionable directive the sub-agent can consume.

---

## 4. Sub-Agent Isolation

Each sub-agent runs in a **git worktree** for its project, with:

- Its own `CLAUDE.md` context
- Its own MCP servers (e.g., Supabase for tabbit)
- Session persistence so it can be paused/resumed
- Tools scoped to what it needs (a design agent gets browser tools, a coding agent gets Edit/Bash/Grep)

---

## Build Phases

| Phase | What | Scope |
|-------|------|-------|
| **1. Core loop** | Coordinator service + Agent SDK, spawn agents, intercept questions, simple CLI queue | Small — prove the concept with terminal-only I/O |
| **2. Dashboard** | Next.js UI with WebSocket, flow queue view, artifact rendering | Medium — the main UX work |
| **3. Voice** | Deepgram + ElevenLabs integration, coordinator-as-interpreter | Medium — mostly API plumbing + prompt engineering for interpretation |
| **4. Polish** | Per-project voice personas, smart priority/urgency detection, notification system for when you're away | Ongoing refinement |

---

## Key Design Decisions

1. **Agent SDK vs. Agent Teams?** Agent SDK gives full programmatic control (recommended for this use case). Agent Teams is higher-level but less customizable — better for ad-hoc collaboration than a structured product.

2. **Where does the coordinator run?** Locally (simplest, your machine is the server) vs. cloud (could run headless agents 24/7). Recommendation: start local.

3. **How do you initiate tasks?** Options: voice command (*"start a new agent on tabbit to refactor the auth flow"*), dashboard UI button, or a CLI command that the coordinator picks up.

4. **Artifact generation** — Sub-agents could use browser MCP tools to take screenshots of their work, or a preview server that hot-reloads their changes. The latter is more powerful but more complex.

---

## Technology & Ecosystem Context

### Claude Agent SDK

- **Languages:** Python (`pip install claude-agent-sdk`) and TypeScript (`npm install @anthropic-ai/claude-agent-sdk`)
- **Core API:** `query()` returns an async iterator of messages; supports subagent orchestration via the `Task` tool
- **Built-in tools:** Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion
- **Hooks system:** `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd` — critical for intercepting sub-agent questions
- **Session persistence:** Capture `session_id` from init, resume later with `ClaudeAgentOptions(resume=session_id)`
- **MCP integration:** Connect any MCP server to agents for tool extensibility

### Voice Stack Comparison

#### STT Options

| Provider | Model | Latency | Cost |
|----------|-------|---------|------|
| Deepgram | Nova-3 | Very low | $0.0077/min |
| OpenAI | gpt-4o-transcribe | Low | ~$0.006/min |
| ElevenLabs | Scribe v2 | ~150ms | Included in plans |
| Web Speech API | Browser-native | Varies | Free |

#### TTS Options

| Provider | Model | TTFB | Cost |
|----------|-------|------|------|
| ElevenLabs | Flash v2.5 | ~75ms | $0.08–0.30/1K chars |
| Deepgram | Aura-2 | ~90ms | $0.015/1K chars |
| OpenAI | tts-1 | ~200ms | $0.015/1K chars |
| Web Speech API | Browser-native | Varies | Free |

### Relevant Open-Source References

- **[claude-flow](https://github.com/ruvnet/claude-flow)** — Enterprise-grade orchestration with 60+ agents, swarm coordination topologies, vector memory
- **[ccswarm](https://github.com/nwiizo/ccswarm)** — Multi-agent system using Claude Code with git worktree isolation
- **[agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)** (Composio) — Agent-agnostic orchestrator for parallel coding agents
- **[Claude Agent SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)** — Official example agents from Anthropic

### Protocol Landscape

| Protocol | Purpose | Maintained By |
|----------|---------|---------------|
| **MCP** | Agent-to-tool | Anthropic / Linux Foundation |
| **A2A** | Agent-to-agent | Google / Linux Foundation |
| **ACP** | Agent-to-agent | IBM BeeAI / Linux Foundation |

MCP is the right choice for tool integration. For inter-agent communication in this system, the Agent SDK's built-in subagent messaging is sufficient — no need for A2A/ACP unless integrating non-Claude agents later.
