import { randomUUID } from "node:crypto";
import type { JsonStore } from "./store.js";
import type { TraceSpan } from "./types.js";

// The one place every log entry gets written, so the shape is always
// consistent and nothing can accidentally skip stamping spanId/timestamp.
export async function writeSpan(
  store: JsonStore,
  span: Omit<TraceSpan, "spanId" | "timestamp">,
): Promise<void> {
  await store.mutate((database) => {
    database.spans.push({
      spanId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...span,
    });
  });
}

export function readSpansForRun(store: JsonStore, runId: string): TraceSpan[] {
  return store
    .snapshot()
    .spans.filter((span) => span.runId === runId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
