import { createServer } from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Coordinator } from './coordinator.js';
import type { ClientMessage, ServerMessage } from './types.js';

export function startServer(port: number): void {
  const app = express();
  const httpServer = createServer(app);

  // Serve static files from public/
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Track all connected WebSocket clients
  const clients = new Set<WebSocket>();

  function broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  const coordinator = new Coordinator(broadcast);

  // WebSocket server attached to the same HTTP server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send full state snapshot on connect
    const state = coordinator.getFullState();
    ws.send(JSON.stringify({ type: 'agents', agents: state.agents } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'questions', questions: state.questions } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'coordinator_status', status: state.coordinatorStatus } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'chat_history', messages: state.chatHistory } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'escalations', escalations: state.escalations } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'projects', projects: state.projects } satisfies ServerMessage));

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'start_agent': {
          coordinator.startAgent(msg.projectName, msg.projectPath, msg.prompt);
          break;
        }
        case 'answer': {
          coordinator.submitAnswer(msg.questionId, msg.answers);
          break;
        }
        case 'directive': {
          coordinator.sendDirective(msg.text, msg.attachments);
          break;
        }
        case 'answer_escalation': {
          coordinator.submitEscalationAnswer(msg.questionId, msg.answers);
          break;
        }
        case 'add_project': {
          coordinator.addProject(msg.name, msg.path, msg.description);
          break;
        }
        case 'remove_project': {
          coordinator.removeProject(msg.projectId);
          break;
        }
        case 'stop_agent': {
          coordinator.stopAgent(msg.agentId);
          break;
        }
        case 'stop_coordinator': {
          coordinator.stopCoordinator();
          break;
        }
        case 'request_state': {
          const s = coordinator.getFullState();
          ws.send(JSON.stringify({ type: 'agents', agents: s.agents } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'questions', questions: s.questions } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'coordinator_status', status: s.coordinatorStatus } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'chat_history', messages: s.chatHistory } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'escalations', escalations: s.escalations } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'projects', projects: s.projects } satisfies ServerMessage));
          break;
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  httpServer.listen(port, () => {
    console.log(`Mission Control running at http://localhost:${port}`);
  });
}
