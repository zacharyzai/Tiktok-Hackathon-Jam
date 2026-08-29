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
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import type { AgentService } from "../src/agent-service.js";
import type { AgentToken, TraceSpan } from "../src/types.js";

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
});
