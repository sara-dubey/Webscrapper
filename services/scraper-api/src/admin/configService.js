import { prisma } from "../db/prisma.js";
import { applyQueueConfigOverrides, getSummaryQueueConfig } from "../queue/summaryQueue.js";

function toPositiveNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseValueJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return raw;
  }
}

export function normalizeConfigPayload(payload = {}) {
  const queue = payload.queue || {};
  const rateLimits = payload.rateLimits || {};
  const timeouts = payload.timeouts || {};
  const retryPolicy = payload.retryPolicy || payload.retry_policy || {};

  return {
    rate_limit_max: toPositiveNumber(payload.rate_limit_max ?? rateLimits.max),
    rate_limit_window_ms: toPositiveNumber(payload.rate_limit_window_ms ?? rateLimits.windowMs),
    summary_queue_max_active: toPositiveNumber(payload.max_concurrency ?? queue.maxConcurrency),
    summary_queue_worker_concurrency: toPositiveNumber(
      payload.worker_concurrency ?? queue.workerConcurrency
    ),
    ollama_timeout_ms: toPositiveNumber(payload.ollama_timeout_ms ?? timeouts.ollamaMs),
    python_timeout_ms: toPositiveNumber(payload.python_timeout_ms ?? timeouts.pythonMs),
    retry_max_attempts: toPositiveNumber(payload.retry_max_attempts ?? retryPolicy.maxAttempts),
    retry_backoff_ms: toPositiveNumber(payload.retry_backoff_ms ?? retryPolicy.backoffMs),
  };
}

export async function readAdminConfigRows() {
  const rows = await prisma.$queryRaw`
    SELECT "key", "value_json", "updated_at", "updated_by"
    FROM "admin_config"
    ORDER BY "key" ASC
  `;

  return Array.isArray(rows)
    ? rows.map((row) => ({
        key: String(row.key),
        value: parseValueJson(row.value_json),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }))
    : [];
}

function defaultsFromEnv() {
  const queue = getSummaryQueueConfig();

  return {
    rate_limit_max: Number(process.env.RATE_LIMIT_MAX || 100),
    rate_limit_window_ms: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    summary_queue_max_active: Number(queue.maxActive || 1),
    summary_queue_worker_concurrency: Number(process.env.SUMMARY_QUEUE_WORKER_CONCURRENCY || 1),
    ollama_timeout_ms: Number(process.env.OLLAMA_TIMEOUT_MS || process.env.RAG_OLLAMA_TIMEOUT_MS || 120_000),
    python_timeout_ms: Number(process.env.PY_HEALTH_TIMEOUT_MS || 1_500),
    retry_max_attempts: Number(queue.maxAttempts || 3),
    retry_backoff_ms: Number(queue.retryBackoffMs || 3_000),
  };
}

export async function getEffectiveAdminConfig() {
  const defaults = defaultsFromEnv();
  const rows = await readAdminConfigRows();

  const values = { ...defaults };
  for (const row of rows) {
    const raw = row.value;
    if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "value")) {
      values[row.key] = raw.value;
    } else {
      values[row.key] = raw;
    }
  }

  applyQueueConfigOverrides({
    maxActive: values.summary_queue_max_active,
    maxAttempts: values.retry_max_attempts,
    retryBackoffMs: values.retry_backoff_ms,
  });

  return {
    values,
    rows,
  };
}

export async function upsertAdminConfigValues(values = {}, actorUserId = null) {
  const entries = Object.entries(values).filter(([, value]) => value != null);
  if (!entries.length) return { updated: 0 };

  let updated = 0;
  for (const [key, value] of entries) {
    const valueJson = { value: Number(value) };
    await prisma.$executeRaw`
      INSERT INTO "admin_config" ("key", "value_json", "updated_at", "updated_by")
      VALUES (${String(key)}, ${valueJson}, NOW(), ${actorUserId ? String(actorUserId) : null})
      ON CONFLICT ("key")
      DO UPDATE SET
        "value_json" = EXCLUDED."value_json",
        "updated_at" = NOW(),
        "updated_by" = EXCLUDED."updated_by"
    `;
    updated += 1;
  }

  const { values: effective } = await getEffectiveAdminConfig();
  return { updated, values: effective };
}
