import { prisma } from "../src/db/prisma.js";

async function listDuplicateGroups(limit = 1000) {
  const rows = await prisma.$queryRaw`
    SELECT "user_search"."userId" AS "userId", "user_search_result"."paperId" AS "paperId", COUNT(*)::int AS "cnt"
    FROM "user_search_result"
    JOIN "user_search" ON "user_search"."id" = "user_search_result"."searchId"
    GROUP BY 1,2
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT ${limit}
  `;
  return Array.isArray(rows) ? rows : [];
}

async function getSearchesForGroup(userId, paperId) {
  return await prisma.userSearch.findMany({
    where: {
      userId: String(userId),
      results: {
        some: { paperId: String(paperId) },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      query: true,
      note: true,
      filters: true,
      createdAt: true,
    },
  });
}

async function moveRedditLinks(fromSearchId, toSearchId, paperId) {
  const rows = await prisma.paperRedditLink.findMany({
    where: { searchId: fromSearchId, paperId },
    select: { redditPostId: true, matchedBy: true },
  });

  if (!rows.length) return 0;

  await prisma.paperRedditLink.createMany({
    data: rows.map((r) => ({
      searchId: toSearchId,
      paperId,
      redditPostId: r.redditPostId,
      matchedBy: r.matchedBy || null,
    })),
    skipDuplicates: true,
  });

  return rows.length;
}

async function ensureWinnerSearchResult(searchId, paperId) {
  const hit = await prisma.userSearchResult.findFirst({
    where: { searchId, paperId },
    select: { id: true },
  });
  if (hit) return false;

  await prisma.userSearchResult.create({
    data: {
      searchId,
      paperId,
      rank: 1,
    },
  });
  return true;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const groups = await listDuplicateGroups();

  const report = {
    ok: true,
    dry_run: dryRun,
    duplicate_groups: groups.length,
    merged_groups: 0,
    removed_search_rows: 0,
    moved_reddit_links: 0,
    details: [],
  };

  for (const g of groups) {
    const userId = String(g.userId || "");
    const paperId = String(g.paperId || "");
    if (!userId || !paperId) continue;

    const searches = await getSearchesForGroup(userId, paperId);
    if (searches.length <= 1) continue;

    const winner = searches[0];
    const losers = searches.slice(1);

    const detail = {
      userId,
      paperId,
      winner: winner.id,
      losers: losers.map((x) => x.id),
      count: searches.length,
    };
    report.details.push(detail);

    if (dryRun) continue;

    await ensureWinnerSearchResult(winner.id, paperId);

    let winnerNote = winner.note || null;
    let winnerFilters = winner.filters || null;

    for (const loser of losers) {
      const moved = await moveRedditLinks(loser.id, winner.id, paperId);
      report.moved_reddit_links += moved;

      if (!winnerNote && loser.note) winnerNote = loser.note;
      if (!winnerFilters && loser.filters) winnerFilters = loser.filters;

      await prisma.userSearch.delete({ where: { id: loser.id } });
      report.removed_search_rows += 1;
    }

    await prisma.userSearch.update({
      where: { id: winner.id },
      data: {
        note: winnerNote,
        filters: winnerFilters,
      },
    });

    report.merged_groups += 1;
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
