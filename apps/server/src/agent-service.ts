import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import { writeSpan } from "./trace.js";
import type {
  Agent,
  AgentRun,
  AgentToken,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

// NOTE: single hardcoded owner stands in for real login; swap when identity exists.
const MOCK_OWNER_ID = "user_a";

function mintToken(agentId: string): { token: AgentToken; secret: string } {
  const secret = "sk_live_" + randomBytes(32).toString("hex");
  const token: AgentToken = {
    tokenId: "tok_" + randomBytes(6).toString("hex"),
    secretHash: createHash("sha256").update(secret).digest("hex"),
    agentId,
    ownerId: MOCK_OWNER_ID,
    scopes: ["resource:read:" + MOCK_OWNER_ID],
    status: "active",
    issuedAt: now(),
    revokedAt: null,
  };
  return { token, secret };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  // NOTE: raw secrets live only here, never on disk. Lost on restart —
  // an Agent using its old token in a container then just fails until reissued.
  private readonly liveSecrets = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(
    input: CreateAgentInput,
  ): Promise<{ agent: Agent; credential: { tokenId: string; secret: string } }> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const { token, secret } = mintToken(id);
    this.liveSecrets.set(id, secret);
    await this.workspaces.create(agent);
    await this.store.mutate((database) => {
      database.agents.push(agent);
      database.tokens.push(token);
    });
    return { agent, credential: { tokenId: token.tokenId, secret } };
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  // The credentials panel's read path: whatever the Agent's most recent
  // token is, active or revoked, so the UI can show its real current state
  // without needing to have just witnessed it being created or reissued.
  getToken(agentId: string): AgentToken {
    this.getAgent(agentId);
    const tokens = this.store
      .snapshot()
      .tokens.filter((item) => item.agentId === agentId)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
    const latest = tokens[0];
    if (!latest) {
      throw new HttpError(404, "No token has been issued for this Agent");
    }
    return latest;
  }

  // Marks the active card dead. Deliberately does NOT clear liveSecrets —
  // the Agent keeps the now-dead card in its pocket, so its next attempt is
  // denied with reason "revoked" instead of silently having no card at all.
  async revokeToken(agentId: string): Promise<AgentToken> {
    this.getAgent(agentId);
    const revoked = await this.store.mutate((database) => {
      const token = database.tokens.find(
        (item) => item.agentId === agentId && item.status === "active",
      );
      if (!token) {
        throw new HttpError(404, "No active token for this Agent");
      }
      token.status = "revoked";
      token.revokedAt = now();
      return structuredClone(token);
    });
    await writeSpan(this.store, {
      runId: null,
      actor: MOCK_OWNER_ID,
      action: "token.revoke",
      resource: revoked.tokenId,
      tokenId: revoked.tokenId,
      decision: "allow",
      reason: "owner_request",
      bytes: 0,
    });
    return revoked;
  }

  async reissueToken(agentId: string): Promise<{ token: AgentToken; secret: string }> {
    this.getAgent(agentId);
    const previouslyActive = await this.store.mutate((database) => {
      const token = database.tokens.find(
        (item) => item.agentId === agentId && item.status === "active",
      );
      if (token) {
        token.status = "revoked";
        token.revokedAt = now();
        return structuredClone(token);
      }
      return null;
    });
    if (previouslyActive) {
      await writeSpan(this.store, {
        runId: null,
        actor: MOCK_OWNER_ID,
        action: "token.revoke",
        resource: previouslyActive.tokenId,
        tokenId: previouslyActive.tokenId,
        decision: "allow",
        reason: "owner_request",
        bytes: 0,
      });
    }
    const { token, secret } = mintToken(agentId);
    this.liveSecrets.set(agentId, secret);
    await this.store.mutate((database) => database.tokens.push(token));
    await writeSpan(this.store, {
      runId: null,
      actor: MOCK_OWNER_ID,
      action: "token.issue",
      resource: token.tokenId,
      tokenId: token.tokenId,
      decision: "allow",
      reason: "owner_request",
      bytes: 0,
    });
    return { token, secret };
  }

  // Policy: credentials destroyed, audit retained. Tokens are flipped to
  // revoked (never deleted) and every span stays — only the Agent, its
  // messages, and its runs are removed.
  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    this.liveSecrets.delete(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    const revokedTokenIds = await this.store.mutate((database) => {
      const revoked: string[] = [];
      for (const token of database.tokens) {
        if (token.agentId === id && token.status === "active") {
          token.status = "revoked";
          token.revokedAt = now();
          revoked.push(token.tokenId);
        }
      }
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      return revoked;
    });
    for (const tokenId of revokedTokenIds) {
      await writeSpan(this.store, {
        runId: null,
        actor: MOCK_OWNER_ID,
        action: "token.revoke",
        resource: tokenId,
        tokenId,
        decision: "allow",
        reason: "agent_deleted",
        bytes: 0,
      });
    }
    await writeSpan(this.store, {
      runId: null,
      actor: MOCK_OWNER_ID,
      action: "agent.delete",
      resource: id,
      tokenId: null,
      decision: "allow",
      reason: "agent_deleted",
      // bytes stays 0, per the frozen contract — the revoked count is
      // already derivable by counting the token.revoke spans just above.
      bytes: 0,
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    // run.start/run.end just mark the run's shape in the trace; the run's
    // own success/failure already lives on the AgentRun record itself, so
    // these always log decision "allow" — they are not a policy check.
    await writeSpan(this.store, {
      runId: run.id,
      actor: agentAtStart.id,
      action: "run.start",
      resource: "-",
      tokenId: null,
      decision: "allow",
      reason: "allowed",
      bytes: 0,
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        agentToken: this.liveSecrets.get(agentAtStart.id) ?? null,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      await writeSpan(this.store, {
        runId: run.id,
        actor: agentAtStart.id,
        action: "run.end",
        resource: "-",
        tokenId: null,
        decision: "allow",
        reason: "allowed",
        bytes: 0,
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      await writeSpan(this.store, {
        runId: run.id,
        actor: agentAtStart.id,
        action: "run.end",
        resource: "-",
        tokenId: null,
        decision: "allow",
        reason: "allowed",
        bytes: 0,
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
