import crypto from "node:crypto";

import { createRedisExecutor, toPositiveInt } from "../infra/redisClient.js";
import {
  markQueueCompleted,
  markQueueFailed,
  markQueueRetry,
  setQueueMetrics,
} from "../observability/metrics.js";
import { logJson } from "../observability/logger.js";

let QUEUE_MAX_ACTIVE = toPositiveInt(process.env.SUMMARY_QUEUE_MAX_ACTIVE, 1);
let QUEUE_MAX_WAITING = toPositiveInt(process.env.SUMMARY_QUEUE_MAX_WAITING, 25);
let QUEUE_MAX_ATTEMPTS = toPositiveInt(process.env.SUMMARY_QUEUE_MAX_ATTEMPTS, 3);
let WAIT_TIMEOUT_MS = toPositiveInt(process.env.SUMMARY_QUEUE_WAIT_TIMEOUT_MS, 45_000);
let POLL_MS = toPositiveInt(process.env.SUMMARY_QUEUE_POLL_MS, 350);
let HEARTBEAT_TTL_MS = toPositiveInt(process.env.SUMMARY_QUEUE_HEARTBEAT_TTL_MS, 30_000);
let HEARTBEAT_INTERVAL_MS = toPositiveInt(process.env.SUMMARY_QUEUE_HEARTBEAT_INTERVAL_MS, 5_000);
let RETRY_BACKOFF_MS = toPositiveInt(process.env.SUMMARY_QUEUE_RETRY_BACKOFF_MS, 3_000);
let MAX_COMPLETED = toPositiveInt(process.env.SUMMARY_QUEUE_MAX_COMPLETED, 1000);
const KEY_PREFIX = process.env.SUMMARY_QUEUE_KEY_PREFIX || "queue";
const INLINE_WORKER_ID = process.env.SUMMARY_QUEUE_INLINE_WORKER_ID || `api-inline:${process.pid}`;

const queueRedis = createRedisExecutor("summary-queue", {
  timeoutMs: toPositiveInt(process.env.SUMMARY_QUEUE_REDIS_TIMEOUT_MS, 400),
  retryMs: toPositiveInt(process.env.SUMMARY_QUEUE_REDIS_RETRY_MS, 8_000),
});

const keys = {
  waiting: `${KEY_PREFIX}:waiting`,
  active: `${KEY_PREFIX}:active`,
  delayed: `${KEY_PREFIX}:delayed`,
  failed: `${KEY_PREFIX}:failed`,
  failedData: `${KEY_PREFIX}:failed:data`,
  completed: `${KEY_PREFIX}:completed`,
  jobs: `${KEY_PREFIX}:jobs`,
  paused: `${KEY_PREFIX}:paused`,
  workerHeartbeats: `${KEY_PREFIX}:worker:heartbeats`,
};

const localQueueState = {
  active: 0,
  waiting: [],
  seq: 0,
};

const ENQUEUE_SCRIPT = `
local waitingCount = redis.call("ZCARD", KEYS[1])
if waitingCount >= tonumber(ARGV[4]) then
  return 0
end
redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])
redis.call("ZADD", KEYS[1], tonumber(ARGV[3]), ARGV[1])
return 1
`;

const MOVE_DUE_DELAYED_SCRIPT = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", tonumber(ARGV[1]), "LIMIT", 0, tonumber(ARGV[2]))
for _, id in ipairs(ids) do
  redis.call("ZREM", KEYS[1], id)
  redis.call("ZADD", KEYS[2], tonumber(ARGV[1]), id)
end
return #ids
`;

const CLAIM_SPECIFIC_SCRIPT = `
if redis.call("GET", KEYS[1]) == "1" then
  return {"PAUSED"}
end
if redis.call("HLEN", KEYS[3]) >= tonumber(ARGV[2]) then
  return {"BUSY"}
end
local first = redis.call("ZRANGE", KEYS[2], 0, 0)
if #first == 0 then
  return {"EMPTY"}
end
if first[1] ~= ARGV[4] then
  return {"WAIT"}
end
redis.call("ZREM", KEYS[2], ARGV[4])
local jobRaw = redis.call("HGET", KEYS[4], ARGV[4])
if not jobRaw then
  return {"MISSING", ARGV[4]}
end
local job = cjson.decode(jobRaw)
job.attempt = tonumber(job.attempt or 0) + 1
job.state = "active"
job.startedAt = tonumber(ARGV[1])
job.updatedAt = tonumber(ARGV[1])
job.workerId = ARGV[3]
local out = cjson.encode(job)
redis.call("HSET", KEYS[4], ARGV[4], out)
redis.call("HSET", KEYS[3], ARGV[4], cjson.encode({workerId=ARGV[3],startedAt=tonumber(ARGV[1]),attempt=job.attempt,jobType=job.jobType or "summary"}))
redis.call("HSET", KEYS[5], ARGV[3], tonumber(ARGV[1]))
return {"OK", ARGV[4], out}
`;

const CLAIM_NEXT_SCRIPT = `
if redis.call("GET", KEYS[1]) == "1" then
  return {"PAUSED"}
end
if redis.call("HLEN", KEYS[3]) >= tonumber(ARGV[2]) then
  return {"BUSY"}
end
local first = redis.call("ZRANGE", KEYS[2], 0, 0)
if #first == 0 then
  return {"EMPTY"}
end
local jobId = first[1]
redis.call("ZREM", KEYS[2], jobId)
local jobRaw = redis.call("HGET", KEYS[4], jobId)
if not jobRaw then
  return {"MISSING", jobId}
end
local job = cjson.decode(jobRaw)
job.attempt = tonumber(job.attempt or 0) + 1
job.state = "active"
job.startedAt = tonumber(ARGV[1])
job.updatedAt = tonumber(ARGV[1])
job.workerId = ARGV[3]
local out = cjson.encode(job)
redis.call("HSET", KEYS[4], jobId, out)
redis.call("HSET", KEYS[3], jobId, cjson.encode({workerId=ARGV[3],startedAt=tonumber(ARGV[1]),attempt=job.attempt,jobType=job.jobType or "summary"}))
redis.call("HSET", KEYS[5], ARGV[3], tonumber(ARGV[1]))
return {"OK", jobId, out}
`;

const COMPLETE_SCRIPT = `
local removed = redis.call("HDEL", KEYS[1], ARGV[1])
local raw = redis.call("HGET", KEYS[2], ARGV[1])
if not raw then
  return removed
end
local job = cjson.decode(raw)
job.state = "completed"
job.completedAt = tonumber(ARGV[2])
job.updatedAt = tonumber(ARGV[2])
job.workerId = nil
redis.call("HSET", KEYS[2], ARGV[1], cjson.encode(job))
redis.call("ZADD", KEYS[3], tonumber(ARGV[2]), ARGV[1])
local over = redis.call("ZCARD", KEYS[3]) - tonumber(ARGV[3])
if over > 0 then
  local oldIds = redis.call("ZRANGE", KEYS[3], 0, over - 1)
  for _, id in ipairs(oldIds) do
    redis.call("ZREM", KEYS[3], id)
    redis.call("HDEL", KEYS[2], id)
  end
end
return removed
`;

const FAIL_SCRIPT = `
redis.call("HDEL", KEYS[1], ARGV[1])
local raw = redis.call("HGET", KEYS[2], ARGV[1])
if not raw then
  return 0
end
local job = cjson.decode(raw)
local attempt = tonumber(job.attempt or 0)
local maxAttempts = tonumber(ARGV[5])
job.errorType = ARGV[3]
job.error = ARGV[4]
job.updatedAt = tonumber(ARGV[2])
job.workerId = nil
if attempt < maxAttempts then
  job.state = "delayed"
  job.nextRunAt = tonumber(ARGV[2]) + tonumber(ARGV[6])
  redis.call("HSET", KEYS[2], ARGV[1], cjson.encode(job))
  redis.call("ZADD", KEYS[5], tonumber(job.nextRunAt), ARGV[1])
  return 2
end
job.state = "failed"
job.failedAt = tonumber(ARGV[2])
redis.call("HSET", KEYS[2], ARGV[1], cjson.encode(job))
redis.call("ZADD", KEYS[3], tonumber(ARGV[2]), ARGV[1])
redis.call("HSET", KEYS[4], ARGV[1], cjson.encode({
  jobType = job.jobType or "summary",
  errorType = ARGV[3],
  error = ARGV[4],
  failedAt = tonumber(ARGV[2]),
  attempt = attempt
}))
return 1
`;

const RETRY_FAILED_SCRIPT = `
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
if removed == 0 then
  return 0
end
redis.call("HDEL", KEYS[2], ARGV[1])
local raw = redis.call("HGET", KEYS[4], ARGV[1])
if not raw then
  return 0
end
local job = cjson.decode(raw)
job.state = "waiting"
job.updatedAt = tonumber(ARGV[2])
job.workerId = nil
job.nextRunAt = nil
redis.call("HSET", KEYS[4], ARGV[1], cjson.encode(job))
redis.call("ZADD", KEYS[3], tonumber(ARGV[2]), ARGV[1])
return 1
`;

const DRAIN_WAITING_SCRIPT = `
local ids = redis.call("ZRANGE", KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  redis.call("ZREM", KEYS[1], id)
  redis.call("HDEL", KEYS[2], id)
end
return #ids
`;

const CANCEL_JOB_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("HDEL", KEYS[5], ARGV[1])
redis.call("ZREM", KEYS[6], ARGV[1])
redis.call("HDEL", KEYS[7], ARGV[1])
return 1
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nowMs() {
  return Date.now();
}

function buildBusyError(reason) {
  const err = new Error(
    reason === "paused"
      ? "Summary queue is paused by admin."
      : reason === "queue_full"
      ? "Summary service queue is full. Please retry shortly."
      : "Summary service is busy right now. Please retry in a few moments."
  );
  err.status = 503;
  err.code = reason === "paused" ? "SUMMARY_QUEUE_PAUSED" : "SUMMARY_QUEUE_BUSY";
  err.retryAfterSec = reason === "paused" ? 10 : Math.max(2, Math.ceil(POLL_MS / 1000) * 2);
  err.queue = {
    maxActive: QUEUE_MAX_ACTIVE,
    maxWaiting: QUEUE_MAX_WAITING,
  };
  return err;
}

function buildRedisUnavailableError(message) {
  const err = new Error(message || "Redis unavailable");
  err.code = "REDIS_UNAVAILABLE";
  return err;
}

function parseJsonSafe(raw, fallback = null) {
  try {
    return raw ? JSON.parse(String(raw)) : fallback;
  } catch {
    return fallback;
  }
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

export function applyQueueConfigOverrides(overrides = {}) {
  if (overrides.maxActive != null) {
    QUEUE_MAX_ACTIVE = toPositiveInt(overrides.maxActive, QUEUE_MAX_ACTIVE);
  }
  if (overrides.maxWaiting != null) {
    QUEUE_MAX_WAITING = toPositiveInt(overrides.maxWaiting, QUEUE_MAX_WAITING);
  }
  if (overrides.maxAttempts != null) {
    QUEUE_MAX_ATTEMPTS = toPositiveInt(overrides.maxAttempts, QUEUE_MAX_ATTEMPTS);
  }
  if (overrides.waitTimeoutMs != null) {
    WAIT_TIMEOUT_MS = toPositiveInt(overrides.waitTimeoutMs, WAIT_TIMEOUT_MS);
  }
  if (overrides.pollMs != null) {
    POLL_MS = toPositiveInt(overrides.pollMs, POLL_MS);
  }
  if (overrides.heartbeatTtlMs != null) {
    HEARTBEAT_TTL_MS = toPositiveInt(overrides.heartbeatTtlMs, HEARTBEAT_TTL_MS);
  }
  if (overrides.heartbeatIntervalMs != null) {
    HEARTBEAT_INTERVAL_MS = toPositiveInt(overrides.heartbeatIntervalMs, HEARTBEAT_INTERVAL_MS);
  }
  if (overrides.retryBackoffMs != null) {
    RETRY_BACKOFF_MS = toPositiveInt(overrides.retryBackoffMs, RETRY_BACKOFF_MS);
  }
  if (overrides.maxCompleted != null) {
    MAX_COMPLETED = toPositiveInt(overrides.maxCompleted, MAX_COMPLETED);
  }
}

async function ensureRedisEnabled() {
  if (!queueRedis.enabled) {
    throw buildRedisUnavailableError("Summary queue requires Redis");
  }
}

function isRedisTransientQueueError(err) {
  const code = String(err?.code || "").toUpperCase();
  const msg = String(err?.message || err || "").toLowerCase();
  if (code === "REDIS_UNAVAILABLE") return true;
  if (msg.includes("redis backoff")) return true;
  if (msg.includes("econnrefused")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("broken pipe")) return true;
  return false;
}

function localQueueSnapshot() {
  return {
    redisEnabled: false,
    paused: false,
    waiting: Math.max(0, localQueueState.waiting.length),
    active: Math.max(0, localQueueState.active),
    delayed: 0,
    failed: 0,
    completed: 0,
    oldestWaitingSeconds: 0,
    workerHeartbeats: 0,
    keyPrefix: `${KEY_PREFIX}:local`,
  };
}

function removeLocalWaiter(waiterId) {
  const idx = localQueueState.waiting.findIndex((w) => w?.id === waiterId);
  if (idx >= 0) {
    localQueueState.waiting.splice(idx, 1);
    return true;
  }
  return false;
}

function maybePromoteLocalWaiters() {
  while (localQueueState.active < QUEUE_MAX_ACTIVE && localQueueState.waiting.length) {
    const waiter = localQueueState.waiting.shift();
    if (!waiter || waiter.done) continue;
    waiter.done = true;
    clearTimeout(waiter.timer);
    localQueueState.active += 1;
    waiter.resolve({
      id: waiter.id,
      queuedAt: waiter.queuedAt,
      acquiredAt: nowMs(),
    });
  }
}

async function acquireLocalQueueSlot({ requestId = null, jobType = "summary" } = {}) {
  if (localQueueState.active < QUEUE_MAX_ACTIVE) {
    localQueueState.active += 1;
    return {
      id: `local:${nowMs()}:${++localQueueState.seq}`,
      queuedAt: nowMs(),
      acquiredAt: nowMs(),
    };
  }

  if (localQueueState.waiting.length >= QUEUE_MAX_WAITING) {
    throw buildBusyError("queue_full");
  }

  return await new Promise((resolve, reject) => {
    const id = `local:${nowMs()}:${++localQueueState.seq}`;
    const queuedAt = nowMs();
    const waiter = {
      id,
      queuedAt,
      done: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        removeLocalWaiter(id);
        reject(buildBusyError("timeout"));
      }, WAIT_TIMEOUT_MS),
    };
    if (waiter.timer?.unref) waiter.timer.unref();
    localQueueState.waiting.push(waiter);
    logJson("warn", "queue_local_waiting", {
      request_id: requestId,
      job_type: jobType,
      waiting: localQueueState.waiting.length,
      active: localQueueState.active,
    });
  });
}

function releaseLocalQueueSlot() {
  localQueueState.active = Math.max(0, localQueueState.active - 1);
  maybePromoteLocalWaiters();
}

async function runWithLocalQueueFallback(fn, {
  jobType = "summary",
  requestId = null,
} = {}) {
  const slot = await acquireLocalQueueSlot({ requestId, jobType });
  logJson("warn", "queue_local_job_acquired", {
    request_id: requestId,
    job_id: slot.id,
    job_type: jobType,
    waiting: localQueueState.waiting.length,
    active: localQueueState.active,
  });

  try {
    const result = await fn();
    markQueueCompleted(jobType || "summary", null);
    return result;
  } catch (err) {
    const errorType = String(err?.code || err?.name || "error").slice(0, 80);
    markQueueFailed(jobType || "summary", errorType);
    throw err;
  } finally {
    releaseLocalQueueSlot();
  }
}

export async function enqueueJob({
  jobType = "summary",
  payload = null,
  maxAttempts = QUEUE_MAX_ATTEMPTS,
  source = "api",
  meta = null,
} = {}) {
  await ensureRedisEnabled();

  const id = randomId();
  const createdAt = nowMs();
  const safeAttempts = Math.max(1, Number(maxAttempts) || QUEUE_MAX_ATTEMPTS);
  const job = {
    id,
    jobType: String(jobType || "summary"),
    payload,
    state: "waiting",
    attempt: 0,
    maxAttempts: safeAttempts,
    createdAt,
    updatedAt: createdAt,
    source,
    meta,
  };

  const enqueued = await queueRedis.exec([
    "EVAL",
    ENQUEUE_SCRIPT,
    "2",
    keys.waiting,
    keys.jobs,
    id,
    JSON.stringify(job),
    String(createdAt),
    String(QUEUE_MAX_WAITING),
  ]);

  if (Number(enqueued) !== 1) {
    throw buildBusyError("queue_full");
  }

  return job;
}

async function moveDueDelayedJobs(limit = 100) {
  await ensureRedisEnabled();
  return await queueRedis.exec([
    "EVAL",
    MOVE_DUE_DELAYED_SCRIPT,
    "2",
    keys.delayed,
    keys.waiting,
    String(nowMs()),
    String(Math.max(1, Number(limit) || 100)),
  ]);
}

function parseClaimResult(reply) {
  const values = Array.isArray(reply) ? reply.map((x) => String(x)) : [];
  const status = values[0] || "EMPTY";
  if (status !== "OK") {
    return { status };
  }

  return {
    status,
    jobId: values[1],
    job: parseJsonSafe(values[2], null),
  };
}

export async function claimNextJob(workerId = INLINE_WORKER_ID) {
  await ensureRedisEnabled();
  await reapStaleActiveJobs();
  await reapStaleWaitingJobs({ maxScan: 50 });
  await moveDueDelayedJobs(100);

  const out = await queueRedis.exec([
    "EVAL",
    CLAIM_NEXT_SCRIPT,
    "5",
    keys.paused,
    keys.waiting,
    keys.active,
    keys.jobs,
    keys.workerHeartbeats,
    String(nowMs()),
    String(QUEUE_MAX_ACTIVE),
    String(workerId || INLINE_WORKER_ID),
  ]);
  return parseClaimResult(out);
}

async function claimSpecificJob(jobId, workerId = INLINE_WORKER_ID) {
  await ensureRedisEnabled();
  await reapStaleActiveJobs();
  await reapStaleWaitingJobs({ maxScan: 50 });
  await moveDueDelayedJobs(100);

  const out = await queueRedis.exec([
    "EVAL",
    CLAIM_SPECIFIC_SCRIPT,
    "5",
    keys.paused,
    keys.waiting,
    keys.active,
    keys.jobs,
    keys.workerHeartbeats,
    String(nowMs()),
    String(QUEUE_MAX_ACTIVE),
    String(workerId || INLINE_WORKER_ID),
    String(jobId),
  ]);

  return parseClaimResult(out);
}

export async function recordWorkerHeartbeat(workerId = INLINE_WORKER_ID) {
  await ensureRedisEnabled();
  return await queueRedis.exec(["HSET", keys.workerHeartbeats, String(workerId), String(nowMs())]);
}

export async function completeJob(job, { result = null } = {}) {
  if (!job?.id) return;
  await ensureRedisEnabled();

  const finishedAt = nowMs();
  await queueRedis.exec([
    "EVAL",
    COMPLETE_SCRIPT,
    "3",
    keys.active,
    keys.jobs,
    keys.completed,
    String(job.id),
    String(finishedAt),
    String(MAX_COMPLETED),
  ]);

  if (result !== undefined) {
    const raw = await queueRedis.exec(["HGET", keys.jobs, String(job.id)]);
    const parsed = parseJsonSafe(raw, null);
    if (parsed) {
      parsed.result = result;
      parsed.updatedAt = finishedAt;
      await queueRedis.exec(["HSET", keys.jobs, String(job.id), JSON.stringify(parsed)]);
    }
  }

  const runtimeSeconds = job.startedAt ? Math.max(0, (finishedAt - Number(job.startedAt)) / 1000) : null;
  markQueueCompleted(job.jobType || "summary", runtimeSeconds);
}

export async function failJob(job, err, { backoffMs = RETRY_BACKOFF_MS } = {}) {
  if (!job?.id) return;
  await ensureRedisEnabled();

  const failedAt = nowMs();
  const errorType = String(err?.code || err?.name || "error").slice(0, 80);
  const errorMessage = String(err?.message || err || "Unknown queue failure").slice(0, 500);
  const maxAttempts = Math.max(1, Number(job.maxAttempts) || QUEUE_MAX_ATTEMPTS);

  const result = await queueRedis.exec([
    "EVAL",
    FAIL_SCRIPT,
    "5",
    keys.active,
    keys.jobs,
    keys.failed,
    keys.failedData,
    keys.delayed,
    String(job.id),
    String(failedAt),
    errorType,
    errorMessage,
    String(maxAttempts),
    String(Math.max(250, Number(backoffMs) || RETRY_BACKOFF_MS)),
  ]);

  if (Number(result) === 2) {
    markQueueRetry(job.jobType || "summary", "auto_backoff");
    return { state: "delayed" };
  }

  markQueueFailed(job.jobType || "summary", errorType);
  return { state: "failed" };
}

export async function cancelJob(jobId) {
  if (!jobId) return;
  await ensureRedisEnabled();
  await queueRedis.exec([
    "EVAL",
    CANCEL_JOB_SCRIPT,
    "7",
    keys.waiting,
    keys.delayed,
    keys.active,
    keys.failed,
    keys.failedData,
    keys.completed,
    keys.jobs,
    String(jobId),
  ]);
}

export async function pauseQueue() {
  await ensureRedisEnabled();
  await queueRedis.exec(["SET", keys.paused, "1"]);
  return { ok: true, paused: true };
}

export async function resumeQueue() {
  await ensureRedisEnabled();
  await queueRedis.exec(["DEL", keys.paused]);
  return { ok: true, paused: false };
}

export async function isQueuePaused() {
  await ensureRedisEnabled();
  const raw = await queueRedis.exec(["GET", keys.paused]);
  return String(raw || "") === "1";
}

export async function drainWaitingQueue() {
  await ensureRedisEnabled();
  const removed = await queueRedis.exec(["EVAL", DRAIN_WAITING_SCRIPT, "2", keys.waiting, keys.jobs]);
  return { removed: Number(removed) || 0 };
}

function parseHashToObject(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = {};
  for (let i = 0; i < arr.length; i += 2) {
    const key = String(arr[i] ?? "");
    const value = arr[i + 1];
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

async function reapStaleActiveJobs({
  now = nowMs(),
  maxScan = 200,
} = {}) {
  await ensureRedisEnabled();

  const [activeRaw, heartbeatsRaw] = await Promise.all([
    queueRedis.exec(["HGETALL", keys.active]),
    queueRedis.exec(["HGETALL", keys.workerHeartbeats]),
  ]);

  const activeEntries = parseHashToObject(activeRaw);
  const heartbeats = parseHashToObject(heartbeatsRaw);
  const staleAgeMs = Math.max(60_000, WAIT_TIMEOUT_MS + HEARTBEAT_TTL_MS);
  const stale = [];

  for (const [jobId, metaRaw] of Object.entries(activeEntries)) {
    if (stale.length >= Math.max(1, Number(maxScan) || 1)) break;

    const meta = parseJsonSafe(metaRaw, {}) || {};
    const workerId = String(meta.workerId || "").trim();
    const startedAt = Number(meta.startedAt) || 0;
    const ageMs = startedAt > 0 ? now - startedAt : Number.POSITIVE_INFINITY;
    const heartbeatAt = workerId ? Number(heartbeats[workerId]) || 0 : 0;
    const workerAlive = heartbeatAt > 0 && now - heartbeatAt <= HEARTBEAT_TTL_MS;

    if (!workerAlive && ageMs >= staleAgeMs) {
      stale.push({
        jobId,
        workerId: workerId || null,
        startedAt: startedAt || null,
        ageMs,
      });
    }
  }

  for (const item of stale) {
    await cancelJob(item.jobId);
    logJson("warn", "queue_job_stale_reaped", {
      job_id: item.jobId,
      worker_id: item.workerId,
      started_at: item.startedAt,
      age_ms: Number.isFinite(item.ageMs) ? Math.round(item.ageMs) : null,
    });
  }

  return stale.length;
}

async function reapStaleWaitingJobs({
  now = nowMs(),
  maxScan = 100,
} = {}) {
  await ensureRedisEnabled();

  // Waiting jobs come from inline API requests that timeout after WAIT_TIMEOUT_MS.
  // Anything much older is stale (client already gone) and can cause head-of-line blocking.
  const staleAgeMs = Math.max(60_000, WAIT_TIMEOUT_MS + 15_000);
  const cutoff = now - staleAgeMs;

  const idsRaw = await queueRedis.exec([
    "ZRANGEBYSCORE",
    keys.waiting,
    "-inf",
    String(cutoff),
    "LIMIT",
    "0",
    String(Math.max(1, Number(maxScan) || 1)),
  ]);

  const ids = Array.isArray(idsRaw) ? idsRaw.map((x) => String(x || "")).filter(Boolean) : [];
  if (!ids.length) return 0;

  let removed = 0;
  for (const jobId of ids) {
    await cancelJob(jobId);
    removed += 1;
    logJson("warn", "queue_job_waiting_stale_reaped", {
      job_id: jobId,
      stale_age_ms: staleAgeMs,
    });
  }

  return removed;
}

async function getFailedJobIdsByScope(scope = "last50") {
  await ensureRedisEnabled();
  const now = nowMs();

  if (scope === "last1h") {
    const oneHourAgo = now - 60 * 60 * 1000;
    const rows = await queueRedis.exec(["ZRANGEBYSCORE", keys.failed, String(oneHourAgo), String(now)]);
    return Array.isArray(rows) ? rows.map((x) => String(x)) : [];
  }

  if (scope === "all") {
    const rows = await queueRedis.exec(["ZRANGE", keys.failed, "0", "-1"]);
    return Array.isArray(rows) ? rows.map((x) => String(x)) : [];
  }

  const rows = await queueRedis.exec(["ZREVRANGE", keys.failed, "0", "49"]);
  return Array.isArray(rows) ? rows.map((x) => String(x)) : [];
}

export async function retryFailedJobs({ scope = "last50", errorType = null } = {}) {
  await ensureRedisEnabled();

  const ids = await getFailedJobIdsByScope(scope);
  if (!ids.length) return { retried: 0, scanned: 0 };

  const failedDataRaw = await queueRedis.exec(["HMGET", keys.failedData, ...ids]);
  const failedData = Array.isArray(failedDataRaw) ? failedDataRaw : [];

  let retried = 0;
  const now = nowMs();

  for (let i = 0; i < ids.length; i += 1) {
    const jobId = ids[i];
    const metadata = parseJsonSafe(failedData[i], null);

    if (errorType && String(metadata?.errorType || "") !== String(errorType)) {
      continue;
    }

    const out = await queueRedis.exec([
      "EVAL",
      RETRY_FAILED_SCRIPT,
      "4",
      keys.failed,
      keys.failedData,
      keys.waiting,
      keys.jobs,
      String(jobId),
      String(now),
    ]);

    if (Number(out) === 1) {
      retried += 1;
      markQueueRetry(metadata?.jobType || "summary", "manual_retry");
    }
  }

  return { retried, scanned: ids.length };
}

async function countFreshWorkerHeartbeats(now, ttlMs = HEARTBEAT_TTL_MS) {
  const raw = await queueRedis.exec(["HGETALL", keys.workerHeartbeats]);
  const obj = parseHashToObject(raw);
  let alive = 0;

  for (const [workerId, seenAtRaw] of Object.entries(obj)) {
    const seenAt = Number(seenAtRaw) || 0;
    if (seenAt <= 0 || now - seenAt > ttlMs) {
      await queueRedis.exec(["HDEL", keys.workerHeartbeats, workerId]);
      continue;
    }
    alive += 1;
  }

  return alive;
}

export async function getQueueStats() {
  if (!queueRedis.enabled) {
    const stats = localQueueSnapshot();
    setQueueMetrics(stats);
    return stats;
  }
  try {
    await reapStaleActiveJobs();
    await reapStaleWaitingJobs();
    await moveDueDelayedJobs(200);

    const [pausedRaw, waitingRaw, activeRaw, delayedRaw, failedRaw, completedRaw, oldestRaw] = await Promise.all([
      queueRedis.exec(["GET", keys.paused]),
      queueRedis.exec(["ZCARD", keys.waiting]),
      queueRedis.exec(["HLEN", keys.active]),
      queueRedis.exec(["ZCARD", keys.delayed]),
      queueRedis.exec(["ZCARD", keys.failed]),
      queueRedis.exec(["ZCARD", keys.completed]),
      queueRedis.exec(["ZRANGE", keys.waiting, "0", "0", "WITHSCORES"]),
    ]);

    const oldestRow = Array.isArray(oldestRaw) ? oldestRaw : [];
    const oldestScore = Number(oldestRow[1] ?? 0) || 0;
    const oldestWaitingSeconds = oldestScore > 0 ? Math.max(0, (nowMs() - oldestScore) / 1000) : 0;
    const workerHeartbeats = await countFreshWorkerHeartbeats(nowMs());

    const stats = {
      redisEnabled: true,
      paused: String(pausedRaw || "") === "1",
      waiting: Number(waitingRaw) || 0,
      active: Number(activeRaw) || 0,
      delayed: Number(delayedRaw) || 0,
      failed: Number(failedRaw) || 0,
      completed: Number(completedRaw) || 0,
      oldestWaitingSeconds: Number(oldestWaitingSeconds.toFixed(3)),
      workerHeartbeats,
      keyPrefix: KEY_PREFIX,
    };

    setQueueMetrics(stats);
    return stats;
  } catch (err) {
    if (isRedisTransientQueueError(err)) {
      const stats = {
        ...localQueueSnapshot(),
        redisEnabled: false,
        degraded: true,
        error: String(err?.message || err),
      };
      setQueueMetrics(stats);
      return stats;
    }
    throw err;
  }
}

export function getSummaryQueueConfig() {
  return {
    keyPrefix: KEY_PREFIX,
    maxActive: QUEUE_MAX_ACTIVE,
    maxWaiting: QUEUE_MAX_WAITING,
    maxAttempts: QUEUE_MAX_ATTEMPTS,
    waitTimeoutMs: WAIT_TIMEOUT_MS,
    pollMs: POLL_MS,
    heartbeatTtlMs: HEARTBEAT_TTL_MS,
    retryBackoffMs: RETRY_BACKOFF_MS,
    backend: queueRedis.enabled ? "redis" : "disabled",
  };
}

export function isSummaryQueueBusyError(err) {
  return String(err?.code || "") === "SUMMARY_QUEUE_BUSY" || String(err?.code || "") === "SUMMARY_QUEUE_PAUSED";
}

async function runWithSummaryQueueRedis(fn, {
  jobType = "summary",
  maxAttempts = 1,
  source = "api_inline",
  workerId = INLINE_WORKER_ID,
  requestId = null,
} = {}) {
  await ensureRedisEnabled();
  await reapStaleWaitingJobs({ maxScan: 20 });

  const paused = await isQueuePaused();
  if (paused) {
    throw buildBusyError("paused");
  }

  const job = await enqueueJob({
    jobType,
    payload: { inline: true },
    maxAttempts,
    source,
  });
  logJson("info", "queue_job_enqueued", {
    request_id: requestId,
    job_id: job.id,
    job_type: jobType,
    source,
  });

  const started = nowMs();
  let claimedJob = null;

  while (nowMs() - started < WAIT_TIMEOUT_MS) {
    const claim = await claimSpecificJob(job.id, workerId);

    if (claim.status === "OK" && claim.job) {
      claimedJob = claim.job;
      break;
    }

    if (claim.status === "PAUSED") {
      await cancelJob(job.id);
      logJson("warn", "queue_job_paused", {
        request_id: requestId,
        job_id: job.id,
      });
      throw buildBusyError("paused");
    }

    if (claim.status === "MISSING") {
      logJson("warn", "queue_job_missing", {
        request_id: requestId,
        job_id: job.id,
      });
      throw buildBusyError("timeout");
    }

    await sleep(POLL_MS);
  }

  if (!claimedJob) {
    await cancelJob(job.id);
    logJson("warn", "queue_job_timeout", {
      request_id: requestId,
      job_id: job.id,
      wait_timeout_ms: WAIT_TIMEOUT_MS,
    });
    throw buildBusyError("timeout");
  }

  const heartbeatTimer = setInterval(() => {
    recordWorkerHeartbeat(workerId).catch(() => {
      // best-effort heartbeat
    });
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  let executionStarted = false;
  try {
    executionStarted = true;
    const result = await fn();

    try {
      await completeJob(claimedJob, { result: { ok: true } });
    } catch (completeErr) {
      if (isRedisTransientQueueError(completeErr)) {
        logJson("warn", "queue_complete_transient_error", {
          request_id: requestId,
          job_id: claimedJob.id,
          job_type: claimedJob.jobType,
          error: String(completeErr?.message || completeErr),
        });
        await cancelJob(claimedJob.id).catch(() => {
          // best-effort cleanup
        });
      } else {
        throw completeErr;
      }
    }

    logJson("info", "queue_job_completed", {
      request_id: requestId,
      job_id: claimedJob.id,
      job_type: claimedJob.jobType,
      attempt: claimedJob.attempt,
    });
    return result;
  } catch (err) {
    try {
      await failJob(claimedJob, err, { backoffMs: RETRY_BACKOFF_MS });
    } catch (failErr) {
      if (isRedisTransientQueueError(failErr)) {
        logJson("warn", "queue_fail_transient_error", {
          request_id: requestId,
          job_id: claimedJob?.id || null,
          job_type: claimedJob?.jobType || null,
          error: String(failErr?.message || failErr),
        });
      } else {
        throw failErr;
      }
    }
    logJson("error", "queue_job_failed", {
      request_id: requestId,
      job_id: claimedJob.id,
      job_type: claimedJob.jobType,
      error: err,
    });
    err.queueExecutionStarted = executionStarted;
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    await getQueueStats().catch(() => {
      // best-effort metrics refresh
    });
  }
}

export async function runWithSummaryQueue(fn, {
  jobType = "summary",
  maxAttempts = 1,
  source = "api_inline",
  workerId = INLINE_WORKER_ID,
  requestId = null,
} = {}) {
  try {
    return await runWithSummaryQueueRedis(fn, {
      jobType,
      maxAttempts,
      source,
      workerId,
      requestId,
    });
  } catch (err) {
    if (isRedisTransientQueueError(err) && !err?.queueExecutionStarted) {
      logJson("warn", "queue_redis_fallback_local", {
        request_id: requestId,
        job_type: jobType,
        source,
        error: String(err?.message || err),
      });
      return await runWithLocalQueueFallback(fn, {
        jobType,
        requestId,
      });
    }
    throw err;
  }
}

export async function getFailedJobsPreview(limit = 50) {
  await ensureRedisEnabled();

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  const idsRaw = await queueRedis.exec(["ZREVRANGE", keys.failed, "0", String(safeLimit - 1)]);
  const ids = Array.isArray(idsRaw) ? idsRaw.map((x) => String(x)) : [];
  if (!ids.length) return [];

  const rows = await queueRedis.exec(["HMGET", keys.failedData, ...ids]);
  const values = Array.isArray(rows) ? rows : [];

  return ids.map((id, idx) => {
    const meta = parseJsonSafe(values[idx], null) || {};
    return {
      id,
      jobType: meta.jobType || "summary",
      errorType: meta.errorType || "unknown",
      error: meta.error || null,
      failedAt: Number(meta.failedAt) || null,
      attempt: Number(meta.attempt) || null,
    };
  });
}
