import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { prisma } from "./db/prisma.js";
import searchRoutes from "./routes/search.js";
import papersRouter from "./routes/papers.js";
import authRoutes from "./routes/auth.js";
import ragRoutes from "./routes/rag.js";
import highlightsRoutes from "./routes/highlights.js";
import notesRoutes from "./routes/notes.js";
import analyticsRoutes from "./routes/analytics.js";
import adminRoutes from "./routes/admin.js";
import { requireAuth } from "./auth/middleware.js";
import { createApiRateLimiter } from "./middleware/apiRateLimit.js";
import { metricsHandler, metricsMiddleware, observeDependencyRequest } from "./observability/metrics.js";
import { logJson, requestLoggerMiddleware } from "./observability/logger.js";
import { getQueueStats } from "./queue/summaryQueue.js";

const PY_HEALTH_TIMEOUT_MS = Number(process.env.PY_HEALTH_TIMEOUT_MS || 1500);
const CHECK_PY_HEALTH = String(process.env.CHECK_PY_HEALTH || "1") !== "0";
const SUPERADMIN_EMAILS = new Set(
  String(process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);

function parseCorsOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeUserRole(roleValue, emailValue) {
  const email = String(emailValue || "").trim().toLowerCase();
  if (email && SUPERADMIN_EMAILS.has(email)) return "superadmin";
  const role = String(roleValue || "user").trim().toLowerCase();
  if (role === "superadmin" || role === "admin") return role;
  return "user";
}

async function probePythonHealth(pyBase) {
  if (!CHECK_PY_HEALTH) {
    return { ok: null, skipped: true, base: pyBase };
  }

  const url = `${String(pyBase).replace(/\/+$/, "")}/health`;
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PY_HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text().catch(() => "");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    observeDependencyRequest("paper_ai", elapsed, response.ok ? "success" : `http_${response.status}`);

    return {
      ok: response.ok,
      status: response.status,
      base: pyBase,
      body,
    };
  } catch (err) {
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    observeDependencyRequest("paper_ai", elapsed, err?.name === "AbortError" ? "timeout" : "error");
    return {
      ok: false,
      base: pyBase,
      error: String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ overrides = {} } = {}) {
  const app = express();
  const port = overrides.port || process.env.PORT || 3001;
  const pyBase = overrides.pyBase || process.env.PY_BASE || "http://127.0.0.1:8000";

  const corsOriginRaw = process.env.CORS_ORIGIN || "http://localhost:3000,http://127.0.0.1:3000";
  const allowedCorsOrigins = parseCorsOrigins(corsOriginRaw);

  const apiRateLimiter = createApiRateLimiter({
    limit: Number(process.env.RATE_LIMIT_MAX || 100),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  });

  app.locals.PY_BASE = pyBase;

  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (allowedCorsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      exposedHeaders: [
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-RateLimit-Backend",
        "RateLimit-Limit",
        "RateLimit-Remaining",
        "RateLimit-Reset",
        "X-UserQuota-Kind",
        "X-UserQuota-Limit",
        "X-UserQuota-Count",
        "X-UserQuota-Remaining",
        "X-UserQuota-ResetAt",
      ],
    })
  );

  app.use(requestLoggerMiddleware);
  app.use(metricsMiddleware);

  const queueStatsRefreshMs = Number(process.env.QUEUE_METRICS_REFRESH_MS || 15_000);
  const timer = setInterval(() => {
    getQueueStats().catch(() => {
      // best-effort metrics refresh
    });
  }, queueStatsRefreshMs);
  if (timer.unref) timer.unref();

  app.get("/metrics", metricsHandler);

  app.get("/health", async (_req, res) => {
    const py = await probePythonHealth(pyBase);
    res.json({ ok: true, node: true, py, port: Number(port) });
  });

  app.use(apiRateLimiter);

  app.use("/auth", authRoutes);

  app.get("/me", requireAuth, async (req, res) => {
    const rid = res?.locals?.requestId || req.get("x-request-id") || "no-rid";

    try {
      const user = await prisma.userAccount.findUnique({
        where: { id: req.userId },
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      });

      if (!user) {
        return res.status(404).json({ ok: false, error: "User not found", request_id: rid });
      }

      return res.json({
        ok: true,
        user: {
          ...user,
          role: normalizeUserRole(user?.role, user?.email),
        },
      });
    } catch (err) {
      logJson("error", "me_route_failed", { request_id: rid, error: err });
      return res.status(500).json({ ok: false, error: String(err?.message || err), request_id: rid });
    }
  });

  app.use("/api/search", searchRoutes);
  app.use("/api/rag", ragRoutes);
  app.use("/api/highlights", highlightsRoutes);
  app.use("/api/notes", notesRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api", papersRouter);

  app.use("/admin", adminRoutes);

  app.use((err, req, res, _next) => {
    const rid = res?.locals?.requestId || req?.get?.("x-request-id") || "no-rid";
    logJson("error", "unhandled_error", {
      request_id: rid,
      route: req?.originalUrl,
      method: req?.method,
      error: err,
    });
    res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || String(err),
      request_id: rid,
    });
  });

  return app;
}
