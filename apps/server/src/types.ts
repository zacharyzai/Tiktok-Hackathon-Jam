export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// Frozen contract (Team Playbook v2, Part 5) — do not change the shape without telling the team.
export interface AgentToken {
  tokenId: string; // the number painted on the locker door — safe for anyone to see
  secretHash: string; // a photo of the key's teeth, never the key itself
  agentId: string;
  ownerId: string;
  scopes: string[];
  status: "active" | "revoked";
  issuedAt: string;
  revokedAt: string | null;
}

// Frozen contract (Team Playbook v2, Part 5) — do not change the shape without telling the team.
export interface TraceSpan {
  spanId: string;
  runId: string | null; // ties the span to a platform Run
  timestamp: string;
  actor: string; // "agent_alpha" or "user_a"
  action: "run.start" | "run.end" | "resource.fetch" | "token.issue" | "token.revoke" | "agent.delete";
  resource: string;
  tokenId: string | null; // NEVER the secret
  decision: "allow" | "deny";
  reason:
    | "allowed"
    | "out_of_scope"
    | "revoked"
    | "unknown_token"
    | "owner_request"
    | "agent_deleted"
    | "service_unavailable";
  bytes: number; // size of the response; NEVER the body itself
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  tokens: AgentToken[];
  spans: TraceSpan[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  agentToken: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
