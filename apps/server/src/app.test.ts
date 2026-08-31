import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentService } from "./agent-service.js";
import type { AgentToken } from "./types.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

async function makeStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

async function issueToken(store: JsonStore): Promise<string> {
  const secret = "sk_test_" + randomBytes(24).toString("hex");
  const token: AgentToken = {
    tokenId: "tok_" + randomBytes(6).toString("hex"),
    secretHash: createHash("sha256").update(secret).digest("hex"),
    agentId: randomUUID(),
    ownerId: "user_a",
    scopes: ["resource:read:user_a"],
    status: "active",
    issuedAt: new Date().toISOString(),
    revokedAt: null,
  };
  await store.mutate((database) => {
    database.tokens.push(token);
  });
  return secret;
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      await makeStore(),
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, await makeStore());
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("locks the control plane to the human principal but leaves the Agent's route open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ owner: "user_a", content: "note" }), { status: 200 })),
    );
    const store = await makeStore();
    const secret = await issueToken(store);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "human-principal-token" }),
      service,
      store,
    );

    // An injected Agent knows this server's address but holds no human
    // credential — it must not be able to enumerate Agents or mint a token.
    const enumerate = await app.inject({ method: "GET", url: "/api/agents" });
    expect(enumerate.statusCode).toBe(401);

    const mintToken = await app.inject({
      method: "POST",
      url: "/api/agents/00000000-0000-4000-8000-000000000000/token/reissue",
    });
    expect(mintToken.statusCode).toBe(401);

    // Its own scoped route still works — authorized by X-Agent-Token, not
    // the human's bearer token. If this route required the bearer too,
    // enabling human auth would silently break every Agent's own calls.
    const ownScope = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });
    expect(ownScope.statusCode).toBe(200);

    await app.close();
  });

  it("writes a service_unavailable span instead of a blind spot when the resource service is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const store = await makeStore();
    const secret = await issueToken(store);
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, store);

    const response = await app.inject({
      method: "POST",
      url: "/api/resource/fetch",
      headers: { "x-agent-token": secret },
      payload: { resource: "user_a/notes" },
    });
    expect(response.statusCode).toBe(502);

    const spans = store.snapshot().spans;
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ decision: "deny", reason: "service_unavailable" });

    await app.close();
  });
});
