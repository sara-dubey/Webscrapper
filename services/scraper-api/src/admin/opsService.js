import { prisma } from "../db/prisma.js";
import { getCacheStats } from "../cache/cache.js";
import { pingRedis } from "../infra/redisOps.js";
import { observeDependencyRequest } from "../observability/metrics.js";
import { getQueueStats, getSummaryQueueConfig } from "../queue/summaryQueue.js";
import { getResolvedLlmConfig } from "../rag/llmConfig.js";
import { getLlmActivitySnapshot } from "../llm/mcpLayer.js";
import { getEffectiveAdminConfig } from "./configService.js";

function nowIso() {
  return new Date().toISOString();
}

async function probeJson(url, dependency, timeoutMs) {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await res.text().catch(() => "");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    observeDependencyRequest(dependency, elapsed, res.ok ? "success" : `http_${res.status}`);

    return {
      ok: res.ok,
      status: res.status,
      body,
      latencyMs: Number((elapsed * 1000).toFixed(2)),
      url,
    };
  } catch (err) {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    observeDependencyRequest(dependency, elapsed, err?.name === "AbortError" ? "timeout" : "error");
    return {
      ok: false,
      error: String(err?.message || err),
      latencyMs: Number((elapsed * 1000).toFixed(2)),
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkPostgres() {
  const started = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    return { ok: true, latencyMs: Number((elapsed * 1000).toFixed(2)) };
  } catch (err) {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    return {
      ok: false,
      latencyMs: Number((elapsed * 1000).toFixed(2)),
      error: String(err?.message || err),
    };
  }
}

export async function getOpsStatus() {
  const pyBase = process.env.PY_BASE || "http://127.0.0.1:8000";
  const ollamaBase =
    process.env.OLLAMA_BASE || process.env.RAG_OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const timeoutMs = Number(process.env.ADMIN_STATUS_TIMEOUT_MS || 1500);

  const [python, ollama, redis, postgres, queueStats, config] = await Promise.all([
    probeJson(`${pyBase.replace(/\/+$/, "")}/health`, "paper_ai", timeoutMs),
    probeJson(`${ollamaBase.replace(/\/+$/, "")}/api/tags`, "ollama", timeoutMs),
    pingRedis(),
    checkPostgres(),
    getQueueStats(),
    getEffectiveAdminConfig(),
  ]);

  return {
    ok: true,
    ts: nowIso(),
    services: {
      node: {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
      },
      python,
      ollama,
      redis,
      postgres,
    },
    queue: {
      ...queueStats,
      config: getSummaryQueueConfig(),
    },
    cache: getCacheStats(),
    activeConfig: config.values,
    llm: {
      configured: getResolvedLlmConfig(),
      activity: getLlmActivitySnapshot(),
    },
  };
}
