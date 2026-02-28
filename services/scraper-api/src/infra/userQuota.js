import { createRedisExecutor, toPositiveInt } from "./redisClient.js";
import { prisma } from "../db/prisma.js";

const WINDOW_MS = toPositiveInt(process.env.USER_QUOTA_WINDOW_MS, 24 * 60 * 60 * 1000);
const PAPER_SEARCH_LIMIT = toPositiveInt(process.env.USER_QUOTA_PAPER_SEARCH_LIMIT, 10);
const LILY_MESSAGE_LIMIT = toPositiveInt(process.env.USER_QUOTA_LILY_MESSAGE_LIMIT, 20);
const KEY_PREFIX = process.env.USER_QUOTA_KEY_PREFIX || "user_quota";
const ROLE_CACHE_TTL_MS = toPositiveInt(process.env.USER_QUOTA_ROLE_CACHE_TTL_MS, 60_000);

const PRIVILEGED_BYPASS_ROLES = new Set(
  String(process.env.USER_QUOTA_BYPASS_ROLES || "superadmin")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

const SUPERADMIN_EMAILS = new Set(
  String(process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

const userQuotaRedis = createRedisExecutor("user-quota", {
  timeoutMs: toPositiveInt(process.env.USER_QUOTA_REDIS_TIMEOUT_MS, 300),
  retryMs: toPositiveInt(process.env.USER_QUOTA_REDIS_RETRY_MS, 8_000),
});

const localCounters = new Map();
const roleCache = new Map();
let cleanupTick = 0;

const INCR_WITH_TTL_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

function normalizeKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "paper_search") return k;
  if (k === "lily_message") return k;
  throw new Error(`Unsupported quota kind: ${kind}`);
}

function kindLabel(kind) {
  return kind === "paper_search" ? "paper searches" : "Lily messages";
}

function getLimit(kind) {
  return kind === "paper_search" ? PAPER_SEARCH_LIMIT : LILY_MESSAGE_LIMIT;
}

function formatRemaining(ms) {
  const safe = Math.max(1, Number(ms) || 1);
  const totalMin = Math.ceil(safe / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function quotaError({ kind, limit, remaining, resetAtMs, requestId }) {
  const left = formatRemaining(resetAtMs - Date.now());
  const err = new Error(
    `Daily limit reached: ${limit} ${kindLabel(
      kind
    )} in 24 hours. If you want more, contact developer. Resets in ${left}.`
  );
  err.status = 429;
  err.code = "USER_QUOTA_EXCEEDED";
  err.quota = {
    kind,
    limit,
    remaining: Math.max(0, Number(remaining) || 0),
    resetAt: new Date(resetAtMs).toISOString(),
    resetIn: left,
  };
  err.retryAfterSec = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
  err.requestId = requestId || null;
  err.resetAt = err.quota.resetAt;
  return err;
}

function readCachedRole(userId, nowMs) {
  const row = roleCache.get(userId);
  if (!row) return null;
  if (!Number.isFinite(row.expiresAt) || row.expiresAt <= nowMs) {
    roleCache.delete(userId);
    return null;
  }
  return row.role;
}

function writeCachedRole(userId, role, nowMs) {
  roleCache.set(userId, {
    role,
    expiresAt: nowMs + ROLE_CACHE_TTL_MS,
  });
}

function normalizeUserRole(rawRole, rawEmail) {
  const email = String(rawEmail || "").toLowerCase().trim();
  if (SUPERADMIN_EMAILS.has(email)) return "superadmin";
  if (ADMIN_EMAILS.has(email)) return "admin";

  const role = String(rawRole || "user").toLowerCase().trim();
  if (role === "superadmin" || role === "admin") return role;
  return "user";
}

async function resolveUserRole(userId, nowMs) {
  const cached = readCachedRole(userId, nowMs);
  if (cached) return cached;

  let role = "user";
  let email = "";

  try {
    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE("role", 'user') AS "role",
        "email"
      FROM "user_account"
      WHERE "id" = ${String(userId)}
      LIMIT 1
    `;
    if (Array.isArray(rows) && rows.length) {
      role = String(rows[0].role || "user");
      email = String(rows[0].email || "");
    }
  } catch {
    try {
      const rows = await prisma.$queryRaw`
        SELECT "email"
        FROM "user_account"
        WHERE "id" = ${String(userId)}
        LIMIT 1
      `;
      if (Array.isArray(rows) && rows.length) {
        email = String(rows[0].email || "");
      }
    } catch {
      // ignore and keep default role=user
    }
  }

  const normalized = normalizeUserRole(role, email);
  writeCachedRole(userId, normalized, nowMs);
  return normalized;
}

function bumpLocalCounter({ key, now }) {
  cleanupTick += 1;
  let row = localCounters.get(key);
  if (!row || !Number.isFinite(row.resetAtMs) || row.resetAtMs <= now) {
    row = { count: 0, resetAtMs: now + WINDOW_MS };
  }

  row.count += 1;
  localCounters.set(key, row);

  if (cleanupTick % 128 === 0 || localCounters.size > 50_000) {
    for (const [k, v] of localCounters.entries()) {
      if (!v || !Number.isFinite(v.resetAtMs) || v.resetAtMs <= now) {
        localCounters.delete(k);
      }
    }
  }

  return { count: row.count, resetAtMs: row.resetAtMs };
}

async function incrementRedisCounter({ redisKey }) {
  const result = await userQuotaRedis.exec([
    "EVAL",
    INCR_WITH_TTL_SCRIPT,
    "1",
    redisKey,
    String(WINDOW_MS),
  ]);

  const pair = Array.isArray(result) ? result : [result, WINDOW_MS];
  const count = Number(pair[0]);
  const ttlMs = Number(pair[1]);

  if (!Number.isFinite(count)) throw new Error(`Invalid redis quota count for ${redisKey}`);

  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : WINDOW_MS;
  return { count, ttlMs: safeTtl };
}

export function getUserQuotaConfig() {
  return {
    windowMs: WINDOW_MS,
    paperSearchLimit: PAPER_SEARCH_LIMIT,
    lilyMessageLimit: LILY_MESSAGE_LIMIT,
    backend: userQuotaRedis.enabled ? "redis+memory-fallback" : "memory-only",
  };
}

export function setUserQuotaHeaders(res, quota) {
  if (!res || !quota || quota.skipped) return;
  res.setHeader("X-UserQuota-Kind", String(quota.kind));
  res.setHeader("X-UserQuota-Limit", String(quota.limit));
  res.setHeader("X-UserQuota-Count", String(quota.count));
  res.setHeader("X-UserQuota-Remaining", String(quota.remaining));
  if (quota.resetAt) res.setHeader("X-UserQuota-ResetAt", String(quota.resetAt));
}

export async function assertUserQuota(kind, userId, { requestId } = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return { ok: true, skipped: true, reason: "missing_user" };

  const normalizedKind = normalizeKind(kind);
  const limit = getLimit(normalizedKind);
  const now = Date.now();
  const role = await resolveUserRole(uid, now);

  if (PRIVILEGED_BYPASS_ROLES.has(role)) {
    return {
      ok: true,
      skipped: true,
      reason: "privileged_user",
      kind: normalizedKind,
      limit,
      count: 0,
      remaining: limit,
      resetAt: new Date(now + WINDOW_MS).toISOString(),
      resetIn: formatRemaining(WINDOW_MS),
      backend: "bypass",
      role,
    };
  }

  const counterKey = `${normalizedKind}:${uid}`;
  const redisKey = `${KEY_PREFIX}:${counterKey}`;

  let count = 0;
  let resetAtMs = now + WINDOW_MS;
  let backend = "memory";

  if (userQuotaRedis.enabled) {
    try {
      const out = await incrementRedisCounter({ redisKey });
      count = out.count;
      resetAtMs = now + out.ttlMs;
      backend = "redis";
    } catch {
      const local = bumpLocalCounter({ key: counterKey, now });
      count = local.count;
      resetAtMs = local.resetAtMs;
    }
  } else {
    const local = bumpLocalCounter({ key: counterKey, now });
    count = local.count;
    resetAtMs = local.resetAtMs;
  }

  const remaining = Math.max(0, limit - count);
  if (count > limit) {
    throw quotaError({
      kind: normalizedKind,
      limit,
      remaining,
      resetAtMs,
      requestId,
    });
  }

  return {
    ok: true,
    kind: normalizedKind,
    limit,
    count,
    remaining,
    resetAt: new Date(resetAtMs).toISOString(),
    resetIn: formatRemaining(resetAtMs - now),
    backend,
    skipped: false,
  };
}
