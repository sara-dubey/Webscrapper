import { prisma } from "../src/db/prisma.js";

/**
 * Backfill PaperRedditLink.searchId by linking:
 * SearchResult(searchId,paperId) -> PaperRedditLink(paperId, redditPostId)
 *
 * After this, you can query:
 * prisma.paperRedditLink.findMany({ where: { searchId } })
 */
async function main() {
  const srs = await prisma.userSearchResult.findMany({
    select: { searchId: true, paperId: true },
  });

  console.log("SearchResult rows:", srs.length);

  let created = 0;
  let skipped = 0;

  for (const sr of srs) {
    // Fetch reddit posts that belong to that paper (legacy links)
    const legacyLinks = await prisma.paperRedditLink.findMany({
      where: { paperId: sr.paperId },
      select: { redditPostId: true, matchedBy: true, searchId: true },
    });

    for (const link of legacyLinks) {
      // If already has searchId, skip
      if (link.searchId) continue;

      try {
        await prisma.paperRedditLink.create({
          data: {
            searchId: sr.searchId,
            paperId: sr.paperId,
            redditPostId: link.redditPostId,
            matchedBy: link.matchedBy ?? null,
          },
        });
        created++;
      } catch {
        // unique constraint collisions etc
        skipped++;
      }
    }
  }

  console.log("Backfill done. Created:", created, "Skipped:", skipped);
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
