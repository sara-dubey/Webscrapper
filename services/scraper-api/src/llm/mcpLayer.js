import { markLlmActiveProvider, observeLlmRequest } from "../observability/metrics.js";

function sanitizeMeta(meta = {}) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

const lastByCapability = new Map();
let lastCall = null;

function normalizeText(value, fallback = "unknown") {
  const clean = String(value || "").trim().toLowerCase();
  return clean || fallback;
}

function resolveModeFromProvider(provider) {
  const p = normalizeText(provider);
  if (p === "ollama") return "local";
  if (p === "openai" || p === "anthropic" || p === "gemini" || p.startsWith("api:")) return "api";
  if (p === "none") return "none";
  return "unknown";
}

function classifyOutcome(err) {
  if (err?.name === "AbortError") return "timeout";
  if (Number.isFinite(Number(err?.status))) return `http_${Number(err.status)}`;
  const klass = normalizeText(err?.name || err?.constructor?.name || "error", "error").replace(/[^a-z0-9_]/g, "_");
  return `error_${klass}`;
}

function recordLastCall({ capability, mode, provider, model, outcome, durationMs }) {
  const snapshot = {
    ts: new Date().toISOString(),
    capability,
    mode,
    provider,
    model: model || null,
    outcome,
    durationMs: Number(durationMs.toFixed(2)),
  };
  lastCall = snapshot;
  lastByCapability.set(capability, snapshot);
}

export function getLlmActivitySnapshot() {
  const byCapability = {};
  for (const [key, value] of lastByCapability.entries()) {
    byCapability[key] = value;
  }
  return {
    lastCall,
    byCapability,
  };
}

export async function runViaMcpLayer({ capability, provider, model, call }) {
  if (typeof call !== "function") {
    throw new Error("runViaMcpLayer requires a callable 'call' function.");
  }

  const safeCapability = normalizeText(capability);
  const safeProvider = normalizeText(provider);
  const mode = resolveModeFromProvider(safeProvider);
  markLlmActiveProvider({
    capability: safeCapability,
    mode,
    provider: safeProvider,
  });

  const started = process.hrtime.bigint();
  try {
    const out = await call();
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    observeLlmRequest({
      capability: safeCapability,
      mode,
      provider: safeProvider,
      outcome: "success",
      durationSeconds: durationMs / 1000,
    });
    recordLastCall({
      capability: safeCapability,
      mode,
      provider: safeProvider,
      model: String(model || "").trim() || null,
      outcome: "success",
      durationMs,
    });
    return out;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const outcome = classifyOutcome(err);
    observeLlmRequest({
      capability: safeCapability,
      mode,
      provider: safeProvider,
      outcome,
      durationSeconds: durationMs / 1000,
    });
    recordLastCall({
      capability: safeCapability,
      mode,
      provider: safeProvider,
      model: String(model || "").trim() || null,
      outcome,
      durationMs,
    });
    err.mcp = {
      capability: safeCapability,
      mode,
      provider: safeProvider,
      model: String(model || "").trim() || null,
      durationMs,
      meta: sanitizeMeta(err?.mcp?.meta || {}),
    };
    throw err;
  }
}
