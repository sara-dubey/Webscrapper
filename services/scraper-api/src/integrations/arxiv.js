// services/scraper-api/src/integrations/arxiv.js
import { assertProviderQuota } from "./providerQuota.js";
import { observeDependencyRequest } from "../observability/metrics.js";

const ARXIV_BASE_PRIMARY = "https://export.arxiv.org/api/query";
const ARXIV_BASE_FALLBACK = "https://arxiv.org/api/query";

const TIMEOUT_MS = Number(process.env.ARXIV_TIMEOUT_MS || 12000);
const CACHE_TTL_MS = Number(process.env.ARXIV_CACHE_TTL_MS || 60 * 60 * 1000); // 1h
const NEGATIVE_TTL_MS = Number(process.env.ARXIV_NEGATIVE_TTL_MS || 5 * 60 * 1000); // 5m

// total time budget so route-level withTimeout(45s) doesn’t kill it
const TOTAL_BUDGET_MS = Number(process.env.ARXIV_TOTAL_BUDGET_MS || 28000);

const USER_AGENT =
  process.env.ARXIV_USER_AGENT ||
  "Threadline/0.1 (local dev; contact: youremail@example.com)";

const cache = new Map(); // key -> {t, v}
const negative = new Map(); // key -> {t, error}

let nextAllowedAt = 0;
let throttleChain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  throttleChain = throttleChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, nextAllowedAt - now);
    if (wait) await sleep(wait);
    // ~1 request / sec
    nextAllowedAt = Date.now() + 1000;
  });
  return throttleChain;
}

function clean(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function norm(s = "") {
  return clean(s).toLowerCase();
}

function cacheGet(key) {
  const x = cache.get(key);
  if (!x) return null;
  if (Date.now() - x.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return x.v;
}

function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
}

function negGet(key) {
  const x = negative.get(key);
  if (!x) return null;
  if (Date.now() - x.t > NEGATIVE_TTL_MS) {
    negative.delete(key);
    return null;
  }
  return x.error;
}

function negSet(key, error) {
  negative.set(key, { t: Date.now(), error });
}

function decodeXml(s = "") {
  return String(s)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function pickYear(published) {
  const m = String(published || "").match(/^(\d{4})-/);
  return m ? m[1] : null;
}

function firstMatch(block, re) {
  const m = block.match(re);
  return m ? decodeXml(m[1]) : "";
}

function allMatches(block, re) {
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(decodeXml(m[1]));
  return out;
}

function parseAtom(xml) {
  const text = String(xml || "");
  const entries = text.split("<entry>").slice(1);

  const results = [];
  for (const e of entries) {
    const entry = e.split("</entry>")[0];

    const id = firstMatch(entry, /<id>([\s\S]*?)<\/id>/i);
    const title = clean(firstMatch(entry, /<title>([\s\S]*?)<\/title>/i));
    const summary = clean(firstMatch(entry, /<summary>([\s\S]*?)<\/summary>/i));
    const published = firstMatch(entry, /<published>([\s\S]*?)<\/published>/i);
    const updated = firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/i);

    const authors = allMatches(
      entry,
      /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi
    )
      .map(clean)
      .filter(Boolean);

    const primaryCategory =
      firstMatch(entry, /<arxiv:primary_category[^>]*term="([^"]+)"/i) ||
      firstMatch(entry, /<category[^>]*term="([^"]+)"/i) ||
      null;
    const doi = firstMatch(entry, /<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/i) || null;
    const journalRef = firstMatch(entry, /<arxiv:journal_ref>([\s\S]*?)<\/arxiv:journal_ref>/i) || null;
    const comment = firstMatch(entry, /<arxiv:comment>([\s\S]*?)<\/arxiv:comment>/i) || null;

    let arxivId = null;
    if (id) {
      const m = id.match(/arxiv\.org\/abs\/([^/]+)$/);
      if (m) arxivId = m[1];
    }

    const pdfUrl =
      firstMatch(entry, /<link[^>]*title="pdf"[^>]*href="([^"]+)"/i) ||
      (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null);

    results.push({
      source: "arxiv",
      arxiv_id: arxivId,
      title,
      abstract: summary,
      authors,
      published,
      updated,
      primaryCategory,
      doi,
      journal_ref: journalRef,
      comment,
      url: id || null,
      pdf_url: pdfUrl || null,
      year: pickYear(published),
    });
  }

  return results.filter((x) => x.title);
}

function parseRetryAfterSeconds(h) {
  if (!h) return null;
  const s = String(h).trim();
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;

  const dt = Date.parse(s);
  if (!Number.isNaN(dt)) {
    const sec = Math.ceil((dt - Date.now()) / 1000);
    return sec > 0 ? sec : null;
  }
  return null;
}

function looksRateExceededBody(body = "") {
  const t = String(body || "").toLowerCase();
  return (
    t.includes("rate exceeded") ||
    t.includes("too many requests") ||
    t.includes("throttl") ||
    t.includes("service unavailable due to rate") ||
    t.includes("exceeded the rate")
  );
}

/**
 * Detect arXiv id or arXiv URL.
 * Supports: 1706.03762, 1706.03762v7, https://arxiv.org/abs/1706.03762
 */
function extractArxivIdFromQuery(q) {
  const s = String(q || "").trim();

  const mUrl = s.match(/arxiv\.org\/abs\/([^?\s/]+)|arxiv\.org\/pdf\/([^?\s/]+)\.pdf/i);
  if (mUrl) return (mUrl[1] || mUrl[2] || "").trim();

  const mId = s.match(/\b\d{4}\.\d{4,5}(v\d+)?\b/);
  if (mId) return mId[0];

  return null;
}

function buildUrl(base, searchQuery, limit, sortBy = "relevance") {
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(limit),
    sortBy,
    sortOrder: "descending",
  });
  return `${base}?${params.toString()}`;
}

function buildIdUrl(base, arxivId) {
  const params = new URLSearchParams({
    id_list: String(arxivId),
    start: "0",
    max_results: "1",
  });
  return `${base}?${params.toString()}`;
}

async function fetchTextWithRetry(url, startedAt) {
  let attempt = 0;
  let lastErr = null;

  while (true) {
    attempt++;

    const elapsed = Date.now() - startedAt;
    if (elapsed > TOTAL_BUDGET_MS) {
      throw new Error(`arXiv budget exceeded (${TOTAL_BUDGET_MS}ms)`);
    }

    await throttle();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let depStart = null;
    try {
      await assertProviderQuota("arxiv");

      depStart = process.hrtime.bigint();
      const r = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/atom+xml,text/xml;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
      });
      const depSeconds = Number(process.hrtime.bigint() - depStart) / 1_000_000_000;

      clearTimeout(timer);

      const status = r.status;
      const bodyText = await r.text().catch(() => "");

      // arXiv sometimes returns 200 with "Rate exceeded."
      if (r.ok && looksRateExceededBody(bodyText)) {
        observeDependencyRequest("arxiv", depSeconds, "rate_limited");
        const e = new Error("arXiv rate exceeded (body)");
        e.status = 429;
        e.body = bodyText;
        throw e;
      }

      if (r.ok) {
        observeDependencyRequest("arxiv", depSeconds, "success");
        return bodyText;
      }
      observeDependencyRequest("arxiv", depSeconds, `http_${status}`);

      // retry 429 / 5xx
      if (status === 429 || (status >= 500 && status <= 599)) {
        const ra = parseRetryAfterSeconds(r.headers.get("retry-after"));
        const base = 600 * Math.pow(2, Math.min(attempt, 3));
        const waitMs = ra ? ra * 1000 : base + Math.floor(Math.random() * 250);

        lastErr = new Error(`arXiv HTTP ${status}`);
        lastErr.status = status;
        lastErr.body = bodyText;

        if (attempt >= 2) throw lastErr;

        await sleep(Math.min(waitMs, 6000));
        continue;
      }

      const e = new Error(`arXiv HTTP ${status}: ${bodyText.slice(0, 200)}`);
      e.status = status;
      e.body = bodyText;
      throw e;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (!Number.isFinite(Number(e?.status))) {
        const depSeconds = depStart ? Number(process.hrtime.bigint() - depStart) / 1_000_000_000 : 0;
        observeDependencyRequest(
          "arxiv",
          depSeconds,
          e?.name === "AbortError" || String(e?.message || "").toLowerCase().includes("timed out")
            ? "timeout"
            : "error"
        );
      }

      const msg = String(e?.message || e);
      const retryable =
        msg.includes("AbortError") ||
        msg.toLowerCase().includes("aborted") ||
        msg.toLowerCase().includes("fetch failed") ||
        msg.includes("ECONN") ||
        msg.includes("ETIMEDOUT");

      if (!retryable || attempt >= 2) throw lastErr;

      await sleep(800 + Math.floor(Math.random() * 300));
    }
  }
}

async function queryArxivWithFallback(urlPrimary, urlFallback, startedAt) {
  try {
    return await fetchTextWithRetry(urlPrimary, startedAt);
  } catch (e) {
    if (String(e?.code || "") === "PROVIDER_RATE_LIMITED") {
      throw e;
    }

    const status = e?.status;
    const body = String(e?.body || "");
    const msg = String(e?.message || "");

    const shouldFallback =
      status === 429 ||
      msg.toLowerCase().includes("rate") ||
      looksRateExceededBody(body) ||
      (status >= 500 && status <= 599);

    if (!shouldFallback) throw e;
    return await fetchTextWithRetry(urlFallback, startedAt);
  }
}

export async function searchArxiv(query, limit = 5) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const q = clean(query);

  // direct id mode (highest precision)
  const maybeId = extractArxivIdFromQuery(q);

  // include mode in cache key
  const keyMode = maybeId ? `id:${norm(maybeId)}` : `q:${norm(q)}`;
  const key = `${keyMode}|${safeLimit}`;

  const neg = negGet(key);
  if (neg) return [];

  const hit = cacheGet(key);
  if (hit) return hit;

  const startedAt = Date.now();

  try {
    // ---- ID mode ----
    if (maybeId) {
      const urlPrimary = buildIdUrl(ARXIV_BASE_PRIMARY, maybeId);
      const urlFallback = buildIdUrl(ARXIV_BASE_FALLBACK, maybeId);

      const xml = await queryArxivWithFallback(urlPrimary, urlFallback, startedAt);

      if (looksRateExceededBody(xml)) {
        negSet(key, "arXiv rate-limited (Rate exceeded). Try again soon.");
        return [];
      }

      const parsed = parseAtom(xml);
      cacheSet(key, parsed);
      return parsed;
    }

    // ---- Title mode first (much better than all:) ----
    const quoted = q.replace(/"/g, "");
    const titleQuery = `ti:"${quoted}"`;

    const urlTitlePrimary = buildUrl(ARXIV_BASE_PRIMARY, titleQuery, safeLimit, "relevance");
    const urlTitleFallback = buildUrl(ARXIV_BASE_FALLBACK, titleQuery, safeLimit, "relevance");

    const xmlTitle = await queryArxivWithFallback(urlTitlePrimary, urlTitleFallback, startedAt);

    if (looksRateExceededBody(xmlTitle)) {
      negSet(key, "arXiv rate-limited (Rate exceeded). Try again soon.");
      return [];
    }

    let parsed = parseAtom(xmlTitle);

    // Fallback to all:"" only if title query returned nothing
    if (!parsed || !parsed.length) {
      const allQuery = `all:"${quoted}"`;

      const urlAllPrimary = buildUrl(ARXIV_BASE_PRIMARY, allQuery, safeLimit, "relevance");
      const urlAllFallback = buildUrl(ARXIV_BASE_FALLBACK, allQuery, safeLimit, "relevance");

      const xmlAll = await queryArxivWithFallback(urlAllPrimary, urlAllFallback, startedAt);

      if (looksRateExceededBody(xmlAll)) {
        negSet(key, "arXiv rate-limited (Rate exceeded). Try again soon.");
        return [];
      }

      parsed = parseAtom(xmlAll);
    }

    cacheSet(key, parsed || []);
    return parsed || [];
  } catch (e) {
    if (String(e?.code || "") === "PROVIDER_RATE_LIMITED") {
      throw e;
    }

    const status = e?.status;
    const body = String(e?.body || "");
    const msg = String(e?.message || "");

    if (
      status === 429 ||
      msg.toLowerCase().includes("429") ||
      msg.toLowerCase().includes("rate") ||
      looksRateExceededBody(body)
    ) {
      negSet(key, "arXiv rate-limited (429 / Rate exceeded). Backing off.");
      return [];
    }

    negSet(key, "arXiv temporarily unavailable. Try again shortly.");
    return [];
  }
}
