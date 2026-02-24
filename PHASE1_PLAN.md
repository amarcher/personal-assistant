# Phase 1: Multi-Agent Coordinator — Implementation Plan

## Context

We're building the core loop of "Mission Control" — a coordinator service that manages multiple Claude Agent SDK sessions, intercepts their questions for user input, queues them in a flow-friendly way, and presents them via a minimal web dashboard. This is Phase 1: prove the concept with a working end-to-end loop.

## Core Mechanism: The Async Promise Bridge

The Agent SDK's `canUseTool` callback is async. When an agent calls `AskUserQuestion`:

1. `canUseTool` fires → we create a `Promise` and store its `resolve` in a `Map<questionId, resolver>`
2. The question is broadcast to the web UI via WebSocket
3. `canUseTool` **awaits** the Promise — the agent suspends (but not the event loop)
4. User answers in the web UI → WebSocket message → server calls `resolve(answers)`
5. The Promise resolves → `canUseTool` returns `{ behavior: 'allow', updatedInput: { questions, answers } }`
6. The agent continues working with the provided answer

Multiple agents work concurrently because each `query()` is an independent async generator on the event loop.

## Tech Stack

- **Runtime:** Node.js + tsx (no build step in dev)
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk`
- **Server:** Express + ws (WebSocket)
- **UI:** Vanilla HTML/CSS/JS (no framework for Phase 1)
- **Config:** dotenv for `ANTHROPIC_API_KEY`

## Files to Create

### Config files
1. **`package.json`** — type: module, scripts: `dev` (tsx), `build` (tsc), `start` (node)
2. **`tsconfig.json`** — target ES2022, module NodeNext
3. **`.env`** — ANTHROPIC_API_KEY, PORT=3000
4. **`.gitignore`** — node_modules, dist, .env

### Source files (in dependency order)
5. **`src/types.ts`** — All shared types: AgentStatus, PendingQuestion, AgentInfo, ActivityLogEntry, WebSocket message protocol (ServerMessage / ClientMessage)
6. **`src/agent-session.ts`** — Wraps a single `query()` call. Implements the `canUseTool` Promise bridge. Manages status lifecycle (starting → working → waiting_for_input → working → completed/errored). Exposes `resolveAnswer(questionId, answers)`.
7. **`src/coordinator.ts`** — Manages `Map<id, AgentSession>` and `Map<id, PendingQuestion>`. Methods: `startAgent()`, `submitAnswer()`, `getState()`. Fire-and-forgets `session.start()`. Broadcasts events to WebSocket clients via a callback.
8. **`src/server.ts`** — Express serves `public/` as static. WebSocket server on same HTTP server. Parses ClientMessage, dispatches to coordinator. Sends full state snapshot on new connections.
9. **`src/index.ts`** — Entry point. Loads dotenv, validates API key, starts server.

### Web UI
10. **`public/index.html`** — Three-panel layout: agents sidebar, questions center, activity feed bottom
11. **`public/style.css`** — Dark theme, CSS grid layout, status dot colors (green=working, yellow=waiting, blue=completed, red=errored)
12. **`public/app.js`** — WebSocket client with auto-reconnect. Local state arrays. Renders agents, questions (grouped by project), activity log. Form handlers for starting agents and submitting answers.

## Key Types

```typescript
type AgentStatus = 'starting' | 'working' | 'waiting_for_input' | 'completed' | 'errored';

interface PendingQuestion {
  id: string; agentId: string; projectName: string;
  questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>;
  createdAt: number;
}

interface AgentInfo {
  id: string; projectName: string; projectPath: string; prompt: string;
  status: AgentStatus; sessionId: string | null; totalCostUsd: number;
  numTurns: number; createdAt: number; error?: string;
}

// WebSocket protocol
type ServerMessage =
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'questions'; questions: PendingQuestion[] }
  | { type: 'activity'; entry: ActivityLogEntry }
  | { type: 'agent_update'; agent: AgentInfo }
  | { type: 'question_added'; question: PendingQuestion }
  | { type: 'question_removed'; questionId: string };

type ClientMessage =
  | { type: 'answer'; questionId: string; answers: Record<string, string> }
  | { type: 'start_agent'; projectName: string; projectPath: string; prompt: string }
  | { type: 'request_state' };
```

## Agent SDK Configuration

Each agent session uses:
- `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` (agents run autonomously)
- `allowedTools`: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion
- `cwd`: the project path provided by the user
- `systemPrompt`: preset claude_code + append with project name and instruction to use AskUserQuestion for clarifications
- `canUseTool`: the async Promise bridge for AskUserQuestion, auto-allow for everything else

## Implementation Order

1. Config files (package.json, tsconfig, .env, .gitignore)
2. `npm install`
3. `src/types.ts`
4. `src/agent-session.ts`
5. `src/coordinator.ts`
6. `src/server.ts`
7. `src/index.ts`
8. `public/index.html` + `public/style.css` + `public/app.js`
9. End-to-end test

## Verification

1. `npm run dev` → "Mission Control running at http://localhost:3000"
2. Open browser → dashboard renders with empty state
3. Start an agent: project name "test", path to a temp dir, prompt "Create a hello world script and ask me what language to use"
4. Agent appears with green "working" status
5. Within ~30s, a question card appears; agent status turns yellow "waiting"
6. Select an answer, click Submit
7. Question disappears, agent resumes (green), eventually completes (blue)
8. Activity feed shows the full lifecycle
9. Repeat with 2 agents on different projects to verify concurrency
