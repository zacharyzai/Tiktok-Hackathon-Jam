// Member 2 — Task 3: test suite for the enforcement boundary
// (playbook: "Minimum four tests" — valid+own, valid+other, revoked+own,
// and every branch above writing a trace span).
//
// These are unit tests against the real HTTP route (/api/resource/fetch)
// and the real enforcement/store code, using Fastify's `.inject()` so no
// live server or live mock-service process is required. The mock service's
// own HTTP call is stubbed per-test (not hardcoded to one fixed response —
// it inspects the requested URL and answers based on the owner segment),
// so these tests still exercise the real branch logic in enforcement.ts.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService as RealAgentService } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { AgentService } from "../src/agent-service.js";
import type { AgentRunner, AgentToken, RunnerRequest, RunnerResult, TraceSpan } from "../src/types.js";

// Minimal stand-in for AgentService — the resource-fetch route never calls
// into it, so only the shape createApp expects needs to exist.
const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

async function makeApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-resource-fetch-test-"));
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const config = loadConfig({ NODE_ENV: "test" });
  const app = await createApp(config, service, store);
  return { app, store, config };
}

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "done: " + request.prompt, threadId: null, usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

// Builds an app and a REAL AgentService sharing the same store, so a route
// test can trigger a genuine Agent lifecycle event (e.g. deletion) and then
// observe its effect through the actual HTTP boundary — not a hand-simulated
// token record.
async function makeAppWithRealAgentService() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-resource-fetch-svc-test-"));
  const store = new JsonStore(path.join(root, "db.json"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const realService = new RealAgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await realService.initialize();
  const app = await createApp(config, realService, store);
  return { app, store, config, realService };
}

// Issues a token straight into the store (bypassing AgentService, which the
// resource-fetch route doesn't touch) with a freshly generated secret each
// call — never a fixed string, so every test run uses different credentials.
async function issueToken(
  store: JsonStore,
  overrides: Partial<Pick<AgentToken, "scopes" | "status">> = {},
): Promise<{ token: AgentToken; secret: string }> {
  const secret = "sk_test_" + randomBytes(24).toString("hex");
  const token: AgentToken = {
    tokenId: "tok_" + randomBytes(6).toString("hex"),
    secretHash: createHash("sha256").update(secret).digest("hex"),
    agentId: randomUUID(),
    ownerId: "user_a",
    scopes: overrides.scopes ?? ["resource:read:user_a"],
    status: overrides.status ?? "active",
    issuedAt: new Date().toISOString(),
    revokedAt: null,
  };
  await store.mutate((database) => {
    database.tokens.push(token);
  });
  return { token, secret };
}

function latestSpanFor(spans: TraceSpan[], tokenId: string | null): TraceSpan | undefined {
  return spans
    .filter((span) => span.tokenId === tokenId)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

describe("POST /api/resource/fetch — enforcement boundary", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    // Stands in for the real mock-service HTTP call. Answers dynamically
    // from whatever owner/resource was actually requested instead of a
    // single fixed payload, so a test asking for the wrong resource would
    // fail loudly rather than accidentally passing against canned output.
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = url.match(/\/resources\/([^/]+)\/notes$/);
      const owner = match?.[1] ?? "unknown";
      const body = JSON.stringify({ owner, content: `fixture note for ${owner}` });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", stub);
    restoreFetch = () => vi.unstubAllGlobals();
  });

  afterEach(() => {
    restoreFetch?.();
  });

  it("1. valid token + own resource -> 200, and writes an allow span", async () => {
    const { app, store } = await makeApp();
    const { token, secret } = await issueToken(store, { scopes: ["resource:read:user_a"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ owner: "user_a", content: "fixture note for user_a" });

    const span = latestSpanFor(store.snapshot().spans, token.tokenId);
    expect(span?.decision).toBe("allow");
    expect(span?.reason).toBe("allowed");

    await app.close();
  });

  it("2. valid token + another user's resource -> 403 out_of_scope, and writes a deny span", async () => {
    const { app, store } = await makeApp();
    const { token, secret } = await issueToken(store, { scopes: ["resource:read:user_a"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_b/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "out_of_scope" });

    const span = latestSpanFor(store.snapshot().spans, token.tokenId);
    expect(span?.decision).toBe("deny");
    expect(span?.reason).toBe("out_of_scope");

    await app.close();
  });

  it("3. revoked token + own resource -> 403 revoked, and writes a deny span", async () => {
    const { app, store } = await makeApp();
    const { token, secret } = await issueToken(store, {
      scopes: ["resource:read:user_a"],
      status: "revoked",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "revoked" });

    const span = latestSpanFor(store.snapshot().spans, token.tokenId);
    expect(span?.decision).toBe("deny");
    expect(span?.reason).toBe("revoked");

    await app.close();
  });

  it("4. unrecognized token -> denied with unknown_token, and writes a deny span", async () => {
    const { app, store } = await makeApp();
    // Never issued anywhere in the store — simulates a made-up/guessed token
    // (playbook Member 2 Task 4: "Made-up token?").
    const madeUpSecret = "sk_test_" + randomBytes(24).toString("hex");

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": madeUpSecret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "unknown_token" });

    const span = latestSpanFor(store.snapshot().spans, null);
    expect(span?.decision).toBe("deny");
    expect(span?.reason).toBe("unknown_token");

    await app.close();
  });

  it("5. missing token header -> 401 unknown_token, and writes a deny span", async () => {
    const { app, store } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: "unknown_token" });

    const span = latestSpanFor(store.snapshot().spans, null);
    expect(span?.decision).toBe("deny");
    expect(span?.reason).toBe("unknown_token");

    await app.close();
  });

  // --- Structural negative cases (v2) ---

  it.each([
    ["garbage string", "not-a-real-token-at-all"],
    ["very long string", "x".repeat(10_000)],
  ])("6. malformed token (%s) -> denied, no crash", async (_label, badSecret) => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": badSecret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "unknown_token" });

    await app.close();
  });

  it("6b. empty token header -> denied as missing, no crash", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": "" },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ reason: "unknown_token" });

    await app.close();
  });

  it("7. another Agent's valid token is still denied -> proves scoping is per-Agent, not global", async () => {
    const { app, store } = await makeApp();
    // Two distinct tokens for two distinct Agents, each scoped to its own owner.
    await issueToken(store, { scopes: ["resource:read:user_a"] });
    const { secret: bravoSecret } = await issueToken(store, {
      scopes: ["resource:read:user_b"],
    });

    // Bravo's token is entirely valid and active — just for the wrong owner.
    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": bravoSecret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "out_of_scope" });

    await app.close();
  });

  it("8. wrong HTTP method (GET on the POST route) -> no policy bypass", async () => {
    const { app, store } = await makeApp();
    await issueToken(store, { scopes: ["resource:read:user_a"] });

    const response = await app.inject({ method: "GET", url: "/api/resource/fetch" });

    expect(response.statusCode).toBe(404);
    // No span at all — the request never reached the enforcement logic.
    expect(store.snapshot().spans).toHaveLength(0);

    await app.close();
  });

  it("9. path traversal (user_a/../user_b/notes) -> denied", async () => {
    const { app, store } = await makeApp();
    const { secret } = await issueToken(store, { scopes: ["resource:read:user_a"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/../user_b/notes" },
    });

    // Must be denied outright, not silently normalized and allowed through —
    // Node's fetch() would otherwise collapse "../" and actually reach
    // user_b's data while this check thinks it authorized "user_a".
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).not.toMatchObject({ owner: "user_b" });

    await app.close();
  });

  it("10. a deleted Agent's token -> 403 revoked, via the real deletion path", async () => {
    const { app, realService } = await makeAppWithRealAgentService();
    const { agent, credential } = await realService.createAgent({ name: "Doomed" });
    await realService.deleteAgent(agent.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": credential.secret },
      payload: { resource: "user_a/notes" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "revoked" });

    await app.close();
  });

  // --- Redaction assertions (v2) — assert the ABSENCE of something. You
  // can't eyeball your way to "no secret ever leaks"; assert it and let
  // this run in CI forever. ---

  it("11. no span anywhere contains the token secret", async () => {
    const { app, store } = await makeApp();
    const { secret } = await issueToken(store, { scopes: ["resource:read:user_a"] });

    // Exercise every branch that writes a span, all with the same secret.
    await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });
    await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_b/notes" },
    });

    const serialized = JSON.stringify(store.snapshot().spans);
    expect(serialized).not.toContain(secret);

    await app.close();
  });

  it("12. no span contains the resource's actual content value", async () => {
    const { app, store } = await makeApp();
    const { secret } = await issueToken(store, { scopes: ["resource:read:user_a"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });
    // Confirm the content really was fetched (so this test would fail loudly
    // if the route stopped returning data), then confirm it never leaked
    // into the trace store even though the route itself saw it.
    const fetchedContent = response.json().content as string;
    expect(fetchedContent).toBeTruthy();

    const serialized = JSON.stringify(store.snapshot().spans);
    expect(serialized).not.toContain(fetchedContent);

    await app.close();
  });
});
