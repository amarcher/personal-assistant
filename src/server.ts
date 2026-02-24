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
    const state = coordinator.getState();
    ws.send(JSON.stringify({ type: 'agents', agents: state.agents } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'questions', questions: state.questions } satisfies ServerMessage));

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
        case 'request_state': {
          const s = coordinator.getState();
          ws.send(JSON.stringify({ type: 'agents', agents: s.agents } satisfies ServerMessage));
          ws.send(JSON.stringify({ type: 'questions', questions: s.questions } satisfies ServerMessage));
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
