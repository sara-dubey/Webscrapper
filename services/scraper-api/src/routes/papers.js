// services/scraper-api/src/routes/papers.js

import { Router } from "express";
import { z } from "zod";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";

import { prisma } from "../db/prisma.js";

import { searchArxiv } from "../integrations/arxiv.js";
import { redditSearch } from "../integrations/reddit.js";
import { fetchCitations } from "../integrations/semanticScholar.js";
import { fetchGithub } from "../integrations/github.js";
import { fetchOpenReview, fetchOpenReviewPublicationByTitle } from "../integrations/openreview.js";
import { fetchHuggingFace } from "../integrations/huggingface.js";
import { fetchJsonRetry, fetchTextRetry } from "../http.js";
import { queryCache, arxivCache, arxivNegCache, summaryCache, redditCache } from "../cache/cache.js";
import { sha1 } from "../hash.js";
import { indexSearchRun } from "../rag/store.js";
import { runWithSummaryQueue, isSummaryQueueBusyError } from "../queue/summaryQueue.js";
import { assertUserQuota, setUserQuotaHeaders } from "../infra/userQuota.js";

// Optional auth attach: if Authorization is present and valid, we store userId.
// If missing/invalid, we still return the result (and will skip user-specific DB writes).
import { verifyAccess } from "../auth/jwt.js";

const router = Router();
const ENABLE_SUMMARY_QUEUE_PROBE = process.env.ENABLE_SUMMARY_QUEUE_PROBE === "1";
const EXTERNAL_API_CALLS_DISABLED = false;
const execFileAsync = promisify(execFile);

// bump this whenever you change selection logic to avoid stale cache returning wrong paper
const CACHE_VERSION = "v14";

function getRequestId(req, res) {
  return (
    req.get("x-request-id") ||
    res?.locals?.requestId ||
    (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()))
  );
}

function logErr(rid, msg, extra) {
  try {
    console.error(`[${new Date().toISOString()}] ${rid} ${msg}`, extra || "");
  } catch {
    // ignore
  }
}

function isLikelyPythonUnavailable(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("aborterror") ||
    message.includes("timed out")
  );
}

const PaperReq = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
  year: z.union([z.string(), z.number()]).optional(),
  category: z.string().optional(),
  note: z.string().optional(), // optional user note to store with Search
});

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function withTimeout(promise, ms, label = "operation") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function settledArray(result) {
  if (result?.status === "fulfilled" && Array.isArray(result.value)) return result.value;
  return [];
}

function settledError(result) {
  if (result?.status === "rejected") return result.reason;
  return null;
}

function toTrimmedOrNull(value, maxLen = 500) {
  const s = String(value || "").trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseCrossrefDate(value) {
  const parts = Array.isArray(value?.["date-parts"]) ? value["date-parts"][0] : null;
  if (!Array.isArray(parts) || !parts.length) return null;
  const year = Number(parts[0]);
  if (!Number.isFinite(year) || year < 1600 || year > 3000) return null;
  const monthRaw = Number(parts[1]);
  const dayRaw = Number(parts[2]);
  const month = Number.isFinite(monthRaw) ? Math.max(1, Math.min(12, Math.trunc(monthRaw))) : 1;
  const day = Number.isFinite(dayRaw) ? Math.max(1, Math.min(31, Math.trunc(dayRaw))) : 1;
  const d = new Date(Date.UTC(Math.trunc(year), month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pickCrossrefPublishedAt(message) {
  return (
    parseCrossrefDate(message?.["published-print"]) ||
    parseCrossrefDate(message?.["published-online"]) ||
    parseCrossrefDate(message?.issued) ||
    parseCrossrefDate(message?.created) ||
    null
  );
}

function pickCrossrefVenue(message) {
  const titles = Array.isArray(message?.["container-title"]) ? message["container-title"] : [];
  for (const t of titles) {
    const s = toTrimmedOrNull(t, 500);
    if (s) return s;
  }
  return null;
}

function isNonArxivDoi(doi) {
  const d = String(doi || "").trim().toLowerCase();
  if (!d) return false;
  return !d.startsWith("10.48550/");
}

function isLikelyPreprintVenue(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return false;
  const compact = s.replace(/[^a-z0-9]/g, "");
  const phrase = s.replace(/[^a-z0-9]+/g, " ").trim();
  const isCorr =
    compact === "corr" ||
    compact.includes("computingresearchrepository") ||
    /\bcorr\b/.test(phrase);
  if (isCorr) return true;
  const directTokens = [
    "arxiv",
    "biorxiv",
    "medrxiv",
    "chemrxiv",
    "ssrn",
    "osf",
    "hal",
    "zenodo",
    "figshare",
  ];
  if (directTokens.some((token) => compact.includes(token))) return true;
  return (
    phrase.includes("preprint") ||
    phrase.includes("research square") ||
    phrase.includes("open science framework")
  );
}

function normalizeSimilarityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;

  const dp = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j += 1) dp[j] = j;

  for (let i = 1; i <= x.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const temp = dp[j];
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[y.length];
}

function titleSimilarityPercent(a, b) {
  const x = normalizeSimilarityText(a);
  const y = normalizeSimilarityText(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  const maxLen = Math.max(x.length, y.length);
  if (!maxLen) return 0;
  const dist = levenshteinDistance(x, y);
  return ((maxLen - dist) / maxLen) * 100;
}

function semanticScholarHeaders() {
  const headers = {
    accept: "application/json",
    "user-agent": process.env.SEMANTIC_SCHOLAR_UA || "Threadline/1.0",
  };
  const key = String(process.env.SEMANTIC_SCHOLAR_API_KEY || "").trim();
  if (key) headers["x-api-key"] = key;
  return headers;
}

function readSemanticScholarResults(data) {
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.papers)) return data.papers;
  return [];
}

function pickSemanticScholarArxivId(externalIds) {
  if (!externalIds || typeof externalIds !== "object") return "";
  const candidates = [
    externalIds.ArXiv,
    externalIds.arXiv,
    externalIds.ARXIV,
    externalIds.arxiv,
  ];
  for (const value of candidates) {
    const id = extractArxivId(value);
    if (id) return id;
  }
  return "";
}

function mapSemanticScholarPrimaryPaper(row) {
  if (!row || typeof row !== "object") return null;
  const semanticScholarPaperId = toTrimmedOrNull(row?.paperId, 128);
  const title = toTrimmedOrNull(row?.title, 2_000);
  if (!semanticScholarPaperId || !title) return null;

  const arxivId = pickSemanticScholarArxivId(row?.externalIds);
  const absUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : null;
  const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null;
  const openAccessPdfUrl = toTrimmedOrNull(row?.openAccessPdf?.url, 2_000);
  const semanticUrl =
    toTrimmedOrNull(row?.url, 2_000) ||
    `https://www.semanticscholar.org/paper/${encodeURIComponent(semanticScholarPaperId)}`;

  const authors = Array.isArray(row?.authors)
    ? row.authors
        .map((a) => toTrimmedOrNull(typeof a === "string" ? a : a?.name, 180))
        .filter(Boolean)
        .slice(0, 30)
    : [];

  return {
    source: "semantic_scholar",
    arxiv_id: arxivId || null,
    semantic_scholar_paper_id: semanticScholarPaperId,
    externalId: semanticScholarPaperId,
    title,
    abstract: toTrimmedOrNull(row?.abstract, 200_000),
    authors,
    year: toIntYear(row?.year),
    venue: toTrimmedOrNull(row?.venue, 500),
    citation_count: Number.isFinite(Number(row?.citationCount))
      ? Math.trunc(Number(row.citationCount))
      : null,
    reference_count: Number.isFinite(Number(row?.referenceCount))
      ? Math.trunc(Number(row.referenceCount))
      : null,
    url: absUrl || semanticUrl,
    pdf_url: pdfUrl || openAccessPdfUrl || null,
    originSource: {
      source: "semantic_scholar",
      semantic_scholar_paper_id: semanticScholarPaperId,
      semantic_url: semanticUrl,
      externalIds: sanitizeJson(row?.externalIds),
    },
  };
}

async function fetchSemanticScholarPrimaryByTitle(title, { year = null, requestId = "no-rid" } = {}) {
  const q = toTrimmedOrNull(title, 2_000);
  if (!q) return null;
  const base = String(process.env.SEMANTIC_SCHOLAR_BASE_URL || "https://api.semanticscholar.org").replace(
    /\/+$/,
    ""
  );
  const limit = Math.max(1, Math.min(Number(process.env.SEMANTIC_SCHOLAR_TITLE_SEARCH_LIMIT || 8), 20));
  const fields = [
    "paperId",
    "title",
    "abstract",
    "year",
    "venue",
    "url",
    "authors",
    "externalIds",
    "openAccessPdf",
    "citationCount",
    "referenceCount",
  ].join(",");
  const url =
    `${base}/graph/v1/paper/search?query=${encodeURIComponent(q)}` +
    `&limit=${limit}&fields=${encodeURIComponent(fields)}`;

  try {
    const data = await fetchJsonRetry(url, {
      method: "GET",
      timeoutMs: Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS || 12_000),
      retries: Number(process.env.SEMANTIC_SCHOLAR_RETRIES || 1),
      backoffMs: Number(process.env.SEMANTIC_SCHOLAR_BACKOFF_MS || 1_000),
      dependency: "semantic_scholar",
      headers: semanticScholarHeaders(),
    });
    const rows = readSemanticScholarResults(data);
    if (!rows.length) return null;

    const normalizedQuery = normTitle(q);
    const requestedYear = toIntYear(year);
    const exact = rows.find((row) => normTitle(row?.title) === normalizedQuery) || null;
    const selected = exact || rows[0] || null;
    if (!selected) return null;
    if (!exact) return null;
    if (requestedYear != null) {
      const selectedYear = toIntYear(selected?.year);
      if (selectedYear != null && selectedYear !== requestedYear) return null;
    }
    return mapSemanticScholarPrimaryPaper(selected);
  } catch (e) {
    logErr(requestId, "Semantic Scholar title search failed", e?.message || e);
    return null;
  }
}

function mapOpenReviewPrimaryPaper(openreview, query) {
  if (!openreview || typeof openreview !== "object") return null;
  const forumId = toTrimmedOrNull(openreview?.forumId, 191);
  const forumUrl = toTrimmedOrNull(openreview?.forumUrl, 2_000);
  const title = toTrimmedOrNull(openreview?.title, 2_000) || toTrimmedOrNull(query, 2_000);
  if (!forumId || !title) return null;

  return {
    source: "openreview",
    openreview_forum_id: forumId,
    externalId: forumId,
    title,
    abstract: null,
    authors: [],
    year: null,
    venue: toTrimmedOrNull(openreview?.venue, 500),
    citation_count: null,
    reference_count: null,
    url: forumUrl || `https://openreview.net/forum?id=${encodeURIComponent(forumId)}`,
    pdf_url: null,
    originSource: {
      source: "openreview",
      openreview_forum_id: forumId,
      openreview: sanitizeJson(openreview),
    },
  };
}

async function fetchSemanticScholarPublicationByArxivId(arxivId, requestId = "no-rid") {
  const id = baseArxivId(arxivId);
  if (!id) return null;
  const base = String(process.env.SEMANTIC_SCHOLAR_BASE_URL || "https://api.semanticscholar.org").replace(
    /\/+$/,
    ""
  );
  const fields = "paperId,externalIds,publicationVenue,journal,publicationTypes,title,citationCount,referenceCount";
  const url = `${base}/graph/v1/paper/arXiv:${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`;
  try {
    const data = await fetchJsonRetry(url, {
      method: "GET",
      timeoutMs: Number(process.env.SEMANTIC_SCHOLAR_TIMEOUT_MS || 12_000),
      retries: Number(process.env.SEMANTIC_SCHOLAR_RETRIES || 1),
      backoffMs: Number(process.env.SEMANTIC_SCHOLAR_BACKOFF_MS || 1000),
      dependency: "semantic_scholar",
      headers: semanticScholarHeaders(),
    });

    const externalIds = data?.externalIds && typeof data.externalIds === "object" ? data.externalIds : {};
    const doi = toTrimmedOrNull(externalIds?.DOI || externalIds?.doi, 256);
    const venue = toTrimmedOrNull(
      data?.publicationVenue?.name || data?.publicationVenue?.alternateName || data?.publicationVenue,
      500
    );
    const journal = toTrimmedOrNull(data?.journal?.name || data?.journal, 500);
    const title = toTrimmedOrNull(data?.title, 2000);
    const paperId = toTrimmedOrNull(data?.paperId, 128);
    const citationCount = Number.isFinite(Number(data?.citationCount))
      ? Math.trunc(Number(data.citationCount))
      : null;
    const referenceCount = Number.isFinite(Number(data?.referenceCount))
      ? Math.trunc(Number(data.referenceCount))
      : null;
    const publicationTypes = Array.isArray(data?.publicationTypes)
      ? data.publicationTypes.map((x) => toTrimmedOrNull(x, 120)).filter(Boolean)
      : [];

    return {
      paperId,
      doi,
      title,
      publicationVenue: venue,
      journal,
      citationCount,
      referenceCount,
      publicationTypes,
      raw: data,
    };
  } catch (e) {
    logErr(requestId, "Semantic Scholar publication lookup failed", e?.message || e);
    return null;
  }
}

function crossrefHeaders() {
  return {
    accept: "application/json",
    "user-agent":
      process.env.CROSSREF_UA ||
      "Threadline/1.0 (publication check; contact: support@example.com)",
  };
}

async function fetchCrossrefByTitle(title, requestId = "no-rid") {
  const t = toTrimmedOrNull(title, 2000);
  if (!t) return [];
  const base = String(process.env.CROSSREF_BASE_URL || "https://api.crossref.org").replace(/\/+$/, "");
  const rows = Math.max(1, Math.min(Number(process.env.CROSSREF_TITLE_ROWS || 3), 10));
  const params = new URLSearchParams({
    "query.title": t,
    rows: String(rows),
  });
  const mailto = String(process.env.CROSSREF_MAILTO || "").trim();
  if (mailto) params.set("mailto", mailto);
  const url = `${base}/works?${params.toString()}`;

  try {
    const data = await fetchJsonRetry(url, {
      method: "GET",
      timeoutMs: Number(process.env.CROSSREF_TIMEOUT_MS || 12_000),
      retries: Number(process.env.CROSSREF_RETRIES || 1),
      backoffMs: Number(process.env.CROSSREF_BACKOFF_MS || 900),
      dependency: "crossref",
      headers: crossrefHeaders(),
    });
    const items = Array.isArray(data?.message?.items) ? data.message.items : [];
    return items.map((item) => {
      const workTitle = toTrimmedOrNull(Array.isArray(item?.title) ? item.title[0] : item?.title, 2000);
      return {
        title: workTitle,
        doi: toTrimmedOrNull(item?.DOI, 256),
        venue: pickCrossrefVenue(item),
        publisher: toTrimmedOrNull(item?.publisher, 300),
        type: toTrimmedOrNull(item?.type, 120),
        publishedAt: pickCrossrefPublishedAt(item),
        similarity: titleSimilarityPercent(t, workTitle || ""),
      };
    });
  } catch (e) {
    logErr(requestId, "Crossref title lookup failed", e?.message || e);
    return [];
  }
}

async function fetchOpenAlexByArxivId(arxivId, requestId = "no-rid") {
  const id = baseArxivId(arxivId);
  if (!id) return null;
  const base = String(process.env.OPENALEX_BASE_URL || "https://api.openalex.org").replace(/\/+$/, "");
  const doiUrl = `https://doi.org/10.48550/arXiv.${id}`;
  const params = new URLSearchParams();
  const mailto = String(process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || "").trim();
  if (mailto) params.set("mailto", mailto);
  const url = `${base}/works/${encodeURIComponent(doiUrl)}${params.toString() ? `?${params.toString()}` : ""}`;
  try {
    const data = await fetchJsonRetry(url, {
      method: "GET",
      timeoutMs: Number(process.env.OPENALEX_TIMEOUT_MS || 12_000),
      retries: Number(process.env.OPENALEX_RETRIES || 1),
      backoffMs: Number(process.env.OPENALEX_BACKOFF_MS || 900),
      dependency: "openalex",
      headers: {
        accept: "application/json",
        "user-agent": process.env.OPENALEX_UA || "Threadline/1.0",
      },
    });
    const primaryType = toTrimmedOrNull(data?.primary_location?.source?.type, 100)?.toLowerCase() || null;
    const locations = Array.isArray(data?.locations) ? data.locations : [];
    const locationTypes = locations
      .map((loc) => toTrimmedOrNull(loc?.source?.type, 100)?.toLowerCase() || null)
      .filter(Boolean);
    const hasNonRepositoryLocation = locationTypes.some((t) => t !== "repository");
    return {
      primarySourceType: primaryType,
      locationTypes,
      hasNonRepositoryLocation,
      raw: data,
    };
  } catch (e) {
    logErr(requestId, "OpenAlex lookup failed", e?.message || e);
    return null;
  }
}

async function resolvePublicationStatus(paper, requestId = "no-rid") {
  const checkedAt = new Date().toISOString();
  const arxivId =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.arxivId) ||
    extractArxivId(paper?.externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url) ||
    null;
  const paperTitle = toTrimmedOrNull(paper?.title, 2000);
  if (!arxivId) {
    return {
      status: "unknown",
      confidence: "low",
      source: "missing_arxiv_id",
      checkedAt,
      evidence: [],
    };
  }

  const evidence = [];
  const openreviewSearchLimit = Math.max(
    5,
    Math.min(Number(process.env.OPENREVIEW_PUBLICATION_SEARCH_LIMIT || 15), 50)
  );

  // Parallel publication signals: lower latency in worst-case path.
  const [semantic, crossrefCandidates, openalex, openreview] = await Promise.all([
    fetchSemanticScholarPublicationByArxivId(arxivId, requestId),
    fetchCrossrefByTitle(paperTitle || "", requestId),
    fetchOpenAlexByArxivId(arxivId, requestId),
    fetchOpenReviewPublicationByTitle(paperTitle || "", {
      limit: openreviewSearchLimit,
      authors: Array.isArray(paper?.authors) ? paper.authors : [],
      arxivId,
    }),
  ]);

  const semanticDoi = toTrimmedOrNull(semantic?.doi, 256);
  const semanticVenue = toTrimmedOrNull(semantic?.publicationVenue, 500);
  const semanticJournal = toTrimmedOrNull(semantic?.journal, 500);
  const semanticPaperId = toTrimmedOrNull(semantic?.paperId, 128);
  const semanticCitationCount = Number.isFinite(Number(semantic?.citationCount))
    ? Math.trunc(Number(semantic.citationCount))
    : null;
  const semanticReferenceCount = Number.isFinite(Number(semantic?.referenceCount))
    ? Math.trunc(Number(semantic.referenceCount))
    : null;
  const resolvedTitle = toTrimmedOrNull(semantic?.title || paperTitle, 2000);
  const semanticLooksPreprint =
    isLikelyPreprintVenue(semanticVenue) || isLikelyPreprintVenue(semanticJournal);
  if (semanticLooksPreprint) evidence.push("semantic_scholar_preprint_venue_or_journal");

  if (isNonArxivDoi(semanticDoi)) {
    evidence.push("semantic_scholar_non_arxiv_doi");
    return {
      status: "published",
      confidence: "high",
      source: "semantic_scholar",
      checkedAt,
      title: resolvedTitle,
      doi: semanticDoi,
      venue: semanticVenue || semanticJournal || null,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
    };
  }

  if ((semanticVenue || semanticJournal) && !semanticLooksPreprint) {
    evidence.push("semantic_scholar_non_preprint_venue_or_journal");
    return {
      status: "published",
      confidence: "high",
      source: "semantic_scholar",
      checkedAt,
      title: resolvedTitle,
      doi: semanticDoi || null,
      venue: semanticVenue || semanticJournal || null,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
    };
  }

  const similarityThreshold = Number(process.env.CROSSREF_TITLE_MATCH_THRESHOLD || 90);
  const crossrefMatch = crossrefCandidates.find(
    (row) =>
      Number(row?.similarity) >= similarityThreshold &&
      isNonArxivDoi(row?.doi) &&
      !isLikelyPreprintVenue(row?.venue)
  );
  const crossrefPreprintMatch = crossrefCandidates.find(
    (row) =>
      Number(row?.similarity) >= similarityThreshold &&
      isNonArxivDoi(row?.doi) &&
      isLikelyPreprintVenue(row?.venue)
  );
  if (crossrefMatch) {
    evidence.push("crossref_title_match_non_arxiv_doi");
    return {
      status: "published",
      confidence: "high",
      source: "crossref_title",
      checkedAt,
      title: resolvedTitle || paperTitle || null,
      doi: crossrefMatch.doi,
      venue: crossrefMatch.venue || null,
      publishedAt: crossrefMatch.publishedAt || null,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
      crossref: {
        similarity: Number(crossrefMatch.similarity),
        threshold: similarityThreshold,
      },
    };
  }
  if (crossrefPreprintMatch) evidence.push("crossref_title_match_preprint_venue");

  const primaryType = String(openalex?.primarySourceType || "").toLowerCase();
  const primaryPublished = primaryType === "journal" || primaryType === "conference";
  const locationPublished = Boolean(openalex?.hasNonRepositoryLocation);
  if (primaryPublished || locationPublished) {
    evidence.push("openalex_non_repository_location");
    return {
      status: "published",
      confidence: "medium",
      source: "openalex",
      checkedAt,
      title: resolvedTitle || paperTitle || null,
      doi: semanticDoi || null,
      venue: null,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
      openalex: {
        primarySourceType: openalex?.primarySourceType || null,
        locationTypes: Array.isArray(openalex?.locationTypes) ? openalex.locationTypes : [],
      },
    };
  }

  if (openreview?.isPublished && !isLikelyPreprintVenue(openreview?.venue)) {
    evidence.push("openreview_accepted_venue");
    return {
      status: "published",
      confidence: "high",
      source: "openreview",
      checkedAt,
      title: resolvedTitle || paperTitle || openreview?.title || null,
      doi: semanticDoi || null,
      venue: openreview?.venue || null,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
      openreview: {
        forumId: openreview?.forumId || null,
        forumUrl: openreview?.forumUrl || null,
        venueId: openreview?.venueId || null,
        decision: openreview?.decision || null,
        similarity: Number.isFinite(Number(openreview?.similarity))
          ? Number(openreview.similarity)
          : null,
      },
    };
  }
  if (isLikelyPreprintVenue(openreview?.venue)) evidence.push("openreview_preprint_venue");

  const preprintVenue =
    semanticLooksPreprint
      ? semanticVenue || semanticJournal || null
      : crossrefPreprintMatch?.venue || (isLikelyPreprintVenue(openreview?.venue) ? openreview?.venue || null : null);
  if (preprintVenue) {
    return {
      status: "preprint",
      confidence: "high",
      source: "preprint_venue_signal",
      checkedAt,
      title: resolvedTitle || paperTitle || openreview?.title || null,
      doi: semanticDoi || crossrefPreprintMatch?.doi || null,
      venue: preprintVenue,
      semanticScholarPaperId: semanticPaperId || null,
      citationCount: semanticCitationCount,
      referenceCount: semanticReferenceCount,
      evidence,
    };
  }

  evidence.push("no_published_signal_found");
  return {
    status: "preprint",
    confidence: "high",
    source: "semantic_crossref_openalex_openreview",
    checkedAt,
    title: resolvedTitle || paperTitle || null,
    doi: semanticDoi || null,
    semanticScholarPaperId: semanticPaperId || null,
    citationCount: semanticCitationCount,
    referenceCount: semanticReferenceCount,
    evidence,
  };
}

function toPayloadPaper({ query, paper }) {
  const arxivId =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.arxivId) ||
    extractArxivId(paper?.externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url) ||
    null;

  const fullText =
    toTrimmedOrNull(paper?.fullText, 1_000_000) ||
    toTrimmedOrNull(paper?.full_text, 1_000_000) ||
    null;

  return {
    doi: toTrimmedOrNull(paper?.doi, 256),
    title: toTrimmedOrNull(paper?.title || query, 2000) || toTrimmedOrNull(query, 2000) || "",
    arxivId,
    semanticScholarPaperId: toTrimmedOrNull(
      paper?.semantic_scholar_paper_id || paper?.semanticScholarPaperId,
      128
    ),
    openreviewForumId: toTrimmedOrNull(
      paper?.openreview_forum_id || paper?.openreviewForumId,
      191
    ),
    fullText,
  };
}

async function buildEvidencePayload({ query, paper, redditThreads, requestId = "no-rid" }) {
  const title = String(paper?.title || query || "").trim();
  const doi = String(paper?.doi || "").trim();
  const publicationDoi = String(paper?.publication?.doi || "").trim();
  const githubDoi = publicationDoi || doi;
  const githubDoiUrl = githubDoi
    ? `https://doi.org/${githubDoi
        .replace(/^doi:\s*/i, "")
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
        .trim()}`
    : "";
  const githubPaperUrls = [
    paper?.url,
    paper?.pdf_url,
    paper?.publication?.forumUrl,
    paper?.publication?.openreview?.forumUrl,
    githubDoiUrl,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  const githubPaperUrlsDeduped = [...new Set(githubPaperUrls)].slice(0, 8);
  const arxivId =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url) ||
    "";
  const authors = Array.isArray(paper?.authors) ? paper.authors : [];
  const sourceTimeoutMs = Math.max(2000, Number(process.env.PAPER_SOURCE_FETCH_TIMEOUT_MS || 25_000));
  const openreviewTimeoutMs = Math.max(
    sourceTimeoutMs,
    Number(process.env.OPENREVIEW_SOURCE_FETCH_TIMEOUT_MS || 45_000)
  );
  const openreviewLimit = Math.max(5, Math.min(Number(process.env.OPENREVIEW_SEARCH_LIMIT || 20), 40));
  const openreviewForumId = String(
    paper?.openreview_forum_id ||
      paper?.openreviewForumId ||
      paper?.publication?.openreview?.forumId ||
      paper?.originSource?.publication?.openreview?.forumId ||
      ""
  ).trim();
  const semanticScholarLimit = Math.max(
    10,
    Math.min(Number(process.env.SEMANTIC_SCHOLAR_EDGE_LIMIT || 100), 100)
  );

  const settled = await Promise.allSettled([
    withTimeout(
      fetchCitations({
        doi: doi || null,
        title: title || null,
        arxivId: arxivId || null,
        year: paper?.year ?? null,
        limit: semanticScholarLimit,
      }),
      sourceTimeoutMs,
      "semantic scholar fetch"
    ),
    withTimeout(
      fetchGithub(title || null, arxivId || null, authors, {
        doi: githubDoi || null,
        paperUrls: githubPaperUrlsDeduped,
      }),
      sourceTimeoutMs,
      "github fetch"
    ),
    withTimeout(
      fetchOpenReview(title || null, {
        limit: openreviewLimit,
        forumId: openreviewForumId || null,
        authors,
        arxivId: arxivId || null,
      }),
      openreviewTimeoutMs,
      "openreview fetch"
    ),
    withTimeout(fetchHuggingFace(arxivId || null, title || null), sourceTimeoutMs, "huggingface fetch"),
  ]);

  const semanticScholarErr = settledError(settled[0]);
  const githubErr = settledError(settled[1]);
  const openreviewErr = settledError(settled[2]);
  const hfErr = settledError(settled[3]);

  if (semanticScholarErr) logErr(requestId, "Semantic Scholar fetch failed", semanticScholarErr?.message || semanticScholarErr);
  if (githubErr) logErr(requestId, "GitHub fetch failed", githubErr?.message || githubErr);
  if (openreviewErr) logErr(requestId, "OpenReview fetch failed", openreviewErr?.message || openreviewErr);
  if (hfErr) logErr(requestId, "HuggingFace fetch failed", hfErr?.message || hfErr);

  return {
    paper: toPayloadPaper({ query, paper }),
    meta: {
      openreview_fetch_ok: !openreviewErr,
    },
    sources: {
      semantic_scholar: settledArray(settled[0]),
      github: settledArray(settled[1]),
      openreview: settledArray(settled[2]),
      huggingface: settledArray(settled[3]),
      reddit: Array.isArray(redditThreads) ? redditThreads : [],
    },
  };
}

async function postEvidenceToPython({ PY_BASE, payload, requestId = "no-rid" }) {
  const pyBase = String(PY_BASE || "").trim();
  if (!pyBase) return null;

  try {
    return await fetchJsonRetry(`${pyBase}/ingest`, {
      method: "POST",
      timeoutMs: Number(process.env.PAPER_INGEST_TIMEOUT_MS || 45_000),
      retries: Number(process.env.PAPER_INGEST_RETRIES || 0),
      dependency: "paper_ai",
      headers: { "Content-Type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    logErr(requestId, "Python ingest request failed", e?.stack || e);
    return null;
  }
}

function normQuery(q) {
  return String(q || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Title normalization for exact-match short-circuit
function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeArxivIdOrUrl(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  if (/arxiv\.org\/(abs|pdf)\//i.test(s)) return true;
  return /\b\d{4}\.\d{4,5}(v\d+)?\b/.test(s);
}

function baseArxivId(value = "") {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.replace(/v\d+$/i, "");
}

function extractArxivId(value = "") {
  const s = String(value || "").trim();
  if (!s) return "";

  const mUrl = s.match(/arxiv\.org\/(?:abs|pdf)\/([^?\s/]+?)(?:\.pdf)?(?:[?#].*)?$/i);
  if (mUrl?.[1]) return baseArxivId(mUrl[1]);

  const mId = s.match(/\b\d{4}\.\d{4,5}(v\d+)?\b/i);
  if (mId?.[0]) return baseArxivId(mId[0]);

  return "";
}

// -------- reranking (best pick) --------
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function scoreCandidate(c, query, year, category) {
  let s = 0;
  const title = c?.title || "";
  const abs = c?.abstract || "";

  // title similarity dominates
  s += jaccard(query, title) * 100;

  // exact-ish boosts (normalized title)
  const qn = normTitle(query);
  const tn = normTitle(title);

  if (tn && qn && tn === qn) s += 200; // make exact title basically unbeatable
  if (tn.includes(qn) || qn.includes(tn)) s += 35;

  // light abstract similarity
  s += jaccard(query, abs) * 20;

  // optional boosts
  if (year && String(c?.year || "") === String(year)) s += 15;
  if (category && String(c?.primaryCategory || "").startsWith(String(category))) s += 12;

  // slight prefer newer updates
  const upd = Date.parse(c?.updated || "") || 0;
  if (upd) s += Math.min(8, (upd - 1400000000000) / 1e10);

  return s;
}

function pickBestCandidate(candidates, query, year, category) {
  if (!candidates?.length) return null;

  // 1) exact title short-circuit (prevents wrong paper)
  const qn = normTitle(query);
  if (qn) {
    const exact = candidates.find((c) => normTitle(c?.title) === qn);
    if (exact) {
      exact.match_score = 999;
      exact._match_reason = "exact_title";
      return exact;
    }
  }

  // 2) otherwise score + pick best
  const scored = candidates
    .map((c) => ({ c, s: scoreCandidate(c, query, year, category) }))
    .sort((a, b) => b.s - a.s);

  const best = scored[0]?.c || candidates[0];
  if (best && scored[0]) best.match_score = scored[0].s;
  return best;
}

// -------- arXiv caching wrapper --------
async function getArxivCandidates(query, safeLimit, year, category) {
  const key = `${CACHE_VERSION}|${normQuery(query)}|${safeLimit}|${year || ""}|${category || ""}`;

  const neg = await arxivNegCache.get(key);
  if (neg) return [];

  const hit = await arxivCache.get(key);
  if (hit) return hit;

  // If user pasted arXiv id/url, we only need 1
  const effectiveLimit = looksLikeArxivIdOrUrl(query) ? 1 : safeLimit;

  const cands = await searchArxiv(query, effectiveLimit);

  if (!cands || !cands.length) {
    await arxivNegCache.set(key, "empty_or_rate_limited");
    return [];
  }

  await arxivCache.set(key, cands);
  return cands;
}

function getOptionalUser(req) {
  try {
    const auth = req.headers.authorization || "";
    const [type, token] = auth.split(" ");
    if (type !== "Bearer" || !token) return null;

    const payload = verifyAccess(token);

    // ✅ FIX: your JWT has { userId: ... } (not sub)
    const id = payload.userId || payload.sub || payload.id;
    if (!id) return null;

    return { id, email: payload.email };
  } catch {
    return null;
  }
}

function toIntYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  const yi = Math.trunc(n);
  if (yi < 1900 || yi > 3000) return null;
  return yi;
}

function pickPaperExternalId(paper) {
  const semanticScholarPaperId = toTrimmedOrNull(
    paper?.semantic_scholar_paper_id || paper?.semanticScholarPaperId || null,
    128
  );
  if (semanticScholarPaperId) return semanticScholarPaperId;

  const openreviewForumId = toTrimmedOrNull(
    paper?.openreview_forum_id || paper?.openreviewForumId || null,
    191
  );
  if (openreviewForumId) return openreviewForumId;

  // Prefer canonical arXiv id (without version), else fall back to URL hash.
  const a =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.arxivId) ||
    extractArxivId(paper?.externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url);
  if (a) return a;
  const u = String(paper?.url || paper?.pdf_url || "").trim();
  if (u) return sha1(String(u));
  return sha1(String(paper?.title || ""));
}

function isArxivBackedPaper(paper) {
  if (!paper || typeof paper !== "object") return false;
  const arxivId =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.arxivId) ||
    extractArxivId(paper?.externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url);
  if (arxivId) return true;

  const url = String(paper?.url || paper?.pdf_url || "").trim().toLowerCase();
  if (url.includes("arxiv.org/abs/") || url.includes("arxiv.org/pdf/")) return true;

  return false;
}

function toDbPaperShape(row) {
  if (!row) return null;

  const canonicalId =
    extractArxivId(row.arxivId) ||
    extractArxivId(row.externalId) ||
    extractArxivId(row.url) ||
    extractArxivId(row.pdfUrl) ||
    "";
  const absUrl = canonicalId ? `https://arxiv.org/abs/${canonicalId}` : null;
  const pdfUrl = canonicalId ? `https://arxiv.org/pdf/${canonicalId}.pdf` : null;
  const publication =
    row?.originSource && typeof row.originSource === "object" && !Array.isArray(row.originSource)
      ? row.originSource.publication || null
      : null;
  const huggingfaceUrl =
    row?.originSource && typeof row.originSource === "object" && !Array.isArray(row.originSource)
      ? String(row.originSource.huggingface_url || row.originSource.huggingfaceUrl || "").trim() || null
      : null;
  const huggingfaceComments = Array.isArray(row?.huggingfaceComments)
    ? row.huggingfaceComments
    : Array.isArray(row?.huggingface_comments)
    ? row.huggingface_comments
    : [];

  return {
    source: row.source || "arxiv",
    search_kind: row.searchKind || "main_search",
    arxiv_id: canonicalId || null,
    semantic_scholar_paper_id: row.semanticScholarPaperId || null,
    openreview_forum_id: row.openreviewForumId || null,
    externalId: row.externalId || null,
    title: String(row.title || "").trim(),
    abstract: row.abstract || null,
    authors: Array.isArray(row.authors) ? row.authors : [],
    year: Number.isFinite(Number(row.year)) ? Number(row.year) : null,
    venue: toTrimmedOrNull(row.venue, 500),
    citation_count: Number.isFinite(Number(row.citationCount)) ? Math.trunc(Number(row.citationCount)) : null,
    reference_count: Number.isFinite(Number(row.referenceCount)) ? Math.trunc(Number(row.referenceCount)) : null,
    url: row.url || absUrl,
    pdf_url: row.pdfUrl || pdfUrl,
    repo_url: row.repoUrl || null,
    huggingface_url: huggingfaceUrl,
    huggingface_comments: huggingfaceComments,
    publication,
  };
}

function mapDbRedditPost(row) {
  return {
    id: row?.platformId || row?.id || null,
    platformId: row?.platformId || null,
    subreddit: row?.subreddit || null,
    title: row?.title || null,
    url: row?.url || null,
    score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
    num_comments: Number.isFinite(Number(row?.numComments)) ? Number(row.numComments) : null,
    numComments: Number.isFinite(Number(row?.numComments)) ? Number(row.numComments) : null,
    createdUtc: row?.createdUtc ?? null,
    snippet: row?.snippet || null,
  };
}

function cleanInlineText(value, maxChars = 280) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > maxChars ? `${s.slice(0, Math.max(0, maxChars - 3)).trim()}...` : s;
}

function openReviewTypeOf(row) {
  const raw = String(row?.type || row?.noteType || "").trim().toLowerCase();
  return raw === "review" ? "review" : "comment";
}

function summarizeOpenReviewRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  const normalized = rows
    .map((row) => {
      const type = openReviewTypeOf(row);
      const summary = cleanInlineText(row?.summary || row?.mainReview || row?.main_review || row?.review || row?.content);
      const comment = cleanInlineText(row?.comment || row?.details || row?.content);
      const strengths = cleanInlineText(row?.strengths);
      const weaknesses = cleanInlineText(row?.weaknesses || row?.questions);
      const decision = cleanInlineText(row?.decision, 180);
      const forumUrl = cleanInlineText(row?.url || row?.forumUrl, 600);
      return { type, summary, comment, strengths, weaknesses, decision, forumUrl };
    })
    .filter((x) => x.summary || x.comment || x.strengths || x.weaknesses || x.decision || x.forumUrl);

  if (!normalized.length) return null;

  const reviews = normalized.filter((x) => x.type === "review");
  const comments = normalized.filter((x) => x.type !== "review");

  const uniq = (arr, limit = 3) => {
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      const key = String(item || "").toLowerCase();
      if (!item || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };

  const topComments = uniq(comments.map((x) => x.comment).filter(Boolean), 3);
  const topReviewSummaries = uniq(reviews.map((x) => x.summary).filter(Boolean), 3);
  const topStrengths = uniq(reviews.map((x) => x.strengths).filter(Boolean), 3);
  const topWeaknesses = uniq(reviews.map((x) => x.weaknesses).filter(Boolean), 3);
  const decision = normalized.map((x) => x.decision).find(Boolean) || null;
  const forumUrl = normalized.map((x) => x.forumUrl).find(Boolean) || null;

  return {
    total: normalized.length,
    reviews: reviews.length,
    comments: comments.length,
    decision,
    forumUrl,
    topReviewSummaries,
    topComments,
    topStrengths,
    topWeaknesses,
  };
}

function mergeOpenReviewSummary(baseSummary, rowsSummary) {
  const base = baseSummary && typeof baseSummary === "object" ? { ...baseSummary } : null;
  const rows = rowsSummary && typeof rowsSummary === "object" ? { ...rowsSummary } : null;
  if (!base && !rows) return null;
  if (!base) return rows;
  if (!rows) return base;

  const merged = { ...base };

  // Always trust deterministic counts from fetched rows over LLM-estimated counts.
  merged.total = Number.isFinite(Number(rows.total)) ? Number(rows.total) : merged.total;
  merged.reviews = Number.isFinite(Number(rows.reviews)) ? Number(rows.reviews) : merged.reviews;
  merged.comments = Number.isFinite(Number(rows.comments)) ? Number(rows.comments) : merged.comments;

  if (merged.evidence_counts && typeof merged.evidence_counts === "object") {
    merged.evidence_counts = {
      ...merged.evidence_counts,
      total: merged.total ?? rows.total ?? 0,
      reviews: merged.reviews ?? rows.reviews ?? 0,
      comments: merged.comments ?? rows.comments ?? 0,
    };
  } else {
    merged.evidence_counts = {
      total: merged.total ?? rows.total ?? 0,
      reviews: merged.reviews ?? rows.reviews ?? 0,
      comments: merged.comments ?? rows.comments ?? 0,
      rebuttals: 0,
    };
  }

  if (!merged.decision && rows.decision) merged.decision = rows.decision;
  if (!merged.forumUrl && rows.forumUrl) merged.forumUrl = rows.forumUrl;
  if (!Array.isArray(merged.topComments) || !merged.topComments.length) merged.topComments = rows.topComments || [];
  if (!Array.isArray(merged.topReviewSummaries) || !merged.topReviewSummaries.length) {
    merged.topReviewSummaries = rows.topReviewSummaries || [];
  }
  if (!Array.isArray(merged.topStrengths) || !merged.topStrengths.length) merged.topStrengths = rows.topStrengths || [];
  if (!Array.isArray(merged.topWeaknesses) || !merged.topWeaknesses.length) merged.topWeaknesses = rows.topWeaknesses || [];

  const clean = (value, max = 420) => cleanInlineText(value, max);
  const decision = clean(merged.decision, 200);
  const topReviewSummary = clean(Array.isArray(merged.topReviewSummaries) ? merged.topReviewSummaries[0] : "");
  const topStrength = clean(Array.isArray(merged.topStrengths) ? merged.topStrengths[0] : "");
  const topWeakness = clean(Array.isArray(merged.topWeaknesses) ? merged.topWeaknesses[0] : "");
  const topComment = clean(Array.isArray(merged.topComments) ? merged.topComments[0] : "");

  const existingOneLiner = clean(merged.one_liner || merged.oneLiner, 260);
  if (!existingOneLiner) {
    merged.one_liner = clean(topReviewSummary || topStrength || topComment || topWeakness || (decision ? `Decision: ${decision}` : ""), 260) || null;
  }

  const existingAssessment = clean(merged.overall_assessment || merged.overallAssessment, 420);
  if (!existingAssessment) {
    const parts = [];
    if (decision) parts.push(`Decision: ${decision}.`);
    if (topReviewSummary) parts.push(`Review summary: ${topReviewSummary}`);
    if (topStrength) parts.push(`Strength: ${topStrength}`);
    if (topWeakness) parts.push(`Weakness: ${topWeakness}`);
    if (topComment) parts.push(`Community note: ${topComment}`);
    merged.overall_assessment = clean(parts.join(" "), 420) || null;
  }

  return merged;
}

function withLookupSource(out, source) {
  return {
    ...out,
    lookup_source: source,
  };
}

function clampText(value, maxChars = 40_000) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 16))}\n...[truncated]`;
}

function sanitizeJson(value, depth = 0) {
  if (depth > 6) return null;
  if (value == null) return null;

  if (typeof value === "string") return clampText(value, 8_000);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((x) => sanitizeJson(x, depth + 1))
      .filter((x) => x !== undefined);
  }

  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).slice(0, 80);
    for (const [k, v] of entries) {
      const key = clampText(k, 80);
      if (!key) continue;
      out[key] = sanitizeJson(v, depth + 1);
    }
    return out;
  }

  return clampText(String(value), 2_000);
}

function toDateOrNull(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

const GITHUB_REPO_HOST_RE = /(^|\.)github\.com$/i;
const GITHUB_REPO_URL_RE = /https?:\/\/(?:www\.)?github\.com\/[^\s<>"')]+/gi;
const NON_REPO_GITHUB_PREFIXES = new Set([
  "about",
  "apps",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "signup",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

function normalizeGithubRepoUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!GITHUB_REPO_HOST_RE.test(u.hostname)) return null;
    const parts = u.pathname
      .split("/")
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    let repo = parts[1];
    if (!owner || !repo) return null;
    if (NON_REPO_GITHUB_PREFIXES.has(owner.toLowerCase())) return null;
    repo = repo.replace(/\.git$/i, "");
    if (!repo) return null;
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return null;
  }
}

function addGithubRepoUrlsFromText(text, counts, weight = 1) {
  const body = String(text || "");
  if (!body) return;
  const w = Number.isFinite(Number(weight)) ? Math.max(1, Math.trunc(Number(weight))) : 1;
  for (const match of body.matchAll(GITHUB_REPO_URL_RE)) {
    const normalized = normalizeGithubRepoUrl(match[0]);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + w);
  }
}

function walkGithubRepoUrls(value, counts, depth = 0, weight = 1) {
  if (depth > 5 || value == null) return;
  if (typeof value === "string") {
    addGithubRepoUrlsFromText(value, counts, weight);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) walkGithubRepoUrls(item, counts, depth + 1, weight);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value).slice(0, 80)) {
      addGithubRepoUrlsFromText(k, counts, weight);
      walkGithubRepoUrls(v, counts, depth + 1, weight);
    }
  }
}

function pickGithubRepoFromOpenReviewRows(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    addGithubRepoUrlsFromText(row?.title, counts);
    addGithubRepoUrlsFromText(row?.summary, counts);
    addGithubRepoUrlsFromText(row?.strengths, counts);
    addGithubRepoUrlsFromText(row?.weaknesses, counts);
    addGithubRepoUrlsFromText(row?.questions, counts);
    addGithubRepoUrlsFromText(row?.comment, counts);
    addGithubRepoUrlsFromText(row?.details, counts);
    addGithubRepoUrlsFromText(row?.content, counts);
    walkGithubRepoUrls(row?.rawContent, counts);
  }
  if (!counts.size) return null;
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].length - b[0].length;
  });
  return ranked[0]?.[0] || null;
}

function pickGithubRepoFromHuggingFaceRows(rows) {
  const counts = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const t = String(row?.type || "").toLowerCase();
    const weight = t === "paper_page" ? 5 : t === "model_page" ? 3 : t === "paper_comment" ? 2 : 1;
    addGithubRepoUrlsFromText(row?.content, counts, weight);
    addGithubRepoUrlsFromText(row?.url, counts, weight);
    if (Array.isArray(row?.githubRepos)) {
      for (const repo of row.githubRepos) addGithubRepoUrlsFromText(repo, counts, weight);
    }
    walkGithubRepoUrls(row, counts, 0, weight);
  }
  if (!counts.size) return null;
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].length - b[0].length;
  });
  return ranked[0]?.[0] || null;
}

function pickHuggingFaceUrlFromRows(rows) {
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = String(row?.url || "").trim();
    if (!url || !/huggingface\.co/i.test(url)) continue;
    const type = String(row?.type || "").toLowerCase();
    let weight = 1;
    if (type === "paper_page") weight = 5;
    else if (type === "model_page") weight = 4;
    else if (type === "discussion") weight = 3;
    else if (type === "paper_comment") weight = 2;
    candidates.push({ url, weight });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].url;
}

function normalizeHuggingFaceCommentRow(row) {
  const type = String(row?.type || "").trim().toLowerCase();
  if (type !== "paper_comment" && type !== "discussion") return null;

  const content = clampText(row?.content, 8_000);
  if (!content) return null;

  return {
    type,
    content,
    url: toTrimmedOrNull(row?.url, 2_000),
    upvotes: Number.isFinite(Number(row?.upvotes)) ? Math.trunc(Number(row.upvotes)) : null,
    created_at: toDateOrNull(row?.created_at)?.toISOString() || null,
    updated_at: toDateOrNull(row?.updated_at)?.toISOString() || null,
    repo: toTrimmedOrNull(row?.repo, 300),
  };
}

function buildHuggingFaceCommentsPayload(rows, limit = 40) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 120));
  const out = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const normalized = normalizeHuggingFaceCommentRow(row);
    if (!normalized) continue;
    const key = `${normalized.type}|${normalized.url || ""}|${normalized.content}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= safeLimit) break;
  }
  return out;
}

function normalizeGithubRepoName(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const s = raw.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "");
  const parts = s
    .split("/")
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1];
  if (!owner || !repo) return null;
  repo = repo.replace(/\.git$/i, "");
  if (!repo || NON_REPO_GITHUB_PREFIXES.has(owner.toLowerCase())) return null;
  return `https://github.com/${owner}/${repo}`;
}

function pickGithubRepoFromGithubRows(rows) {
  const officialRows = (Array.isArray(rows) ? rows : []).filter((row) => Boolean(row?.isOfficial));
  if (!officialRows.length) return null;

  const scores = new Map();
  for (const row of officialRows) {
    const byRepo = normalizeGithubRepoName(row?.repo);
    const byUrl = normalizeGithubRepoUrl(row?.url);
    const urls = new Set([byRepo, byUrl].filter(Boolean));

    const stars = Number(row?.stars);
    const forks = Number(row?.forks);
    const popularityBoost = Math.max(
      0,
      (Number.isFinite(stars) ? Math.log1p(stars) * 10 : 0) +
        (Number.isFinite(forks) ? Math.log1p(forks) * 5 : 0)
    );
    const officialBoost = 1000;

    for (const url of urls) {
      scores.set(url, (scores.get(url) || 0) + officialBoost + popularityBoost);
    }

    // Fallback: if repo URL appears only in content, still count it.
    addGithubRepoUrlsFromText(row?.content, scores, row?.isOfficial ? 1000 : 5);
  }
  if (!scores.size) return null;
  const ranked = Array.from(scores.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].length - b[0].length;
  });
  return ranked[0]?.[0] || null;
}

function collectGithubRepoUrlsFromText(text) {
  const counts = new Map();
  addGithubRepoUrlsFromText(text, counts, 1);
  return Array.from(counts.keys());
}

function collectGithubRepoUrlsFromAny(value) {
  const counts = new Map();
  walkGithubRepoUrls(value, counts, 0, 1);
  return Array.from(counts.keys());
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasArxivIdInText(text, arxivId) {
  const base = baseArxivId(arxivId);
  if (!base) return false;
  const body = String(text || "");
  if (!body) return false;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`\\b${escaped}(?:v\\d+)?\\b`, "i");
  const linkRe = new RegExp(`arxiv\\.org\\/(?:abs|pdf)\\/${escaped}(?:v\\d+)?`, "i");
  return idRe.test(body) || linkRe.test(body);
}

function hasTitleInText(title, text) {
  const t = normalizeMatchText(title);
  const body = normalizeMatchText(text);
  if (!t || !body) return false;
  if (t.length < 12) return false;
  return body.includes(t);
}

function hasAuthorNameInText(authors, text) {
  const body = normalizeMatchText(text);
  if (!body) return false;
  for (const rawAuthor of Array.isArray(authors) ? authors : []) {
    const full = normalizeMatchText(rawAuthor);
    if (!full) continue;
    if (full.length >= 6 && body.includes(full)) return true;
    const parts = full.split(" ").filter(Boolean);
    const last = parts[parts.length - 1] || "";
    if (last.length >= 4 && body.includes(last)) return true;
  }
  return false;
}

function extractGithubDescriptionFromContent(content) {
  const s = String(content || "");
  if (!s) return "";
  const m = s.match(/(?:^|\n)Description:\s*([^\n]+)/i);
  return m?.[1] ? String(m[1]).trim() : "";
}

function extractGithubReadmeFromContent(content) {
  const s = String(content || "");
  if (!s) return "";
  const m = s.match(/(?:^|\n)README:\s*([\s\S]*)$/i);
  return m?.[1] ? String(m[1]).trim() : "";
}

function normalizeAbsCandidateUrl(paper) {
  const direct = String(paper?.url || "").trim();
  if (direct) return direct.replace(/^http:\/\//i, "https://");
  const arxivId = extractArxivId(paper?.arxiv_id || paper?.externalId || paper?.pdf_url || "");
  if (arxivId) return `https://arxiv.org/abs/${arxivId}`;
  return "";
}

function toValidDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = toDateOrNull(value);
  return d instanceof Date ? d : null;
}

function getPaperPublishedDate(paper) {
  const byPublished = toValidDate(paper?.published);
  if (byPublished) return byPublished;
  const byUpdated = toValidDate(paper?.updated);
  if (byUpdated) return byUpdated;
  const year = toIntYear(paper?.year);
  if (year != null) return new Date(Date.UTC(year, 0, 1));
  return null;
}

function isWithinDays(a, b, days) {
  if (!(a instanceof Date) || Number.isNaN(a.getTime())) return false;
  if (!(b instanceof Date) || Number.isNaN(b.getTime())) return false;
  const limitMs = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
  return Math.abs(a.getTime() - b.getTime()) <= limitMs;
}

async function fetchArxivAbstractGithubRepoUrls(paper, rid = "no-rid") {
  const enabled = String(process.env.PAPER_REPO_ENABLE_ARXIV_SCRAPE || "1") !== "0";
  if (!enabled) return [];
  const absUrl = normalizeAbsCandidateUrl(paper);
  if (!absUrl) return [];
  try {
    const html = await fetchTextRetry(absUrl, {
      method: "GET",
      timeoutMs: Number(process.env.PAPER_REPO_ARXIV_TIMEOUT_MS || 12_000),
      retries: Number(process.env.PAPER_REPO_ARXIV_RETRIES || 1),
      backoffMs: Number(process.env.PAPER_REPO_ARXIV_BACKOFF_MS || 900),
      dependency: "arxiv",
      headers: { "User-Agent": process.env.PAPER_REPO_ARXIV_UA || "Threadline/1.0" },
    });
    return collectGithubRepoUrlsFromText(html);
  } catch (e) {
    logErr(rid, "arXiv abstract github-link scan failed", e?.message || e);
    return [];
  }
}

async function fetchPdfGithubRepoUrls(paper, rid = "no-rid") {
  const enabled = String(process.env.PAPER_REPO_ENABLE_PDF_MINING || "1") !== "0";
  if (!enabled) return [];
  const timeoutMs = Math.max(2000, Number(process.env.PAPER_REPO_PDF_TIMEOUT_MS || 20_000));
  try {
    const text = await withTimeout(extractPdfStoryText(paper, rid), timeoutMs, "pdf github-link scan");
    if (!text) return [];
    return collectGithubRepoUrlsFromText(text);
  } catch (e) {
    logErr(rid, "PDF github-link scan failed", e?.message || e);
    return [];
  }
}

function createRepoCandidate(url) {
  return {
    repoUrl: url,
    sources: new Set(),
    readmeTexts: [],
    descriptionTexts: [],
    stars: null,
    forks: null,
    createdAt: null,
  };
}

function addRepoCandidateEvidence(candidates, rawUrl, evidence = {}) {
  const normalized = normalizeGithubRepoUrl(rawUrl) || normalizeGithubRepoName(rawUrl);
  if (!normalized) return;
  let candidate = candidates.get(normalized);
  if (!candidate) {
    candidate = createRepoCandidate(normalized);
    candidates.set(normalized, candidate);
  }

  const source = String(evidence?.source || "").trim();
  if (source) candidate.sources.add(source);

  const stars = Number(evidence?.stars);
  if (Number.isFinite(stars)) {
    candidate.stars = candidate.stars == null ? stars : Math.max(candidate.stars, stars);
  }

  const forks = Number(evidence?.forks);
  if (Number.isFinite(forks)) {
    candidate.forks = candidate.forks == null ? forks : Math.max(candidate.forks, forks);
  }

  const created = toValidDate(evidence?.createdAt);
  if (created) {
    candidate.createdAt =
      !candidate.createdAt || created.getTime() < candidate.createdAt.getTime()
        ? created
        : candidate.createdAt;
  }

  const readme = String(evidence?.readme || "").trim();
  if (readme) candidate.readmeTexts.push(readme);

  const description = String(evidence?.description || "").trim();
  if (description) candidate.descriptionTexts.push(description);
}

function collectRepoCandidates({
  semanticScholarRows = [],
  githubRows = [],
  huggingfaceRows = [],
  arxivAbstractRepoUrls = [],
  pdfRepoUrls = [],
}) {
  const candidates = new Map();

  for (const row of Array.isArray(huggingfaceRows) ? huggingfaceRows : []) {
    const urls = new Set();
    for (const u of Array.isArray(row?.githubRepos) ? row.githubRepos : []) {
      const normalized = normalizeGithubRepoUrl(u);
      if (normalized) urls.add(normalized);
    }
    for (const u of collectGithubRepoUrlsFromText(row?.content)) urls.add(u);
    for (const u of collectGithubRepoUrlsFromAny(row)) urls.add(u);
    for (const url of urls) {
      addRepoCandidateEvidence(candidates, url, { source: "huggingface" });
    }
  }

  for (const row of Array.isArray(semanticScholarRows) ? semanticScholarRows : []) {
    const urls = new Set();
    for (const u of collectGithubRepoUrlsFromText(row?.url)) urls.add(u);
    for (const u of collectGithubRepoUrlsFromText(row?.title)) urls.add(u);
    for (const u of collectGithubRepoUrlsFromText(row?.abstract)) urls.add(u);
    for (const url of urls) {
      addRepoCandidateEvidence(candidates, url, { source: "semantic_scholar" });
    }
  }

  for (const url of Array.isArray(arxivAbstractRepoUrls) ? arxivAbstractRepoUrls : []) {
    addRepoCandidateEvidence(candidates, url, { source: "arxiv_abstract" });
  }

  for (const url of Array.isArray(pdfRepoUrls) ? pdfRepoUrls : []) {
    addRepoCandidateEvidence(candidates, url, { source: "pdf_text" });
  }

  for (const row of Array.isArray(githubRows) ? githubRows : []) {
    const urls = new Set();
    const fromRepo = normalizeGithubRepoName(row?.repo);
    const fromUrl = normalizeGithubRepoUrl(row?.url);
    if (fromRepo) urls.add(fromRepo);
    if (fromUrl) urls.add(fromUrl);
    for (const u of collectGithubRepoUrlsFromText(row?.content)) urls.add(u);

    const readme = String(row?.type || "").toLowerCase() === "readme"
      ? extractGithubReadmeFromContent(row?.content)
      : "";
    const description = String(row?.type || "").toLowerCase() === "readme"
      ? extractGithubDescriptionFromContent(row?.content)
      : "";

    for (const url of urls) {
      addRepoCandidateEvidence(candidates, url, {
        source: "github_search",
        stars: row?.stars,
        forks: row?.forks,
        createdAt: row?.created_at,
        readme,
        description,
      });
    }
  }

  return candidates;
}

function repoConfidenceFromScore(score) {
  const n = Number(score) || 0;
  if (n >= 100) return "high";
  if (n >= 60) return "medium";
  return "low";
}

function scoreRepoCandidate(candidate, { paperTitle, arxivId, authors, paperDate }) {
  const readmeText = candidate.readmeTexts.join("\n\n");
  const descriptionText = candidate.descriptionTexts.join("\n\n");
  const sourceCount = candidate.sources.size;
  let score = 0;
  const reasons = [];

  if (hasArxivIdInText(readmeText, arxivId)) {
    score += 50;
    reasons.push("arxiv_id_in_readme");
  }
  if (hasArxivIdInText(descriptionText, arxivId)) {
    score += 50;
    reasons.push("arxiv_id_in_description");
  }
  if (hasTitleInText(paperTitle, readmeText)) {
    score += 30;
    reasons.push("title_in_readme");
  }
  if (hasAuthorNameInText(authors, readmeText)) {
    score += 20;
    reasons.push("author_in_readme");
  }

  const repoCreatedAt = toValidDate(candidate.createdAt);
  if (paperDate && repoCreatedAt && isWithinDays(repoCreatedAt, paperDate, 183)) {
    score += 20;
    reasons.push("created_within_6_months");
  }

  if (sourceCount >= 2) {
    score += 10;
    reasons.push("multi_source_agreement");
  }

  if (Number.isFinite(Number(candidate.stars)) && Number(candidate.stars) === 0) {
    score -= 10;
    reasons.push("zero_stars_penalty");
  }

  return {
    repoUrl: candidate.repoUrl,
    score,
    reasons,
    sourceCount,
    sources: Array.from(candidate.sources),
    stars: candidate.stars,
    forks: candidate.forks,
    createdAt: repoCreatedAt ? repoCreatedAt.toISOString() : null,
    confidence: repoConfidenceFromScore(score),
  };
}

async function resolveRepoFromEvidence({
  paper,
  semanticScholarRows = [],
  githubRows = [],
  huggingfaceRows = [],
  requestId = "no-rid",
}) {
  // Fast path requested: if HuggingFace already has a linked repo, trust it.
  const hfRepo = pickGithubRepoFromHuggingFaceRows(huggingfaceRows);
  if (hfRepo) {
    return {
      repoUrl: hfRepo,
      score: 999,
      confidence: "high",
      manualReview: false,
      strategy: "huggingface_short_circuit",
      sources: ["huggingface"],
      sourceCount: 1,
      reasons: ["huggingface_direct_repo_link"],
      candidates: [
        {
          repoUrl: hfRepo,
          score: 999,
          confidence: "high",
          sourceCount: 1,
          sources: ["huggingface"],
        },
      ],
    };
  }

  const [arxivAbstractRepoUrls, pdfRepoUrls] = await Promise.all([
    fetchArxivAbstractGithubRepoUrls(paper, requestId),
    fetchPdfGithubRepoUrls(paper, requestId),
  ]);

  const candidates = collectRepoCandidates({
    semanticScholarRows,
    githubRows,
    huggingfaceRows,
    arxivAbstractRepoUrls,
    pdfRepoUrls,
  });

  if (!candidates.size) {
    return {
      repoUrl: null,
      score: 0,
      confidence: "low",
      manualReview: true,
      strategy: "scored_candidates",
      sources: [],
      sourceCount: 0,
      reasons: ["no_repo_candidates"],
      candidates: [],
    };
  }

  const paperDate = getPaperPublishedDate(paper);
  const scored = Array.from(candidates.values())
    .map((candidate) =>
      scoreRepoCandidate(candidate, {
        paperTitle: paper?.title || "",
        arxivId: paper?.arxiv_id || paper?.externalId || paper?.url || "",
        authors: Array.isArray(paper?.authors) ? paper.authors : [],
        paperDate,
      })
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.sourceCount - a.sourceCount ||
        Number(b.stars || 0) - Number(a.stars || 0)
    );

  const top = scored[0] || null;
  if (!top) {
    return {
      repoUrl: null,
      score: 0,
      confidence: "low",
      manualReview: true,
      strategy: "scored_candidates",
      sources: [],
      sourceCount: 0,
      reasons: ["no_repo_candidates"],
      candidates: [],
    };
  }

  return {
    repoUrl: top.repoUrl,
    score: top.score,
    confidence: top.confidence,
    manualReview: top.confidence === "low",
    strategy: "scored_candidates",
    sources: top.sources,
    sourceCount: top.sourceCount,
    reasons: top.reasons,
    candidates: scored.slice(0, 5),
  };
}

function normalizeOpenReviewRowForDb(row) {
  const noteId = String(row?.noteId || "").trim();
  if (!noteId) return null;
  const forumId = String(row?.forum || row?.forumId || row?.noteId || "").trim();
  if (!forumId) return null;

  return {
    noteId,
    forumId,
    parentNoteId: toTrimmedOrNull(row?.parentNoteId, 191),
    noteType: toTrimmedOrNull(row?.type, 80) || "comment",
    invitation: toTrimmedOrNull(row?.invitation, 300),
    title: clampText(row?.title, 8_000),
    summary: clampText(row?.summary, 32_000),
    strengths: clampText(row?.strengths, 32_000),
    weaknesses: clampText(row?.weaknesses, 32_000),
    questions: clampText(row?.questions, 32_000),
    comment: clampText(row?.comment, 32_000),
    details: clampText(row?.details, 32_000),
    decision: clampText(row?.decision, 8_000),
    soundness: clampText(row?.soundness, 2_000),
    presentation: clampText(row?.presentation, 2_000),
    contribution: clampText(row?.contribution, 2_000),
    ratingText: toTrimmedOrNull(row?.ratingText, 500),
    confidenceText: toTrimmedOrNull(row?.confidenceText, 500),
    ratingScore: Number.isFinite(Number(row?.rating)) ? Number(row.rating) : null,
    confidenceScore: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
    url: toTrimmedOrNull(row?.url, 2000),
    readers: sanitizeJson(row?.readers),
    signatures: sanitizeJson(row?.signatures),
    rawContent: sanitizeJson(row?.rawContent),
    createdAtRemote: toDateOrNull(row?.created_at),
    updatedAtRemote: toDateOrNull(row?.updated_at),
  };
}

function normalizeSemanticScholarRowForDb(row) {
  const directionRaw = String(row?.direction || "").trim().toLowerCase();
  const direction = directionRaw === "backward" ? "backward" : "forward";

  const citedPaperId = toTrimmedOrNull(row?.paperId, 128);
  if (!citedPaperId) return null;
  const title = clampText(row?.title, 2_000) || citedPaperId;
  const arxivId = extractArxivId(row?.arxivId || row?.url || "");

  const url = toTrimmedOrNull(row?.url, 2_000);
  const sourcePaperId = toTrimmedOrNull(row?.sourcePaperId || row?.anchorPaperId, 128);
  const keySeed = citedPaperId;

  return {
    citationKey: sha1(keySeed),
    sourcePaperId: sourcePaperId || null,
    direction,
    citedPaperId: citedPaperId || null,
    arxivId: arxivId || null,
    title,
    url,
    influentialCitationCount: Number.isFinite(Number(row?.influentialCitationCount))
      ? Math.trunc(Number(row.influentialCitationCount))
      : null,
    rawPayload: sanitizeJson(row),
  };
}

function semanticScholarRowScore(row) {
  const influential = Number(row?.influentialCitationCount);
  const total = Number(row?.citationCount);
  const year = Number(row?.year);

  const influentialScore = Number.isFinite(influential) ? influential * 3 : 0;
  const totalScore = Number.isFinite(total) ? total : 0;
  const recencyScore = Number.isFinite(year) ? Math.max(0, year - 2000) : 0;
  return influentialScore + totalScore + recencyScore;
}

function pickTopSemanticScholarRows(rows, perDirectionLimit = 100) {
  const limit = Math.max(1, Math.min(Number(perDirectionLimit) || 100, 100));
  const forward = [];
  const backward = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const dir = String(row?.direction || "").toLowerCase();
    if (dir === "backward") backward.push(row);
    else forward.push(row);
  }

  forward.sort((a, b) => semanticScholarRowScore(b) - semanticScholarRowScore(a));
  backward.sort((a, b) => semanticScholarRowScore(b) - semanticScholarRowScore(a));

  return [...forward.slice(0, limit), ...backward.slice(0, limit)];
}

function toSemanticScholarPaperUrl(row) {
  const direct = toTrimmedOrNull(row?.url, 2_000);
  if (direct) return direct;
  const sid = toTrimmedOrNull(row?.paperId || row?.citedPaperId, 128);
  if (!sid) return null;
  return `https://www.semanticscholar.org/paper/${encodeURIComponent(sid)}`;
}

function toSemanticScholarPaperAuthors(row) {
  if (!Array.isArray(row?.authors)) return [];
  return row.authors
    .map((a) => toTrimmedOrNull(typeof a === "string" ? a : a?.name, 180))
    .filter(Boolean)
    .slice(0, 30);
}

function normalizeSummaryStorage(raw) {
  if (!raw || typeof raw !== "object") return null;

  const model = clampText(raw.model || raw.summary_model || "", 160);
  const promptVersion = clampText(raw.promptVersion || raw.summary_prompt_version || "", 120);
  const promptText = clampText(raw.promptText || raw.summary_prompt || "", 60_000);
  const summarySource = sanitizeJson(raw.summarySource || raw.summary_source || null);

  if (!model && !promptVersion && !promptText && !summarySource) return null;

  return {
    model: model || null,
    promptVersion: promptVersion || null,
    promptText: promptText || null,
    summarySource: summarySource || null,
  };
}

function normalizePaperOriginSource(paper) {
  if (!paper || typeof paper !== "object") return null;
  const out = sanitizeJson(paper);
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  return out;
}

function mergePaperOriginSource(existingValue, incomingValue) {
  const existing =
    existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
      ? sanitizeJson(existingValue)
      : null;
  const incoming =
    incomingValue && typeof incomingValue === "object" && !Array.isArray(incomingValue)
      ? sanitizeJson(incomingValue)
      : null;

  if (!existing && !incoming) return null;
  if (!existing) return incoming;
  if (!incoming) return existing;

  return {
    ...existing,
    ...incoming,
  };
}

function buildPaperOriginText(paper) {
  if (!paper || typeof paper !== "object") return null;
  const lines = [
    `Title: ${clampText(paper.title || "", 500) || ""}`,
    clampText(paper.abstract || "", 20_000) ? `Abstract: ${clampText(paper.abstract || "", 20_000)}` : "",
    Array.isArray(paper.authors) && paper.authors.length
      ? `Authors: ${paper.authors.map((x) => clampText(x, 160)).filter(Boolean).join(", ")}`
      : "",
    clampText(paper.published || "", 120) ? `Published: ${clampText(paper.published || "", 120)}` : "",
    clampText(paper.updated || "", 120) ? `Updated: ${clampText(paper.updated || "", 120)}` : "",
    clampText(paper.primaryCategory || "", 120)
      ? `Primary Category: ${clampText(paper.primaryCategory || "", 120)}`
      : "",
    clampText(paper.arxiv_id || "", 120) ? `arXiv ID: ${clampText(paper.arxiv_id || "", 120)}` : "",
    clampText(paper.url || "", 1000) ? `URL: ${clampText(paper.url || "", 1000)}` : "",
    clampText(paper.pdf_url || "", 1000) ? `PDF: ${clampText(paper.pdf_url || "", 1000)}` : "",
  ].filter(Boolean);

  if (!lines.length) return null;
  return clampText(lines.join("\n"), 30_000);
}

function looksLikeMetadataOriginText(value) {
  const s = String(value || "");
  if (!s.trim()) return true;
  return s.startsWith("Title: ") && s.includes("\nAbstract:");
}

function hasNoisyStoryPrefix(value) {
  const head = String(value || "").slice(0, 1600);
  if (!head.trim()) return true;
  if (/^arxiv:\S+/i.test(head.trim())) return true;
  if (/^title:\s+/i.test(head.trim())) return true;
  if (/^\w.+@[\w.-]+\.[A-Za-z]{2,}/m.test(head)) return true;
  return false;
}

function hasStoryOriginText(row) {
  if (!row || typeof row !== "object") return false;
  const format = String(row?.originSource?.origin_text_format || "").trim().toLowerCase();

  const text = String(row?.originText || "").trim();
  if (!text) return false;
  if (looksLikeMetadataOriginText(text)) return false;
  if (hasNoisyStoryPrefix(text)) return false;

  if (format === "pdf_story_text") return true;

  // Heuristic for legacy rows without origin_text_format:
  // long extracted paper text is usually far larger than abstract-only text.
  return text.length >= 8_000;
}

function normalizePdfCandidateUrl(paper) {
  const direct = String(paper?.pdf_url || "").trim();
  if (direct) return direct.replace(/^http:\/\//i, "https://");
  const arxivId = extractArxivId(paper?.arxiv_id || paper?.externalId || paper?.url || "");
  if (arxivId) return `https://arxiv.org/pdf/${arxivId}.pdf`;
  return "";
}

function looksLikePdfUrl(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return false;
  return /\.pdf(?:$|[?#])/.test(s) || s.includes("/pdf/");
}

function normalizeLineKey(line) {
  return String(line || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizePdfLine(line) {
  return String(line || "").replace(/\s+/g, " ").trim();
}

function isLikelySectionHeading(line) {
  const s = String(line || "").trim();
  if (!s) return false;
  if (/^(abstract|introduction|related work|background|method|methods|experiments?|results?|discussion|conclusion|conclusions?|appendix|acknowledg(e)?ments?)$/i.test(s)) {
    return true;
  }
  if (/^\d+(\.\d+){0,3}\s+[A-Z]/.test(s)) return true;
  return false;
}

function isLikelyRunningHeaderFooter(line) {
  const s = String(line || "").trim();
  if (!s) return false;
  if (s.length > 140) return false;
  if (isLikelySectionHeading(s)) return false;
  if (/[.!?]$/.test(s)) return false;
  if (/^(references|bibliography|appendix)$/i.test(s)) return false;

  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 16) return false;

  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 4) return false;

  return true;
}

function collectRepeatedEdgeKeys(pages) {
  const freq = new Map();

  for (const lines of pages) {
    const candidates = [];
    if (lines[0]) candidates.push(lines[0]);
    if (lines[1]) candidates.push(lines[1]);
    if (lines[lines.length - 1]) candidates.push(lines[lines.length - 1]);
    if (lines[lines.length - 2]) candidates.push(lines[lines.length - 2]);

    for (const line of candidates) {
      if (!isLikelyRunningHeaderFooter(line)) continue;
      const key = normalizeLineKey(line);
      if (!key) continue;
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }

  const minHits = pages.length <= 3 ? 2 : Math.max(2, Math.ceil(pages.length * 0.45));
  return new Set(
    Array.from(freq.entries())
      .filter(([, count]) => count >= minHits)
      .map(([key]) => key)
  );
}

function dropConsecutiveDuplicateLines(lines) {
  const out = [];
  let prevKey = "";
  for (const line of lines) {
    const key = normalizeLineKey(line);
    if (key && key === prevKey) continue;
    out.push(line);
    prevKey = key;
  }
  return out;
}

function isLikelyNoiseLine(line) {
  const s = String(line || "").trim();
  if (!s) return true;
  const lower = s.toLowerCase();

  if (/^(page\s*)?\d+(\s*\/\s*\d+)?$/.test(lower)) return true;
  if (/^p(age)?\s*\d+\s+of\s+\d+$/i.test(s)) return true;
  if (/^arxiv:\S+/i.test(s)) return true;
  if (/^https?:\/\/\S+$/i.test(s)) return true;
  if (/^doi:\s*/i.test(lower)) return true;
  if (/^(copyright|all rights reserved)\b/i.test(lower)) return true;
  if (/^(also affiliated with|equal contribution\.?)$/i.test(lower)) return true;
  if (/^[^\w\s]{1,4}$/.test(s)) return true;

  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const symbols = (s.match(/[^A-Za-z0-9\s]/g) || []).length;
  if (letters === 0 && digits > 0) return true;
  if (letters < 2 && digits > 3 && symbols > 2) return true;
  if (letters === 0 && symbols >= Math.max(6, Math.floor(s.length * 0.6))) return true;

  return false;
}

function shouldJoinLines(prev, line) {
  const a = String(prev || "").trim();
  const b = String(line || "").trim();
  if (!a || !b) return false;

  if (/-$/.test(a) && /^[a-z]/.test(b)) return true;
  if (/[.!?:;"')\]]$/.test(a)) return false;
  if (isLikelySectionHeading(b)) return false;
  return /^[a-z0-9(\[]/.test(b);
}

function cleanExtractedPaperText(text) {
  const normalizedRaw = String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const pages = normalizedRaw
    .split(/\f+/g)
    .map((block) => block.split("\n").map(normalizePdfLine).filter(Boolean))
    .filter((lines) => lines.length);
  if (!pages.length) return null;

  const repeatedEdgeKeys = collectRepeatedEdgeKeys(pages);

  const rawLines = [];
  for (const lines of pages) {
    for (const line of lines) {
      if (!line) continue;
      const key = normalizeLineKey(line);
      if (repeatedEdgeKeys.has(key)) continue;
      rawLines.push(line);
    }
  }
  if (!rawLines.length) return null;

  const freq = new Map();
  for (const line of rawLines) {
    const key = normalizeLineKey(line);
    if (!key || key.length > 120) continue;
    if (!isLikelyRunningHeaderFooter(line)) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  const repeatedThreshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const repeatedKeys = new Set(
    Array.from(freq.entries())
      .filter(([, count]) => count >= repeatedThreshold)
      .map(([key]) => key)
  );

  let lines = rawLines.filter((line) => {
    const key = normalizeLineKey(line);
    if (repeatedKeys.has(key)) return false;
    if (isLikelyNoiseLine(line)) return false;
    return true;
  });
  lines = dropConsecutiveDuplicateLines(lines);

  if (!lines.length) return null;

  const absIdx = lines.findIndex((line) => /^abstract\b/i.test(line));
  if (absIdx > 0) {
    lines = lines.slice(absIdx);
  } else {
    const introIdx = lines.findIndex(
      (line, idx) => idx < 120 && /^(1(\.0+)?\s+)?introduction\b/i.test(line)
    );
    if (introIdx > 15) lines = lines.slice(introIdx);
  }

  const refIdx = lines.findIndex(
    (line, idx) => idx > 40 && /^(references|bibliography)\b/i.test(normalizeLineKey(line))
  );
  if (refIdx > 0) lines = lines.slice(0, refIdx);

  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (isLikelySectionHeading(line)) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(line.trim());
      continue;
    }

    if (!current) {
      current = line.trim();
      continue;
    }

    if (shouldJoinLines(current, line)) {
      if (/-$/.test(current) && /^[a-z]/.test(line)) {
        current = `${current.slice(0, -1)}${line}`;
      } else {
        current = `${current} ${line}`.replace(/\s+/g, " ").trim();
      }
      continue;
    }

    chunks.push(current.trim());
    current = line.trim();
  }

  if (current) chunks.push(current.trim());

  const cleaned = chunks
    .filter((chunk) => chunk && chunk.length >= 2)
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleaned) return null;
  return clampText(cleaned, 350_000);
}

async function extractPdfStoryText(paper, rid = "no-rid") {
  const pdfUrl = normalizePdfCandidateUrl(paper);
  if (!pdfUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let tempPdfPath = "";

  try {
    const res = await fetch(pdfUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Threadline/0.1 (+paper origin text extraction)",
      },
    });
    if (!res.ok) {
      logErr(rid, `PDF fetch failed (${res.status})`, pdfUrl);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 40 * 1024 * 1024) return null;

    tempPdfPath = path.join(
      os.tmpdir(),
      `paper-origin-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
    );
    await fs.writeFile(tempPdfPath, buf);

    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-enc", "UTF-8", "-nopgbrk", "-q", tempPdfPath, "-"],
      { timeout: 45_000, maxBuffer: 50 * 1024 * 1024 }
    );

    const cleaned = cleanExtractedPaperText(stdout);
    if (!cleaned || cleaned.length < 500) return null;
    return cleaned;
  } catch (e) {
    logErr(rid, "PDF story text extraction failed", e?.stack || e);
    return null;
  } finally {
    clearTimeout(timeout);
    if (tempPdfPath) {
      try {
        await fs.unlink(tempPdfPath);
      } catch {
        // ignore temp cleanup failures
      }
    }
  }
}

async function hydrateSemanticScholarNeighborTexts(rows, rid = "no-rid") {
  const fetchLimit = Math.max(
    0,
    Math.min(Number(process.env.SEMANTIC_SCHOLAR_TEXT_FETCH_LIMIT || 20), 200)
  );
  if (!fetchLimit) return { attempted: 0, updated: 0 };

  const concurrency = Math.max(
    1,
    Math.min(Number(process.env.SEMANTIC_SCHOLAR_TEXT_FETCH_CONCURRENCY || 4), 12)
  );
  const perDocTimeoutMs = Math.max(
    5_000,
    Math.min(Number(process.env.SEMANTIC_SCHOLAR_TEXT_FETCH_TIMEOUT_MS || 45_000), 120_000)
  );

  const deduped = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(row);
  }

  const targets = deduped
    .filter((row) => !hasStoryOriginText(row) && looksLikePdfUrl(row?.url))
    .slice(0, fetchLimit);
  if (!targets.length) return { attempted: 0, updated: 0 };

  let cursor = 0;
  let attempted = 0;
  let updated = 0;

  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= targets.length) return;

      const row = targets[idx];
      attempted += 1;
      try {
        const text = await withTimeout(
          extractPdfStoryText(
            {
              externalId: row.externalId,
              url: row.url,
              pdf_url: row.url,
            },
            rid
          ),
          perDocTimeoutMs,
          "semantic scholar neighbor text extraction"
        );
        if (!text) continue;

        const nextOriginSource = mergePaperOriginSource(row.originSource, {
          source: "semantic_scholar",
          origin_text_format: "pdf_story_text",
          origin_url: row.url || null,
          hydrated_at: new Date().toISOString(),
        });

        await prisma.paperRecord.update({
          where: { id: row.id },
          data: {
            originText: text,
            originSource: nextOriginSource,
          },
        });
        updated += 1;
      } catch (e) {
        logErr(rid, "Semantic Scholar neighbor text hydrate failed", e?.message || e);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  );
  return { attempted, updated };
}

function toPublicPaperOut(out) {
  if (!out || typeof out !== "object") return out;
  const next = { ...out };
  const derived = summarizeOpenReviewRows(next._openreviewRows);
  if (derived) {
    const pub = next?.paper?.publication?.openreview;
    if (!derived.decision && pub?.decision) derived.decision = String(pub.decision);
    if (!derived.forumUrl && pub?.forumUrl) derived.forumUrl = String(pub.forumUrl);
  }
  next.openreview_summary = mergeOpenReviewSummary(next.openreview_summary, derived);
  if (next?.paper && typeof next.paper === "object" && next.openreview_summary && !next.paper.openreview_summary) {
    next.paper = {
      ...next.paper,
      openreview_summary: next.openreview_summary,
    };
  }
  delete next._summaryStorage;
  delete next._quota;
  delete next._openreviewRows;
  delete next._openreviewFetchOk;
  delete next._githubRows;
  delete next._semanticScholarRows;
  delete next._huggingfaceRows;
  delete next._repoResolution;
  return next;
}

function toSearchOutPaper(paper) {
  if (!paper) return null;
  const canonicalId =
    extractArxivId(paper.arxivId) ||
    extractArxivId(paper.externalId) ||
    extractArxivId(paper.url) ||
    "";
  const absUrl = canonicalId ? `https://arxiv.org/abs/${canonicalId}` : paper.url || null;
  const pdfUrl = canonicalId ? `https://arxiv.org/pdf/${canonicalId}.pdf` : null;
  const publication =
    paper?.originSource && typeof paper.originSource === "object" && !Array.isArray(paper.originSource)
      ? paper.originSource.publication || null
      : null;
  const huggingfaceUrl =
    paper?.originSource && typeof paper.originSource === "object" && !Array.isArray(paper.originSource)
      ? String(paper.originSource.huggingface_url || paper.originSource.huggingfaceUrl || "").trim() || null
      : null;
  const huggingfaceComments = Array.isArray(paper?.huggingfaceComments)
    ? paper.huggingfaceComments
    : Array.isArray(paper?.huggingface_comments)
    ? paper.huggingface_comments
    : [];

  return {
    source: paper.source || "arxiv",
    search_kind: paper.searchKind || "main_search",
    arxiv_id: canonicalId || null,
    semantic_scholar_paper_id: paper.semanticScholarPaperId || null,
    openreview_forum_id: paper.openreviewForumId || null,
    externalId: paper.externalId || null,
    title: String(paper.title || "").trim(),
    abstract: paper.abstract || null,
    authors: Array.isArray(paper.authors) ? paper.authors : [],
    year: Number.isFinite(Number(paper.year)) ? Number(paper.year) : null,
    venue: toTrimmedOrNull(paper.venue, 500),
    citation_count: Number.isFinite(Number(paper.citationCount))
      ? Math.trunc(Number(paper.citationCount))
      : Number.isFinite(Number(paper.citation_count))
      ? Math.trunc(Number(paper.citation_count))
      : null,
    reference_count: Number.isFinite(Number(paper.referenceCount))
      ? Math.trunc(Number(paper.referenceCount))
      : Number.isFinite(Number(paper.reference_count))
      ? Math.trunc(Number(paper.reference_count))
      : null,
    url: absUrl,
    pdf_url: pdfUrl,
    repo_url: paper.repoUrl || null,
    huggingface_url: huggingfaceUrl,
    huggingface_comments: huggingfaceComments,
    publication,
  };
}

function toOutFromSearchRecord(searchRow) {
  const paper = Array.isArray(searchRow?.results)
    ? searchRow.results.find((r) => r?.paper)?.paper || null
    : null;
  const latestSummary = paper
    ? {
        model: paper.summaryModel ?? null,
        promptVersion: paper.summaryPromptVersion ?? null,
        promptText: paper.summaryPromptText ?? null,
        summarySource: paper.summarySource ?? null,
        summaryMd: paper.summaryMd ?? null,
        keyPoints: paper.keyPoints ?? null,
      }
    : null;
  const openreviewRows = Array.isArray(paper?.openReviewNotes) ? paper.openReviewNotes : [];
  const openreviewSummary = summarizeOpenReviewRows(openreviewRows);
  const summaryStorage = normalizeSummaryStorage({
    model: latestSummary?.model,
    promptVersion: latestSummary?.promptVersion,
    promptText: latestSummary?.promptText,
    summarySource: latestSummary?.summarySource,
  });
  const reddit_threads = Array.isArray(searchRow?.redditLinks)
    ? searchRow.redditLinks.map((x) => mapDbRedditPost(x?.redditPost)).filter((x) => x?.title)
    : [];

  return {
    ok: true,
    paper: (() => {
      const basePaper = toSearchOutPaper(paper);
      if (!basePaper || !openreviewSummary) return basePaper;
      return { ...basePaper, openreview_summary: openreviewSummary };
    })(),
    summary: latestSummary?.summaryMd || null,
    novelty: Array.isArray(latestSummary?.keyPoints) ? latestSummary.keyPoints : [],
    reddit_threads,
    openreview_summary: openreviewSummary,
    _summaryStorage: summaryStorage,
  };
}

function hasUsablePaper(out) {
  return Boolean(out && typeof out === "object" && out.paper && typeof out.paper === "object");
}

function isMainSearchPaperOut(out) {
  if (!hasUsablePaper(out)) return false;
  const kind = String(out?.paper?.search_kind || "main_search").trim().toLowerCase();
  return kind === "main_search";
}

async function findHistoryMatch(userId, query, year = null, category = null) {
  const uid = String(userId || "").trim();
  const q = String(query || "").trim();
  if (!uid || !q) return null;

  // History rows do not preserve category semantics strongly enough for safe filtering.
  if (String(category || "").trim()) return null;

  const requestedYear = toIntYear(year);
  const arxivId = extractArxivId(q);

  const includePayload = {
    results: {
      orderBy: { rank: "asc" },
      include: {
        paper: {
          include: {
            openReviewNotes: {
              orderBy: { updatedAt: "desc" },
              take: 120,
            },
          },
        },
      },
    },
    redditLinks: {
      orderBy: { createdAt: "desc" },
      include: { redditPost: true },
      take: 10,
    },
  };

  let search = null;

  if (arxivId) {
    search = await prisma.userSearch.findFirst({
      where: {
        userId: uid,
        results: {
          some: {
            paper: {
              ...(requestedYear ? { year: requestedYear } : {}),
              OR: [
                { arxivId },
                { externalId: arxivId },
                { externalId: { startsWith: `${arxivId}v` } },
                { url: { contains: `/abs/${arxivId}`, mode: "insensitive" } },
                { url: { contains: `/pdf/${arxivId}`, mode: "insensitive" } },
              ],
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: includePayload,
    });
  } else {
    // Strict exact-title reuse for non-arXiv query.
    search = await prisma.userSearch.findFirst({
      where: {
        userId: uid,
        query: { equals: q, mode: "insensitive" },
        results: {
          some: {
            paper: {
              ...(requestedYear ? { year: requestedYear } : {}),
              title: { equals: q, mode: "insensitive" },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      include: includePayload,
    });
  }

  if (!search) return null;
  const out = toOutFromSearchRecord(search);
  if (!hasUsablePaper(out)) return null;

  return {
    searchId: search.id,
    out: withLookupSource(out, "history"),
  };
}

async function findPaperInDbFirst(query, year = null, category = null) {
  const q = String(query || "").trim();
  if (!q) return null;

  // Category isn't represented on cached search artifacts; skip DB shortcut to avoid wrong match.
  if (String(category || "").trim()) return null;

  const requestedYear = toIntYear(year);
  const arxivId = extractArxivId(q);

  let paper = null;

  if (arxivId) {
    const where = {
      OR: [
        { arxivId },
        { externalId: arxivId },
        { externalId: { startsWith: `${arxivId}v` } },
        { url: { contains: `/abs/${arxivId}`, mode: "insensitive" } },
        { url: { contains: `/pdf/${arxivId}`, mode: "insensitive" } },
      ],
    };

    paper = await prisma.paperRecord.findFirst({
      where: requestedYear ? { AND: [where, { year: requestedYear }] } : where,
      orderBy: { createdAt: "desc" },
    });
  } else {
    paper = await prisma.paperRecord.findFirst({
      where: {
        title: { equals: q, mode: "insensitive" },
        ...(requestedYear ? { year: requestedYear } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  if (!paper) return null;

  const links = await prisma.paperRedditLink.findMany({
    where: { paperId: paper.id },
    orderBy: { createdAt: "desc" },
    include: { redditPost: true },
    take: 40,
  });

  const threads = [];
  const seen = new Set();
  for (const link of links) {
    const rp = link?.redditPost;
    const key = String(rp?.platformId || rp?.id || "").trim();
    if (!rp || !key || seen.has(key)) continue;
    seen.add(key);
    threads.push(mapDbRedditPost(rp));
    if (threads.length >= 10) break;
  }

  const openreviewRows = await prisma.paperOpenReviewNote.findMany({
    where: { paperId: paper.id },
    orderBy: { updatedAt: "desc" },
    take: 120,
  });
  const openreviewSummary = summarizeOpenReviewRows(openreviewRows);

  return {
    paper: openreviewSummary
      ? { ...toDbPaperShape(paper), openreview_summary: openreviewSummary }
      : toDbPaperShape(paper),
    searchKind: String(paper?.searchKind || "main_search"),
    originText: typeof paper?.originText === "string" ? paper.originText : null,
    summary: typeof paper?.summaryMd === "string" ? paper.summaryMd : null,
    novelty: Array.isArray(paper?.keyPoints) ? paper.keyPoints : [],
    summaryStorage: normalizeSummaryStorage({
      model: paper?.summaryModel,
      promptVersion: paper?.summaryPromptVersion,
      promptText: paper?.summaryPromptText,
      summarySource: paper?.summarySource,
    }),
    reddit_threads: threads,
    openreview_summary: openreviewSummary,
  };
}

async function findExistingPaperRow(tx, source, externalId, paper) {
  const arxivBase =
    extractArxivId(paper?.arxiv_id) ||
    extractArxivId(paper?.arxivId) ||
    extractArxivId(externalId) ||
    extractArxivId(paper?.url) ||
    extractArxivId(paper?.pdf_url) ||
    "";
  const semanticScholarPaperId = toTrimmedOrNull(
    paper?.semantic_scholar_paper_id || paper?.semanticScholarPaperId,
    128
  );
  const openreviewForumId = toTrimmedOrNull(
    paper?.openreview_forum_id || paper?.openreviewForumId,
    191
  );

  if (arxivBase) {
    const row = await tx.paperRecord.findFirst({
      where: {
        source,
        OR: [
          { arxivId: arxivBase },
          { externalId: arxivBase },
          { externalId: { startsWith: `${arxivBase}v` } },
          { url: { contains: `/abs/${arxivBase}`, mode: "insensitive" } },
          { url: { contains: `/pdf/${arxivBase}`, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        externalId: true,
        arxivId: true,
        semanticScholarPaperId: true,
        openreviewForumId: true,
        venue: true,
        citationCount: true,
        referenceCount: true,
        repoUrl: true,
        repoResolution: true,
        originText: true,
        originSource: true,
        huggingfaceComments: true,
      },
    });
    if (row) return { row, arxivBase };
  }

  if (semanticScholarPaperId) {
    const row = await tx.paperRecord.findFirst({
      where: {
        source,
        OR: [
          { externalId: semanticScholarPaperId },
          { semanticScholarPaperId },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        externalId: true,
        arxivId: true,
        semanticScholarPaperId: true,
        openreviewForumId: true,
        venue: true,
        citationCount: true,
        referenceCount: true,
        repoUrl: true,
        repoResolution: true,
        originText: true,
        originSource: true,
        huggingfaceComments: true,
      },
    });
    if (row) return { row, arxivBase };
  }

  if (openreviewForumId) {
    const row = await tx.paperRecord.findFirst({
      where: {
        source,
        OR: [
          { externalId: openreviewForumId },
          { openreviewForumId },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        externalId: true,
        arxivId: true,
        semanticScholarPaperId: true,
        openreviewForumId: true,
        venue: true,
        citationCount: true,
        referenceCount: true,
        repoUrl: true,
        repoResolution: true,
        originText: true,
        originSource: true,
        huggingfaceComments: true,
      },
    });
    if (row) return { row, arxivBase };
  }

  const byExactExternal = await tx.paperRecord.findFirst({
    where: { source, externalId },
    select: {
      id: true,
      externalId: true,
      arxivId: true,
      semanticScholarPaperId: true,
      openreviewForumId: true,
      venue: true,
      citationCount: true,
      referenceCount: true,
      repoUrl: true,
      repoResolution: true,
      originText: true,
      originSource: true,
      huggingfaceComments: true,
    },
  });

  if (byExactExternal) return { row: byExactExternal, arxivBase };

  const exactTitle = toTrimmedOrNull(paper?.title, 2_000);
  if (exactTitle) {
    const byExactTitle = await tx.paperRecord.findFirst({
      where: {
        source,
        title: { equals: exactTitle, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        externalId: true,
        arxivId: true,
        semanticScholarPaperId: true,
        openreviewForumId: true,
        venue: true,
        citationCount: true,
        referenceCount: true,
        repoUrl: true,
        repoResolution: true,
        originText: true,
        originSource: true,
        huggingfaceComments: true,
      },
    });
    if (byExactTitle) return { row: byExactTitle, arxivBase };
  }

  return { row: null, arxivBase };
}

function getRedditPlatformId(t) {
  // try common fields; fallback to sha1(url)
  const id =
    t?.platformId ||
    t?.id ||
    t?.post_id ||
    t?.fullname ||
    t?.name ||
    t?.permalink ||
    t?.url;
  const s = String(id || "").trim();
  if (s) return s;
  return sha1(String(t?.url || t?.permalink || t?.title || ""));
}

function epochToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // many APIs return seconds
  const ms = n < 10_000_000_000 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function persistRunToDb({ userId, query, note, filters, out, rid }) {
  // Your schema requires userId on Search; so if no user, skip persistence.
  if (!userId) return { searchId: null, paperId: null };
  const persistablePaper = out?.paper && typeof out.paper === "object" ? out.paper : null;

  let extractedStoryOriginText = null;
  let usingExtractedStoryText = false;
  if (persistablePaper) {
    try {
      const source = String(persistablePaper?.source || "arxiv").trim() || "arxiv";
      const externalId = pickPaperExternalId(persistablePaper);
      const existingPaper = await findExistingPaperRow(prisma, source, externalId, persistablePaper);
      const needStoryText = !hasStoryOriginText(existingPaper?.row);

      if (needStoryText && isArxivBackedPaper(persistablePaper)) {
        extractedStoryOriginText = await extractPdfStoryText(persistablePaper, rid);
        usingExtractedStoryText = Boolean(extractedStoryOriginText);
      }
    } catch (e) {
      logErr(rid, "Paper story text prefetch failed", e?.stack || e);
    }
  }

  try {
    // ✅ Transaction: ensures consistency and avoids half-writes
    const result = await prisma.$transaction(async (tx) => {
      const rawQuery = String(query || "").trim();
      const historyTitle = String(persistablePaper?.title || rawQuery || "").trim() || rawQuery;
      const persistedQuery = rawQuery || historyTitle;
      const safeNote = note ? String(note) : null;
      let reusableSearch = null;

      if (persistablePaper) {
        const source = String(persistablePaper?.source || "arxiv").trim() || "arxiv";
        const externalId = pickPaperExternalId(persistablePaper);
        const arxivBase =
          extractArxivId(persistablePaper?.arxiv_id) ||
          extractArxivId(persistablePaper?.arxivId) ||
          extractArxivId(externalId) ||
          extractArxivId(persistablePaper?.url) ||
          extractArxivId(persistablePaper?.pdf_url);
        const semanticScholarPaperId = toTrimmedOrNull(
          persistablePaper?.semantic_scholar_paper_id || persistablePaper?.semanticScholarPaperId,
          128
        );
        const openreviewForumId = toTrimmedOrNull(
          persistablePaper?.openreview_forum_id || persistablePaper?.openreviewForumId,
          191
        );
        const idClauses = arxivBase
          ? [
              { arxivId: arxivBase },
              { externalId: arxivBase },
              { externalId: { startsWith: `${arxivBase}v` } },
              { url: { contains: `/abs/${arxivBase}`, mode: "insensitive" } },
              { url: { contains: `/pdf/${arxivBase}`, mode: "insensitive" } },
            ]
          : [
              { externalId },
              ...(semanticScholarPaperId ? [{ semanticScholarPaperId }] : []),
              ...(openreviewForumId ? [{ openreviewForumId }] : []),
              ...(persistablePaper?.title
                ? [{ title: { equals: String(persistablePaper.title), mode: "insensitive" } }]
                : []),
            ];

        reusableSearch = await tx.userSearch.findFirst({
          where: {
            userId,
            results: {
              some: {
                paper: {
                  source,
                  OR: idClauses,
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
      } else {
        reusableSearch = await tx.userSearch.findFirst({
          where: {
            userId,
            OR: [
              { query: { equals: persistedQuery, mode: "insensitive" } },
              { query: { equals: historyTitle, mode: "insensitive" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
      }

      let searchId = null;
      if (reusableSearch?.id) {
        await tx.userSearch.update({
          where: { id: reusableSearch.id },
          data: {
            createdAt: new Date(),
            query: persistedQuery,
            filters,
            note: safeNote,
          },
        });
        searchId = reusableSearch.id;
      } else {
        const created = await tx.userSearch.create({
          data: {
            userId,
            query: persistedQuery,
            filters,
            note: safeNote,
          },
          select: { id: true },
        });
        searchId = created.id;
      }

      // If no paper found / low confidence, stop after touching/creating Search.
      if (!persistablePaper) return { searchId, paperId: null };

      const p = persistablePaper;
      const openReviewRows = Array.isArray(out?._openreviewRows) ? out._openreviewRows : [];
      const openReviewFetchOk = out?._openreviewFetchOk === true;
      const huggingfaceRows = Array.isArray(out?._huggingfaceRows) ? out._huggingfaceRows : [];
      const githubRows = Array.isArray(out?._githubRows) ? out._githubRows : [];
      const semanticScholarRowsRaw = Array.isArray(out?._semanticScholarRows) ? out._semanticScholarRows : [];
      const repoResolutionRecord = sanitizeJson(out?._repoResolution);
      const resolvedRepoUrl = normalizeGithubRepoUrl(out?._repoResolution?.repoUrl || null);
      const discoveredRepoUrl =
        resolvedRepoUrl ||
        pickGithubRepoFromHuggingFaceRows(huggingfaceRows) ||
        pickGithubRepoFromGithubRows(githubRows) ||
        null;
      const semanticSourcePaperId = toTrimmedOrNull(
        semanticScholarRowsRaw.find((row) => String(row?.sourcePaperId || "").trim())?.sourcePaperId,
        128
      );
      const source = String(p?.source || "arxiv").trim() || "arxiv";
      const externalId = pickPaperExternalId(p);
      const arxivId =
        extractArxivId(p?.arxiv_id) ||
        extractArxivId(p?.arxivId) ||
        extractArxivId(p?.externalId) ||
        extractArxivId(p?.url) ||
        extractArxivId(p?.pdf_url) ||
        null;
      const semanticScholarPaperId = toTrimmedOrNull(
        p?.semantic_scholar_paper_id || p?.semanticScholarPaperId,
        128
      ) || semanticSourcePaperId;
      const openreviewForumId =
        toTrimmedOrNull(p?.openreview_forum_id || p?.openreviewForumId, 191) ||
        toTrimmedOrNull(p?.publication?.openreview?.forumId, 191) ||
        null;
      const nextTitle = String(p?.title || query);
      const nextUrl = p?.url || p?.pdf_url || null;
      const nextAbstract = p?.abstract || null;
      const nextYear = toIntYear(p?.year) ?? null;
      const nextVenue = toTrimmedOrNull(p?.venue, 500);
      const nextCitationCount = Number.isFinite(Number(p?.citation_count))
        ? Math.trunc(Number(p.citation_count))
        : Number.isFinite(Number(p?.citationCount))
        ? Math.trunc(Number(p.citationCount))
        : null;
      const nextReferenceCount = Number.isFinite(Number(p?.reference_count))
        ? Math.trunc(Number(p.reference_count))
        : Number.isFinite(Number(p?.referenceCount))
        ? Math.trunc(Number(p.referenceCount))
        : null;
      const nextHuggingfaceCommentsRaw = Array.isArray(p?.huggingface_comments)
        ? p.huggingface_comments
        : Array.isArray(p?.huggingfaceComments)
        ? p.huggingfaceComments
        : buildHuggingFaceCommentsPayload(huggingfaceRows);
      const nextHuggingfaceComments = Array.isArray(nextHuggingfaceCommentsRaw)
        ? sanitizeJson(nextHuggingfaceCommentsRaw)
        : null;
      const nextAuthors = p?.authors ?? null;
      const nextOriginSource = normalizePaperOriginSource({
        ...p,
        origin_text_format: usingExtractedStoryText ? "pdf_story_text" : "metadata_text",
      });
      const nextOriginText = buildPaperOriginText(p);

      const existingPaper = await findExistingPaperRow(tx, source, externalId, p);
      let paperRow;

      if (existingPaper?.row?.id) {
        let normalizedExternalId = existingPaper.row.externalId;
        if (externalId && existingPaper.row.externalId !== externalId) {
          const conflict = await tx.paperRecord.findFirst({
            where: { source, externalId },
            select: { id: true },
          });
          if (!conflict || conflict.id === existingPaper.row.id) {
            normalizedExternalId = externalId;
          }
        }

        const mergedOriginSource = mergePaperOriginSource(
          existingPaper.row.originSource,
          nextOriginSource
        );

        paperRow = await tx.paperRecord.update({
          where: { id: existingPaper.row.id },
          data: {
            searchKind: "main_search",
            externalId: normalizedExternalId,
            arxivId: arxivId || existingPaper.row.arxivId || null,
            semanticScholarPaperId:
              semanticScholarPaperId || existingPaper.row.semanticScholarPaperId || null,
            openreviewForumId: openreviewForumId || existingPaper.row.openreviewForumId || null,
            title: nextTitle,
            url: nextUrl,
            abstract: nextAbstract,
            year: nextYear,
            venue: nextVenue || existingPaper.row.venue || null,
            citationCount:
              nextCitationCount != null ? nextCitationCount : existingPaper.row.citationCount ?? null,
            referenceCount:
              nextReferenceCount != null ? nextReferenceCount : existingPaper.row.referenceCount ?? null,
            authors: nextAuthors,
            repoUrl: discoveredRepoUrl || existingPaper.row.repoUrl || null,
            repoResolution: repoResolutionRecord || existingPaper.row.repoResolution || null,
            huggingfaceComments:
              nextHuggingfaceComments || existingPaper.row.huggingfaceComments || null,
            originText: extractedStoryOriginText || existingPaper.row.originText || nextOriginText || null,
            originSource: mergedOriginSource,
          },
        });
      } else {
        paperRow = await tx.paperRecord.create({
          data: {
            source,
            searchKind: "main_search",
            externalId,
            arxivId,
            semanticScholarPaperId,
            openreviewForumId,
            title: nextTitle,
            url: nextUrl,
            abstract: nextAbstract,
            year: nextYear,
            venue: nextVenue,
            citationCount: nextCitationCount,
            referenceCount: nextReferenceCount,
            authors: nextAuthors,
            repoUrl: discoveredRepoUrl || null,
            repoResolution: repoResolutionRecord || null,
            huggingfaceComments: nextHuggingfaceComments || null,
            originText: extractedStoryOriginText || nextOriginText,
            originSource: nextOriginSource,
          },
        });
      }

      const semanticScholarPersistLimit = Math.max(
        1,
        Math.min(Number(process.env.SEMANTIC_SCHOLAR_PERSIST_LIMIT || 100), 100)
      );
      const semanticScholarRows = pickTopSemanticScholarRows(
        semanticScholarRowsRaw,
        semanticScholarPersistLimit
      );
      const semanticNeighborRows = [];
      if (semanticScholarRows.length) {
        const seen = new Set();
        const seenNeighbors = new Set();
        for (const raw of semanticScholarRows) {
          const row = normalizeSemanticScholarRowForDb(raw);
          if (!row?.citationKey) continue;
          const key = `${paperRow.id}:${row.citationKey}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          await tx.paperSemanticScholarCitation.upsert({
            where: {
              paperId_citationKey: {
                paperId: paperRow.id,
                citationKey: row.citationKey,
              },
            },
            update: {
              sourcePaperId: row.sourcePaperId,
              direction: row.direction,
              citedPaperId: row.citedPaperId,
              title: row.title,
              url: row.url,
              influentialCitationCount: row.influentialCitationCount,
              rawPayload: row.rawPayload,
            },
            create: {
              paperId: paperRow.id,
              citationKey: row.citationKey,
              sourcePaperId: row.sourcePaperId,
              direction: row.direction,
              citedPaperId: row.citedPaperId,
              title: row.title,
              url: row.url,
              influentialCitationCount: row.influentialCitationCount,
              rawPayload: row.rawPayload,
            },
          });

          const neighborExternalId = String(row.citedPaperId || "").trim();
          if (!neighborExternalId) continue;
          if (seenNeighbors.has(neighborExternalId)) continue;
          seenNeighbors.add(neighborExternalId);

          const neighborTitle = String(row.title || neighborExternalId).trim() || neighborExternalId;
          const neighborUrl = toSemanticScholarPaperUrl(raw);
          const neighborAuthors = toSemanticScholarPaperAuthors(raw);
          const neighborYear = toIntYear(raw?.year);

          const neighborSelect = {
            id: true,
            searchKind: true,
            externalId: true,
            url: true,
            title: true,
            originText: true,
            originSource: true,
          };
          let neighbor = await tx.paperRecord.findUnique({
            where: {
              source_externalId: {
                source: "semantic_scholar",
                externalId: neighborExternalId,
              },
            },
            select: neighborSelect,
          });
          if (!neighbor) {
            neighbor = await tx.paperRecord.findFirst({
              where: {
                source: "semantic_scholar",
                title: { equals: neighborTitle, mode: "insensitive" },
              },
              orderBy: { createdAt: "desc" },
              select: neighborSelect,
            });
          }
          if (neighbor) {
            let normalizedNeighborExternalId = neighbor.externalId;
            if (neighbor.externalId !== neighborExternalId) {
              const conflict = await tx.paperRecord.findUnique({
                where: {
                  source_externalId: {
                    source: "semantic_scholar",
                    externalId: neighborExternalId,
                  },
                },
                select: { id: true },
              });
              if (!conflict || conflict.id === neighbor.id) {
                normalizedNeighborExternalId = neighborExternalId;
              }
            }
            neighbor = await tx.paperRecord.update({
              where: { id: neighbor.id },
              data: {
                searchKind:
                  neighbor.searchKind === "main_search" ? "main_search" : "citation_search",
                externalId: normalizedNeighborExternalId,
                semanticScholarPaperId: neighborExternalId,
                arxivId: extractArxivId(row?.arxivId || raw?.url) || null,
                title: neighborTitle,
                ...(neighborUrl ? { url: neighborUrl } : {}),
                ...(neighborYear != null ? { year: neighborYear } : {}),
                ...(neighborAuthors.length ? { authors: neighborAuthors } : {}),
              },
              select: neighborSelect,
            });
          } else {
            neighbor = await tx.paperRecord.create({
              data: {
                source: "semantic_scholar",
                searchKind: "citation_search",
                externalId: neighborExternalId,
                semanticScholarPaperId: neighborExternalId,
                arxivId: extractArxivId(row?.arxivId || raw?.url) || null,
                title: neighborTitle,
                url: neighborUrl || `https://www.semanticscholar.org/paper/${encodeURIComponent(neighborExternalId)}`,
                year: neighborYear,
                authors: neighborAuthors,
              },
              select: neighborSelect,
            });
          }
          semanticNeighborRows.push(neighbor);
        }
      }

      if (openReviewRows.length) {
        const seen = new Set();
        for (const raw of openReviewRows) {
          const row = normalizeOpenReviewRowForDb(raw);
          if (!row?.noteId) continue;
          const key = `${paperRow.id}:${row.noteId}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          await tx.paperOpenReviewNote.upsert({
            where: {
              paperId_noteId: {
                paperId: paperRow.id,
                noteId: row.noteId,
              },
            },
            update: {
              forumId: row.forumId,
              parentNoteId: row.parentNoteId,
              noteType: row.noteType,
              invitation: row.invitation,
              title: row.title,
              summary: row.summary,
              strengths: row.strengths,
              weaknesses: row.weaknesses,
              questions: row.questions,
              comment: row.comment,
              details: row.details,
              decision: row.decision,
              soundness: row.soundness,
              presentation: row.presentation,
              contribution: row.contribution,
              ratingText: row.ratingText,
              confidenceText: row.confidenceText,
              ratingScore: row.ratingScore,
              confidenceScore: row.confidenceScore,
              url: row.url,
              readers: row.readers,
              signatures: row.signatures,
              rawContent: row.rawContent,
              createdAtRemote: row.createdAtRemote,
              updatedAtRemote: row.updatedAtRemote,
            },
            create: {
              paperId: paperRow.id,
              noteId: row.noteId,
              forumId: row.forumId,
              parentNoteId: row.parentNoteId,
              noteType: row.noteType,
              invitation: row.invitation,
              title: row.title,
              summary: row.summary,
              strengths: row.strengths,
              weaknesses: row.weaknesses,
              questions: row.questions,
              comment: row.comment,
              details: row.details,
              decision: row.decision,
              soundness: row.soundness,
              presentation: row.presentation,
              contribution: row.contribution,
              ratingText: row.ratingText,
              confidenceText: row.confidenceText,
              ratingScore: row.ratingScore,
              confidenceScore: row.confidenceScore,
              url: row.url,
              readers: row.readers,
              signatures: row.signatures,
              rawContent: row.rawContent,
              createdAtRemote: row.createdAtRemote,
              updatedAtRemote: row.updatedAtRemote,
            },
          });
        }
        if (!paperRow.openreviewForumId) {
          const forumFromRows = toTrimmedOrNull(
            openReviewRows.find((x) => String(x?.forum || "").trim())?.forum,
            191
          );
          if (forumFromRows) {
            paperRow = await tx.paperRecord.update({
              where: { id: paperRow.id },
              data: { openreviewForumId: forumFromRows },
            });
          }
        }
      } else if (openReviewFetchOk) {
        // If OpenReview fetch succeeded but returned no verified rows,
        // clear stale rows to avoid showing previously mismatched forums.
        await tx.paperOpenReviewNote.deleteMany({
          where: { paperId: paperRow.id },
        });
      }

      // Save summary/novelty if present
      const noveltyPoints = (Array.isArray(out?.novelty) ? out.novelty : Array.isArray(out?.key_points) ? out.key_points : [])
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 12);
      const summaryStorage = normalizeSummaryStorage(out?._summaryStorage);
      const summaryText = typeof out?.summary === "string" ? String(out.summary).trim() : "";
      const summaryUpdateData = {};
      if (summaryText) summaryUpdateData.summaryMd = summaryText;
      if (noveltyPoints.length) summaryUpdateData.keyPoints = noveltyPoints;
      if (summaryStorage?.model || out?.summary_model) {
        summaryUpdateData.summaryModel = summaryStorage?.model || String(out.summary_model);
      }
      if (summaryStorage?.promptVersion || summaryText || noveltyPoints.length) {
        summaryUpdateData.summaryPromptVersion = summaryStorage?.promptVersion || CACHE_VERSION;
      }
      if (summaryStorage?.promptText) {
        summaryUpdateData.summaryPromptText = summaryStorage.promptText;
      }
      if (summaryStorage?.summarySource) {
        summaryUpdateData.summarySource = summaryStorage.summarySource;
      }
      if (Object.keys(summaryUpdateData).length) {
        await tx.paperRecord.update({
          where: { id: paperRow.id },
          data: summaryUpdateData,
        });
      }

      // Upsert reddit posts
      const threads = Array.isArray(out?.reddit_threads) ? out.reddit_threads : [];
      const redditIds = [];

      for (const t of threads.slice(0, 10)) {
        const platformId = getRedditPlatformId(t);
        const url = String(t?.url || t?.permalink || "").trim();
        const title = String(t?.title || "").trim() || "(untitled)";
        const subreddit = t?.subreddit ? String(t.subreddit) : null;

        const rp = await tx.paperRedditPost.upsert({
          where: { platformId },
          create: {
            platformId,
            subreddit,
            title,
            url: url || null,
            score: Number.isFinite(Number(t?.score)) ? Number(t.score) : null,
            numComments: Number.isFinite(Number(t?.numComments ?? t?.num_comments))
              ? Number(t.numComments ?? t.num_comments)
              : null,
            createdUtc: epochToDate(t?.createdUtc ?? t?.created_utc) ?? null,
            snippet: t?.snippet ? String(t.snippet) : null,
          },
          update: {
            subreddit,
            title,
            url: url || null,
            score: Number.isFinite(Number(t?.score)) ? Number(t.score) : null,
            numComments: Number.isFinite(Number(t?.numComments ?? t?.num_comments))
              ? Number(t.numComments ?? t.num_comments)
              : null,
            createdUtc: epochToDate(t?.createdUtc ?? t?.created_utc) ?? null,
            snippet: t?.snippet ? String(t.snippet) : null,
          },
        });

        redditIds.push(rp.id);
      }

      // ✅ CRITICAL FIX:
      // Link reddit posts to *this search* as well, so querying by searchId works.
      // We use createMany(skipDuplicates) to avoid depending on a specific unique constraint name.
      if (redditIds.length) {
        await tx.paperRedditLink.createMany({
          data: redditIds.map((redditPostId) => ({
            searchId,
            paperId: paperRow.id,
            redditPostId,
            matchedBy: "title+query",
          })),
          skipDuplicates: true,
        });
      }

      // Save SearchResults: rank 1 = paper, rank 2.. = reddit posts
      // If your SearchResult schema doesn't have redditPostId, we still keep rank=1 paper.
      try {
        const rows = [
          { searchId, rank: 1, paperId: paperRow.id },
          ...redditIds.map((rid2, i) => ({
            searchId,
            rank: i + 2,
            redditPostId: rid2,
          })),
        ];

        await tx.userSearchResult.createMany({
          data: rows,
          skipDuplicates: true,
        });
      } catch {
        await tx.userSearchResult.createMany({
          data: [{ searchId, rank: 1, paperId: paperRow.id }],
          skipDuplicates: true,
        });
      }

      return { searchId, paperId: paperRow.id, semanticNeighborRows };
    });
    const neighborRows = Array.isArray(result?.semanticNeighborRows) ? result.semanticNeighborRows : [];
    if (neighborRows.length) {
      const hydratePromise = hydrateSemanticScholarNeighborTexts(neighborRows, rid);
      if (String(process.env.SEMANTIC_SCHOLAR_TEXT_FETCH_WAIT || "0") === "1") {
        await hydratePromise;
      } else {
        hydratePromise.catch((e) => logErr(rid, "Semantic Scholar neighbor hydration failed", e?.message || e));
      }
    }

    return { searchId: result?.searchId || null, paperId: result?.paperId || null };
  } catch (e) {
    logErr(rid, "DB persist failed", e?.stack || e);
    return { searchId: null, paperId: null };
  }
}

async function resolveCitationPaperArxivId(
  paper,
  { query, year = null, category = null, safeLimit = 5, requestId = "no-rid" } = {}
) {
  if (!paper || typeof paper !== "object") return paper;
  if (isArxivBackedPaper(paper)) return paper;

  const title = toTrimmedOrNull(paper?.title || query, 2_000);
  if (!title) return paper;

  const resolveLimit = Math.max(
    3,
    Math.min(Number(process.env.CITATION_ARXIV_RESOLVE_LIMIT || safeLimit || 5), 10)
  );

  try {
    const candidates = await withTimeout(
      getArxivCandidates(title, resolveLimit, year, category),
      45_000,
      "citation arxiv resolve"
    );
    if (!Array.isArray(candidates) || !candidates.length) return paper;

    const exact = candidates.find((cand) => normTitle(cand?.title) === normTitle(title));
    if (!exact) return paper;

    const arxivId = extractArxivId(exact?.arxiv_id || exact?.url || exact?.pdf_url || "");
    if (!arxivId) return paper;

    return {
      ...paper,
      arxiv_id: arxivId,
      year: toIntYear(paper?.year) ?? toIntYear(exact?.year),
      abstract: paper?.abstract || exact?.abstract || null,
      authors:
        Array.isArray(paper?.authors) && paper.authors.length
          ? paper.authors
          : Array.isArray(exact?.authors)
          ? exact.authors
          : [],
      url: paper?.url || exact?.url || `https://arxiv.org/abs/${arxivId}`,
      pdf_url: paper?.pdf_url || exact?.pdf_url || `https://arxiv.org/pdf/${arxivId}.pdf`,
      originSource: mergePaperOriginSource(paper?.originSource, {
        citation_arxiv_resolved: true,
        citation_arxiv_id: arxivId,
        citation_arxiv_title: toTrimmedOrNull(exact?.title, 2_000),
        citation_arxiv_url: toTrimmedOrNull(exact?.url, 2_000),
        citation_arxiv_pdf_url: toTrimmedOrNull(exact?.pdf_url, 2_000),
      }),
    };
  } catch (e) {
    logErr(requestId, "Citation arXiv id resolve failed", e?.message || e);
    return paper;
  }
}

async function buildPaperResponse({
  query,
  limit,
  year = null,
  category = null,
  userId = null,
  PY_BASE,
  onProgress,
  requestId = "no-rid",
}) {
  const rid = requestId;
  const safeLimit = Math.max(1, Math.min(Number(limit || 5) || 5, 10));
  const qKey = `${CACHE_VERSION}|${normQuery(query)}|${safeLimit}|${year || ""}|${category || ""}`;

  const uid = String(userId || "").trim();
  let chargedQuota = null;
  let citationPaperFromDb = null;
  let openreviewPublication = null;

  if (uid) {
    onProgress?.({ stage: "checking_history", pct: 0.05 });
    try {
      const historyHit = await withTimeout(findHistoryMatch(uid, query, year, category), 4_000, "history lookup");
      if (isMainSearchPaperOut(historyHit?.out)) {
        await queryCache.set(qKey, historyHit.out);
        onProgress?.({ stage: "done", pct: 1.0, note: "history_hit" });
        return historyHit.out;
      }
    } catch (e) {
      logErr(rid, "History lookup failed before cache", e?.stack || e);
    }
  }

  const cached = await queryCache.get(qKey);
  if (cached) {
    const source = String(cached?.lookup_source || "").trim() || "cache";
    // Only main_search can short-circuit with zero API calls.
    if (!hasUsablePaper(cached)) {
      onProgress?.({ stage: "cache_stale", pct: 0.12, note: `${source}_without_usable_paper` });
    } else if (!isMainSearchPaperOut(cached)) {
      onProgress?.({ stage: "cache_partial", pct: 0.12, note: `${source}_citation_requires_enrichment` });
    } else {
      onProgress?.({ stage: "cache_hit", pct: 1.0 });
      return withLookupSource(cached, source);
    }
  }

  onProgress?.({ stage: "checking_db", pct: 0.1 });
  try {
    const dbHit = await withTimeout(findPaperInDbFirst(query, year, category), 4_000, "db lookup");
    if (dbHit?.paper) {
      const dbKind = String(dbHit.searchKind || dbHit.paper?.search_kind || "main_search")
        .trim()
        .toLowerCase();
      if (dbKind === "citation_search") {
        citationPaperFromDb = {
          ...dbHit.paper,
          ...(dbHit?.originText ? { fullText: dbHit.originText } : {}),
        };
        onProgress?.({ stage: "db_citation_hit", pct: 0.14, note: "db_partial_requires_enrichment" });
      } else {
        const out = {
          ok: true,
          paper: dbHit.paper,
          summary: dbHit.summary ?? null,
          novelty: dbHit.novelty ?? null,
          reddit_threads: Array.isArray(dbHit.reddit_threads) ? dbHit.reddit_threads : [],
          openreview_summary: dbHit.openreview_summary ?? null,
          request_id: rid,
          _summaryStorage: normalizeSummaryStorage(dbHit.summaryStorage),
        };
        const tagged = withLookupSource(out, "db");
        await queryCache.set(qKey, tagged);
        onProgress?.({ stage: "done", pct: 1.0, note: "db_main_hit" });
        return tagged;
      }
    }
  } catch (e) {
    logErr(rid, "DB lookup failed before web search", e?.stack || e);
  }

  if (EXTERNAL_API_CALLS_DISABLED) {
    const out = {
      ok: true,
      paper: null,
      summary: null,
      novelty: null,
      reddit_threads: [],
      code: "EXTERNAL_FETCH_DISABLED",
      note: "External API calls are temporarily disabled by configuration.",
      request_id: rid,
    };
    const tagged = withLookupSource(out, "config");
    await queryCache.set(qKey, tagged);
    onProgress?.({ stage: "done", pct: 1.0, note: "external_fetch_disabled" });
    return tagged;
  }

  const QUERY_IS_ARXIV = looksLikeArxivIdOrUrl(query);
  const MIN_MATCH = Number(process.env.MIN_PAPER_MATCH_SCORE || 45);
  const OPENREVIEW_PUBLICATION_LIMIT = Math.max(
    5,
    Math.min(Number(process.env.OPENREVIEW_PUBLICATION_LIMIT || 20), 50)
  );
  let paper = citationPaperFromDb ? { ...citationPaperFromDb } : null;
  let candidates = [];

  if (!paper) {
    onProgress?.({ stage: "searching_sources", pct: 0.15 });
    const sourceSettled = QUERY_IS_ARXIV
      ? await Promise.allSettled([
          withTimeout(getArxivCandidates(query, safeLimit, year, category), 45_000, "arxiv search"),
        ])
      : await Promise.allSettled([
          withTimeout(getArxivCandidates(query, safeLimit, year, category), 45_000, "arxiv search"),
          withTimeout(
            fetchSemanticScholarPrimaryByTitle(query, { year, requestId: rid }),
            20_000,
            "semantic scholar title search"
          ),
          withTimeout(
            fetchOpenReviewPublicationByTitle(query, {
              limit: OPENREVIEW_PUBLICATION_LIMIT,
              arxivId: extractArxivId(query) || null,
            }),
            20_000,
            "openreview publication search"
          ),
        ]);

    const arxivCandidates = settledArray(sourceSettled[0]);
    candidates = Array.isArray(arxivCandidates) ? arxivCandidates : [];
    const arxivSearchErr = settledError(sourceSettled[0]);
    if (arxivSearchErr) logErr(rid, "arXiv search failed", arxivSearchErr?.message || arxivSearchErr);
    if (!QUERY_IS_ARXIV) {
      const semanticSearchErr = settledError(sourceSettled[1]);
      const openreviewSearchErr = settledError(sourceSettled[2]);
      if (semanticSearchErr) {
        logErr(rid, "Semantic Scholar title search failed", semanticSearchErr?.message || semanticSearchErr);
      }
      if (openreviewSearchErr) {
        logErr(rid, "OpenReview title search failed", openreviewSearchErr?.message || openreviewSearchErr);
      }
    }

    paper = pickBestCandidate(arxivCandidates, query, year, category) || null;

    if (paper && !QUERY_IS_ARXIV) {
      const exact = normTitle(query) === normTitle(paper?.title);
      if (!exact && typeof paper.match_score === "number" && paper.match_score < MIN_MATCH) {
        paper = null;
      }
    }

    if (!paper && !QUERY_IS_ARXIV) {
      const semanticPaper = sourceSettled[1]?.status === "fulfilled" ? sourceSettled[1].value : null;
      if (semanticPaper && normTitle(query) === normTitle(semanticPaper?.title)) {
        const semanticArxivId = extractArxivId(semanticPaper?.arxiv_id || semanticPaper?.url || "");
        if (semanticArxivId) {
          const fallbackArxivCandidates = await withTimeout(
            getArxivCandidates(semanticArxivId, 1, year, category),
            30_000,
            "arxiv lookup by semantic scholar arxiv id"
          );
          const fallbackArxivPaper = pickBestCandidate(
            fallbackArxivCandidates,
            semanticArxivId,
            year,
            category
          );
          if (fallbackArxivPaper) {
            paper = fallbackArxivPaper;
          }
        }
        if (!paper) {
          paper = semanticPaper;
        }
      }
    }

    if (!paper && !QUERY_IS_ARXIV) {
      openreviewPublication = sourceSettled[2]?.status === "fulfilled" ? sourceSettled[2].value : null;
      if (openreviewPublication && normTitle(query) === normTitle(openreviewPublication?.title)) {
        const openreviewPaper = mapOpenReviewPrimaryPaper(openreviewPublication, query);
        if (openreviewPaper) {
          paper = openreviewPaper;
        }
      }
    }

    if (!paper) {
      const out = {
        ok: true,
        paper: null,
        summary: null,
        novelty: null,
        reddit_threads: [],
        candidates,
        code: "PAPER_NOT_FOUND",
        note:
          "No exact paper match found in DB/arXiv/Semantic Scholar/OpenReview. Use exact title, arXiv ID, or DOI.",
        request_id: rid,
      };
      const tagged = withLookupSource(out, "web");
      await queryCache.set(qKey, tagged);
      onProgress?.({ stage: "done", pct: 1.0, note: out.note });
      return tagged;
    }
  } else {
    onProgress?.({ stage: "citation_enrich", pct: 0.15 });
  }

  if (String(paper?.search_kind || "").trim().toLowerCase() === "citation_search") {
    onProgress?.({ stage: "citation_resolve_arxiv", pct: 0.2 });
    paper = await resolveCitationPaperArxivId(paper, {
      query,
      year,
      category,
      safeLimit,
      requestId: rid,
    });
  }

  onProgress?.({ stage: "checking_publication", pct: 0.4 });
  try {
    if (isArxivBackedPaper(paper)) {
      const publication = await resolvePublicationStatus(paper, rid);
      if (publication && typeof publication === "object") {
        paper.publication = publication;
        paper.publication_status = publication.status || null;
        paper.publication_confidence = publication.confidence || null;
        paper.venue = toTrimmedOrNull(publication?.venue, 500) || toTrimmedOrNull(paper?.venue, 500);
        paper.semantic_scholar_paper_id =
          toTrimmedOrNull(publication?.semanticScholarPaperId, 128) ||
          toTrimmedOrNull(paper?.semantic_scholar_paper_id || paper?.semanticScholarPaperId, 128) ||
          null;
        paper.citation_count = Number.isFinite(Number(publication?.citationCount))
          ? Math.trunc(Number(publication.citationCount))
          : Number.isFinite(Number(paper?.citation_count))
          ? Math.trunc(Number(paper.citation_count))
          : Number.isFinite(Number(paper?.citationCount))
          ? Math.trunc(Number(paper.citationCount))
          : null;
        paper.reference_count = Number.isFinite(Number(publication?.referenceCount))
          ? Math.trunc(Number(publication.referenceCount))
          : Number.isFinite(Number(paper?.reference_count))
          ? Math.trunc(Number(paper.reference_count))
          : Number.isFinite(Number(paper?.referenceCount))
          ? Math.trunc(Number(paper.referenceCount))
          : null;
      }
    } else if (paper?.source === "openreview") {
      const venue = toTrimmedOrNull(openreviewPublication?.venue, 500);
      const decision = toTrimmedOrNull(openreviewPublication?.decision, 500);
      const status = Boolean(openreviewPublication?.isPublished) && !isLikelyPreprintVenue(venue)
        ? "published"
        : "preprint";
      paper.publication = {
        status,
        confidence: "medium",
        source: "openreview",
        checkedAt: new Date().toISOString(),
        venue: venue || null,
        openreview: {
          forumId: toTrimmedOrNull(openreviewPublication?.forumId, 191),
          forumUrl: toTrimmedOrNull(openreviewPublication?.forumUrl, 2_000),
          decision: decision || null,
        },
      };
      paper.publication_status = paper.publication.status;
      paper.publication_confidence = paper.publication.confidence;
      paper.venue = venue || toTrimmedOrNull(paper?.venue, 500) || null;
    }
  } catch (e) {
    logErr(rid, "Publication status check failed", e?.message || e);
  }

  const paperId = paper.arxiv_id || paper.url || paper.title;
  const absHash = sha1(paper.abstract || "");
  const paperKey = `${CACHE_VERSION}|summary|${paperId}|${absHash}`;
  const redditKey = `${CACHE_VERSION}|reddit|${paperId}|10`;

  onProgress?.({ stage: "fetching_reddit", pct: 0.45 });
  let reddit_threads = await redditCache.get(redditKey);
  if (!Array.isArray(reddit_threads)) {
    try {
      reddit_threads = await withTimeout(redditSearch(paper, 10), 18_000, "reddit search");
    } catch {
      reddit_threads = [];
    }
    reddit_threads = (reddit_threads || []).slice(0, 10);
    await redditCache.set(redditKey, reddit_threads);
  }
  reddit_threads = (reddit_threads || []).slice(0, 10);

  onProgress?.({ stage: "fetching_sources", pct: 0.58 });
  const rawEvidence = await buildEvidencePayload({
    query,
    paper,
    redditThreads: reddit_threads,
    requestId: rid,
  });
  const semanticScholarRows = Array.isArray(rawEvidence?.sources?.semantic_scholar)
    ? rawEvidence.sources.semantic_scholar
    : [];
  const githubRows = Array.isArray(rawEvidence?.sources?.github)
    ? rawEvidence.sources.github
    : [];
  const openreviewRows = Array.isArray(rawEvidence?.sources?.openreview)
    ? rawEvidence.sources.openreview
    : [];
  const openreviewFetchOk = Boolean(rawEvidence?.meta?.openreview_fetch_ok);
  const openreviewSummary = summarizeOpenReviewRows(openreviewRows);
  if (openreviewSummary && paper && typeof paper === "object") {
    paper.openreview_summary = openreviewSummary;
  }
  const huggingfaceRows = Array.isArray(rawEvidence?.sources?.huggingface)
    ? rawEvidence.sources.huggingface
    : [];
  const huggingfaceUrl = pickHuggingFaceUrlFromRows(huggingfaceRows);
  const huggingfaceComments = buildHuggingFaceCommentsPayload(huggingfaceRows);
  if (huggingfaceUrl && paper && typeof paper === "object") {
    paper.huggingface_url = huggingfaceUrl;
    paper.huggingfaceUrl = huggingfaceUrl;
  }
  if (paper && typeof paper === "object") {
    paper.huggingface_comments = huggingfaceComments;
    paper.huggingfaceComments = huggingfaceComments;
  }

  onProgress?.({ stage: "resolving_repo", pct: 0.62 });
  const repoResolution = await resolveRepoFromEvidence({
    paper,
    semanticScholarRows,
    githubRows,
    huggingfaceRows,
    requestId: rid,
  });
  if (repoResolution?.repoUrl) {
    paper.repo_url = repoResolution.repoUrl;
    paper.repoUrl = repoResolution.repoUrl;
    paper.repo_confidence = repoResolution.confidence || null;
    paper.repo_score = Number.isFinite(Number(repoResolution.score))
      ? Number(repoResolution.score)
      : null;
    paper.repo_resolution_strategy = repoResolution.strategy || null;
    paper.repo_manual_review = Boolean(repoResolution.manualReview);
  }

  // best-effort ingest handoff; do not block summary or response behavior
  await postEvidenceToPython({
    PY_BASE,
    payload: rawEvidence,
    requestId: rid,
  });

  // Summary cache hit
  const cachedSummary = await summaryCache.get(paperKey);
  if (cachedSummary && typeof cachedSummary === "object") {
    const out = {
      ok: true,
      paper,
      summary: cachedSummary.summary ?? null,
      novelty: cachedSummary.novelty ?? null,
      reddit_threads,
      openreview_summary: mergeOpenReviewSummary(cachedSummary.openreview_summary, openreviewSummary),
      request_id: rid,
      _summaryStorage: normalizeSummaryStorage(cachedSummary._summaryStorage),
      _semanticScholarRows: semanticScholarRows,
      _githubRows: githubRows,
      _openreviewRows: openreviewRows,
      _openreviewFetchOk: openreviewFetchOk,
      _huggingfaceRows: huggingfaceRows,
      _repoResolution: repoResolution,
    };
    const tagged = withLookupSource(out, "web");
    await queryCache.set(qKey, tagged);
    onProgress?.({ stage: "done", pct: 1.0, note: "summary_cache_hit" });
    return tagged;
  }

  // Charge paper-search quota only when this request is about to invoke the LLM summary step.
  if (uid) {
    chargedQuota = await assertUserQuota("paper_search", uid, { requestId: rid });
  }

  onProgress?.({ stage: "summarizing_paper", pct: 0.7 });

  let py;
  try {
    py = await runWithSummaryQueue(
      () =>
        fetchJsonRetry(`${PY_BASE}/paper_summary`, {
          method: "POST",
          timeoutMs: 240_000,
          dependency: "paper_ai",
          headers: { "Content-Type": "application/json", "x-request-id": rid },
          body: JSON.stringify({
            topic: paper.title || query,
            paper,
            candidates,
            openreview_rows: openreviewRows,
          }),
        }),
      { requestId: rid, jobType: "paper_summary" }
    );
  } catch (e) {
    if (isSummaryQueueBusyError(e)) {
      throw e;
    }
    logErr(rid, "Python summary request failed", e?.stack || e);
    const pythonUnavailable = isLikelyPythonUnavailable(e);
    const out = {
      ok: true,
      paper,
      summary: null,
      novelty: null,
      reddit_threads,
      openreview_summary: openreviewSummary,
      error: pythonUnavailable
        ? "Python summary service is unavailable right now. Please retry shortly."
        : `Python request failed: ${String(e?.message || e)}`,
      code: pythonUnavailable ? "PYTHON_UNAVAILABLE" : "PYTHON_REQUEST_FAILED",
      retry_after_sec: pythonUnavailable ? 5 : null,
      request_id: rid,
      _quota: chargedQuota,
      _semanticScholarRows: semanticScholarRows,
      _githubRows: githubRows,
      _openreviewRows: openreviewRows,
      _openreviewFetchOk: openreviewFetchOk,
      _huggingfaceRows: huggingfaceRows,
      _repoResolution: repoResolution,
    };
    const tagged = withLookupSource(out, "web");
    await queryCache.set(qKey, tagged);
    onProgress?.({ stage: "done", pct: 1.0 });
    return tagged;
  }

  if (py && typeof py === "object" && py.ok !== true && py.detail && !py.error) {
    py.error = String(py.detail);
  }

  if (!py?.ok) {
    const out = {
      ok: true,
      paper,
      summary: null,
      novelty: null,
      reddit_threads,
      openreview_summary: openreviewSummary,
      code: "PYTHON_SUMMARY_FAILED",
      error: py?.error || py?.detail || "Python returned ok=false",
      request_id: rid,
      _quota: chargedQuota,
      _semanticScholarRows: semanticScholarRows,
      _githubRows: githubRows,
      _openreviewRows: openreviewRows,
      _openreviewFetchOk: openreviewFetchOk,
      _huggingfaceRows: huggingfaceRows,
      _repoResolution: repoResolution,
    };
    const tagged = withLookupSource(out, "web");
    await queryCache.set(qKey, tagged);
    onProgress?.({ stage: "done", pct: 1.0 });
    return tagged;
  }

  const summaryStorage = normalizeSummaryStorage({
    model: py?.summary_model || null,
    promptVersion: py?.summary_prompt_version || null,
    promptText: py?.summary_prompt || null,
    summarySource: py?.summary_source || null,
  });
  const summaryObj = {
    summary: py.summary ?? null,
    novelty: py.novelty ?? null,
    openreview_summary: mergeOpenReviewSummary(py.openreview_summary, openreviewSummary),
    _summaryStorage: summaryStorage,
  };

  await summaryCache.set(paperKey, summaryObj);

  const out = {
    ok: true,
    paper,
    summary: summaryObj.summary,
    novelty: summaryObj.novelty,
    reddit_threads,
    openreview_summary: summaryObj.openreview_summary,
    request_id: rid,
    _summaryStorage: summaryStorage,
    _quota: chargedQuota,
    _semanticScholarRows: semanticScholarRows,
    _githubRows: githubRows,
    _openreviewRows: openreviewRows,
    _openreviewFetchOk: openreviewFetchOk,
    _huggingfaceRows: huggingfaceRows,
    _repoResolution: repoResolution,
  };

  const tagged = withLookupSource(out, "web");
  await queryCache.set(qKey, tagged);
  onProgress?.({ stage: "done", pct: 1.0 });
  return tagged;
}

// -------- routes --------
router.post("/paper", async (req, res) => {
  const rid = getRequestId(req, res);

  try {
    const parsed = PaperReq.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.message });
    }

    const { query, limit, year, category, note } = parsed.data;
    const user = getOptionalUser(req);
    const PY_BASE = req.app?.locals?.PY_BASE || process.env.PY_BASE || "http://127.0.0.1:8000";

    const out = await buildPaperResponse({
      query,
      limit,
      year: year ?? null,
      category: category ?? null,
      userId: user?.id || null,
      PY_BASE,
      requestId: rid,
    });
    const publicOut = toPublicPaperOut(out);

    if (out?._quota) {
      setUserQuotaHeaders(res, out._quota);
    }

    if (!user?.id) {
      return res.json({
        ...publicOut,
        search_id: null,
        paper_id: null,
        rag: null,
        history_saved: false,
        history_reason: "Missing or invalid Bearer token",
        request_id: rid,
      });
    }

    // ✅ persist to DB (best effort)
    const filters = {
      limit: limit ?? null,
      year: year ?? null,
      category: category ?? null,
    };

    const { searchId, paperId } = await persistRunToDb({
      userId: user?.id || null,
      query: String(query).trim(),
      note: note ?? null,
      filters,
      out,
      rid,
    });

    let rag = null;
    if (user?.id && searchId && out?.paper) {
      try {
        rag = await indexSearchRun({
          userId: user.id,
          searchId,
          query: String(query).trim(),
          out,
          paperId,
          pyBase: PY_BASE,
        });
      } catch (e) {
        logErr(rid, "RAG indexing failed", e?.stack || e);
      }
    }

    res.json({
      ...publicOut,
      search_id: searchId,
      paper_id: paperId,
      rag,
      history_saved: Boolean(searchId),
      history_reason: searchId ? null : "Search persistence failed",
    });
  } catch (e) {
    if (String(e?.code || "") !== "USER_QUOTA_EXCEEDED") {
      logErr(rid, "Unhandled error", e?.stack || e);
    }
    const status = Number(e?.status) || (isSummaryQueueBusyError(e) ? 503 : 500);
    return res.status(status).json({
      ok: false,
      code: e?.code || null,
      error: String(e?.message || e),
      retry_after_sec: e?.retryAfterSec || null,
      reset_at: e?.resetAt || null,
      quota: e?.quota || null,
      request_id: rid,
    });
  }
});

router.post("/summary/queue-probe", async (req, res) => {
  if (!ENABLE_SUMMARY_QUEUE_PROBE) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  const rid = getRequestId(req, res);
  const holdMsRaw = Number(req.body?.hold_ms ?? 1200);
  const holdMs = Math.max(100, Math.min(Number.isFinite(holdMsRaw) ? holdMsRaw : 1200, 60_000));

  try {
    await runWithSummaryQueue(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, holdMs);
        }),
      { requestId: rid, jobType: "summary_probe" }
    );

    return res.json({
      ok: true,
      request_id: rid,
      hold_ms: holdMs,
    });
  } catch (e) {
    const status = Number(e?.status) || (isSummaryQueueBusyError(e) ? 503 : 500);
    return res.status(status).json({
      ok: false,
      code: e?.code || null,
      error: String(e?.message || e),
      retry_after_sec: e?.retryAfterSec || null,
      request_id: rid,
    });
  }
});

router.get("/paper/stream", async (req, res) => {
  const rid = getRequestId(req, res);
  const query = String(req.query.query || "").trim();
  const limit = Number(req.query.limit || 5);
  const year = req.query.year ?? null;
  const category = req.query.category ?? null;
  const note = req.query.note ?? null;

  if (!query) {
    res.status(400).json({ ok: false, error: "Missing query" });
    return;
  }

  const PY_BASE = req.app?.locals?.PY_BASE || process.env.PY_BASE || "http://127.0.0.1:8000";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseSend(res, "progress", { stage: "starting", pct: 0.05 });

  try {
    const user = getOptionalUser(req);

    const out = await buildPaperResponse({
      query,
      limit,
      year,
      category,
      userId: user?.id || null,
      PY_BASE,
      onProgress: (p) => sseSend(res, "progress", p),
      requestId: rid,
    });
    const publicOut = toPublicPaperOut(out);

    if (!user?.id) {
      sseSend(res, "result", {
        ...publicOut,
        search_id: null,
        paper_id: null,
        rag: null,
        history_saved: false,
        history_reason: "Missing or invalid Bearer token",
      });
      return;
    }

    // ✅ best-effort DB persist for SSE too (attach if logged-in)
    const filters = {
      limit: Number.isFinite(limit) ? limit : null,
      year: year ?? null,
      category: category ?? null,
    };

    const { searchId, paperId } = await persistRunToDb({
      userId: user?.id || null,
      query,
      note: note ?? null,
      filters,
      out,
      rid,
    });

    let rag = null;
    if (user?.id && searchId && out?.paper) {
      try {
        rag = await indexSearchRun({
          userId: user.id,
          searchId,
          query: String(query).trim(),
          out,
          paperId,
          pyBase: PY_BASE,
        });
      } catch (e) {
        logErr(rid, "RAG indexing failed", e?.stack || e);
      }
    }

    sseSend(res, "result", {
      ...publicOut,
      search_id: searchId,
      paper_id: paperId,
      rag,
      history_saved: Boolean(searchId),
      history_reason: searchId ? null : "Search persistence failed",
    });
  } catch (e) {
    if (String(e?.code || "") !== "USER_QUOTA_EXCEEDED") {
      logErr(rid, "Unhandled error", e?.stack || e);
    }
    sseSend(res, "error", {
      ok: false,
      code: e?.code || null,
      error: String(e?.message || e),
      retry_after_sec: e?.retryAfterSec || null,
      reset_at: e?.resetAt || null,
      quota: e?.quota || null,
      request_id: rid,
    });
  } finally {
    res.end();
  }
});

export default router;
