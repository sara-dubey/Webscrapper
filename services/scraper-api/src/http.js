// scraper-api/src/http.js
import { observeDependencyRequest } from "./observability/metrics.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(t) };
}

function jitter(ms) {
  const j = ms * 0.2;
  return Math.max(0, Math.floor(ms - j + Math.random() * (2 * j)));
}

function parseRetryAfterMs(h) {
  if (!h) return null;
  const s = String(h).trim();

  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 0) return asNum * 1000;

  const dt = Date.parse(s);
  if (!Number.isNaN(dt)) {
    const ms = dt - Date.now();
    return ms > 0 ? ms : null;
  }
  return null;
}

function isRetryableNetworkError(e) {
  const name = String(e?.name || "");
  const msg = String(e?.message || "");

  if (name === "AbortError") return true;

  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN")
  )
    return true;

  return false;
}

async function readBodySnippet(res, max = 240) {
  try {
    const txt = await res.text();
    const clean = String(txt).replace(/\s+/g, " ").trim();
    return clean.slice(0, max);
  } catch {
    return "";
  }
}

async function fetchRetry(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 45000,
    retries = 2,
    backoffMs = 800,
    dependency = null,
    retryOn = (status) => status >= 500 || status === 429,
  } = opts;

  let lastErr = null;
  const started = dependency ? process.hrtime.bigint() : null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { signal, done } = makeTimeout(timeoutMs);

    try {
      const res = await fetch(url, { method, headers, body, signal });
      done();

      if (res.ok) {
        if (started) {
          const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
          observeDependencyRequest(dependency, seconds, "success");
        }
        return res;
      }

      const status = res.status;

      if (attempt < retries && retryOn(status)) {
        if (status === 429) {
          const ra = parseRetryAfterMs(res.headers.get("retry-after"));
          const wait = ra ?? jitter(backoffMs * Math.pow(2, attempt));
          await sleep(Math.min(wait, 20000));
          continue;
        }
        const wait = jitter(backoffMs * Math.pow(2, attempt));
        await sleep(Math.min(wait, 12000));
        continue;
      }

      const snippet = await readBodySnippet(res);
      const msg = snippet || res.statusText || "Unknown Error";
      const e = new Error(`HTTP ${status} ${msg} :: ${url}`);
      e.status = status;
      throw e;
    } catch (e) {
      done();
      lastErr = e;

      if (attempt < retries && isRetryableNetworkError(e)) {
        const wait = jitter(backoffMs * Math.pow(2, attempt));
        await sleep(Math.min(wait, 12000));
        continue;
      }

      if (started) {
        const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
        const outcome = e?.name === "AbortError" ? "timeout" : "error";
        observeDependencyRequest(dependency, seconds, outcome);
      }
      throw lastErr;
    }
  }

  if (started && lastErr) {
    const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    observeDependencyRequest(dependency, seconds, "error");
  }
  throw lastErr || new Error("fetch failed");
}

export async function fetchTextRetry(url, opts = {}) {
  const res = await fetchRetry(url, opts);
  return res.text();
}

export async function fetchJsonRetry(url, opts = {}) {
  const res = await fetchRetry(url, opts);
  const txt = await res.text();

  try {
    return JSON.parse(txt);
  } catch {
    const preview = String(txt).replace(/\s+/g, " ").trim().slice(0, 240);
    const e = new Error(`Invalid JSON from ${url}: ${preview}`);
    e.raw = txt.slice(0, 1200);
    throw e;
  }
}
