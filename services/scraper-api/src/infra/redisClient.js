import net from "node:net";
import tls from "node:tls";

export function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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

  if (type === "+") return { type: "simple", value: line.value, nextOffset: line.next };
  if (type === "-") return { type: "error", value: line.value, nextOffset: line.next };
  if (type === ":") return { type: "integer", value: Number(line.value), nextOffset: line.next };

  if (type === "$") {
    const len = Number(line.value);
    if (len === -1) return { type: "bulk", value: null, nextOffset: line.next };
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
    if (count === -1) return { type: "array", value: null, nextOffset: line.next };
    let offset = line.next;
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const parsed = parseRespValue(buffer, offset);
      if (!parsed) return null;
      if (parsed.type === "error") return parsed;
      items.push(parsed.value);
      offset = parsed.nextOffset;
    }
    return { type: "array", value: items, nextOffset: offset };
  }

  return { type: "error", value: `Unsupported RESP type: ${type}`, nextOffset: line.next };
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

export function buildRedisUrlFromEnv() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  if (process.env.RATE_LIMIT_REDIS_URL) return process.env.RATE_LIMIT_REDIS_URL;

  const host = process.env.REDIS_HOST || process.env.RATE_LIMIT_REDIS_HOST;
  if (!host) return null;

  const tlsEnabled = (process.env.REDIS_TLS || process.env.RATE_LIMIT_REDIS_TLS || "")
    .toString()
    .toLowerCase();
  const protocol = tlsEnabled === "1" || tlsEnabled === "true" ? "rediss:" : "redis:";
  const port = process.env.REDIS_PORT || process.env.RATE_LIMIT_REDIS_PORT || (protocol === "rediss:" ? "6380" : "6379");
  const db = process.env.REDIS_DB || process.env.RATE_LIMIT_REDIS_DB || "0";
  const username = process.env.REDIS_USER || process.env.RATE_LIMIT_REDIS_USER || "";
  const password = process.env.REDIS_PASS || process.env.RATE_LIMIT_REDIS_PASS || "";

  const url = new URL(`${protocol}//${host}:${port}/${db}`);
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
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

async function runRedisCommandRaw(redisUrl, commandArgs, timeoutMs) {
  const conf = parseRedisConnection(redisUrl);
  const commands = [];
  if (conf.password) {
    if (conf.username) commands.push(["AUTH", conf.username, conf.password]);
    else commands.push(["AUTH", conf.password]);
  }
  if (conf.db && conf.db !== "0") commands.push(["SELECT", conf.db]);
  commands.push(commandArgs);

  const payload = Buffer.concat(commands.map(encodeRespCommand));
  const expectedResponses = commands.length;

  const rejectUnauthorized =
    (process.env.REDIS_REJECT_UNAUTHORIZED || process.env.RATE_LIMIT_REDIS_REJECT_UNAUTHORIZED || "1") !== "0";

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

    const timer = setTimeout(() => finish(new Error("Redis command timed out")), timeoutMs);

    socket.once("connect", () => socket.write(payload));
    socket.once("error", (err) => finish(err));
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

      if (offset > 0) buffer = buffer.slice(offset);
      if (responses.length >= expectedResponses) {
        finish(null, responses[responses.length - 1]);
      }
    });
  });
}

export function createRedisExecutor(
  component = "redis",
  { timeoutMs = toPositiveInt(process.env.REDIS_TIMEOUT_MS, 450), retryMs = toPositiveInt(process.env.REDIS_RETRY_MS, 10_000) } = {}
) {
  const redisUrl = buildRedisUrlFromEnv();
  let backoffUntil = 0;
  let fallbackLogged = false;

  if (!redisUrl) {
    return {
      enabled: false,
      async exec() {
        const e = new Error("Redis is not configured");
        e.code = "REDIS_DISABLED";
        throw e;
      },
    };
  }

  async function exec(commandArgs) {
    const now = Date.now();
    if (now < backoffUntil) {
      const e = new Error("Redis backoff in progress");
      e.code = "REDIS_BACKOFF";
      throw e;
    }

    try {
      const out = await runRedisCommandRaw(redisUrl, commandArgs, timeoutMs);
      if (fallbackLogged) {
        console.warn(`[${component}] Redis recovered. Back to distributed mode.`);
        fallbackLogged = false;
      }
      return out;
    } catch (err) {
      backoffUntil = Date.now() + retryMs;
      if (!fallbackLogged) {
        console.warn(
          `[${component}] Redis unavailable. Falling back to memory for ${Math.ceil(retryMs / 1000)}s.`
        );
        fallbackLogged = true;
      }
      if (!err?.code) err.code = "REDIS_UNAVAILABLE";
      throw err;
    }
  }

  return { enabled: true, exec };
}

export const INCR_WITH_EXPIRE_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

export async function incrementWindowCounter(executor, key, windowMs) {
  const ttlMs = Math.max(1000, Number(windowMs) + 5000);
  const result = await executor.exec(["EVAL", INCR_WITH_EXPIRE_SCRIPT, "1", key, String(ttlMs)]);
  const count = Number(result);
  if (!Number.isFinite(count)) throw new Error(`Invalid redis counter result for key=${key}`);
  return count;
}

