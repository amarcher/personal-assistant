export type AgentStatus = 'starting' | 'working' | 'waiting_for_input' | 'completed' | 'errored';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingQuestion {
  id: string;
  agentId: string;
  projectName: string;
  questions: QuestionItem[];
  createdAt: number;
}

export interface ToolUseEntry {
  tool: string;
  summary: string;
  timestamp: number;
}

export interface AgentInfo {
  id: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  status: AgentStatus;
  sessionId: string | null;
  totalCostUsd: number;
  numTurns: number;
  createdAt: number;
  error?: string;
  /** Accumulated assistant text output */
  output: string[];
  /** Tool usage log */
  toolUses: ToolUseEntry[];
  /** Final result summary (set on completion) */
  resultText?: string;
}

export interface ActivityLogEntry {
  id: string;
  agentId: string;
  projectName: string;
  message: string;
  timestamp: number;
}

// WebSocket protocol: server → client
export type ServerMessage =
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'questions'; questions: PendingQuestion[] }
  | { type: 'activity'; entry: ActivityLogEntry }
  | { type: 'agent_update'; agent: AgentInfo }
  | { type: 'question_added'; question: PendingQuestion }
  | { type: 'question_removed'; questionId: string };

// WebSocket protocol: client → server
export type ClientMessage =
  | { type: 'answer'; questionId: string; answers: Record<string, string> }
  | { type: 'start_agent'; projectName: string; projectPath: string; prompt: string }
  | { type: 'request_state' };
