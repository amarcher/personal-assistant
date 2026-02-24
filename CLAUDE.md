# Mission Control

Multi-agent coordinator that manages Claude Agent SDK sessions via an intelligent executive assistant. A coordinator agent takes high-level directives, decomposes them into tasks, spawns autonomous worker agents, and only escalates to the human when decisions genuinely matter.

## Tech Stack

- **Runtime:** Node.js + tsx (dev), tsc (build)
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk` — `query()` async generator, `canUseTool` for intercepting `AskUserQuestion`
- **Server:** Express + ws (WebSocket) on same HTTP server
- **UI:** Vanilla HTML/CSS/JS in `public/` (no framework yet)

## Architecture

- `src/agent-session.ts` — Wraps a single `query()` call. The **async Promise bridge**: when an agent calls `AskUserQuestion`, `canUseTool` creates a Promise, stores its resolver, and awaits it. The agent suspends (not the event loop). When the answer arrives via WebSocket, the resolver fires and the agent resumes.
- `src/coordinator.ts` — Manages `Map<id, AgentSession>` and `Map<id, PendingQuestion>`. Broadcasts state changes to WebSocket clients.
- `src/server.ts` — Express serves `public/`, WebSocket handles the real-time protocol between dashboard and coordinator.
- `src/types.ts` — All shared types and the WebSocket message protocol (`ServerMessage` / `ClientMessage`).

## Key Conventions

- `permissionMode: 'default'` with `canUseTool` that auto-allows everything except `AskUserQuestion` (which uses the Promise bridge). This gives agents full autonomy while intercepting questions.
- `env: { ...process.env, CLAUDECODE: undefined }` — required to allow SDK subprocess spawning from within a Claude Code session.
- Agent output (assistant text blocks, tool usage, result text) is captured and streamed to the dashboard in real time.

## Commands

- `npm run dev` — Start dev server with tsx (no build step)
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled output
