import express from "express";
import { z } from "zod";

import { requireAuth } from "../auth/middleware.js";
import { indexSearchRun, queryRagViaPython } from "../rag/store.js";
import { prisma } from "../db/prisma.js";
import { assertUserQuota, setUserQuotaHeaders } from "../infra/userQuota.js";
import { fetchGithub } from "../integrations/github.js";
import { fetchHuggingFace } from "../integrations/huggingface.js";
import { appendTurn, getThreadHistory, mergeThreadHistory, setThreadHistory } from "../rag/threadMemory.js";

const router = express.Router();

const RagQueryReq = z.object({
  question: z.string().min(1),
  searchId: z.string().optional(),
  k: z.number().int().min(1).max(20).optional(),
  answer: z.boolean().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(4000),
      })
    )
    .max(20)
    .optional(),
});

const INTENT = Object.freeze({
  CONCEPTUAL: "CONCEPTUAL",
  REPRODUCIBILITY: "REPRODUCIBILITY",
  COMMUNITY: "COMMUNITY",
  DEPENDENCIES: "DEPENDENCIES",
  COMPARISON: "COMPARISON",
});

function classifyIntent(question) {
  const q = String(question || "").toLowerCase();
  if (!q) return INTENT.CONCEPTUAL;

  if (/(dependency|dependencies|cuda|torch|version|install|requirements|environment|setup|package|pip|conda)/i.test(q)) {
    return INTENT.DEPENDENCIES;
  }
  if (/(reproduc|replicat|failed|failure|bug|issue|error|unstable|break|not work|crash|hallucinat)/i.test(q)) {
    return INTENT.REPRODUCIBILITY;
  }
  if (/(reddit|community|discussion|opinion|sentiment|hype|practitioner|people say)/i.test(q)) {
    return INTENT.COMMUNITY;
  }
  if (/(compare|comparison|vs\.?|versus|better than|difference between|baseline)/i.test(q)) {
    return INTENT.COMPARISON;
  }
  return INTENT.CONCEPTUAL;
}

function extractArxivIdFromPaper(paper) {
  const candidates = [
    paper?.externalId,
    paper?.url,
    paper?.title,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  for (const value of candidates) {
    const m = value.match(/(\d{4}\.\d{4,5})(v\d+)?/i);
    if (m?.[1]) return String(m[1]).trim();
  }
  return null;
}

function inferDoiFromPaper(paper) {
  const v = String(paper?.externalId || "").trim();
  if (!v) return null;
  if (/^10\.\d{4,9}\//i.test(v)) return v;
  return null;
}

function rowsFromRepoResolution(repoResolution) {
  const rows = [];
  const candidates = Array.isArray(repoResolution?.candidates) ? repoResolution.candidates : [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i] || {};
    const repoUrl = String(c?.repoUrl || "").trim();
    if (!repoUrl) continue;
    rows.push({
      source: "github",
      type: "readme",
      content: [
        `Repo URL: ${repoUrl}`,
        Number.isFinite(Number(c?.score)) ? `Score: ${Number(c.score)}` : "",
        c?.confidence ? `Confidence: ${String(c.confidence)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      url: repoUrl,
      repo: repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "") || null,
      stars: Number.isFinite(Number(c?.stars)) ? Number(c.stars) : null,
      forks: Number.isFinite(Number(c?.forks)) ? Number(c.forks) : null,
      isOfficial: i === 0,
      relevanceScore: Number.isFinite(Number(c?.score)) ? Number(c.score) : null,
      created_at: c?.createdAt || null,
      updated_at: c?.createdAt || null,
    });
  }
  return rows;
}

async function fetchExternalReindexEvidence(paper) {
  if (!paper || typeof paper !== "object") {
    return { githubRows: [], huggingfaceRows: [] };
  }
  const title = String(paper?.title || "").trim();
  const arxivId = extractArxivIdFromPaper(paper);
  const authors = Array.isArray(paper?.authors) ? paper.authors : [];
  const doi = inferDoiFromPaper(paper);
  const paperUrls = [paper?.url].filter(Boolean);

  const settled = await Promise.allSettled([
    fetchGithub(title, arxivId, authors, { repoLimit: 4, issueLimit: 6, doi, paperUrls }),
    fetchHuggingFace(arxivId, title, { modelLimit: 4, discussionLimit: 6 }),
  ]);

  const githubRows =
    settled[0]?.status === "fulfilled" && Array.isArray(settled[0].value) ? settled[0].value : [];
  const huggingfaceRows =
    settled[1]?.status === "fulfilled" && Array.isArray(settled[1].value) ? settled[1].value : [];

  return { githubRows, huggingfaceRows };
}

async function buildOutFromSearch(searchId, userId) {
  const search = await prisma.userSearch.findFirst({
    where: { id: searchId, userId },
    include: {
      results: {
        orderBy: { rank: "asc" },
        include: {
          paper: {
            include: {
              openReviewNotes: {
                orderBy: { createdAtRemote: "desc" },
                take: 120,
              },
              semanticScholarCitations: {
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
    },
  });

  if (!search) return null;

  const paper = search.results.find((r) => r.paper)?.paper || null;
  const reddit_threads = search.redditLinks.map((x) => x.redditPost).filter(Boolean);
  const repoResolution = paper?.repoResolution && typeof paper.repoResolution === "object" ? paper.repoResolution : null;
  const openreviewRows = Array.isArray(paper?.openReviewNotes)
    ? paper.openReviewNotes.map((row) => ({
        noteId: row.noteId,
        forum: row.forumId,
        parentNoteId: row.parentNoteId,
        invitation: row.invitation,
        type: row.noteType,
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
        content: [row.title, row.summary, row.strengths, row.weaknesses, row.questions, row.comment, row.details]
          .filter(Boolean)
          .join("\n"),
        url: row.url,
        rating: row.ratingScore,
        confidence: row.confidenceScore,
        ratingText: row.ratingText,
        confidenceText: row.confidenceText,
        created_at: row.createdAtRemote ? row.createdAtRemote.toISOString() : null,
        updated_at: row.updatedAtRemote ? row.updatedAtRemote.toISOString() : null,
      }))
    : [];
  const semanticScholarRows = Array.isArray(paper?.semanticScholarCitations)
    ? paper.semanticScholarCitations.map((row) => ({
        sourcePaperId: row.sourcePaperId,
        direction: row.direction,
        citedPaperId: row.citedPaperId,
        title: row.title,
        abstract:
          typeof row?.rawPayload?.abstract === "string" ? row.rawPayload.abstract : null,
        year: Number.isFinite(Number(row?.rawPayload?.year))
          ? Math.trunc(Number(row.rawPayload.year))
          : null,
        venue:
          typeof row?.rawPayload?.venue === "string" && row.rawPayload.venue.trim()
            ? row.rawPayload.venue.trim()
            : null,
        url: row.url,
        citationCount: Number.isFinite(Number(row?.rawPayload?.citationCount))
          ? Math.trunc(Number(row.rawPayload.citationCount))
          : null,
        influentialCitationCount: row.influentialCitationCount,
      }))
    : [];
  const externalRows = await fetchExternalReindexEvidence(paper);
  const githubRows = externalRows.githubRows.length
    ? externalRows.githubRows
    : rowsFromRepoResolution(repoResolution);
  const huggingfaceRows = externalRows.huggingfaceRows.length ? externalRows.huggingfaceRows : [];

  return {
    search,
    out: {
      paper: paper
        ? {
            title: paper.title,
            abstract: paper.abstract,
            year: paper.year,
            url: paper.url,
            externalId: paper.externalId,
          }
        : null,
      summary: typeof paper?.summaryMd === "string" ? paper.summaryMd : null,
      novelty: Array.isArray(paper?.keyPoints) ? paper.keyPoints : [],
      reddit_threads,
      _openreviewRows: openreviewRows,
      _semanticScholarRows: semanticScholarRows,
      _githubRows: githubRows,
      _huggingfaceRows: huggingfaceRows,
    },
    paperId: paper?.id || null,
  };
}

router.post("/query", requireAuth, async (req, res, next) => {
  try {
    const parsed = RagQueryReq.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.message });
    }

    const { question, searchId, k, answer = true, history = [] } = parsed.data;
    const uid = req.user?.id || req.userId;
    const intent = classifyIntent(question);

    const quota = await assertUserQuota("lily_message", uid, {
      requestId: req.get("x-request-id") || null,
    });
    setUserQuotaHeaders(res, quota);

    if (searchId) {
      const owned = await prisma.userSearch.findFirst({
        where: { id: searchId, userId: uid },
        select: { id: true },
      });
      if (!owned) return res.status(404).json({ ok: false, error: "Search not found" });
    }

    const cachedHistory = searchId ? await getThreadHistory({ userId: uid, searchId }) : [];
    const mergedHistory = mergeThreadHistory(history, cachedHistory);

    const pyBase = req.app?.locals?.PY_BASE || process.env.PY_BASE || "http://127.0.0.1:8000";
    const out = await queryRagViaPython({
      userId: uid,
      question,
      searchId: searchId || null,
      k: k ?? 6,
      answer,
      intent,
      history: mergedHistory,
      pyBase,
    });

    if (searchId) {
      const nextHistory = appendTurn(mergedHistory, question, out.answer || "");
      await setThreadHistory({ userId: uid, searchId, history: nextHistory });
    }

    return res.json({
      ok: true,
      question,
      intent: out.intent || intent,
      answer: out.answer || "",
      answerModel: out.answerModel || null,
      embeddingModel: out.model || null,
      confidence: out.confidence,
      conflicts_detected: Array.isArray(out.conflictsDetected) ? out.conflictsDetected : [],
      audit: out.audit || null,
      chunks: Array.isArray(out.chunks) ? out.chunks : [],
      count: Number.isFinite(Number(out.count))
        ? Number(out.count)
        : Array.isArray(out.chunks)
        ? out.chunks.length
        : 0,
    });
  } catch (err) {
    if (Number(err?.status) === 429 || String(err?.code || "") === "USER_QUOTA_EXCEEDED") {
      return res.status(429).json({
        ok: false,
        code: err?.code || "USER_QUOTA_EXCEEDED",
        error: String(err?.message || "Daily user quota reached."),
        retry_after_sec: err?.retryAfterSec || null,
        reset_at: err?.resetAt || null,
        quota: err?.quota || null,
      });
    }
    return next(err);
  }
});

router.post("/reindex", requireAuth, async (req, res, next) => {
  try {
    const searchId = String(req.body?.searchId || "").trim();
    if (!searchId) return res.status(400).json({ ok: false, error: "searchId is required" });

    const uid = req.user?.id || req.userId;
    const payload = await buildOutFromSearch(searchId, uid);
    if (!payload) return res.status(404).json({ ok: false, error: "Search not found" });

    const pyBase = req.app?.locals?.PY_BASE || process.env.PY_BASE || "http://127.0.0.1:8000";
    const indexed = await indexSearchRun({
      userId: uid,
      searchId,
      query: payload.search.query,
      out: payload.out,
      paperId: payload.paperId,
      pyBase,
    });

    return res.json({ ok: true, indexed, searchId });
  } catch (err) {
    return next(err);
  }
});

export default router;
