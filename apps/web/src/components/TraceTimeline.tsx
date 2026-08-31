import { useMemo, useState } from "react";

export type TraceSpan = {
  spanId: string;
  runId: string | null;
  timestamp: string;
  actor: string;
  action:
    | "run.start"
    | "run.end"
    | "resource.fetch"
    | "token.issue"
    | "token.revoke"
    | "agent.delete";
  resource: string;
  tokenId: string | null;
  decision: "allow" | "deny";
  reason:
    | "allowed"
    | "out_of_scope"
    | "revoked"
    | "unknown_token"
    | "owner_request"
    | "agent_deleted"
    | "service_unavailable";
  bytes: number;
};

type Filter = "all" | "allowed" | "denied";

const styles = {
  wrapper: { fontFamily: "system-ui, sans-serif", maxWidth: 720 },
  filterRow: { display: "flex", gap: 8, marginBottom: 16 },
  filterButton: (active: boolean): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 999,
    border: "1px solid #ccc",
    background: active ? "#111" : "#fff",
    color: active ? "#fff" : "#111",
    cursor: "pointer",
    fontSize: 13,
  }),
  runGroup: { marginBottom: 20, border: "1px solid #e2e2e2", borderRadius: 8 },
  runHeader: {
    padding: "10px 14px",
    background: "#f6f6f6",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
  },
  spanRow: (allow: boolean): React.CSSProperties => ({
    padding: "10px 14px",
    borderLeft: `4px solid ${allow ? "#22a55e" : "#e5484d"}`,
    background: allow ? "#f0faf3" : "#fdf1f1",
    marginTop: 8,
    marginRight: 8,
    marginLeft: 8,
    borderRadius: 4,
  }),
  reasonBadge: (allow: boolean): React.CSSProperties => ({
    display: "inline-block",
    fontWeight: 700,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    padding: "2px 8px",
    borderRadius: 4,
    color: "#fff",
    background: allow ? "#22a55e" : "#e5484d",
  }),
  metaLine: { fontSize: 12, color: "#555", marginTop: 4 },
};

export function TraceTimeline({ spans }: { spans: TraceSpan[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (filter === "all") return spans;
    if (filter === "allowed") return spans.filter((s) => s.decision === "allow");
    return spans.filter((s) => s.decision === "deny");
  }, [spans, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, TraceSpan[]>();
    for (const span of filtered) {
      const key = span.runId ?? "unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(span);
    }
    for (const group of map.values()) {
      group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }
    return Array.from(map.entries()).sort(([, a], [, b]) => {
      const latestA = a[a.length - 1].timestamp;
      const latestB = b[b.length - 1].timestamp;
      return latestB.localeCompare(latestA);
    });
  }, [filtered]);

  const toggle = (runId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div style={styles.wrapper}>
      <div style={styles.filterRow}>
        {(["all", "allowed", "denied"] as Filter[]).map((f) => (
          <button key={f} style={styles.filterButton(filter === f)} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "allowed" ? "Allowed" : "Denied"}
          </button>
        ))}
      </div>

      {groups.map(([runId, group]) => {
        const isCollapsed = collapsed.has(runId);
        return (
          <div key={runId} style={styles.runGroup}>
            <div style={styles.runHeader} onClick={() => toggle(runId)}>
              <span>{runId === "unassigned" ? "No run" : `Run ${runId}`}</span>
              <span>{isCollapsed ? "▸" : "▾"}</span>
            </div>
            {!isCollapsed &&
              group.map((span) => {
                const allow = span.decision === "allow";
                return (
                  <div key={span.spanId} style={styles.spanRow(allow)}>
                    <span style={styles.reasonBadge(allow)}>{span.reason}</span>
                    <div style={styles.metaLine}>
                      <strong>{span.actor}</strong> · {span.action} · {span.resource}
                    </div>
                    <div style={styles.metaLine}>{span.timestamp}</div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
