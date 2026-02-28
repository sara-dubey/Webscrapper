import { fetchJsonRetry } from "../http.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { assertProviderQuota } from "./providerQuota.js";

const BASE = String(process.env.SEMANTIC_SCHOLAR_BASE_URL || "https://api.semanticscholar.org").replace(
  /\/+$/,
  ""
);
const API_KEY = String(process.env.SEMANTIC_SCHOLAR_API_KEY || "").trim();

const limiter = makeLimiter({
  minIntervalMs: Number(process.env.SEMANTIC_SCHOLAR_MIN_INTERVAL_MS || (API_KEY ? 250 : 2200)),
  maxConcurrency: Number(process.env.SEMANTIC_SCHOLAR_MAX_CONCURRENCY || 1),
  maxBackoffMs: Number(process.env.SEMANTIC_SCHOLAR_MAX_BACKOFF_MS || 60_000),
});

const PAPER_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "url",
  "citationCount",
  "influentialCitationCount",
].join(",");

const EDGE_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "url",
  "authors",
  "externalIds",
  "citationCount",
  "influentialCitationCount",
  "openAccessPdf",
].join(",");

const PAPER_WITH_EDGES_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "url",
  "citations.paperId",
  "citations.title",
  "citations.abstract",
  "citations.year",
  "citations.venue",
  "citations.url",
  "citations.authors",
  "citations.externalIds",
  "citations.citationCount",
  "citations.influentialCitationCount",
  "citations.openAccessPdf",
  "references.paperId",
  "references.title",
  "references.abstract",
  "references.year",
  "references.venue",
  "references.url",
  "references.authors",
  "references.externalIds",
  "references.citationCount",
  "references.influentialCitationCount",
  "references.openAccessPdf",
].join(",");

function cleanText(value, max = 8000) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 18))} ...[truncated]` : s;
}

function parseYear(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function pickArxivIdFromExternalIds(externalIds) {
  if (!externalIds || typeof externalIds !== "object") return "";
  const values = [
    externalIds.ArXiv,
    externalIds.arXiv,
    externalIds.ARXIV,
    externalIds.arxiv,
  ];
  for (const value of values) {
    const id = baseArxivId(String(value || "").trim());
    if (/^\d{4}\.\d{4,5}$/i.test(id)) return id;
  }
  return "";
}

function baseArxivId(value = "") {
  return String(value || "")
    .trim()
    .replace(/v\d+$/i, "");
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(queryTitle, candidateTitle) {
  const q = normalizeTitle(queryTitle);
  const t = normalizeTitle(candidateTitle);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (q.includes(t) || t.includes(q)) return 0.92;
  const qw = new Set(q.split(" ").filter(Boolean));
  const tw = new Set(t.split(" ").filter(Boolean));
  if (!qw.size || !tw.size) return 0;
  let inter = 0;
  for (const tok of qw) if (tw.has(tok)) inter += 1;
  return inter / (qw.size + tw.size - inter);
}

function isRateLimited(err) {
  const status = Number(err?.status);
  if (status === 429) return true;
  if (status === 403) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("http 429");
}

function buildHeaders() {
  const headers = {
    accept: "application/json",
    "user-agent": process.env.SEMANTIC_SCHOLAR_UA || "Threadline/1.0",
  };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  return headers;
}

async function runRequest(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("semantic_scholar");
    return await fetchJsonRetry(url, {
      method: "GET",
      headers: buildHeaders(),
      timeoutMs: Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS || 20_000),
      retries: Number(process.env.SEMANTIC_SCHOLAR_RETRIES || 1),
      backoffMs: Number(process.env.SEMANTIC_SCHOLAR_BACKOFF_MS || 1100),
      dependency: "semantic_scholar",
    });
  });
}

function readResults(data) {
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.papers)) return data.papers;
  return [];
}

function mapEdgeRow(row, direction, sourcePaperId) {
  const paper =
    row?.paper ||
    (direction === "forward" ? row?.citingPaper : row?.citedPaper) ||
    row?.citedPaper ||
    row?.citingPaper ||
    row ||
    {};
  const openAccessPdf = paper?.openAccessPdf?.url || null;
  const arxivId = pickArxivIdFromExternalIds(paper?.externalIds);
  return {
    source: "semantic_scholar",
    sourcePaperId: String(sourcePaperId || "").trim() || null,
    direction, // "forward" or "backward"
    paperId: String(paper?.paperId || "").trim() || null,
    arxivId: arxivId || null,
    title: cleanText(paper?.title || "", 500),
    abstract: cleanText(paper?.abstract || "", 8000) || null,
    year: parseYear(paper?.year),
    url: openAccessPdf || paper?.url || null,
    venue: cleanText(paper?.venue || "", 180) || null,
    citationCount: Number.isFinite(Number(paper?.citationCount))
      ? Number(paper.citationCount)
      : null,
    influentialCitationCount: Number.isFinite(Number(paper?.influentialCitationCount))
      ? Number(paper.influentialCitationCount)
      : null,
    authors: Array.isArray(paper?.authors)
      ? paper.authors
          .map((a) => cleanText(a?.name || a, 180))
          .filter(Boolean)
          .slice(0, 20)
      : [],
  };
}

function scoreCandidatePaper(queryTitle, yearHint, row) {
  const sim = titleScore(queryTitle, row?.title);
  let score = sim * 100;

  const y = parseYear(row?.year);
  const hint = parseYear(yearHint);
  if (hint && y) {
    if (hint === y) score += 7;
    else if (Math.abs(hint - y) === 1) score += 2;
    else score -= Math.min(8, Math.abs(hint - y));
  }
  if (row?.paperId) score += 1;

  return { sim, score };
}

async function fetchPaperByArxivId(arxivId) {
  const idClean = baseArxivId(arxivId);
  if (!idClean) return null;
  const id = encodeURIComponent(`ARXIV:${idClean}`);
  const url = `${BASE}/graph/v1/paper/${id}?fields=${encodeURIComponent(PAPER_FIELDS)}`;
  try {
    const data = await runRequest(url);
    if (!data || !data.paperId) return null;
    return data;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

async function fetchPaperWithEmbeddedEdges(identifier) {
  const id = String(identifier || "").trim();
  if (!id) return null;
  const url = `${BASE}/graph/v1/paper/${encodeURIComponent(id)}?fields=${encodeURIComponent(
    PAPER_WITH_EDGES_FIELDS
  )}`;
  try {
    const data = await runRequest(url);
    if (!data || !data.paperId) return null;
    return data;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

function mapEmbeddedRows(data, direction, sourcePaperId, limit) {
  const rows = Array.isArray(data) ? data : [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 100));
  return rows
    .slice(0, safeLimit)
    .map((row) => mapEdgeRow(row, direction, sourcePaperId))
    .filter((x) => x.paperId);
}

async function fetchPaperByDoi(doi) {
  const s = String(doi || "").trim();
  if (!s) return null;
  const id = encodeURIComponent(`DOI:${s}`);
  const url = `${BASE}/graph/v1/paper/${id}?fields=${encodeURIComponent(PAPER_FIELDS)}`;
  try {
    const data = await runRequest(url);
    if (!data || !data.paperId) return null;
    return data;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

async function searchPaperByTitle(title, { year = null } = {}) {
  const q = cleanText(title, 280);
  if (!q) return null;
  const limit = Number(process.env.SEMANTIC_SCHOLAR_SEARCH_LIMIT || 8);
  const url =
    `${BASE}/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${Math.max(1, limit)}` +
    `&fields=${encodeURIComponent(PAPER_FIELDS)}`;
  try {
    const data = await runRequest(url);
    const rows = readResults(data);
    if (!rows.length) return null;
    const ranked = rows
      .map((row) => ({
        row,
        ...scoreCandidatePaper(title, year, row),
      }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best?.row) return null;

    const minTitleScore = Number(process.env.SEMANTIC_SCHOLAR_MIN_TITLE_SCORE || 0.45);
    if (best.sim < minTitleScore) return null;
    return best.row;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

async function fetchEdges(paperId, direction, limit) {
  const pid = String(paperId || "").trim();
  if (!pid) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 100));
  const endpoint = direction === "forward" ? "citations" : "references";
  const url =
    `${BASE}/graph/v1/paper/${encodeURIComponent(pid)}/${endpoint}?limit=${safeLimit}` +
    `&fields=${encodeURIComponent(EDGE_FIELDS)}`;
  try {
    const data = await runRequest(url);
    return readResults(data)
      .map((row) => mapEdgeRow(row, direction, pid))
      .filter((x) => x.paperId);
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return [];
  }
}

function dedupeRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(row?.paperId || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Fetches forward and backward citation graph rows from Semantic Scholar.
 * Returns a flat list of rows with `direction` set to "forward" or "backward".
 */
export async function fetchCitations(doiOrParams, maybeTitle, maybeOpts = {}) {
  let doi = doiOrParams;
  let title = maybeTitle;
  let arxivId = maybeOpts?.arxivId ?? null;
  let year = maybeOpts?.year ?? null;
  let limit = maybeOpts?.limit ?? 12;

  if (doiOrParams && typeof doiOrParams === "object" && !Array.isArray(doiOrParams)) {
    const params = doiOrParams;
    doi = params?.doi ?? null;
    title = params?.title ?? null;
    arxivId = params?.arxivId ?? null;
    year = params?.year ?? null;
    limit = params?.limit ?? 12;
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 100));

  // Fast path: fetch paper + citations + references in one request by stable identifier.
  const arxivBase = baseArxivId(arxivId);
  if (arxivBase) {
    const embedded = await fetchPaperWithEmbeddedEdges(`ARXIV:${arxivBase}`);
    if (embedded) {
      const forward = mapEmbeddedRows(embedded?.citations, "forward", embedded.paperId, safeLimit);
      const backward = mapEmbeddedRows(embedded?.references, "backward", embedded.paperId, safeLimit);
      return dedupeRows([...forward, ...backward]);
    }
  }

  const doiNorm = String(doi || "").trim();
  if (doiNorm) {
    const embedded = await fetchPaperWithEmbeddedEdges(`DOI:${doiNorm}`);
    if (embedded) {
      const forward = mapEmbeddedRows(embedded?.citations, "forward", embedded.paperId, safeLimit);
      const backward = mapEmbeddedRows(embedded?.references, "backward", embedded.paperId, safeLimit);
      return dedupeRows([...forward, ...backward]);
    }
  }

  // Fallback path (title-only queries): search first, then fetch embedded edges by paperId.
  const basePaper = await searchPaperByTitle(title, { year });
  if (!basePaper?.paperId) return [];

  const embedded = await fetchPaperWithEmbeddedEdges(basePaper.paperId);
  if (embedded) {
    const forward = mapEmbeddedRows(embedded?.citations, "forward", embedded.paperId, safeLimit);
    const backward = mapEmbeddedRows(embedded?.references, "backward", embedded.paperId, safeLimit);
    return dedupeRows([...forward, ...backward]);
  }

  // Final fallback for compatibility.
  const [forward, backward] = await Promise.all([
    fetchEdges(basePaper.paperId, "forward", safeLimit),
    fetchEdges(basePaper.paperId, "backward", safeLimit),
  ]);
  return dedupeRows([...forward, ...backward]);
}
