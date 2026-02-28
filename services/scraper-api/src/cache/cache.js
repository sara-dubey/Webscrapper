import { LRUCache } from "lru-cache";
import { createRedisExecutor, toPositiveInt } from "../infra/redisClient.js";
import { deleteByPattern } from "../infra/redisOps.js";
import { recordCacheHit, recordCacheMiss } from "../observability/metrics.js";

const cacheRedis = createRedisExecutor("cache", {
  timeoutMs: toPositiveInt(process.env.CACHE_REDIS_TIMEOUT_MS, 350),
  retryMs: toPositiveInt(process.env.CACHE_REDIS_RETRY_MS, 8_000),
});

const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || "paper_cache";

function makeRedisKey(namespace, key) {
  return `${CACHE_KEY_PREFIX}:${namespace}:${String(key)}`;
}

const namespaceStats = new Map();

function getNamespaceStats(namespace) {
  if (!namespaceStats.has(namespace)) {
    namespaceStats.set(namespace, { hits: 0, misses: 0 });
  }
  return namespaceStats.get(namespace);
}

function cacheMetricLabel(namespace) {
  if (namespace === "arxiv_neg") return "neg";
  return namespace;
}

class HybridCache {
  constructor({ namespace, max, ttlMs }) {
    this.namespace = namespace;
    this.ttlMs = Math.max(1000, Number(ttlMs) || 60_000);
    this.local = new LRUCache({
      max: Math.max(1, Number(max) || 200),
      ttl: this.ttlMs,
    });
  }

  hit() {
    const stats = getNamespaceStats(this.namespace);
    stats.hits += 1;
    recordCacheHit(cacheMetricLabel(this.namespace));
  }

  miss() {
    const stats = getNamespaceStats(this.namespace);
    stats.misses += 1;
    recordCacheMiss(cacheMetricLabel(this.namespace));
  }

  async get(key) {
    const localHit = this.local.get(key);
    if (localHit !== undefined) {
      this.hit();
      return localHit;
    }

    if (!cacheRedis.enabled) {
      this.miss();
      return null;
    }

    try {
      const raw = await cacheRedis.exec(["GET", makeRedisKey(this.namespace, key)]);
      if (raw == null) {
        this.miss();
        return null;
      }
      const parsed = JSON.parse(String(raw));
      const value = parsed && Object.prototype.hasOwnProperty.call(parsed, "v") ? parsed.v : null;
      if (value !== undefined) this.local.set(key, value);
      this.hit();
      return value;
    } catch {
      this.miss();
      return null;
    }
  }

  async set(key, value) {
    this.local.set(key, value);
    if (!cacheRedis.enabled) return;

    try {
      const payload = JSON.stringify({ v: value });
      await cacheRedis.exec(["SET", makeRedisKey(this.namespace, key), payload, "PX", String(this.ttlMs)]);
    } catch {
      // Keep local cache as fallback.
    }
  }

  clearLocal() {
    this.local.clear();
  }
}

export const queryCache = new HybridCache({
  namespace: "query",
  max: toPositiveInt(process.env.QUERY_CACHE_MAX, 400),
  ttlMs: toPositiveInt(process.env.QUERY_CACHE_TTL_MS, 10 * 60 * 1000),
});

export const summaryCache = new HybridCache({
  namespace: "summary",
  max: toPositiveInt(process.env.SUMMARY_CACHE_MAX, 800),
  ttlMs: toPositiveInt(process.env.SUMMARY_CACHE_TTL_MS, 6 * 60 * 60 * 1000),
});

export const arxivCache = new HybridCache({
  namespace: "arxiv",
  max: toPositiveInt(process.env.ARXIV_ROUTE_CACHE_MAX, 600),
  ttlMs: toPositiveInt(process.env.ARXIV_ROUTE_CACHE_TTL_MS, 15 * 60 * 1000),
});

export const arxivNegCache = new HybridCache({
  namespace: "arxiv_neg",
  max: toPositiveInt(process.env.ARXIV_ROUTE_NEG_CACHE_MAX, 600),
  ttlMs: toPositiveInt(process.env.ARXIV_ROUTE_NEGATIVE_TTL_MS, 2 * 60 * 1000),
});

export const redditCache = new HybridCache({
  namespace: "reddit",
  max: toPositiveInt(process.env.REDDIT_CACHE_MAX, 600),
  ttlMs: toPositiveInt(process.env.REDDIT_CACHE_TTL_MS, 10 * 60 * 1000),
});

const ALL_CACHES = [queryCache, summaryCache, arxivCache, arxivNegCache, redditCache];

export function getCacheStats() {
  const perCache = {};
  let totalHits = 0;
  let totalMisses = 0;

  for (const [namespace, stats] of namespaceStats.entries()) {
    const hits = Number(stats.hits) || 0;
    const misses = Number(stats.misses) || 0;
    totalHits += hits;
    totalMisses += misses;
    const total = hits + misses;
    perCache[namespace] = {
      hits,
      misses,
      hitRate: total > 0 ? Number((hits / total).toFixed(4)) : null,
    };
  }

  const total = totalHits + totalMisses;
  return {
    keyPrefix: CACHE_KEY_PREFIX,
    redisEnabled: cacheRedis.enabled,
    totals: {
      hits: totalHits,
      misses: totalMisses,
      hitRate: total > 0 ? Number((totalHits / total).toFixed(4)) : null,
    },
    perCache,
  };
}

function clearLocalCaches() {
  for (const cache of ALL_CACHES) cache.clearLocal();
}

export async function clearCacheByIdentifier(identifier) {
  const token = String(identifier || "").trim();
  if (!token) return { deleted: 0, keysScanned: 0, pattern: null };

  clearLocalCaches();
  const pattern = `${CACHE_KEY_PREFIX}:*:*${token}*`;
  return await deleteByPattern(pattern, { max: 20_000 });
}

export async function clearAllCaches() {
  clearLocalCaches();
  const pattern = `${CACHE_KEY_PREFIX}:*`;
  return await deleteByPattern(pattern, { max: 100_000 });
}

export function getCacheKeyPrefix() {
  return CACHE_KEY_PREFIX;
}
