import { prisma } from "../db/prisma.js";

function normalizeSearch(value) {
  const s = String(value || "").trim();
  return s ? `%${s.replace(/%/g, "\\%").replace(/_/g, "\\_")}%` : null;
}

export async function listUsers({ search = null, limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const pattern = normalizeSearch(search);

  try {
    if (pattern) {
      const rows = await prisma.$queryRaw`
        SELECT
          "id",
          "email",
          COALESCE("role", 'user') AS "role",
          COALESCE("disabled", false) AS "disabled",
          "createdAt"
        FROM "user_account"
        WHERE "email" ILIKE ${pattern}
        ORDER BY "createdAt" DESC
        LIMIT ${safeLimit}
        OFFSET ${safeOffset}
      `;
      return Array.isArray(rows) ? rows : [];
    }

    const rows = await prisma.$queryRaw`
      SELECT
        "id",
        "email",
        COALESCE("role", 'user') AS "role",
        COALESCE("disabled", false) AS "disabled",
        "createdAt"
      FROM "user_account"
      ORDER BY "createdAt" DESC
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `;
    return Array.isArray(rows) ? rows : [];
  } catch {
    const fallbackRows = pattern
      ? await prisma.$queryRaw`
          SELECT "id", "email", "createdAt"
          FROM "user_account"
          WHERE "email" ILIKE ${pattern}
          ORDER BY "createdAt" DESC
          LIMIT ${safeLimit}
          OFFSET ${safeOffset}
        `
      : await prisma.$queryRaw`
          SELECT "id", "email", "createdAt"
          FROM "user_account"
          ORDER BY "createdAt" DESC
          LIMIT ${safeLimit}
          OFFSET ${safeOffset}
        `;

    return (Array.isArray(fallbackRows) ? fallbackRows : []).map((row) => ({
      ...row,
      role: "user",
      disabled: false,
    }));
  }
}

export async function setUserDisabled(userId, disabled) {
  const value = !!disabled;
  try {
    await prisma.$executeRaw`
      UPDATE "user_account"
      SET "disabled" = ${value}
      WHERE "id" = ${String(userId)}
    `;
  } catch (err) {
    if (String(err?.message || "").toLowerCase().includes("column") && String(err?.message || "").toLowerCase().includes("disabled")) {
      throw new Error('Column "user_account.disabled" is missing. Apply latest migration first.');
    }
    throw err;
  }

  const rows = await prisma.$queryRaw`
    SELECT "id", "email", COALESCE("role", 'user') AS "role", COALESCE("disabled", false) AS "disabled", "createdAt"
    FROM "user_account"
    WHERE "id" = ${String(userId)}
    LIMIT 1
  `;

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("User not found");
  }

  return rows[0];
}

export async function setUserRole(userId, role) {
  const safeRole = String(role || "").toLowerCase();
  if (safeRole !== "admin" && safeRole !== "user") {
    throw new Error("role must be one of: admin, user");
  }

  try {
    await prisma.$executeRaw`
      UPDATE "user_account"
      SET "role" = ${safeRole}
      WHERE "id" = ${String(userId)}
    `;
  } catch (err) {
    if (String(err?.message || "").toLowerCase().includes("column") && String(err?.message || "").toLowerCase().includes("role")) {
      throw new Error('Column "user_account.role" is missing. Apply latest migration first.');
    }
    throw err;
  }

  const rows = await prisma.$queryRaw`
    SELECT "id", "email", COALESCE("role", 'user') AS "role", COALESCE("disabled", false) AS "disabled", "createdAt"
    FROM "user_account"
    WHERE "id" = ${String(userId)}
    LIMIT 1
  `;

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("User not found");
  }

  return rows[0];
}
