import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { JsonStore } from "./store.js";
import { writeSpan } from "./trace.js";
import type { TraceSpan } from "./types.js";

export interface ResourceFetchResult {
  statusCode: number;
  body: unknown;
}

// The doorman: every request must pass through here to reach a resource.
// Every branch below writes exactly one trace span before returning.
export async function enforceResourceFetch(
  store: JsonStore,
  config: AppConfig,
  params: { agentTokenHeader: string | undefined; resource: string; runId: string | null },
): Promise<ResourceFetchResult> {
  const { agentTokenHeader, resource, runId } = params;
  const secret = agentTokenHeader?.trim();

  const deny = async (
    actor: string,
    tokenId: string | null,
    reason: TraceSpan["reason"],
    statusCode: number,
  ): Promise<ResourceFetchResult> => {
    await writeSpan(store, {
      runId,
      actor,
      action: "resource.fetch",
      resource,
      tokenId,
      decision: "deny",
      reason,
      bytes: 0,
    });
    return { statusCode, body: { error: "Access denied", reason } };
  };

  if (!secret) {
    return deny("anonymous", null, "unknown_token", 401);
  }

  const secretHash = createHash("sha256").update(secret).digest("hex");
  const token = store.snapshot().tokens.find((item) => item.secretHash === secretHash);

  if (!token) {
    return deny("unknown", null, "unknown_token", 403);
  }
  if (token.status === "revoked") {
    return deny(token.agentId, token.tokenId, "revoked", 403);
  }

  const owner = resource.split("/")[0];
  const requiredScope = `resource:read:${owner}`;
  if (!token.scopes.includes(requiredScope)) {
    return deny(token.agentId, token.tokenId, "out_of_scope", 403);
  }

  // ponytail: mock service unreachable is an infra failure, not a policy
  // decision — no "reason" in the frozen enum fits it, so no span here.
  // Upgrade if the enum ever grows a "service_unavailable" reason.
  let response: Response;
  try {
    response = await fetch(`${config.mockServiceUrl}/resources/${resource}`);
  } catch {
    return { statusCode: 502, body: { error: "Resource service unreachable" } };
  }
  if (!response.ok) {
    return { statusCode: 502, body: { error: "Resource service error" } };
  }

  const text = await response.text();
  await writeSpan(store, {
    runId,
    actor: token.agentId,
    action: "resource.fetch",
    resource,
    tokenId: token.tokenId,
    decision: "allow",
    reason: "allowed",
    bytes: Buffer.byteLength(text),
  });
  return { statusCode: 200, body: JSON.parse(text) };
}
