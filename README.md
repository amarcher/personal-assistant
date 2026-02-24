# Mission Control

Multi-agent coordinator that manages [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) sessions through a real-time dashboard. Give it a high-level directive, and a coordinator agent decomposes the work into tasks, spawns autonomous worker agents, and only escalates to you when decisions genuinely matter.

## How it works

1. You send a directive via the web dashboard
2. A coordinator agent breaks it down and spawns worker agents across your projects
3. Workers run autonomously — when one needs human input, the question surfaces in the dashboard
4. You answer (or the coordinator answers on your behalf) and the agent resumes

All agent output, tool usage, and costs stream to the dashboard in real time over WebSocket.

## Architecture

```
Browser ⟷ WebSocket ⟷ Express Server ⟷ Coordinator ⟷ Agent Sessions (Claude Agent SDK)
```

- **`src/agent-session.ts`** — Wraps a single SDK `query()` call with an async Promise bridge for intercepting agent questions
- **`src/coordinator.ts`** — Manages agents and pending questions, broadcasts state to connected clients
- **`src/coordinator-agent.ts`** — The AI coordinator that decomposes directives and manages workers
- **`src/server.ts`** — Express + WebSocket server
- **`src/types.ts`** — Shared types and the WebSocket message protocol
- **`public/`** — Dashboard UI (vanilla HTML/CSS/JS)

## Setup

```bash
git clone https://github.com/amarcher/personal-assistant.git
cd personal-assistant
npm install
```

Create a `.env` file:

```
ANTHROPIC_API_KEY=your-api-key
PORT=3000
```

## Usage

```bash
# Development (no build step)
npm run dev

# Production
npm run build
npm start
```

Then open `http://localhost:3000` in your browser.

## Tech stack

- **Runtime:** Node.js + TypeScript
- **Agent SDK:** `@anthropic-ai/claude-agent-sdk`
- **Server:** Express + ws
- **UI:** Vanilla HTML/CSS/JS
