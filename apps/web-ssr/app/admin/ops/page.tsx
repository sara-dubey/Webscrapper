"use client";

import { useEffect, useState } from "react";
import AdminShell from "../components/AdminShell";
import {
  adminClearAllCache,
  adminClearPaperCache,
  adminClearUserCache,
  adminDrainQueue,
  adminGetConfig,
  adminOpsStatus,
  adminPauseQueue,
  adminResumeQueue,
  adminRetryFailed,
  adminSetConfig,
  getToken,
} from "../../lib/api.js";

function pretty(value: any) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AdminOpsPage() {
  const [status, setStatus] = useState<any>(null);
  const [config, setConfig] = useState<any>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  const [retryScope, setRetryScope] = useState("last50");
  const [retryErrorType, setRetryErrorType] = useState("");
  const [userToken, setUserToken] = useState("");
  const [paperToken, setPaperToken] = useState("");

  async function loadStatus() {
    setError("");
    try {
      const out = await adminOpsStatus();
      setStatus(out);
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }

  async function loadConfig() {
    setError("");
    try {
      const out = await adminGetConfig();
      setConfig(out?.values || {});
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  }

  useEffect(() => {
    if (!getToken()) return;
    void loadStatus();
    void loadConfig();
  }, []);

  async function runAction(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      const out = await fn();
      setLastResult(out);
      await loadStatus();
      await loadConfig();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  const llmConfigured = status?.llm?.configured;
  const llmLast = status?.llm?.activity?.lastCall;
  const llmItem = {
    ok: String(llmConfigured?.chat?.provider || "none") !== "none",
    status: `${llmConfigured?.mode || "unknown"} / ${llmConfigured?.chat?.provider || "none"}`,
    sub: llmLast
      ? `last: ${llmLast.capability} (${llmLast.mode}/${llmLast.provider}) ${llmLast.ts || ""}`
      : "last: no mcp call yet",
  };

  return (
    <AdminShell title="Admin Ops">
      {!getToken() ? <div className="alert alertErr">Save an admin token first.</div> : null}
      {error ? <div className="alert alertErr">{error}</div> : null}

      <section className="adminBlock">
        <div className="adminBlockHead">
          <h3>Health Summary</h3>
          <button className="btn" onClick={() => loadStatus()} disabled={busy}>
            Refresh
          </button>
        </div>

        <div className="adminHealthGrid">
          {[
            { name: "node", item: status?.services?.node },
            { name: "python", item: status?.services?.python },
            { name: "ollama", item: status?.services?.ollama },
            { name: "redis", item: status?.services?.redis },
            { name: "postgres", item: status?.services?.postgres },
            { name: "llm", item: llmItem },
          ].map((x) => (
            <article key={x.name} className="adminHealthCard">
              <div className="adminCellMain">{x.name}</div>
              <div className={x.item?.ok ? "statusOk" : "statusBad"}>{x.item?.ok ? "OK" : "DOWN"}</div>
              <div className="adminCellSub">{x.item?.sub || x.item?.error || x.item?.status || "-"}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="adminBlock">
        <div className="adminBlockHead">
          <h3>Queue Controls</h3>
        </div>

        <div className="adminActionsRow">
          <button className="btn" onClick={() => runAction(() => adminPauseQueue())} disabled={busy}>
            Pause Queue
          </button>
          <button className="btn" onClick={() => runAction(() => adminResumeQueue())} disabled={busy}>
            Resume Queue
          </button>
          <button
            className="btn"
            onClick={() => runAction(() => adminRetryFailed({ scope: retryScope, errorType: retryErrorType }))}
            disabled={busy}
          >
            Retry Failed
          </button>
          <button
            className="btn"
            onClick={() => {
              const confirm = window.prompt('Type DRAIN to confirm', '');
              if (confirm !== "DRAIN") return;
              void runAction(() => adminDrainQueue("DRAIN"));
            }}
            disabled={busy}
          >
            Drain Waiting
          </button>
        </div>

        <div className="adminToolbar">
          <select className="input adminSelect" value={retryScope} onChange={(e) => setRetryScope(e.target.value)}>
            <option value="last50">last50</option>
            <option value="last1h">last1h</option>
            <option value="all">all</option>
          </select>
          <input
            className="input"
            value={retryErrorType}
            onChange={(e) => setRetryErrorType(e.target.value)}
            placeholder="Optional error type"
          />
        </div>
      </section>

      <section className="adminBlock">
        <div className="adminBlockHead">
          <h3>Cache Controls</h3>
        </div>

        <div className="adminToolbar">
          <input
            className="input"
            value={userToken}
            onChange={(e) => setUserToken(e.target.value)}
            placeholder="userId or email"
          />
          <button
            className="btn"
            onClick={() => runAction(() => adminClearUserCache({ userId: userToken }))}
            disabled={busy || !userToken.trim()}
          >
            Clear User Cache
          </button>
        </div>

        <div className="adminToolbar">
          <input
            className="input"
            value={paperToken}
            onChange={(e) => setPaperToken(e.target.value)}
            placeholder="arxiv_id or doi"
          />
          <button
            className="btn"
            onClick={() => runAction(() => adminClearPaperCache({ arxiv_id: paperToken }))}
            disabled={busy || !paperToken.trim()}
          >
            Clear Paper Cache
          </button>
          <button
            className="btn"
            onClick={() => {
              const confirm = window.prompt('Type CLEAR-ALL to confirm', '');
              if (confirm !== "CLEAR-ALL") return;
              void runAction(() => adminClearAllCache("CLEAR-ALL"));
            }}
            disabled={busy}
          >
            Clear All Cache
          </button>
        </div>
      </section>

      <section className="adminBlock">
        <div className="adminBlockHead">
          <h3>Config</h3>
          <button className="btn" onClick={() => loadConfig()} disabled={busy}>
            Refresh
          </button>
        </div>

        <div className="adminConfigGrid">
          {[
            "rate_limit_max",
            "rate_limit_window_ms",
            "summary_queue_max_active",
            "summary_queue_worker_concurrency",
            "ollama_timeout_ms",
            "python_timeout_ms",
            "retry_max_attempts",
            "retry_backoff_ms",
          ].map((key) => (
            <label key={key} className="adminCfgField">
              <span>{key}</span>
              <input
                className="input"
                type="number"
                value={config?.[key] ?? ""}
                onChange={(e) =>
                  setConfig((prev: any) => ({
                    ...prev,
                    [key]: e.target.value === "" ? "" : Number(e.target.value),
                  }))
                }
              />
            </label>
          ))}
        </div>

        <div className="adminActionsRow">
          <button className="btn" onClick={() => runAction(() => adminSetConfig(config))} disabled={busy}>
            Save Config
          </button>
        </div>
      </section>

      <section className="adminBlock">
        <div className="adminBlockHead">
          <h3>Response</h3>
        </div>
        <pre className="adminJson">{pretty(lastResult || status || {})}</pre>
      </section>
    </AdminShell>
  );
}
