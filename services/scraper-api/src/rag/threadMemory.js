import { createRedisExecutor, toPositiveInt } from "../infra/redisClient.js";

const redis = createRedisExecutor("rag-thread-memory", {
  timeoutMs: toPositiveInt(process.env.RAG_THREAD_REDIS_TIMEOUT_MS, 350),
  retryMs: toPositiveInt(process.env.RAG_THREAD_REDIS_RETRY_MS, 8_000),
});

const KEY_PREFIX = String(process.env.RAG_THREAD_CACHE_PREFIX || "rag_thread").trim();
const TTL_SEC = toPositiveInt(process.env.RAG_THREAD_CACHE_TTL_SEC, 6 * 60 * 60);
const MAX_TURNS = toPositiveInt(process.env.RAG_THREAD_MAX_TURNS, 12);
const MAX_TEXT = toPositiveInt(process.env.RAG_THREAD_MAX_TEXT_CHARS, 1400);

const localCache = new Map();

function safeString(value) {
  return String(value || "").trim();
}

function cacheKey(userId, searchId) {
  const uid = safeString(userId);
  const sid = safeString(searchId);
  if (!uid || !sid) return "";
  return `${KEY_PREFIX}:${uid}:${sid}`;
}

function normalizeHistory(rows = []) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const role = safeString(row?.role).toLowerCase();
    const text = safeString(row?.text);
    if ((role !== "user" && role !== "assistant") || !text) continue;
    out.push({ role, text: text.slice(0, MAX_TEXT) });
  }
  if (!out.length) return [];
  return out.slice(-MAX_TURNS);
}

function getLocal(key) {
  const row = localCache.get(key);
  if (!row) return [];
  if (!Number.isFinite(row.expiresAt) || row.expiresAt <= Date.now()) {
    localCache.delete(key);
    return [];
  }
  return normalizeHistory(row.items);
}

function setLocal(key, items) {
  localCache.set(key, {
    expiresAt: Date.now() + TTL_SEC * 1000,
    items: normalizeHistory(items),
  });
}

export async function getThreadHistory({ userId, searchId }) {
  const key = cacheKey(userId, searchId);
  if (!key) return [];

  if (redis.enabled) {
    try {
      const raw = await redis.exec(["GET", key]);
      if (typeof raw === "string" && raw.trim()) {
        const parsed = JSON.parse(raw);
        const clean = normalizeHistory(parsed);
        setLocal(key, clean);
        return clean;
      }
    } catch {
      // fall back to memory
    }
  }

  return getLocal(key);
}

export async function setThreadHistory({ userId, searchId, history }) {
  const key = cacheKey(userId, searchId);
  if (!key) return [];
  const clean = normalizeHistory(history);
  setLocal(key, clean);

  if (redis.enabled) {
    try {
      await redis.exec(["SET", key, JSON.stringify(clean), "EX", String(TTL_SEC)]);
    } catch {
      // keep memory copy only
    }
  }
  return clean;
}

export function mergeThreadHistory(clientHistory = [], cachedHistory = []) {
  const preferred = normalizeHistory(clientHistory);
  if (preferred.length) return preferred;
  return normalizeHistory(cachedHistory);
}

export function appendTurn(history = [], question = "", answer = "") {
  const out = normalizeHistory(history);
  const q = safeString(question);
  const a = safeString(answer);
  if (q) out.push({ role: "user", text: q.slice(0, MAX_TEXT) });
  if (a) out.push({ role: "assistant", text: a.slice(0, MAX_TEXT) });
  return normalizeHistory(out);
}

