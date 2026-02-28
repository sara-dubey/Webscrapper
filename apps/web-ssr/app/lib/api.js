// apps/web-ssr/app/lib/api.js
// Client-side helper for calling scraper-api (Node backend)

export function getApiBase() {
  const explicit = process.env.NEXT_PUBLIC_API_BASE;
  if (explicit) return explicit;

  if (typeof window !== "undefined") {
    const host = window.location.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
    return `http://${host}:3001`;
  }

  return "http://localhost:3001";
}

const TOKEN_KEY = "paper_ai_token";

export function getToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}


function normalizeErrorMessage(raw, status) {
  const txt = String(raw || "").trim();
  if (!txt) return `HTTP ${status}`;

  const pre = txt.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (pre?.[1]) return pre[1].replace(/\s+/g, " ").trim();

  if (/<!doctype html>/i.test(txt)) {
    const noTags = txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return noTags || `HTTP ${status}`;
  }

  return txt;
}

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function extractUserQuotaHeaders(res) {
  if (!res?.headers) return null;
  const kind = String(res.headers.get("x-userquota-kind") || "").trim();
  if (!kind) return null;

  const limit = toSafeInt(res.headers.get("x-userquota-limit"));
  const remaining = toSafeInt(res.headers.get("x-userquota-remaining"));
  const count = toSafeInt(res.headers.get("x-userquota-count"));
  const resetAt = String(res.headers.get("x-userquota-resetat") || "").trim() || null;

  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;

  return {
    kind,
    limit,
    remaining,
    count,
    resetAt,
  };
}

function readTokenFromPayload(payload) {
  return payload?.access_token || payload?.token || payload?.accessToken || "";
}

async function http(path, { method = "GET", headers = {}, body } = {}) {
  const base = getApiBase();
  const url = path.startsWith("http") ? path : `${base}${path}`;

  const token = getToken();
  const h = {
    Accept: "application/json",
    ...headers,
  };

  if (body !== undefined && !h["Content-Type"]) {
    h["Content-Type"] = "application/json";
  }

  if (token) h.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    credentials: "include",
  });

  const text = await res.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: text || `HTTP ${res.status}` };
  }

  const headerQuota = extractUserQuotaHeaders(res);

  if (!res.ok) {
    const err = new Error(normalizeErrorMessage(data?.error || "", res.status));
    err.status = res.status;
    err.data = data;
    err.code = data?.code || null;
    err.retryAfterSec = data?.retry_after_sec ?? null;
    err.resetAt = data?.reset_at || null;
    err.quota = data?.quota || headerQuota || null;
    throw err;
  }

  if (data && typeof data === "object" && headerQuota) {
    return {
      ...data,
      _quota: headerQuota,
    };
  }

  return data;
}

export async function getPasswordRules() {
  try {
    return await http("/auth/password-rules");
  } catch {
    return {
      ok: true,
      hints: [
        "Use at least 12 characters.",
        "Include uppercase, lowercase, number, and symbol.",
        "Do not use spaces.",
      ],
    };
  }
}

export async function login(email, password) {
  const out = await http("/auth/login", {
    method: "POST",
    body: { email, password },
  });

  const token = readTokenFromPayload(out);
  if (token) setToken(token);

  return out;
}

export async function sendRegisterVerificationCode(email) {
  return await http("/auth/register/send-code", {
    method: "POST",
    body: { email },
  });
}

export async function register(email, password, verificationCode, name = "") {
  const out = await http("/auth/register", {
    method: "POST",
    body: { email, password, verificationCode, name },
  });

  const token = readTokenFromPayload(out);
  if (token) setToken(token);

  return out;
}

export async function requestPasswordReset(email) {
  return await http("/auth/password/forgot", {
    method: "POST",
    body: { email },
  });
}

export async function resetPassword(token, password) {
  return await http("/auth/password/reset", {
    method: "POST",
    body: { token, password },
  });
}

export async function me() {
  return await http("/me");
}

export async function listSearches() {
  return await http("/api/search");
}

export async function getSearch(id) {
  return await http(`/api/search/${encodeURIComponent(id)}`);
}

export async function runPaper(query, limit = 5, note = "") {
  return await http("/api/paper", {
    method: "POST",
    body: { query, limit, note },
  });
}

export async function ragAsk(question, searchId = "", k = 6, history = []) {
  const cleanHistory = Array.isArray(history)
    ? history
        .map((row) => ({
          role: String(row?.role || "").trim(),
          text: String(row?.text || "").trim(),
        }))
        .filter((row) => (row.role === "user" || row.role === "assistant") && row.text)
        .slice(-8)
    : [];

  return await http("/api/rag/query", {
    method: "POST",
    body: {
      question,
      searchId: searchId || undefined,
      k,
      answer: true,
      history: cleanHistory.length ? cleanHistory : undefined,
    },
  });
}

export async function ragReindex(searchId) {
  return await http("/api/rag/reindex", {
    method: "POST",
    body: { searchId },
  });
}

export async function listHighlights({ paperId = "", source = "", externalId = "" } = {}) {
  const params = new URLSearchParams();
  if (paperId) params.set("paperId", paperId);
  if (!paperId && source) params.set("source", source);
  if (!paperId && externalId) params.set("externalId", externalId);
  const qs = params.toString();
  return await http(`/api/highlights${qs ? `?${qs}` : ""}`);
}

export async function createHighlight(payload) {
  return await http("/api/highlights", {
    method: "POST",
    body: payload,
  });
}

export async function deleteHighlight(id) {
  return await http(`/api/highlights/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getPaperNote(paperId) {
  const id = String(paperId || "").trim();
  if (!id) throw new Error("paperId is required");
  return await http(`/api/notes?paperId=${encodeURIComponent(id)}`);
}

export async function savePaperNote(paperId, note) {
  const id = String(paperId || "").trim();
  if (!id) throw new Error("paperId is required");
  return await http("/api/notes", {
    method: "PUT",
    body: { paperId: id, note: String(note || "") },
  });
}

export async function getAnalyticsOverview(days = 7) {
  const rangeDays = Math.max(7, Math.min(30, Number(days) || 7));
  return await http(`/api/analytics/overview?days=${rangeDays}`);
}

// -------- Admin Ops --------
export async function adminOpsStatus() {
  return await http("/admin/ops/status");
}

export async function adminPauseQueue() {
  return await http("/admin/ops/queue/pause", { method: "POST", body: {} });
}

export async function adminResumeQueue() {
  return await http("/admin/ops/queue/resume", { method: "POST", body: {} });
}

export async function adminRetryFailed({ scope = "last50", errorType = "" } = {}) {
  const body = { scope };
  if (String(errorType || "").trim()) body.errorType = String(errorType).trim();
  return await http("/admin/ops/queue/retry-failed", { method: "POST", body });
}

export async function adminDrainQueue(confirm = "DRAIN") {
  return await http("/admin/ops/queue/drain", {
    method: "POST",
    body: { confirm: String(confirm || "") },
  });
}

export async function adminClearUserCache({ userId = "", email = "" } = {}) {
  const body = {};
  if (String(userId || "").trim()) body.userId = String(userId).trim();
  if (String(email || "").trim()) body.email = String(email).trim();
  return await http("/admin/ops/cache/clear-user", { method: "POST", body });
}

export async function adminClearPaperCache({ arxiv_id = "", doi = "" } = {}) {
  const body = {};
  if (String(arxiv_id || "").trim()) body.arxiv_id = String(arxiv_id).trim();
  if (String(doi || "").trim()) body.doi = String(doi).trim();
  return await http("/admin/ops/cache/clear-paper", { method: "POST", body });
}

export async function adminClearAllCache(confirm = "CLEAR-ALL") {
  return await http("/admin/ops/cache/clear-all", {
    method: "POST",
    body: { confirm: String(confirm || "") },
  });
}

export async function adminGetConfig() {
  return await http("/admin/config");
}

export async function adminSetConfig(payload = {}) {
  return await http("/admin/config", { method: "POST", body: payload || {} });
}

export async function adminListUsers(search = "") {
  const q = String(search || "").trim();
  const qs = q ? `?search=${encodeURIComponent(q)}` : "";
  return await http(`/admin/users${qs}`);
}

export async function adminDisableUser(id, disabled = true) {
  return await http(`/admin/users/${encodeURIComponent(String(id || "").trim())}/disable`, {
    method: "POST",
    body: { disabled: !!disabled },
  });
}

export async function adminSetUserRole(id, role = "user") {
  return await http(`/admin/users/${encodeURIComponent(String(id || "").trim())}/role`, {
    method: "POST",
    body: { role: String(role || "user").toLowerCase() },
  });
}
