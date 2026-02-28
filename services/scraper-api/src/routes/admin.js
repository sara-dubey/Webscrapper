import { Router } from "express";

import { requireAuth } from "../auth/middleware.js";
import {
  adminMutationRateLimit,
  requireAdmin,
  requireSuperAdmin,
} from "../admin/authz.js";
import { getEffectiveAdminConfig, normalizeConfigPayload, upsertAdminConfigValues } from "../admin/configService.js";
import { getOpsStatus } from "../admin/opsService.js";
import { listUsers, setUserDisabled, setUserRole } from "../admin/userService.js";
import {
  drainWaitingQueue,
  getQueueStats,
  pauseQueue,
  resumeQueue,
  retryFailedJobs,
} from "../queue/summaryQueue.js";
import { clearAllCaches, clearCacheByIdentifier, getCacheStats } from "../cache/cache.js";
import { deleteByPattern } from "../infra/redisOps.js";

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);
router.use(requireSuperAdmin);
router.use(adminMutationRateLimit);

async function auditMutation() {}

router.get("/ops/status", async (req, res) => {
  try {
    const status = await getOpsStatus();
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/queue/pause", async (req, res) => {
  try {
    const out = await pauseQueue();
    await auditMutation(req, {
      action: "queue_pause",
      targetType: "queue",
      targetId: "summary",
      payload: {},
      result: "ok",
    });
    return res.json({ ok: true, queue: out, stats: await getQueueStats() });
  } catch (err) {
    await auditMutation(req, {
      action: "queue_pause",
      targetType: "queue",
      targetId: "summary",
      payload: {},
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/queue/resume", async (req, res) => {
  try {
    const out = await resumeQueue();
    await auditMutation(req, {
      action: "queue_resume",
      targetType: "queue",
      targetId: "summary",
      payload: {},
      result: "ok",
    });
    return res.json({ ok: true, queue: out, stats: await getQueueStats() });
  } catch (err) {
    await auditMutation(req, {
      action: "queue_resume",
      targetType: "queue",
      targetId: "summary",
      payload: {},
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/queue/retry-failed", async (req, res) => {
  const scope = String(req.body?.scope || "last50").trim();
  const errorType = req.body?.errorType ? String(req.body.errorType) : null;

  if (!["last50", "last1h", "all"].includes(scope)) {
    return res.status(400).json({ ok: false, error: "scope must be one of: last50 | last1h | all" });
  }

  try {
    const out = await retryFailedJobs({ scope, errorType });
    await auditMutation(req, {
      action: "queue_retry_failed",
      targetType: "queue",
      targetId: "summary",
      payload: { scope, errorType },
      result: "ok",
    });
    return res.json({ ok: true, ...out, stats: await getQueueStats() });
  } catch (err) {
    await auditMutation(req, {
      action: "queue_retry_failed",
      targetType: "queue",
      targetId: "summary",
      payload: { scope, errorType },
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/queue/drain", async (req, res) => {
  const confirm = String(req.body?.confirm || "").trim();
  if (confirm !== "DRAIN") {
    await auditMutation(req, {
      action: "queue_drain",
      targetType: "queue",
      targetId: "summary",
      payload: { confirm },
      result: "rejected:confirm_required",
    });
    return res.status(400).json({ ok: false, error: 'Dangerous operation: provide confirm="DRAIN"' });
  }

  try {
    const out = await drainWaitingQueue();
    await auditMutation(req, {
      action: "queue_drain",
      targetType: "queue",
      targetId: "summary",
      payload: { confirm: "DRAIN" },
      result: "ok",
    });
    return res.json({ ok: true, ...out, stats: await getQueueStats() });
  } catch (err) {
    await auditMutation(req, {
      action: "queue_drain",
      targetType: "queue",
      targetId: "summary",
      payload: { confirm: "DRAIN" },
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/cache/clear-user", async (req, res) => {
  const token = String(req.body?.userId || req.body?.email || "").trim();
  if (!token) {
    return res.status(400).json({ ok: false, error: "Provide userId or email" });
  }

  const rateLimitPrefix = process.env.RATE_LIMIT_KEY_PREFIX || "api_rl";

  try {
    const cacheOut = await clearCacheByIdentifier(token);
    const rateOut = await deleteByPattern(`${rateLimitPrefix}:*${token}*`, { max: 20_000 });
    await auditMutation(req, {
      action: "cache_clear_user",
      targetType: "cache",
      targetId: token,
      payload: { token },
      result: "ok",
    });
    return res.json({
      ok: true,
      token,
      cache: cacheOut,
      rateLimit: rateOut,
      cacheStats: getCacheStats(),
    });
  } catch (err) {
    await auditMutation(req, {
      action: "cache_clear_user",
      targetType: "cache",
      targetId: token,
      payload: { token },
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/cache/clear-paper", async (req, res) => {
  const token = String(req.body?.arxiv_id || req.body?.doi || "").trim();
  if (!token) {
    return res.status(400).json({ ok: false, error: "Provide arxiv_id or doi" });
  }

  try {
    const cacheOut = await clearCacheByIdentifier(token);
    await auditMutation(req, {
      action: "cache_clear_paper",
      targetType: "cache",
      targetId: token,
      payload: { token },
      result: "ok",
    });
    return res.json({ ok: true, token, cache: cacheOut, cacheStats: getCacheStats() });
  } catch (err) {
    await auditMutation(req, {
      action: "cache_clear_paper",
      targetType: "cache",
      targetId: token,
      payload: { token },
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/ops/cache/clear-all", requireSuperAdmin, async (req, res) => {
  const confirm = String(req.body?.confirm || "").trim();
  if (confirm !== "CLEAR-ALL") {
    await auditMutation(req, {
      action: "cache_clear_all",
      targetType: "cache",
      targetId: "all",
      payload: { confirm },
      result: "rejected:confirm_required",
    });
    return res.status(400).json({ ok: false, error: 'Dangerous operation: provide confirm="CLEAR-ALL"' });
  }

  const rateLimitPrefix = process.env.RATE_LIMIT_KEY_PREFIX || "api_rl";

  try {
    const cacheOut = await clearAllCaches();
    const rateOut = await deleteByPattern(`${rateLimitPrefix}:*`, { max: 200_000 });
    await auditMutation(req, {
      action: "cache_clear_all",
      targetType: "cache",
      targetId: "all",
      payload: { confirm: "CLEAR-ALL" },
      result: "ok",
    });
    return res.json({
      ok: true,
      cache: cacheOut,
      rateLimit: rateOut,
      cacheStats: getCacheStats(),
    });
  } catch (err) {
    await auditMutation(req, {
      action: "cache_clear_all",
      targetType: "cache",
      targetId: "all",
      payload: { confirm: "CLEAR-ALL" },
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.get("/config", async (_req, res) => {
  try {
    const out = await getEffectiveAdminConfig();
    return res.json({ ok: true, values: out.values, rows: out.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/config", async (req, res) => {
  const normalized = normalizeConfigPayload(req.body || {});
  const entries = Object.entries(normalized).filter(([, value]) => value != null);

  if (!entries.length) {
    return res.status(400).json({ ok: false, error: "No valid config fields found" });
  }

  try {
    const out = await upsertAdminConfigValues(normalized, req.adminUser?.id || req.userId || null);
    await auditMutation(req, {
      action: "config_update",
      targetType: "admin_config",
      targetId: "global",
      payload: normalized,
      result: "ok",
    });
    return res.json({ ok: true, ...out });
  } catch (err) {
    await auditMutation(req, {
      action: "config_update",
      targetType: "admin_config",
      targetId: "global",
      payload: normalized,
      result: `error:${String(err?.message || err)}`,
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.get("/users", async (req, res) => {
  const search = req.query?.search ? String(req.query.search) : null;
  const limit = req.query?.limit ? Number(req.query.limit) : 50;
  const offset = req.query?.offset ? Number(req.query.offset) : 0;

  try {
    const users = await listUsers({ search, limit, offset });
    return res.json({ ok: true, users });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/users/:id/disable", async (req, res) => {
  const userId = String(req.params.id || "").trim();
  const disabled = req.body?.disabled == null ? true : !!req.body.disabled;

  if (!userId) return res.status(400).json({ ok: false, error: "User id is required" });

  try {
    const user = await setUserDisabled(userId, disabled);
    await auditMutation(req, {
      action: "user_disable",
      targetType: "user",
      targetId: userId,
      payload: { disabled },
      result: "ok",
    });
    return res.json({ ok: true, user });
  } catch (err) {
    await auditMutation(req, {
      action: "user_disable",
      targetType: "user",
      targetId: userId,
      payload: { disabled },
      result: `error:${String(err?.message || err)}`,
    });
    const msg = String(err?.message || err);
    const status = /not found/i.test(msg) ? 404 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
});

router.post("/users/:id/role", async (req, res) => {
  const userId = String(req.params.id || "").trim();
  const role = String(req.body?.role || "").toLowerCase();

  if (!userId) return res.status(400).json({ ok: false, error: "User id is required" });
  if (role !== "admin" && role !== "user") {
    return res.status(400).json({ ok: false, error: "role must be admin or user" });
  }

  try {
    const user = await setUserRole(userId, role);
    await auditMutation(req, {
      action: "user_set_role",
      targetType: "user",
      targetId: userId,
      payload: { role },
      result: "ok",
    });
    return res.json({ ok: true, user });
  } catch (err) {
    await auditMutation(req, {
      action: "user_set_role",
      targetType: "user",
      targetId: userId,
      payload: { role },
      result: `error:${String(err?.message || err)}`,
    });
    const msg = String(err?.message || err);
    const status = /not found/i.test(msg) ? 404 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
});

export default router;
