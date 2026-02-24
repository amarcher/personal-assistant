import { randomUUID } from 'crypto';
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentInfo, AgentStatus, PendingQuestion, QuestionItem, ToolUseEntry } from './types.js';

export interface AgentSessionEvents {
  onStatusChange: (agent: AgentInfo) => void;
  onQuestion: (question: PendingQuestion) => void;
  onQuestionResolved: (questionId: string) => void;
  onActivity: (agentId: string, projectName: string, message: string) => void;
}

export class AgentSession {
  readonly id: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly prompt: string;
  readonly createdAt: number;

  private status: AgentStatus = 'starting';
  private sessionId: string | null = null;
  private totalCostUsd = 0;
  private numTurns = 0;
  private error?: string;
  private resultText?: string;
  private output: string[] = [];
  private toolUses: ToolUseEntry[] = [];
  private queryInstance: Query | null = null;

  // Promise bridge: questionId → resolve function
  private pendingResolvers = new Map<string, (answers: Record<string, string>) => void>();

  constructor(
    private readonly events: AgentSessionEvents,
    config: { projectName: string; projectPath: string; prompt: string },
  ) {
    this.id = randomUUID();
    this.projectName = config.projectName;
    this.projectPath = config.projectPath;
    this.prompt = config.prompt;
    this.createdAt = Date.now();
  }

  getInfo(): AgentInfo {
    return {
      id: this.id,
      projectName: this.projectName,
      projectPath: this.projectPath,
      prompt: this.prompt,
      status: this.status,
      sessionId: this.sessionId,
      totalCostUsd: this.totalCostUsd,
      numTurns: this.numTurns,
      createdAt: this.createdAt,
      error: this.error,
      output: this.output,
      toolUses: this.toolUses,
      resultText: this.resultText,
    };
  }

  resolveAnswer(questionId: string, answers: Record<string, string>): boolean {
    const resolver = this.pendingResolvers.get(questionId);
    if (!resolver) return false;
    this.pendingResolvers.delete(questionId);
    resolver(answers);
    return true;
  }

  async start(): Promise<void> {
    this.setStatus('working');
    this.events.onActivity(this.id, this.projectName, `Agent started: "${this.prompt}"`);

    try {
      this.queryInstance = query({
        prompt: this.prompt,
        options: {
          cwd: this.projectPath,
          env: { ...process.env, CLAUDECODE: undefined },
          permissionMode: 'default',
          allowedTools: [
            'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
            'WebSearch', 'WebFetch', 'AskUserQuestion',
          ],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: `\n\nYou are working on the project "${this.projectName}" at ${this.projectPath}.\nWhen you need clarification or have questions for the user, use the AskUserQuestion tool.\nDo not guess — ask when uncertain.`,
          },
          stderr: (data: string) => {
            console.error(`[${this.projectName}] stderr:`, data.trim());
          },
          canUseTool: async (toolName, input) => {
            if (toolName === 'AskUserQuestion') {
              return this.handleAskUserQuestion(input);
            }
            return { behavior: 'allow' as const, updatedInput: input };
          },
        },
      });

      for await (const message of this.queryInstance) {
        this.handleMessage(message);
      }

      // Query completed successfully
      this.setStatus('completed');
      this.events.onActivity(this.id, this.projectName, `Agent completed. Cost: $${this.totalCostUsd.toFixed(4)}`);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus('errored');
      this.events.onActivity(this.id, this.projectName, `Agent errored: ${this.error}`);
    }
  }

  private async handleAskUserQuestion(input: Record<string, unknown>): Promise<{
    behavior: 'allow';
    updatedInput: Record<string, unknown>;
  }> {
    const questionId = randomUUID();
    const questions = input.questions as QuestionItem[];

    const pendingQuestion: PendingQuestion = {
      id: questionId,
      agentId: this.id,
      projectName: this.projectName,
      questions,
      createdAt: Date.now(),
    };

    this.setStatus('waiting_for_input');
    this.events.onQuestion(pendingQuestion);
    this.events.onActivity(this.id, this.projectName, `Waiting for input: "${questions[0]?.question ?? 'unknown'}"`);

    // Create the Promise bridge — this suspends the agent until the user answers
    const answers = await new Promise<Record<string, string>>((resolve) => {
      this.pendingResolvers.set(questionId, resolve);
    });

    this.events.onQuestionResolved(questionId);
    this.setStatus('working');
    this.events.onActivity(this.id, this.projectName, 'User answered — resuming work');

    return {
      behavior: 'allow' as const,
      updatedInput: { ...input, answers },
    };
  }

  private handleMessage(message: SDKMessage): void {
    if (message.type === 'system' && 'session_id' in message) {
      this.sessionId = message.session_id;
      this.broadcastUpdate();
    }

    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ('text' in block && typeof block.text === 'string' && block.text.trim()) {
            this.output.push(block.text);
            this.broadcastUpdate();
          }
          if ('name' in block && typeof block.name === 'string') {
            const input = 'input' in block ? (block.input as Record<string, unknown>) : {};
            const summary = this.summarizeToolUse(block.name, input);
            this.toolUses.push({ tool: block.name, summary, timestamp: Date.now() });
            this.broadcastUpdate();
          }
        }
      }
    }

    if (message.type === 'result') {
      this.totalCostUsd = message.total_cost_usd;
      this.numTurns = message.num_turns;
      if (message.subtype === 'success' && 'result' in message) {
        this.resultText = message.result as string;
      } else {
        const errors = 'errors' in message ? (message.errors as string[]) : [];
        this.error = errors.join('; ') || `Ended with: ${message.subtype}`;
      }
      this.broadcastUpdate();
    }
  }

  private summarizeToolUse(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case 'Bash': return String(input.command ?? '').slice(0, 120);
      case 'Read': return String(input.file_path ?? '');
      case 'Write': return String(input.file_path ?? '');
      case 'Edit': return String(input.file_path ?? '');
      case 'Glob': return String(input.pattern ?? '');
      case 'Grep': return String(input.pattern ?? '');
      default: return '';
    }
  }

  private setStatus(status: AgentStatus): void {
    this.status = status;
    this.broadcastUpdate();
  }

  private broadcastUpdate(): void {
    this.events.onStatusChange(this.getInfo());
  }
}
