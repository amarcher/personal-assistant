import { randomUUID } from 'crypto';
import { AgentSession } from './agent-session.js';
import type { AgentInfo, PendingQuestion, ActivityLogEntry, ServerMessage } from './types.js';

export class Coordinator {
  private agents = new Map<string, AgentSession>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private activityLog: ActivityLogEntry[] = [];
  private broadcast: (message: ServerMessage) => void;

  constructor(broadcast: (message: ServerMessage) => void) {
    this.broadcast = broadcast;
  }

  startAgent(projectName: string, projectPath: string, prompt: string): AgentInfo {
    const session = new AgentSession(
      {
        onStatusChange: (agent) => {
          this.broadcast({ type: 'agent_update', agent });
        },
        onQuestion: (question) => {
          this.pendingQuestions.set(question.id, question);
          this.broadcast({ type: 'question_added', question });
        },
        onQuestionResolved: (questionId) => {
          this.pendingQuestions.delete(questionId);
          this.broadcast({ type: 'question_removed', questionId });
        },
        onActivity: (agentId, name, message) => {
          const entry: ActivityLogEntry = {
            id: randomUUID(),
            agentId,
            projectName: name,
            message,
            timestamp: Date.now(),
          };
          this.activityLog.push(entry);
          // Keep last 200 entries
          if (this.activityLog.length > 200) {
            this.activityLog = this.activityLog.slice(-200);
          }
          this.broadcast({ type: 'activity', entry });
        },
      },
      { projectName, projectPath, prompt },
    );

    this.agents.set(session.id, session);

    // Fire-and-forget — the session runs concurrently on the event loop
    session.start().catch(() => {
      // errors are handled inside start() and broadcast via onStatusChange
    });

    return session.getInfo();
  }

  submitAnswer(questionId: string, answers: Record<string, string>): boolean {
    const question = this.pendingQuestions.get(questionId);
    if (!question) return false;

    const session = this.agents.get(question.agentId);
    if (!session) return false;

    return session.resolveAnswer(questionId, answers);
  }

  getState(): { agents: AgentInfo[]; questions: PendingQuestion[] } {
    const agents = Array.from(this.agents.values()).map((s) => s.getInfo());
    const questions = Array.from(this.pendingQuestions.values());
    return { agents, questions };
  }
}
