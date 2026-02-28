import { createRedisExecutor, incrementWindowCounter, toPositiveInt } from "../infra/redisClient.js";

const WINDOW_MS = toPositiveInt(process.env.PROVIDER_RATE_WINDOW_MS, 60_000);
const ARXIV_LIMIT = toPositiveInt(process.env.ARXIV_PROVIDER_RPM, 20); // ~1 req / 3 sec
const REDDIT_LIMIT = toPositiveInt(process.env.REDDIT_PROVIDER_RPM, 30);
const SEMANTIC_SCHOLAR_LIMIT = toPositiveInt(process.env.SEMANTIC_SCHOLAR_PROVIDER_RPM, 45);
const GITHUB_LIMIT = toPositiveInt(process.env.GITHUB_PROVIDER_RPM, 45);
const OPENREVIEW_LIMIT = toPositiveInt(process.env.OPENREVIEW_PROVIDER_RPM, 45);
const HUGGINGFACE_LIMIT = toPositiveInt(process.env.HUGGINGFACE_PROVIDER_RPM, 60);
const KEY_PREFIX = process.env.PROVIDER_RATE_KEY_PREFIX || "provider_rl";

const providerRedis = createRedisExecutor("provider-rate", {
  timeoutMs: toPositiveInt(process.env.PROVIDER_RATE_REDIS_TIMEOUT_MS, 300),
  retryMs: toPositiveInt(process.env.PROVIDER_RATE_REDIS_RETRY_MS, 8_000),
});

const localCounters = new Map();
let cleanupTick = 0;

function getProviderLimit(provider) {
  if (provider === "arxiv") return ARXIV_LIMIT;
  if (provider === "reddit") return REDDIT_LIMIT;
  if (provider === "semantic_scholar") return SEMANTIC_SCHOLAR_LIMIT;
  if (provider === "github") return GITHUB_LIMIT;
  if (provider === "openreview") return OPENREVIEW_LIMIT;
  if (provider === "huggingface") return HUGGINGFACE_LIMIT;
  throw new Error(`Unsupported provider for quota: ${provider}`);
}

function nowWindow(now) {
  return Math.floor(now / WINDOW_MS);
}

function bumpLocal(provider, windowId, now) {
  cleanupTick += 1;
  const key = `${provider}:${windowId}`;
  const hit = localCounters.get(key);
  if (hit) {
    hit.count += 1;
  } else {
    localCounters.set(key, {
      count: 1,
      expiresAt: (windowId + 1) * WINDOW_MS + 5000,
    });
  }

  if (cleanupTick % 128 === 0 || localCounters.size > 5000) {
    for (const [k, row] of localCounters.entries()) {
      if (!row || row.expiresAt <= now) localCounters.delete(k);
    }
  }

  return localCounters.get(key)?.count || 1;
}

function quotaError({ provider, limit, remaining, resetAtMs, requestId }) {
  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  const err = new Error(
    `${provider.toUpperCase()} upstream is busy. Please retry in ~${retryAfterSec}s (limit ${limit}/min).`
  );
  err.status = 429;
  err.code = "PROVIDER_RATE_LIMITED";
  err.provider = provider;
  err.limit = limit;
  err.remaining = Math.max(0, remaining);
  err.retryAfterSec = retryAfterSec;
  err.resetAt = new Date(resetAtMs).toISOString();
  err.requestId = requestId || null;
  return err;
}

export function getProviderQuotaConfig() {
  return {
    windowMs: WINDOW_MS,
    arxivPerMin: ARXIV_LIMIT,
    redditPerMin: REDDIT_LIMIT,
    semanticScholarPerMin: SEMANTIC_SCHOLAR_LIMIT,
    githubPerMin: GITHUB_LIMIT,
    openreviewPerMin: OPENREVIEW_LIMIT,
    huggingfacePerMin: HUGGINGFACE_LIMIT,
    backend: providerRedis.enabled ? "redis+memory-fallback" : "memory-only",
  };
}

export async function assertProviderQuota(provider, { requestId } = {}) {
  const p = String(provider || "").toLowerCase();
  const limit = getProviderLimit(p);
  const now = Date.now();
  const windowId = nowWindow(now);
  const resetAtMs = (windowId + 1) * WINDOW_MS;

  let backend = "memory";
  let count;

  if (providerRedis.enabled) {
    try {
      count = await incrementWindowCounter(
        providerRedis,
        `${KEY_PREFIX}:${p}:${windowId}`,
        WINDOW_MS
      );
      backend = "redis";
    } catch {
      count = bumpLocal(p, windowId, now);
      backend = "memory";
    }
  } else {
    count = bumpLocal(p, windowId, now);
  }

  const remaining = Math.max(0, limit - count);
  if (count > limit) {
    throw quotaError({
      provider: p,
      limit,
      remaining,
      resetAtMs,
      requestId,
    });
  }

  return {
    ok: true,
    provider: p,
    limit,
    count,
    remaining,
    resetAt: new Date(resetAtMs).toISOString(),
    backend,
  };
}
