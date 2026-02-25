export type AgentStatus = 'starting' | 'working' | 'waiting_for_input' | 'completed' | 'errored' | 'stopped';
export type CoordinatorStatus = 'idle' | 'running' | 'stopped';

export interface Project {
  id: string;
  name: string;
  path: string;
  description?: string;
}

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

export interface Artifact {
  type: 'code' | 'diff' | 'plan' | 'text' | 'file';
  title: string;
  content: string;
  language?: string;
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'coordinator';
  text: string;
  timestamp: number;
  artifacts?: Artifact[];
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  type: 'image';
  mediaType: string;
  data: string; // base64
  name?: string;
}

export interface EscalatedQuestion extends PendingQuestion {
  coordinatorReason: string;
}

// WebSocket protocol: server → client
export type ServerMessage =
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'questions'; questions: PendingQuestion[] }
  | { type: 'activity'; entry: ActivityLogEntry }
  | { type: 'agent_update'; agent: AgentInfo }
  | { type: 'question_added'; question: PendingQuestion }
  | { type: 'question_removed'; questionId: string }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'chat_history'; messages: ChatMessage[] }
  | { type: 'coordinator_status'; status: CoordinatorStatus }
  | { type: 'escalation_added'; escalation: EscalatedQuestion }
  | { type: 'escalation_removed'; questionId: string }
  | { type: 'escalations'; escalations: EscalatedQuestion[] }
  | { type: 'projects'; projects: Project[] };

// WebSocket protocol: client → server
export type ClientMessage =
  | { type: 'answer'; questionId: string; answers: Record<string, string> }
  | { type: 'start_agent'; projectName: string; projectPath: string; prompt: string }
  | { type: 'request_state' }
  | { type: 'directive'; text: string; attachments?: MessageAttachment[] }
  | { type: 'answer_escalation'; questionId: string; answers: Record<string, string> }
  | { type: 'add_project'; name: string; path: string; description?: string }
  | { type: 'remove_project'; projectId: string }
  | { type: 'stop_agent'; agentId: string }
  | { type: 'stop_coordinator' };

// Interface for coordinator agent to call back into the coordinator (avoids circular deps)
export interface WorkerManager {
  startAgent(projectName: string, projectPath: string, prompt: string): AgentInfo;
  submitAnswer(questionId: string, answers: Record<string, string>): boolean;
  getState(): { agents: AgentInfo[]; questions: PendingQuestion[] };
  getProjects(): Project[];
}
