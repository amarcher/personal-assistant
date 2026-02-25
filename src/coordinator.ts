import { randomUUID } from 'crypto';
import { AgentSession } from './agent-session.js';
import { CoordinatorAgent } from './coordinator-agent.js';
import { ProjectRegistry } from './project-registry.js';
import type {
  AgentInfo,
  ChatMessage,
  CoordinatorStatus,
  EscalatedQuestion,
  MessageAttachment,
  PendingQuestion,
  Project,
  ActivityLogEntry,
  ServerMessage,
  WorkerManager,
} from './types.js';

export class Coordinator implements WorkerManager {
  private agents = new Map<string, AgentSession>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private activityLog: ActivityLogEntry[] = [];
  private broadcast: (message: ServerMessage) => void;
  private projectRegistry = new ProjectRegistry();

  // Phase 2: Coordinator agent
  private coordinatorAgent: CoordinatorAgent | null = null;
  private _coordinatorStatus: CoordinatorStatus = 'idle';
  private chatHistory: ChatMessage[] = [];
  private pendingEscalations = new Map<string, EscalatedQuestion>();

  constructor(broadcast: (message: ServerMessage) => void) {
    this.broadcast = broadcast;
  }

  get coordinatorStatus(): CoordinatorStatus {
    return this._coordinatorStatus;
  }

  // --- WorkerManager interface (used by CoordinatorAgent) ---

  startAgent(projectName: string, projectPath: string, prompt: string): AgentInfo {
    const session = new AgentSession(
      {
        onStatusChange: (agent) => {
          this.broadcast({ type: 'agent_update', agent });
        },
        onQuestion: (question) => {
          this.pendingQuestions.set(question.id, question);

          if (this.coordinatorAgent?.isRunning) {
            // Route to coordinator agent instead of dashboard
            this.broadcast({ type: 'question_added', question });
            const resolver = (answers: Record<string, string>) => {
              session.resolveAnswer(question.id, answers);
            };
            this.coordinatorAgent.notifyWorkerQuestion(question, resolver);
          } else {
            // Phase 1 fallback: direct to dashboard
            this.broadcast({ type: 'question_added', question });
          }
        },
        onQuestionResolved: (questionId) => {
          this.pendingQuestions.delete(questionId);
          this.broadcast({ type: 'question_removed', questionId });
          // Also remove escalation if it was escalated
          if (this.pendingEscalations.has(questionId)) {
            this.pendingEscalations.delete(questionId);
            this.broadcast({ type: 'escalation_removed', questionId });
          }
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
          if (this.activityLog.length > 200) {
            this.activityLog = this.activityLog.slice(-200);
          }
          this.broadcast({ type: 'activity', entry });
        },
      },
      { projectName, projectPath, prompt },
    );

    this.agents.set(session.id, session);

    session.start().catch(() => {
      // errors handled inside start() via onStatusChange
    });

    return session.getInfo();
  }

  stopAgent(agentId: string): boolean {
    const session = this.agents.get(agentId);
    if (!session) return false;

    session.stop();

    // Clean up pending questions for this agent
    for (const [qId, q] of this.pendingQuestions) {
      if (q.agentId === agentId) {
        this.pendingQuestions.delete(qId);
        this.broadcast({ type: 'question_removed', questionId: qId });
      }
    }

    // Clean up escalations for this agent
    for (const [qId, e] of this.pendingEscalations) {
      if (e.agentId === agentId) {
        this.pendingEscalations.delete(qId);
        this.broadcast({ type: 'escalation_removed', questionId: qId });
      }
    }

    return true;
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

  getProjects(): Project[] {
    return this.projectRegistry.getAll();
  }

  // --- Project management ---

  addProject(name: string, projectPath: string, description?: string): Project {
    const project = this.projectRegistry.add(name, projectPath, description);
    this.broadcast({ type: 'projects', projects: this.projectRegistry.getAll() });
    return project;
  }

  removeProject(projectId: string): boolean {
    const removed = this.projectRegistry.remove(projectId);
    if (removed) {
      this.broadcast({ type: 'projects', projects: this.projectRegistry.getAll() });
    }
    return removed;
  }

  // --- Coordinator agent lifecycle ---

  startCoordinator(directive: string, attachments?: MessageAttachment[]): void {
    if (this.coordinatorAgent?.isRunning) {
      // Already running — just send the directive
      this.sendDirective(directive, attachments);
      return;
    }

    this.coordinatorAgent = new CoordinatorAgent(this, {
      onChatMessage: (message) => {
        this.chatHistory.push(message);
        this.broadcast({ type: 'chat_message', message });
      },
      onEscalation: (escalation) => {
        this.pendingEscalations.set(escalation.id, escalation);
        this.broadcast({ type: 'escalation_added', escalation });
      },
      onStatusChange: (status) => {
        this._coordinatorStatus = status;
        this.broadcast({ type: 'coordinator_status', status });
      },
      onActivity: (message) => {
        const entry: ActivityLogEntry = {
          id: randomUUID(),
          agentId: 'coordinator',
          projectName: 'Coordinator',
          message,
          timestamp: Date.now(),
        };
        this.activityLog.push(entry);
        if (this.activityLog.length > 200) {
          this.activityLog = this.activityLog.slice(-200);
        }
        this.broadcast({ type: 'activity', entry });
      },
    }, this.broadcast, () => this.projectRegistry.getAll());

    // Fire and forget — coordinator runs concurrently
    this.coordinatorAgent.start(directive, attachments).catch((err) => {
      console.error('[Coordinator] Coordinator agent failed:', err);
    });
  }

  stopCoordinator(): void {
    this.coordinatorAgent?.stop();
  }

  sendDirective(text: string, attachments?: MessageAttachment[]): void {
    // Add to chat history (store attachment metadata but not the full base64 data for display)
    const humanMsg: ChatMessage = {
      id: randomUUID(),
      role: 'human',
      text,
      timestamp: Date.now(),
      attachments,
    };
    this.chatHistory.push(humanMsg);
    this.broadcast({ type: 'chat_message', message: humanMsg });

    if (this.coordinatorAgent?.isRunning) {
      this.coordinatorAgent.sendDirective(text, attachments);
    } else {
      // Auto-start coordinator on first directive
      this.startCoordinator(text, attachments);
    }
  }

  submitEscalationAnswer(questionId: string, answers: Record<string, string>): boolean {
    const escalation = this.pendingEscalations.get(questionId);
    if (!escalation) return false;

    // Resolve the worker's promise via the coordinator agent
    if (this.coordinatorAgent) {
      const resolved = this.coordinatorAgent.resolveEscalation(questionId, answers);
      if (resolved) {
        this.pendingEscalations.delete(questionId);
        this.broadcast({ type: 'escalation_removed', questionId });
        return true;
      }
    }

    // Fallback: try direct resolution
    return this.submitAnswer(questionId, answers);
  }

  getFullState() {
    const { agents, questions } = this.getState();
    return {
      agents,
      questions,
      coordinatorStatus: this._coordinatorStatus,
      chatHistory: this.chatHistory,
      escalations: Array.from(this.pendingEscalations.values()),
      projects: this.projectRegistry.getAll(),
    };
  }
}
