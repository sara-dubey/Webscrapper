import crypto from "node:crypto";

const LOG_LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const currentLevel = LOG_LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;

function canLog(level) {
  const n = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return n <= currentLevel;
}

function safeData(value) {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: value.code,
      status: value.status,
    };
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function logJson(level, message, fields = {}) {
  const lvl = String(level || "info").toLowerCase();
  if (!canLog(lvl)) return;

  const payload = {
    ts: new Date().toISOString(),
    level: lvl,
    message: String(message || ""),
    ...safeData(fields),
  };

  const line = JSON.stringify(payload);
  if (lvl === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function makeRequestId(req) {
  const headerRid = req?.get?.("x-request-id") || req?.headers?.["x-request-id"];
  if (headerRid) return String(headerRid);
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

export function requestLoggerMiddleware(req, res, next) {
  const requestId = makeRequestId(req);
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logJson("info", "http_request", {
      request_id: requestId,
      method: req.method,
      route: req.originalUrl,
      status: res.statusCode,
      duration_ms: Number(elapsedMs.toFixed(3)),
      user_id: req.userId || null,
      ip: req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
    });
  });

  next();
}
