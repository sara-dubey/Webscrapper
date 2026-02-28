import net from "node:net";
import tls from "node:tls";
import { recordCacheHit, recordCacheMiss } from "../observability/metrics.js";

const INCR_WITH_EXPIRE_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function readLine(buffer, start) {
  const end = buffer.indexOf("\r\n", start);
  if (end === -1) return null;
  return {
    value: buffer.toString("utf8", start, end),
    next: end + 2,
  };
}

function parseRespValue(buffer, start = 0) {
  if (start >= buffer.length) return null;
  const type = String.fromCharCode(buffer[start]);
  const line = readLine(buffer, start + 1);
  if (!line) return null;

  if (type === "+") {
    return { type: "simple", value: line.value, nextOffset: line.next };
  }

  if (type === "-") {
    return { type: "error", value: line.value, nextOffset: line.next };
  }

  if (type === ":") {
    return { type: "integer", value: Number(line.value), nextOffset: line.next };
  }

  if (type === "$") {
    const len = Number(line.value);
    if (len === -1) {
      return { type: "bulk", value: null, nextOffset: line.next };
    }
    const end = line.next + len;
    if (end + 2 > buffer.length) return null;
    return {
      type: "bulk",
      value: buffer.toString("utf8", line.next, end),
      nextOffset: end + 2,
    };
  }

  if (type === "*") {
    const count = Number(line.value);
    if (count === -1) {
      return { type: "array", value: null, nextOffset: line.next };
    }
    let offset = line.next;
    const items = [];
    for (let i = 0; i < count; i++) {
      const parsed = parseRespValue(buffer, offset);
      if (!parsed) return null;
      if (parsed.type === "error") return parsed;
      items.push(parsed.value);
      offset = parsed.nextOffset;
    }
    return { type: "array", value: items, nextOffset: offset };
  }

  return { type: "error", value: `Unsupported Redis RESP type: ${type}`, nextOffset: line.next };
}

function encodeRespCommand(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const value = Buffer.from(String(arg), "utf8");
    chunks.push(Buffer.from(`$${value.length}\r\n`, "utf8"));
    chunks.push(value);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

function buildRedisUrlFromEnv() {
  if (process.env.RATE_LIMIT_REDIS_URL) return process.env.RATE_LIMIT_REDIS_URL;
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host = process.env.RATE_LIMIT_REDIS_HOST || process.env.REDIS_HOST;
  if (!host) return null;

  const tlsEnabled = (process.env.RATE_LIMIT_REDIS_TLS || process.env.REDIS_TLS || "")
    .toString()
    .toLowerCase();
  const protocol = tlsEnabled === "1" || tlsEnabled === "true" ? "rediss:" : "redis:";

  const port =
    process.env.RATE_LIMIT_REDIS_PORT || process.env.REDIS_PORT || (protocol === "rediss:" ? "6380" : "6379");
  const db = process.env.RATE_LIMIT_REDIS_DB || process.env.REDIS_DB || "0";
  const username = process.env.RATE_LIMIT_REDIS_USER || process.env.REDIS_USER || "";
  const password = process.env.RATE_LIMIT_REDIS_PASS || process.env.REDIS_PASS || "";

  const url = new URL(`${protocol}//${host}:${port}/${db}`);
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

function getClientId(req) {
  if (req.userId) return `u:${req.userId}`;

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return `ip:${forwarded.split(",")[0].trim()}`;
  }

  return `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

function parseRedisConnection(redisUrl) {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis protocol: ${url.protocol}`);
  }
  return {
    tls: url.protocol === "rediss:",
    host: url.hostname,
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    db: (url.pathname || "/0").replace(/^\//, "") || "0",
  };
}

async function runRedisCommand(redisUrl, commandArgs, timeoutMs) {
  const conf = parseRedisConnection(redisUrl);
  const commands = [];

  if (conf.password) {
    if (conf.username) {
      commands.push(["AUTH", conf.username, conf.password]);
    } else {
      commands.push(["AUTH", conf.password]);
    }
  }
  if (conf.db && conf.db !== "0") {
    commands.push(["SELECT", conf.db]);
  }
  commands.push(commandArgs);

  const payload = Buffer.concat(commands.map(encodeRespCommand));
  const expectedResponses = commands.length;
  const rejectUnauthorized =
    (process.env.RATE_LIMIT_REDIS_REJECT_UNAUTHORIZED ||
      process.env.REDIS_REJECT_UNAUTHORIZED ||
      "1") !== "0";

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const responses = [];
    const socket = conf.tls
      ? tls.connect({
          host: conf.host,
          port: conf.port,
          servername: conf.host,
          rejectUnauthorized,
        })
      : net.createConnection({ host: conf.host, port: conf.port });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error("Redis command timed out"));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(payload);
    });

    socket.once("error", (err) => {
      finish(err);
    });

    socket.once("end", () => {
      if (!settled && responses.length < expectedResponses) {
        finish(new Error("Redis connection closed before command completed"));
      }
    });

    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      let offset = 0;
      while (true) {
        const parsed = parseRespValue(buffer, offset);
        if (!parsed) break;
        if (parsed.type === "error") {
          finish(new Error(`Redis error: ${parsed.value}`));
          return;
        }
        responses.push(parsed.value);
        offset = parsed.nextOffset;
      }

      if (offset > 0) {
        buffer = buffer.slice(offset);
      }

      if (responses.length >= expectedResponses) {
        finish(null, responses[responses.length - 1]);
      }
    });
  });
}

async function incrementRedisCount({ redisUrl, key, windowMs, timeoutMs }) {
  const ttlMs = windowMs + 5000;
  const result = await runRedisCommand(redisUrl, ["EVAL", INCR_WITH_EXPIRE_SCRIPT, "1", key, String(ttlMs)], timeoutMs);
  const count = Number(result);
  if (!Number.isFinite(count)) {
    throw new Error(`Unexpected Redis count result: ${String(result)}`);
  }
  return count;
}

export function createApiRateLimiter({
  limit = toPositiveInt(process.env.RATE_LIMIT_MAX, 100),
  windowMs = toPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  keyPrefix = process.env.RATE_LIMIT_KEY_PREFIX || "api_rl",
} = {}) {
  const redisUrl = buildRedisUrlFromEnv();
  const redisTimeoutMs = toPositiveInt(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS, 400);
  const redisRetryMs = toPositiveInt(process.env.RATE_LIMIT_REDIS_RETRY_MS, 10_000);
  const localMaxKeys = toPositiveInt(process.env.RATE_LIMIT_MEMORY_MAX_KEYS, 20_000);

  const localCounters = new Map();
  let localCleanupTick = 0;
  let redisBackoffUntil = 0;
  let redisFallbackLogged = false;

  if (!redisUrl) {
    console.warn("[rate-limit] Redis not configured. Using in-memory fallback only.");
  }

  function cleanupLocal(currentWindowId, now) {
    for (const [clientId, entry] of localCounters.entries()) {
      if (entry.windowId < currentWindowId - 2 || now - entry.lastSeenAt > windowMs * 5) {
        localCounters.delete(clientId);
      }
    }
  }

  function incrementLocalCount(clientId, windowId, now) {
    const current = localCounters.get(clientId);
    if (!current || current.windowId !== windowId) {
      localCounters.set(clientId, { windowId, count: 1, lastSeenAt: now });
      localCleanupTick += 1;
      if (localCleanupTick % 500 === 0 || localCounters.size > localMaxKeys) {
        cleanupLocal(windowId, now);
      }
      return 1;
    }

    current.count += 1;
    current.lastSeenAt = now;
    localCounters.set(clientId, current);

    localCleanupTick += 1;
    if (localCleanupTick % 500 === 0 || localCounters.size > localMaxKeys) {
      cleanupLocal(windowId, now);
    }

    return current.count;
  }

  return async function apiRateLimit(req, res, next) {
    if (req.method === "OPTIONS" || req.path === "/health") {
      return next();
    }

    const now = Date.now();
    const windowId = Math.floor(now / windowMs);
    const resetInMs = Math.max(1, (windowId + 1) * windowMs - now);
    const clientId = getClientId(req);
    const redisKey = `${keyPrefix}:${clientId}:${windowId}`;

    let count;
    let backend = "memory";

    if (redisUrl && now >= redisBackoffUntil) {
      try {
        count = await incrementRedisCount({
          redisUrl,
          key: redisKey,
          windowMs,
          timeoutMs: redisTimeoutMs,
        });
        backend = "redis";

        if (redisFallbackLogged) {
          console.warn("[rate-limit] Redis recovered. Switched back to distributed counters.");
          redisFallbackLogged = false;
        }
      } catch (err) {
        redisBackoffUntil = now + redisRetryMs;
        if (!redisFallbackLogged) {
          console.warn(
            `[rate-limit] Redis unavailable. Falling back to in-memory counters for ${Math.ceil(
              redisRetryMs / 1000
            )}s.`
          );
          redisFallbackLogged = true;
        }
        console.warn("[rate-limit] Redis error:", err?.message || err);
      }
    }

    if (!Number.isFinite(count)) {
      count = incrementLocalCount(clientId, windowId, now);
      backend = "memory";
      recordCacheMiss("rate");
    } else {
      recordCacheHit("rate");
    }

    const remaining = Math.max(0, limit - count);
    const resetAtEpochSec = Math.ceil((now + resetInMs) / 1000);
    const resetInSeconds = Math.max(1, Math.ceil(resetInMs / 1000));

    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetAtEpochSec));
    res.setHeader("X-RateLimit-Backend", backend);
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetInSeconds));

    if (count > limit) {
      res.setHeader("Retry-After", String(resetInSeconds));
      return res.status(429).json({
        ok: false,
        error: `Rate limit exceeded. Max ${limit} requests per ${Math.floor(windowMs / 1000)} seconds.`,
      });
    }

    return next();
  };
}
