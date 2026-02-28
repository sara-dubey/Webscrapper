import { prisma } from "../db/prisma.js";

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

async function fetchUserAdminState(userId) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        "id",
        "email",
        COALESCE("role", 'user') AS "role",
        COALESCE("disabled", false) AS "disabled"
      FROM "user_account"
      WHERE "id" = ${String(userId)}
      LIMIT 1
    `;
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    const fallbackRows = await prisma.$queryRaw`
      SELECT "id", "email"
      FROM "user_account"
      WHERE "id" = ${String(userId)}
      LIMIT 1
    `;
    if (!Array.isArray(fallbackRows) || !fallbackRows.length) return null;
    return {
      ...fallbackRows[0],
      role: "user",
      disabled: false,
    };
  }
}

function normalizeRole(row) {
  const email = String(row?.email || "").toLowerCase();
  if (SUPERADMIN_EMAILS.has(email)) return "superadmin";

  const role = String(row?.role || "user").toLowerCase();
  if (role === "admin" || role === "superadmin") return role;

  if (ADMIN_EMAILS.has(email)) return "admin";
  return "user";
}

export async function requireAdmin(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }

    const row = await fetchUserAdminState(req.userId);
    if (!row) {
      return res.status(401).json({ ok: false, error: "User not found" });
    }

    if (row.disabled === true || String(row.disabled) === "t") {
      return res.status(403).json({ ok: false, error: "User account is disabled" });
    }

    const role = normalizeRole(row);
    if (role !== "admin" && role !== "superadmin") {
      return res.status(403).json({ ok: false, error: "Admin access required" });
    }

    req.adminUser = {
      id: String(row.id),
      email: String(row.email || ""),
      role,
      disabled: false,
    };

    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

const mutationBuckets = new Map();
const MUTATION_LIMIT = Number(process.env.ADMIN_MUTATION_RATE_LIMIT || 20);
const MUTATION_WINDOW_MS = Number(process.env.ADMIN_MUTATION_RATE_WINDOW_MS || 60_000);

export function adminMutationRateLimit(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

  const actorId = String(req.adminUser?.id || req.userId || "anon");
  const key = `${actorId}:${method}:${req.route?.path || req.path || "admin"}`;

  const now = Date.now();
  const item = mutationBuckets.get(key);
  if (!item || now >= item.resetAt) {
    mutationBuckets.set(key, { count: 1, resetAt: now + MUTATION_WINDOW_MS });
    return next();
  }

  item.count += 1;
  mutationBuckets.set(key, item);

  if (item.count > MUTATION_LIMIT) {
    const retryAfterSec = Math.max(1, Math.ceil((item.resetAt - now) / 1000));
    res.setHeader("retry-after", String(retryAfterSec));
    return res.status(429).json({
      ok: false,
      error: "Too many admin mutations. Please retry later.",
      retry_after_sec: retryAfterSec,
    });
  }

  return next();
}

export function requireSuperAdmin(req, res, next) {
  if (String(req.adminUser?.role || "") !== "superadmin") {
    return res.status(403).json({ ok: false, error: "Superadmin access required" });
  }
  return next();
}
