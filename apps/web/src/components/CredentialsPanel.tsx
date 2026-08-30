import { useState } from "react";

export type AgentToken = {
  tokenId: string;
  secretHash: string;
  agentId: string;
  ownerId: string;
  scopes: string[];
  status: "active" | "revoked";
  issuedAt: string;
  revokedAt: string | null;
};

const styles = {
  panel: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 480,
    border: "1px solid #e2e2e2",
    borderRadius: 8,
    padding: 16,
  },
  row: { display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13 },
  label: { color: "#666" },
  value: { fontFamily: "monospace" },
  badge: (active: boolean): React.CSSProperties => ({
    padding: "2px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    color: active ? "#fff" : "#333",
    background: active ? "#22a55e" : "#ccc",
  }),
  scopeTag: {
    display: "inline-block",
    background: "#f0f0f0",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 12,
    fontFamily: "monospace",
    marginRight: 6,
    marginBottom: 4,
  },
  buttonRow: { display: "flex", gap: 8, marginTop: 14 },
  button: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #ccc",
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
  },
  buttonDanger: { color: "#e5484d", borderColor: "#e5484d" },
  buttonDisabled: { opacity: 0.5, cursor: "not-allowed" },
  secretBox: {
    marginTop: 14,
    padding: 12,
    background: "#fff8e1",
    border: "1px solid #e5c453",
    borderRadius: 6,
  },
  secretWarning: { fontSize: 12, fontWeight: 700, marginBottom: 6 },
  secretValue: {
    display: "block",
    fontFamily: "monospace",
    fontSize: 12,
    wordBreak: "break-all" as const,
    background: "#fff",
    padding: 8,
    borderRadius: 4,
    marginBottom: 8,
  },
  error: { color: "#e5484d", fontSize: 12, marginTop: 8 },
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function CredentialsPanel({
  token,
  onRevoke,
  onReissue,
}: {
  token: AgentToken;
  onRevoke: () => Promise<void>;
  onReissue: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const handleRevoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRevoke();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleReissue = async () => {
    setBusy(true);
    setError(null);
    try {
      const secret = await onReissue();
      setRevealedSecret(secret);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const active = token.status === "active";

  return (
    <div style={styles.panel}>
      <div style={styles.row}>
        <span style={styles.label}>Token ID</span>
        <span style={styles.value}>{token.tokenId}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Status</span>
        <span style={styles.badge(active)}>{active ? "Active" : "Revoked"}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Issued</span>
        <span style={styles.value}>{formatDate(token.issuedAt)}</span>
      </div>
      <div style={{ ...styles.row, alignItems: "flex-start" }}>
        <span style={styles.label}>Scopes</span>
        <span>
          {token.scopes.map((scope) => (
            <span key={scope} style={styles.scopeTag}>
              {scope}
            </span>
          ))}
        </span>
      </div>

      <div style={styles.buttonRow}>
        <button
          style={{
            ...styles.button,
            ...styles.buttonDanger,
            ...(busy || !active ? styles.buttonDisabled : {}),
          }}
          disabled={busy || !active}
          onClick={handleRevoke}
        >
          Revoke
        </button>
        <button
          style={{ ...styles.button, ...(busy ? styles.buttonDisabled : {}) }}
          disabled={busy}
          onClick={handleReissue}
        >
          Reissue
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {revealedSecret && (
        <div style={styles.secretBox}>
          <div style={styles.secretWarning}>
            Copy this now — it will not be shown again.
          </div>
          <code style={styles.secretValue}>{revealedSecret}</code>
          <button style={styles.button} onClick={() => setRevealedSecret(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
