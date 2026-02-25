import { randomUUID } from 'crypto';
import { query, createSdkMcpServer, tool, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { AsyncPushQueue } from './async-push-queue.js';
import type {
  Artifact,
  ChatMessage,
  EscalatedQuestion,
  MessageAttachment,
  PendingQuestion,
  Project,
  ServerMessage,
  WorkerManager,
} from './types.js';

const COORDINATOR_SYSTEM_PROMPT = `You are the Executive Coordinator for Mission Control — a multi-agent orchestration system. You take high-level directives from the human operator, decompose them into tasks, spawn worker agents, and manage their execution.

## Your Role

You are an autonomous project manager. When the human gives a directive, you:
1. Break it down into concrete worker tasks
2. Spawn workers with specific, detailed prompts using start_worker
3. Monitor their progress with get_worker_status
4. Answer routine questions from workers yourself
5. Only escalate to the human when the decision genuinely matters

IMPORTANT: You do NOT have direct access to files, code, or the terminal. You can ONLY act through your MCP tools (start_worker, list_projects, etc.). To get any coding work done, you MUST spawn a worker.

## Decision Framework

**Answer yourself** (use answer_worker_question):
- Obvious technical choices (naming conventions, file structure)
- Standard confirmations ("should I proceed?", "is this correct?")
- Routine decisions with clear best practices
- Questions where the worker just needs a nudge forward

**Escalate to human** (use escalate_to_human):
- Architectural decisions that affect the whole system
- Business logic choices where you don't know the user's preference
- Production/deployment/money concerns
- Genuine ambiguity where either choice could be wrong
- Security-sensitive decisions

## Communication

- Use send_message_to_human to proactively update the human on progress
- When a worker completes, fetch its output with get_worker_status and summarize results
- Surface interesting artifacts (plans, code, diffs) using the artifacts parameter
- Keep the human informed without overwhelming them — summarize, don't dump
- Be concise and direct in your messages

## Worker Prompts

When spawning workers, give them specific, actionable prompts that include:
- The exact task to accomplish
- The project path to work in
- Any relevant context or constraints
- What to do if they encounter ambiguity (ask via AskUserQuestion)`;

export interface CoordinatorAgentEvents {
  onChatMessage: (message: ChatMessage) => void;
  onEscalation: (escalation: EscalatedQuestion) => void;
  onStatusChange: (status: 'idle' | 'running' | 'stopped') => void;
  onActivity: (message: string) => void;
}

export class CoordinatorAgent {
  private queryInstance: Query | null = null;
  private inputQueue = new AsyncPushQueue<SDKUserMessage>();
  private sessionId = '';
  private pendingWorkerResolvers = new Map<string, (answers: Record<string, string>) => void>();
  private running = false;

  constructor(
    private readonly workerManager: WorkerManager,
    private readonly events: CoordinatorAgentEvents,
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly getProjects: () => Project[],
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  private buildSystemPrompt(): string {
    const projects = this.getProjects();
    let prompt = COORDINATOR_SYSTEM_PROMPT;

    if (projects.length > 0) {
      prompt += '\n\n## Registered Projects\n\n';
      prompt += 'Use list_projects to get current project details. Quick reference:\n';
      for (const p of projects) {
        prompt += `- **${p.name}** — \`${p.path}\`${p.description ? ` — ${p.description}` : ''}\n`;
      }
      prompt += '\nWhen the human references a registered project, use its known path with start_worker. Use projectId for convenience.';
    } else {
      prompt += '\n\n## Projects\n\nNo projects are registered yet. When spawning workers, you\'ll need the human to provide project paths, or use list_projects to check if any have been added.';
    }

    return prompt;
  }

  async start(initialDirective: string, attachments?: MessageAttachment[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.events.onStatusChange('running');

    const mcpServer = this.createMcpServer();

    // Build the initial prompt — string for text-only, or pre-build the first message with image blocks
    let prompt: string | AsyncIterable<SDKUserMessage> = initialDirective;

    if (attachments && attachments.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (initialDirective) {
        blocks.push({ type: 'text', text: initialDirective });
      }
      for (const att of attachments) {
        if (att.type === 'image') {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.data },
          });
        }
      }
      // Wrap in an async iterable that yields one message then waits for more via streamInput
      const firstMsg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: blocks as unknown as string },
        parent_tool_use_id: null,
        session_id: '',
      };
      async function* initialPrompt() { yield firstMsg; }
      prompt = initialPrompt();
    }

    try {
      this.queryInstance = query({
        prompt,
        options: {
          model: 'claude-sonnet-4-6',
          cwd: process.cwd(),
          env: { ...process.env, CLAUDECODE: undefined, ANTHROPIC_API_KEY: undefined },
          permissionMode: 'default',
          tools: [],
          allowedTools: [],
          systemPrompt: this.buildSystemPrompt(),
          mcpServers: { 'coordinator-tools': mcpServer },
          canUseTool: async (_toolName, input) => {
            return { behavior: 'allow' as const, updatedInput: input };
          },
        },
      });

      // Set up streaming input for subsequent messages
      this.queryInstance.streamInput(this.inputQueue).catch(() => {
        // Stream ended or query closed — expected
      });

      for await (const message of this.queryInstance) {
        this.handleMessage(message);
      }
    } catch (err) {
      console.error('[Coordinator Agent] Error:', err);
    } finally {
      this.running = false;
      this.events.onStatusChange('stopped');
    }
  }

  stop(): void {
    this.inputQueue.end();
    this.queryInstance?.close();
    this.queryInstance = null;
  }

  sendDirective(text: string, attachments?: MessageAttachment[]): void {
    if (!this.running || !this.sessionId) return;
    this.pushUserMessage(text, attachments);
  }

  notifyWorkerQuestion(
    question: PendingQuestion,
    resolver: (answers: Record<string, string>) => void,
  ): void {
    this.pendingWorkerResolvers.set(question.id, resolver);

    const questionsText = question.questions
      .map((q) => {
        const opts = q.options.map((o) => `  - ${o.label}: ${o.description}`).join('\n');
        return `${q.question}\nOptions:\n${opts}`;
      })
      .join('\n\n');

    this.pushUserMessage(
      `[WORKER QUESTION] Worker "${question.projectName}" (agent ${question.agentId}) is asking:\n\n${questionsText}\n\nQuestion ID: ${question.id}\n\nYou can answer this yourself with answer_worker_question, or escalate it to the human with escalate_to_human.`,
    );
  }

  resolveEscalation(questionId: string, answers: Record<string, string>): boolean {
    // Human answered an escalated question — feed the answer back into the worker
    const resolver = this.pendingWorkerResolvers.get(questionId);
    if (!resolver) return false;
    this.pendingWorkerResolvers.delete(questionId);
    resolver(answers);

    // Also notify the coordinator that the escalation was answered
    this.pushUserMessage(
      `[ESCALATION RESOLVED] The human answered the escalated question ${questionId}. Answers: ${JSON.stringify(answers)}`,
    );
    return true;
  }

  private pushUserMessage(text: string, attachments?: MessageAttachment[]): void {
    let content: string | Array<Record<string, unknown>> = text;

    if (attachments && attachments.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (text) {
        blocks.push({ type: 'text', text });
      }
      for (const att of attachments) {
        if (att.type === 'image') {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mediaType,
              data: att.data,
            },
          });
        }
      }
      content = blocks;
    }

    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: content as string },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    };
    this.inputQueue.push(msg);
  }

  private handleMessage(message: SDKMessage): void {
    // Capture session ID
    if (message.type === 'system' && 'session_id' in message) {
      this.sessionId = message.session_id;
      this.events.onActivity('Coordinator session started');
    }

    // Capture assistant text and tool calls
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ('text' in block && typeof block.text === 'string' && block.text.trim()) {
            const chatMsg: ChatMessage = {
              id: randomUUID(),
              role: 'coordinator',
              text: block.text,
              timestamp: Date.now(),
            };
            this.events.onChatMessage(chatMsg);
          }
          // Surface tool calls as activity
          if ('name' in block && typeof block.name === 'string') {
            const input = 'input' in block ? (block.input as Record<string, unknown>) : {};
            const summary = this.summarizeToolCall(block.name, input);
            this.events.onActivity(summary);
          }
        }
      }
    }

    if (message.type === 'result') {
      const subtype = 'subtype' in message ? message.subtype : 'unknown';
      this.events.onActivity(`Coordinator finished (${subtype})`);
    }
  }

  private summarizeToolCall(name: string, input: Record<string, unknown>): string {
    // Strip MCP server prefix if present
    const toolName = name.replace(/^mcp__coordinator-tools__/, '');
    switch (toolName) {
      case 'start_worker': {
        const proj = input.projectName || input.projectId || 'worker';
        const promptSnippet = typeof input.prompt === 'string' ? input.prompt.slice(0, 80) : '';
        return `Starting worker "${proj}": ${promptSnippet}${promptSnippet.length >= 80 ? '...' : ''}`;
      }
      case 'answer_worker_question':
        return `Answering worker question ${String(input.questionId).slice(0, 8)}...`;
      case 'escalate_to_human':
        return `Escalating to human: ${input.reason}`;
      case 'get_worker_status':
        return input.agentId ? `Checking worker ${String(input.agentId).slice(0, 8)}...` : 'Checking all workers';
      case 'send_message_to_human': {
        const preview = typeof input.text === 'string' ? input.text.slice(0, 60) : '';
        return `Message to human: ${preview}${preview.length >= 60 ? '...' : ''}`;
      }
      case 'list_projects':
        return 'Listing registered projects';
      default:
        return `Tool: ${toolName}`;
    }
  }

  private createMcpServer() {
    return createSdkMcpServer({
      name: 'coordinator-tools',
      version: '1.0.0',
      tools: [
        tool(
          'start_worker',
          'Spawn a new worker agent to handle a specific task. Either provide a projectId (from a registered project) OR a projectName + projectPath pair.',
          {
            projectId: z.string().optional().describe('ID of a registered project (from list_projects). If provided, projectName and projectPath are auto-filled.'),
            projectName: z.string().optional().describe('Short name for the worker (required if no projectId)'),
            projectPath: z.string().optional().describe('Absolute filesystem path the worker should operate in (required if no projectId)'),
            prompt: z.string().describe('Detailed task prompt for the worker'),
          },
          async (args) => {
            let name = args.projectName;
            let workerPath = args.projectPath;

            if (args.projectId) {
              const projects = this.getProjects();
              const project = projects.find((p) => p.id === args.projectId);
              if (!project) {
                return { content: [{ type: 'text', text: `Error: No registered project with ID ${args.projectId}. Use list_projects to see available projects.` }] };
              }
              name = name || project.name;
              workerPath = workerPath || project.path;
            }

            if (!name || !workerPath) {
              return { content: [{ type: 'text', text: 'Error: Must provide either projectId or both projectName and projectPath.' }] };
            }

            const agent = this.workerManager.startAgent(name, workerPath, args.prompt);
            return {
              content: [{ type: 'text', text: `Worker started: ${agent.projectName} (ID: ${agent.id}). Path: ${workerPath}. Status: ${agent.status}` }],
            };
          },
        ),

        tool(
          'list_projects',
          'List all registered projects with their IDs, names, paths, and descriptions.',
          {},
          async () => {
            const projects = this.getProjects();
            if (projects.length === 0) {
              return { content: [{ type: 'text', text: 'No projects registered. The human can add projects through the dashboard.' }] };
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
            };
          },
        ),

        tool(
          'answer_worker_question',
          'Answer a pending question from a worker agent. Use this for routine decisions you can handle yourself.',
          {
            questionId: z.string().describe('The question ID from the worker question notification'),
            answers: z.record(z.string(), z.string()).describe('Map of question text to answer text'),
          },
          async (args) => {
            const resolver = this.pendingWorkerResolvers.get(args.questionId);
            if (!resolver) {
              return { content: [{ type: 'text', text: `Error: No pending question with ID ${args.questionId}` }] };
            }
            this.pendingWorkerResolvers.delete(args.questionId);
            resolver(args.answers);
            return {
              content: [{ type: 'text', text: `Answered question ${args.questionId} successfully. Worker will resume.` }],
            };
          },
        ),

        tool(
          'escalate_to_human',
          'Escalate a worker question to the human operator. Use this when the decision requires human judgment — architectural choices, business logic, security concerns, or genuine ambiguity.',
          {
            questionId: z.string().describe('The question ID to escalate'),
            reason: z.string().describe('Why you are escalating this to the human (be specific)'),
          },
          async (args) => {
            // Find the original question from coordinator state
            const state = this.workerManager.getState();
            const question = state.questions.find((q) => q.id === args.questionId);
            if (!question) {
              return { content: [{ type: 'text', text: `Error: No pending question with ID ${args.questionId}` }] };
            }

            const escalation: EscalatedQuestion = {
              ...question,
              coordinatorReason: args.reason,
            };
            this.events.onEscalation(escalation);

            return {
              content: [{ type: 'text', text: `Escalated question ${args.questionId} to human. Reason: ${args.reason}. Worker is paused until they answer.` }],
            };
          },
        ),

        tool(
          'get_worker_status',
          'Get the current status of one or all workers, including their output and result text.',
          {
            agentId: z.string().optional().describe('Specific agent ID to query. Omit for all workers.'),
          },
          async (args) => {
            const state = this.workerManager.getState();
            let agents = state.agents;
            if (args.agentId) {
              agents = agents.filter((a) => a.id === args.agentId);
              if (agents.length === 0) {
                return { content: [{ type: 'text', text: `No agent found with ID ${args.agentId}` }] };
              }
            }

            const summary = agents.map((a) => ({
              id: a.id,
              name: a.projectName,
              status: a.status,
              cost: `$${a.totalCostUsd.toFixed(4)}`,
              turns: a.numTurns,
              toolUses: a.toolUses.length,
              error: a.error,
              resultText: a.resultText,
              recentOutput: a.output.slice(-3),
            }));

            return {
              content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
            };
          },
        ),

        tool(
          'send_message_to_human',
          'Send a message to the human operator in the chat. Use this to provide status updates, summaries, or present worker artifacts. Always summarize rather than dumping raw output.',
          {
            text: z.string().describe('The message text to display'),
            artifacts: z
              .array(
                z.object({
                  type: z.enum(['code', 'diff', 'plan', 'text', 'file']).describe('Artifact type'),
                  title: z.string().describe('Short title for the artifact'),
                  content: z.string().describe('The artifact content'),
                  language: z.string().optional().describe('Language for syntax highlighting (for code type)'),
                }),
              )
              .optional()
              .describe('Optional artifacts to attach (plans, code snippets, diffs)'),
          },
          async (args) => {
            const chatMsg: ChatMessage = {
              id: randomUUID(),
              role: 'coordinator',
              text: args.text,
              timestamp: Date.now(),
              artifacts: args.artifacts as Artifact[] | undefined,
            };
            this.events.onChatMessage(chatMsg);
            return {
              content: [{ type: 'text', text: 'Message sent to human.' }],
            };
          },
        ),
      ],
    });
  }
}
