import crypto from "crypto";
import express from "express";
import bcrypt from "bcryptjs";

import { prisma } from "../db/prisma.js";
import {
  getGoogleRedirectCandidates,
  isAllowedGoogleRedirectUri,
  makeGoogleClient,
  pickGoogleRedirectUri,
} from "../auth/google.js";
import { signAccess } from "../auth/jwt.js";
import {
  checkPasswordStrength,
  getPasswordPolicy,
  getPasswordRuleText,
} from "../auth/password.js";
import {
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from "../email/mailer.js";

const router = express.Router();

const RESET_TOKEN_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MS || 30 * 60 * 1000);
const VERIFICATION_CODE_TTL_MS = Number(process.env.EMAIL_VERIFICATION_CODE_TTL_MS || 10 * 60 * 1000);
const VERIFICATION_CODE_MAX_ATTEMPTS = Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS || 5);
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.CORS_ORIGIN || "http://localhost:3000";
const IS_DEV = process.env.NODE_ENV !== "production";

function normalizeHttpOrigin(raw) {
  const txt = String(raw || "").trim();
  if (!txt) return null;
  try {
    const u = new URL(txt);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function allowedAppOrigins() {
  const out = new Set();
  const add = (v) => {
    const n = normalizeHttpOrigin(v);
    if (n) out.add(n);
  };
  add(APP_BASE_URL);
  String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach(add);
  return Array.from(out);
}

function deriveAppOriginFromRequest(req) {
  const allowed = allowedAppOrigins();
  if (!allowed.length) return normalizeHttpOrigin(APP_BASE_URL) || "http://localhost:3000";
  const allowedSet = new Set(allowed);

  const fromOrigin = normalizeHttpOrigin(req?.get?.("origin"));
  if (fromOrigin && allowedSet.has(fromOrigin)) return fromOrigin;

  const fromReferer = (() => {
    const ref = String(req?.get?.("referer") || "").trim();
    if (!ref) return null;
    try {
      return normalizeHttpOrigin(new URL(ref).origin);
    } catch {
      return null;
    }
  })();
  if (fromReferer && allowedSet.has(fromReferer)) return fromReferer;

  return normalizeHttpOrigin(APP_BASE_URL) || allowed[0];
}

function pickStateAppOrigin(state) {
  const candidate = normalizeHttpOrigin(state?.app);
  if (!candidate) return null;
  return allowedAppOrigins().includes(candidate) ? candidate : null;
}

function publicError(e, fallback) {
  const message = String(e?.message || "").trim();
  if (/email service is not available/i.test(message)) {
    return "Unable to send email right now. Please try again shortly.";
  }
  if (/invalid login|username and password not accepted|eauth/i.test(message)) {
    return "SMTP authentication failed. Check SMTP_USER and SMTP_PASS. If your provider requires an app password, use that.";
  }
  if (/enotfound|getaddrinfo|econnrefused|etimedout|ehostunreach/i.test(message)) {
    return "SMTP server could not be reached. Check SMTP_SERVICE or SMTP_HOST/SMTP_PORT settings.";
  }
  if (!IS_DEV) return fallback;
  return message || fallback;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function parseName(name) {
  const value = String(name || "").trim();
  return value ? value.slice(0, 120) : null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashEmailCode(email, code) {
  const pepper = process.env.EMAIL_VERIFICATION_CODE_PEPPER || "email_code_pepper";
  return hashToken(`${normalizeEmail(email)}:${String(code || "")}:${pepper}`);
}

function createVerificationCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

async function fetchUserAdminFlags(userId) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE("disabled", false) AS "disabled",
        COALESCE("role", 'user') AS "role"
      FROM "user_account"
      WHERE "id" = ${String(userId)}
      LIMIT 1
    `;
    if (!Array.isArray(rows) || !rows.length) return { disabled: false, role: "user" };
    return {
      disabled: rows[0].disabled === true || String(rows[0].disabled) === "t",
      role: String(rows[0].role || "user"),
    };
  } catch {
    return { disabled: false, role: "user" };
  }
}

function buildResetLink(rawToken) {
  const url = new URL("/auth/reset-password", APP_BASE_URL);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

function encodeGoogleState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeGoogleState(rawState) {
  const state = String(rawState || "").trim();
  if (!state) return null;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

router.get("/password-rules", (_req, res) => {
  res.json({
    ok: true,
    policy: getPasswordPolicy(),
    hints: getPasswordRuleText(),
  });
});

router.post("/register/send-code", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email address" });
    }

    const existing = await prisma.userAccount.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return res.status(409).json({ ok: false, error: "An account with that email already exists" });
    }

    const code = createVerificationCode();
    const codeHash = hashEmailCode(email, code);
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);

    await prisma.userEmailVerificationCode.upsert({
      where: { email },
      create: {
        email,
        codeHash,
        expiresAt,
        consumedAt: null,
        attempts: 0,
      },
      update: {
        codeHash,
        expiresAt,
        consumedAt: null,
        attempts: 0,
      },
    });

    await sendVerificationCodeEmail({ to: email, code });

    return res.json({ ok: true, message: "Verification code sent." });
  } catch (e) {
    console.error("[auth/register/send-code]", e);
    return res.status(500).json({ ok: false, error: publicError(e, "Could not send verification code right now. Please try again.") });
  }
});

router.post("/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const name = parseName(req.body?.name);
    const verificationCode = String(req.body?.verificationCode || "").trim();

    if (!name || !email || !password || !verificationCode) {
      return res.status(400).json({ ok: false, error: "name, email, password, and verificationCode are required" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email address" });
    }

    const pwd = checkPasswordStrength(password, { email });
    if (!pwd.ok) {
      return res.status(400).json({
        ok: false,
        error: "Password does not meet policy",
        passwordErrors: pwd.errors,
        passwordHints: pwd.hints,
      });
    }

    const existing = await prisma.userAccount.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return res.status(409).json({ ok: false, error: "An account with that email already exists" });
    }

    const record = await prisma.userEmailVerificationCode.findUnique({ where: { email } });

    if (!record || record.consumedAt || record.expiresAt <= new Date()) {
      return res.status(400).json({ ok: false, error: "Invalid or expired verification code" });
    }

    if (record.attempts >= VERIFICATION_CODE_MAX_ATTEMPTS) {
      return res.status(400).json({ ok: false, error: "Too many invalid attempts. Request a new code." });
    }

    const expectedHash = hashEmailCode(email, verificationCode);
    if (record.codeHash !== expectedHash) {
      await prisma.userEmailVerificationCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ ok: false, error: "Invalid or expired verification code" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
        },
        select: { id: true, email: true, name: true },
      });

      await tx.emailVerificationCode.update({
        where: { email },
        data: {
          consumedAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      return created;
    });

    const accessToken = signAccess(user.id);

    return res.json({
      ok: true,
      accessToken,
      token: accessToken,
      user,
    });
  } catch (e) {
    console.error("[auth/register]", e);
    return res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email and password are required" });
    }

    const user = await prisma.userAccount.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        password: true,
      },
    });

    if (!user?.password) {
      return res.status(401).json({ ok: false, error: "Invalid email or password" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ ok: false, error: "Invalid email or password" });
    }

    const flags = await fetchUserAdminFlags(user.id);
    if (flags.disabled) {
      return res.status(403).json({ ok: false, error: "Account is disabled" });
    }

    const accessToken = signAccess(user.id);

    return res.json({
      ok: true,
      accessToken,
      token: accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: flags.role },
    });
  } catch (e) {
    console.error("[auth/login]", e);
    return res.status(500).json({ ok: false, error: "Login failed" });
  }
});

router.post("/password/forgot", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }

    const generic = {
      ok: true,
      message: "If the account exists, reset instructions were sent.",
    };

    const user = await prisma.userAccount.findUnique({
      where: { email },
      select: { id: true },
    });

    if (!user) {
      return res.json(generic);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await prisma.userPasswordResetToken.deleteMany({
      where: {
        userId: user.id,
        usedAt: null,
      },
    });

    await prisma.userPasswordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    const resetLink = buildResetLink(rawToken);
    await sendPasswordResetEmail({ to: email, resetLink });

    return res.json(generic);
  } catch (e) {
    console.error("[auth/password/forgot]", e);
    return res.status(500).json({ ok: false, error: publicError(e, "Could not send reset instructions right now. Please try again.") });
  }
});

router.post("/password/reset", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const newPassword = String(req.body?.password || "");

    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "token and password are required" });
    }

    const tokenHash = hashToken(token);
    const reset = await prisma.userPasswordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: { id: true, email: true },
        },
      },
    });

    if (!reset || !reset.user) {
      return res.status(400).json({ ok: false, error: "Invalid or expired reset token" });
    }

    const pwd = checkPasswordStrength(newPassword, { email: reset.user.email });
    if (!pwd.ok) {
      return res.status(400).json({
        ok: false,
        error: "Password does not meet policy",
        passwordErrors: pwd.errors,
        passwordHints: pwd.hints,
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.userAccount.update({
        where: { id: reset.user.id },
        data: { password: hashedPassword },
      }),
      prisma.userPasswordResetToken.update({
        where: { id: reset.id },
        data: { usedAt: new Date() },
      }),
      prisma.userPasswordResetToken.deleteMany({
        where: {
          userId: reset.user.id,
          id: { not: reset.id },
          usedAt: null,
        },
      }),
    ]);

    return res.json({ ok: true, message: "Password has been reset" });
  } catch (e) {
    console.error("[auth/password/reset]", e);
    return res.status(500).json({ ok: false, error: "Could not reset password" });
  }
});

router.get("/google/start", (req, res) => {
  const redirectUri = pickGoogleRedirectUri(req);
  if (!redirectUri) {
    return res.status(500).send("Google auth is not configured. Missing redirect URI.");
  }

  const client = makeGoogleClient(redirectUri);
  const state = encodeGoogleState({
    ru: redirectUri,
    app: deriveAppOriginFromRequest(req),
    t: Date.now(),
  });
  const url = client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "consent",
    redirect_uri: redirectUri,
    state,
  });
  res.redirect(url);
});

async function handleGoogleCallback(req, res) {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    const state = decodeGoogleState(req.query.state);
    const stateRedirectUri = String(state?.ru || "").trim();
    const redirectUri =
      stateRedirectUri && isAllowedGoogleRedirectUri(stateRedirectUri, req)
        ? stateRedirectUri
        : pickGoogleRedirectUri(req);

    if (!redirectUri) {
      return res.status(500).send("Google auth is not configured. Missing redirect URI.");
    }

    const client = makeGoogleClient(redirectUri);
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    client.setCredentials(tokens);

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload?.email;
    const googleId = payload?.sub;
    const name = payload?.name || null;

    if (!email || !googleId) return res.status(400).send("Invalid Google payload");

    const user = await prisma.userAccount.upsert({
      where: { email },
      update: { name },
      create: { email, name, password: null },
      select: { id: true, email: true, name: true },
    });

    const accessToken = signAccess(user.id);
    const appOrigin = pickStateAppOrigin(state) || deriveAppOriginFromRequest(req);
    const redirectUrl = new URL("/auth/callback", appOrigin || APP_BASE_URL);
    redirectUrl.searchParams.set("accessToken", accessToken);
    redirectUrl.searchParams.set("token", accessToken);

    res.redirect(redirectUrl.toString());
  } catch (e) {
    console.error("[google/callback]", e);

    const errorText = String(e?.message || e || "");
    if (/redirect_uri_mismatch/i.test(errorText)) {
      const expected = pickGoogleRedirectUri(req) || "(missing)";
      const candidates = getGoogleRedirectCandidates(req);
      return res.status(400).send(
        `Google redirect_uri_mismatch. Add this URI in Google Cloud OAuth client: ${expected}. Also allow: ${candidates.join(", ")}`
      );
    }

    res.status(500).send("Google auth failed");
  }
}

router.get("/google/callback", handleGoogleCallback);
router.get("/callback", handleGoogleCallback);

router.get("/google/config", (req, res) => {
  const selectedRedirectUri = pickGoogleRedirectUri(req);
  const redirectCandidates = getGoogleRedirectCandidates(req);
  res.json({
    ok: true,
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    selectedRedirectUri,
    redirectCandidates,
    callbackRoutes: ["/auth/google/callback", "/auth/callback"],
  });
});

export default router;
