import express from "express";

import { prisma } from "../db/prisma.js";
import { requireAuth } from "../auth/middleware.js";

const router = express.Router();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabel(d) {
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function sourceLabel(raw) {
  const key = String(raw || "").toLowerCase().trim();
  if (!key) return "Unknown";
  if (key === "arxiv") return "arXiv";
  if (key === "reddit") return "Reddit threads";
  if (key === "scholar" || key === "google_scholar" || key === "googlescholar") return "Google Scholar";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

router.get("/overview", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const days = clampInt(req.query.days, 7, 30, 7);
    const now = new Date();

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - (days - 1));

    const [weeklySearches, monthlySearches] = await Promise.all([
      prisma.userSearch.findMany({
        where: {
          userId,
          createdAt: { gte: weekStart },
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 2000,
      }),
      prisma.userSearch.findMany({
        where: {
          userId,
          createdAt: { gte: monthStart },
        },
        select: {
          id: true,
          results: {
            select: { paperId: true },
            take: 12,
          },
        },
        orderBy: { createdAt: "desc" },
        take: 3000,
      }),
    ]);

    const dayCounts = new Map();
    for (const row of weeklySearches) {
      const key = isoDay(new Date(row.createdAt));
      dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
    }

    const weeklyActivity = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const key = isoDay(d);
      weeklyActivity.push({
        day: dayLabel(d),
        date: key,
        views: Number(dayCounts.get(key) || 0),
      });
    }

    const searchIds = monthlySearches.map((x) => x.id);
    const paperIdSet = new Set();
    for (const s of monthlySearches) {
      for (const result of Array.isArray(s.results) ? s.results : []) {
        const id = String(result?.paperId || "").trim();
        if (id) paperIdSet.add(id);
      }
    }
    const paperIds = Array.from(paperIdSet);

    const [papers, redditSearchRows] = await Promise.all([
      paperIds.length
        ? prisma.paperRecord.findMany({
            where: { id: { in: paperIds } },
            select: { id: true, title: true, source: true, abstract: true },
          })
        : Promise.resolve([]),
      searchIds.length
        ? prisma.paperRedditLink.findMany({
            where: { searchId: { in: searchIds } },
            select: { searchId: true },
            distinct: ["searchId"],
            take: 4000,
          })
        : Promise.resolve([]),
    ]);

    const sourceCounts = new Map();

    for (const paper of papers) {
      const source = sourceLabel(paper?.source);
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    }

    if (Array.isArray(redditSearchRows) && redditSearchRows.length > 0) {
      sourceCounts.set("Reddit threads", (sourceCounts.get("Reddit threads") || 0) + redditSearchRows.length);
    }

    const sourceRowsBase = Array.from(sourceCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const totalSourceCount = sourceRowsBase.reduce((sum, row) => sum + row.count, 0);
    const sourceRows = sourceRowsBase.map((row) => ({
      ...row,
      pct: totalSourceCount > 0 ? Math.round((row.count / totalSourceCount) * 100) : 0,
    }));

    const papersReadThisMonth = papers.length;
    const topSourcesSummary = sourceRows.slice(0, 2).map((x) => x.name).join(" / ") || "N/A";
    const maxViews = Math.max(1, ...weeklyActivity.map((x) => Number(x.views || 0)));

    return res.json({
      ok: true,
      generatedAt: now.toISOString(),
      metrics: {
        papersReadThisMonth,
        mostActiveTopic: "N/A",
        avgReadingTimeMin: null,
        topSourcesSummary,
      },
      weeklyActivity: {
        rangeDays: days,
        maxViews,
        items: weeklyActivity,
      },
      topTopics: [],
      topSources: sourceRows.slice(0, 5),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
