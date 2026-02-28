import express from "express";
import { prisma } from "../db/prisma.js";
import { requireAuth } from "../auth/middleware.js";

const router = express.Router();

/**
 * IMPORTANT:
 * - Express v4 does NOT catch async errors automatically.
 * - Always try/catch + next(err), otherwise requests can "hang forever".
 */

function normalizeNovelty(value) {
  const toCleanArray = (arr) =>
    arr
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 12);

  if (Array.isArray(value)) return toCleanArray(value);

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return toCleanArray(parsed);
    } catch {
      // no-op
    }
    return toCleanArray(
      raw
        .split(/\n+/)
        .map((line) => line.replace(/^[\s\-*0-9.)]+/, "").trim())
        .filter(Boolean)
    );
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value.keyPoints)) return toCleanArray(value.keyPoints);
    if (Array.isArray(value.novelty)) return toCleanArray(value.novelty);
    if (Array.isArray(value.items)) return toCleanArray(value.items);
  }

  return [];
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
    .map((row) => ({
      type: openReviewTypeOf(row),
      summary: cleanInlineText(row?.summary || row?.mainReview || row?.main_review || row?.review || row?.content),
      comment: cleanInlineText(row?.comment || row?.details || row?.content),
      strengths: cleanInlineText(row?.strengths),
      weaknesses: cleanInlineText(row?.weaknesses || row?.questions),
      decision: cleanInlineText(row?.decision, 180),
      forumUrl: cleanInlineText(row?.url || row?.forumUrl, 600),
    }))
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

  const decision = normalized.map((x) => x.decision).find(Boolean) || null;
  const topReviewSummaries = uniq(reviews.map((x) => x.summary).filter(Boolean), 3);
  const topStrengths = uniq(reviews.map((x) => x.strengths).filter(Boolean), 3);
  const topWeaknesses = uniq(reviews.map((x) => x.weaknesses).filter(Boolean), 3);
  const topComments = uniq(comments.map((x) => x.comment).filter(Boolean), 3);

  const oneLiner = topReviewSummaries[0] || topStrengths[0] || topComments[0] || topWeaknesses[0] || (decision ? `Decision: ${decision}` : null);
  const overallParts = [];
  if (decision) overallParts.push(`Decision: ${decision}.`);
  if (topReviewSummaries[0]) overallParts.push(`Review summary: ${topReviewSummaries[0]}`);
  if (topStrengths[0]) overallParts.push(`Strength: ${topStrengths[0]}`);
  if (topWeaknesses[0]) overallParts.push(`Weakness: ${topWeaknesses[0]}`);
  if (topComments[0]) overallParts.push(`Community note: ${topComments[0]}`);

  return {
    total: normalized.length,
    reviews: reviews.length,
    comments: comments.length,
    decision,
    forumUrl: normalized.map((x) => x.forumUrl).find(Boolean) || null,
    one_liner: oneLiner || null,
    overall_assessment: cleanInlineText(overallParts.join(" "), 420) || null,
    topReviewSummaries,
    topComments,
    topStrengths,
    topWeaknesses,
  };
}

// Create a search record (query + optional note + filters)
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { query, filters = null, note = null } = req.body || {};

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ ok: false, error: "query is required (string)" });
    }

    const search = await prisma.userSearch.create({
      data: {
        userId: req.user.id,
        query: query.trim(),
        filters,
        note: note ? String(note) : null,
      },
    });

    return res.json({ ok: true, search });
  } catch (err) {
    return next(err);
  }
});

// List latest searches for the logged-in user
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.userSearch.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        results: {
          orderBy: { rank: "asc" },
          take: 1,
          include: {
            paper: {
              select: { title: true },
            },
          },
        },
      },
    });

    const items = rows.map(({ results, ...search }) => ({
      ...search,
      title: String(results?.[0]?.paper?.title || search.query || "").trim(),
    }));

    return res.json({ ok: true, items });
  } catch (err) {
    return next(err);
  }
});

// ✅ Get one search with joined results for "View more"
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    // Ensure user owns the search
    const search = await prisma.userSearch.findFirst({
      where: { id, userId: req.user.id },
    });

    if (!search) return res.status(404).json({ ok: false, error: "Search not found" });

    // Move opened history item to top instead of creating another history row.
    const touched = await prisma.userSearch.update({
      where: { id },
      data: { createdAt: new Date() },
    });

    // Paper result(s) are stored in SearchResult (paper only in your schema)
    const paperResults = await prisma.userSearchResult.findMany({
      where: { searchId: id },
      orderBy: { rank: "asc" },
      include: { paper: true },
    });

    const paper = paperResults.find((r) => r.paperId)?.paper || null;

    // Paper stores a single latest summary payload directly.
    const summary = paper
      ? {
          summaryMd: typeof paper.summaryMd === "string" ? paper.summaryMd : null,
          keyPoints: Array.isArray(paper.keyPoints) ? paper.keyPoints : null,
          model: typeof paper.summaryModel === "string" ? paper.summaryModel : null,
          promptVersion:
            typeof paper.summaryPromptVersion === "string" ? paper.summaryPromptVersion : null,
          promptText: typeof paper.summaryPromptText === "string" ? paper.summaryPromptText : null,
          summarySource:
            paper.summarySource && typeof paper.summarySource === "object"
              ? paper.summarySource
              : null,
        }
      : null;
    const novelty = normalizeNovelty(summary?.keyPoints);
    const openReviewRows = paper?.id
      ? await prisma.paperOpenReviewNote.findMany({
          where: { paperId: paper.id },
          orderBy: { updatedAt: "desc" },
          take: 120,
        })
      : [];
    const openreview_summary = summarizeOpenReviewRows(openReviewRows);

    // ✅ Reddit threads are stored via PaperRedditLink in your schema
    const redditLinks = await prisma.paperRedditLink.findMany({
      where: { searchId: id },
      orderBy: { createdAt: "desc" },
      include: { redditPost: true },
      take: 10,
    });

    const reddit_threads = redditLinks
      .map((l) => l.redditPost)
      .filter(Boolean);
    const historyNeedsRefresh = !paper;

    return res.json({
      ok: true,
      search: touched,
      paper,
      summary,
      novelty,
      reddit_threads,
      openreview_summary,
      paper_results_count: paperResults.length,
      reddit_count: reddit_threads.length,
      history_needs_refresh: historyNeedsRefresh,
      history_refresh_reason: historyNeedsRefresh
        ? "This history item was saved without a linked paper result. Click Run to fetch it again."
        : null,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
