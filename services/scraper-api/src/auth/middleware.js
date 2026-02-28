import { verifyAccess } from "./jwt.js";

export function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: "Missing Bearer token" });

    const token = m[1].trim();
    const payload = verifyAccess(token);

    req.userId = payload.userId;      // single source of truth
    req.user = { id: payload.userId }; // optional compatibility layer

    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}

export function attachAuthIfPresent(req, _res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return next();

    const token = m[1].trim();
    if (!token) return next();

    const payload = verifyAccess(token);
    req.userId = payload.userId;
    req.user = { id: payload.userId };
  } catch {}
  next();
}
