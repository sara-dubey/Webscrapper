import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";

const state = {
  paused: false,
  waiting: [],
  active: [],
  failed: [],
  completed: [],
  cacheKeys: new Set(),
  rateKeys: new Set(),
};

function resetState() {
  state.paused = false;
  state.waiting = [];
  state.active = [];
  state.failed = [];
  state.completed = [];
  state.cacheKeys = new Set();
  state.rateKeys = new Set();
}

function wildcardPatternToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const queueMock = {
  pauseQueue: jest.fn(async () => {
    state.paused = true;
    return { ok: true, paused: true };
  }),
  resumeQueue: jest.fn(async () => {
    state.paused = false;
    return { ok: true, paused: false };
  }),
  retryFailedJobs: jest.fn(async ({ errorType } = {}) => {
    const nextFailed = [];
    let retried = 0;
    for (const job of state.failed) {
      if (errorType && job.errorType !== errorType) {
        nextFailed.push(job);
        continue;
      }
      state.waiting.push({ ...job, state: "waiting" });
      retried += 1;
    }
    state.failed = nextFailed;
    return { retried, scanned: retried + nextFailed.length };
  }),
  drainWaitingQueue: jest.fn(async () => {
    const removed = state.waiting.length;
    state.waiting = [];
    return { removed };
  }),
  getQueueStats: jest.fn(async () => ({
    paused: state.paused,
    waiting: state.waiting.length,
    active: state.active.length,
    delayed: 0,
    failed: state.failed.length,
    completed: state.completed.length,
    oldestWaitingSeconds: 0,
    workerHeartbeats: 1,
    redisEnabled: true,
  })),
  claimNextJob: jest.fn(async () => {
    if (state.paused) return { status: "PAUSED" };
    if (!state.waiting.length) return { status: "EMPTY" };
    const job = state.waiting.shift();
    state.active.push(job);
    return { status: "OK", jobId: job.id, job };
  }),
};

const cacheMock = {
  clearCacheByIdentifier: jest.fn(async (token) => {
    const before = state.cacheKeys.size;
    const next = new Set();
    for (const key of state.cacheKeys.values()) {
      if (!String(key).includes(String(token))) next.add(key);
    }
    state.cacheKeys = next;
    return { deleted: before - next.size, keysScanned: before };
  }),
  clearAllCaches: jest.fn(async () => {
    const deleted = state.cacheKeys.size;
    state.cacheKeys.clear();
    return { deleted, keysScanned: deleted };
  }),
  getCacheStats: jest.fn(() => ({
    totals: { hits: 0, misses: 0, hitRate: null },
    perCache: {},
    keyPrefix: "paper_cache",
    redisEnabled: true,
  })),
};

const deleteByPattern = jest.fn(async (pattern) => {
  const regex = wildcardPatternToRegex(pattern);
  const before = state.rateKeys.size;
  const next = new Set();
  for (const key of state.rateKeys.values()) {
    if (!regex.test(key)) next.add(key);
  }
  state.rateKeys = next;
  return { deleted: before - next.size, keysScanned: before - next.size };
});

jest.unstable_mockModule("../src/auth/middleware.js", () => ({
  requireAuth(req, res, next) {
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token === "admin-token" || token === "superadmin-token") {
      req.userId = "u-admin";
      return next();
    }
    if (token === "user-token") {
      req.userId = "u-user";
      return next();
    }
    return res.status(401).json({ ok: false, error: "Invalid token" });
  },
}));

jest.unstable_mockModule("../src/admin/authz.js", () => ({
  adminMutationRateLimit(_req, _res, next) {
    return next();
  },
  requireAdmin(req, res, next) {
    if (req.userId !== "u-admin") {
      return res.status(403).json({ ok: false, error: "Admin access required" });
    }
    req.adminUser = {
      id: "u-admin",
      email: "admin@example.com",
      role:
        req.headers.authorization === "Bearer superadmin-token"
          ? "superadmin"
          : "admin",
    };
    return next();
  },
  requireSuperAdmin(req, res, next) {
    if (req.adminUser?.role !== "superadmin") {
      return res.status(403).json({ ok: false, error: "Superadmin access required" });
    }
    return next();
  },
}));

jest.unstable_mockModule("../src/queue/summaryQueue.js", () => queueMock);
jest.unstable_mockModule("../src/cache/cache.js", () => cacheMock);
jest.unstable_mockModule("../src/infra/redisOps.js", () => ({ deleteByPattern }));

jest.unstable_mockModule("../src/admin/configService.js", () => ({
  normalizeConfigPayload: (payload = {}) => payload,
  getEffectiveAdminConfig: jest.fn(async () => ({ values: { rate_limit_max: 100 }, rows: [] })),
  upsertAdminConfigValues: jest.fn(async (payload) => ({ updated: Object.keys(payload || {}).length, values: payload })),
}));

jest.unstable_mockModule("../src/admin/opsService.js", () => ({
  getOpsStatus: jest.fn(async () => ({ ok: true, services: { node: { ok: true } }, queue: {}, cache: {}, activeConfig: {} })),
}));

jest.unstable_mockModule("../src/admin/userService.js", () => ({
  listUsers: jest.fn(async () => [
    { id: "u-admin", email: "admin@example.com", role: "admin", disabled: false },
  ]),
  setUserDisabled: jest.fn(async (id, disabled) => ({ id, email: `${id}@example.com`, disabled })),
  setUserRole: jest.fn(async (id, role) => ({ id, email: `${id}@example.com`, role })),
}));

const { default: adminRouter } = await import("../src/routes/admin.js");
const { claimNextJob } = await import("../src/queue/summaryQueue.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter);
  return app;
}

describe("admin routes", () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    resetState();
  });

  test("auth required", async () => {
    const res = await request(app).post("/admin/ops/queue/pause").send({});
    expect(res.status).toBe(401);
  });

  test("non-admin blocked", async () => {
    const res = await request(app)
      .post("/admin/ops/queue/pause")
      .set("Authorization", "Bearer user-token")
      .send({});

    expect(res.status).toBe(403);
  });

  test("pause prevents new jobs from being claimed", async () => {
    state.waiting.push({ id: "job-1", jobType: "summary" });

    const pauseRes = await request(app)
      .post("/admin/ops/queue/pause")
      .set("Authorization", "Bearer admin-token")
      .send({});

    expect(pauseRes.status).toBe(200);

    const claim = await claimNextJob("worker-1");
    expect(claim.status).toBe("PAUSED");
  });

  test("resume allows processing", async () => {
    state.paused = true;
    state.waiting.push({ id: "job-2", jobType: "summary" });

    const resumeRes = await request(app)
      .post("/admin/ops/queue/resume")
      .set("Authorization", "Bearer admin-token")
      .send({});

    expect(resumeRes.status).toBe(200);

    const claim = await claimNextJob("worker-1");
    expect(claim.status).toBe("OK");
    expect(claim.jobId).toBe("job-2");
  });

  test("drain requires confirm and empties waiting", async () => {
    state.waiting.push({ id: "job-3" }, { id: "job-4" });

    const rejectRes = await request(app)
      .post("/admin/ops/queue/drain")
      .set("Authorization", "Bearer admin-token")
      .send({ confirm: "nope" });

    expect(rejectRes.status).toBe(400);
    expect(state.waiting.length).toBe(2);

    const okRes = await request(app)
      .post("/admin/ops/queue/drain")
      .set("Authorization", "Bearer admin-token")
      .send({ confirm: "DRAIN" });

    expect(okRes.status).toBe(200);
    expect(okRes.body.removed).toBe(2);
    expect(state.waiting.length).toBe(0);
  });

  test("retry-failed requeues expected jobs", async () => {
    state.failed.push(
      { id: "f-1", errorType: "TimeoutError" },
      { id: "f-2", errorType: "ValidationError" }
    );

    const res = await request(app)
      .post("/admin/ops/queue/retry-failed")
      .set("Authorization", "Bearer admin-token")
      .send({ scope: "last50", errorType: "TimeoutError" });

    expect(res.status).toBe(200);
    expect(res.body.retried).toBe(1);
    expect(state.waiting.map((x) => x.id)).toContain("f-1");
    expect(state.waiting.map((x) => x.id)).not.toContain("f-2");
    expect(state.failed.map((x) => x.id)).toEqual(["f-2"]);
  });

  test("cache clear endpoints remove expected key patterns", async () => {
    state.cacheKeys.add("paper_cache:summary:u-123:a1");
    state.cacheKeys.add("paper_cache:summary:u-789:a2");
    state.rateKeys.add("api_rl:u-123:window:1");
    state.rateKeys.add("api_rl:u-789:window:1");

    const userClear = await request(app)
      .post("/admin/ops/cache/clear-user")
      .set("Authorization", "Bearer admin-token")
      .send({ userId: "u-123" });

    expect(userClear.status).toBe(200);
    expect(userClear.body.cache.deleted).toBe(1);
    expect(state.cacheKeys.has("paper_cache:summary:u-123:a1")).toBe(false);
    expect(state.cacheKeys.has("paper_cache:summary:u-789:a2")).toBe(true);

    expect(deleteByPattern).toHaveBeenCalledWith("api_rl:*u-123*", { max: 20_000 });
    expect(state.rateKeys.has("api_rl:u-123:window:1")).toBe(false);
    expect(state.rateKeys.has("api_rl:u-789:window:1")).toBe(true);
  });

});
