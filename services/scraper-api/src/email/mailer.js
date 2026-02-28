import nodemailer from "nodemailer";

let transporter = null;

export function getEmailMode() {
  const mode = clean(process.env.AUTH_EMAIL_MODE || "smtp").toLowerCase();
  return mode === "console" ? "console" : "smtp";
}

function clean(value) {
  return String(value ?? "").trim();
}

function isPlaceholder(value) {
  const v = clean(value).toLowerCase();
  if (!v) return true;
  return /your[._-]|example|changeme|placeholder/.test(v);
}

function parseBool(value, fallback = false) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

export function getMailerConfig() {
  const service = clean(process.env.SMTP_SERVICE);
  const host = clean(process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT || (service ? 0 : 587));
  const secure = parseBool(process.env.SMTP_SECURE, port === 465);
  const user = clean(process.env.SMTP_USER).toLowerCase();
  const pass = clean(process.env.SMTP_PASS).replace(/\s+/g, "");
  const from = clean(process.env.SMTP_FROM) || user;

  return { service, host, port, secure, user, pass, from };
}

export function isMailerConfigured() {
  if (getEmailMode() === "console") return true;

  const cfg = getMailerConfig();
  const hasTarget = Boolean((cfg.service && !isPlaceholder(cfg.service)) || (cfg.host && !isPlaceholder(cfg.host)));
  const hasPortForHost = cfg.service ? true : Boolean(cfg.port);
  return Boolean(hasTarget && hasPortForHost && cfg.from && cfg.user && cfg.pass
    && !isPlaceholder(cfg.user)
    && !isPlaceholder(cfg.pass)
    && !isPlaceholder(cfg.from));
}

export function getMissingMailerConfigKeys() {
  if (getEmailMode() === "console") return [];

  const cfg = getMailerConfig();
  const missing = [];
  if ((!cfg.service || isPlaceholder(cfg.service)) && (!cfg.host || isPlaceholder(cfg.host))) missing.push("SMTP_SERVICE or SMTP_HOST");
  if (!cfg.service && !cfg.port) missing.push("SMTP_PORT");
  if (!cfg.user || isPlaceholder(cfg.user)) missing.push("SMTP_USER");
  if (!cfg.pass || isPlaceholder(cfg.pass)) missing.push("SMTP_PASS");
  if (!cfg.from || isPlaceholder(cfg.from)) missing.push("SMTP_FROM");
  return missing;
}

function getTransporter() {
  if (transporter) return transporter;

  const cfg = getMailerConfig();
  const options = {
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  };

  if (cfg.service) {
    options.service = cfg.service;
  } else {
    options.host = cfg.host;
    options.port = cfg.port;
    options.secure = cfg.secure;
  }

  transporter = nodemailer.createTransport(options);

  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  if (getEmailMode() === "console") {
    console.log("[email:console]", JSON.stringify({ to, subject, text }, null, 2));
    return { accepted: [to], response: "console" };
  }

  if (!isMailerConfigured()) {
    const missing = getMissingMailerConfigKeys();
    console.error(`[email/config] Missing SMTP config: ${missing.join(", ")}`);
    throw new Error("Email service is not available right now.");
  }

  const cfg = getMailerConfig();
  const tx = getTransporter();

  return await tx.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
    html,
  });
}

export async function sendVerificationCodeEmail({ to, code }) {
  const subject = "Your PAPER-AI verification code";
  const text = `Your verification code is ${code}. It expires in 10 minutes.`;
  const html = `<p>Your verification code is <b>${code}</b>.</p><p>It expires in 10 minutes.</p>`;

  return await sendEmail({ to, subject, text, html });
}

export async function sendPasswordResetEmail({ to, resetLink }) {
  const subject = "Reset your PAPER-AI password";
  const text = `Reset your password using this link: ${resetLink}`;
  const html = `<p>Reset your password using this link:</p><p><a href="${resetLink}">${resetLink}</a></p>`;

  return await sendEmail({ to, subject, text, html });
}
