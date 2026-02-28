import { createRedisExecutor, toPositiveInt } from "./redisClient.js";

const redisOps = createRedisExecutor("redis-ops", {
  timeoutMs: toPositiveInt(process.env.REDIS_TIMEOUT_MS, 500),
  retryMs: toPositiveInt(process.env.REDIS_RETRY_MS, 8_000),
});

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function getRedisOpsExecutor() {
  return redisOps;
}

export async function pingRedis() {
  if (!redisOps.enabled) {
    return { ok: false, enabled: false, error: "redis_not_configured" };
  }
  try {
    const out = await redisOps.exec(["PING"]);
    return { ok: String(out || "").toUpperCase() === "PONG", enabled: true };
  } catch (err) {
    return { ok: false, enabled: true, error: String(err?.message || err) };
  }
}

export async function scanKeys(pattern, { count = 200, max = 10_000 } = {}) {
  if (!redisOps.enabled) return [];

  const results = [];
  let cursor = "0";
  const safeCount = Math.max(10, Math.min(1000, Number(count) || 200));
  const maxKeys = Math.max(0, Number(max) || 10_000);

  do {
    const reply = await redisOps.exec(["SCAN", cursor, "MATCH", String(pattern), "COUNT", String(safeCount)]);
    const rows = toArray(reply);
    cursor = String(rows[0] ?? "0");
    const keys = toArray(rows[1]).map((x) => String(x));

    for (const key of keys) {
      results.push(key);
      if (results.length >= maxKeys) return results;
    }
  } while (cursor !== "0");

  return results;
}

export async function deleteKeys(keys = []) {
  if (!redisOps.enabled) return 0;
  const all = Array.from(new Set(toArray(keys).map((x) => String(x)).filter(Boolean)));
  if (!all.length) return 0;

  let deleted = 0;
  const chunkSize = 200;
  for (let i = 0; i < all.length; i += chunkSize) {
    const chunk = all.slice(i, i + chunkSize);
    const out = await redisOps.exec(["DEL", ...chunk]);
    deleted += Number(out) || 0;
  }

  return deleted;
}

export async function deleteByPattern(pattern, { count = 200, max = 10_000 } = {}) {
  const keys = await scanKeys(pattern, { count, max });
  const deleted = await deleteKeys(keys);
  return { deleted, keysScanned: keys.length };
}
