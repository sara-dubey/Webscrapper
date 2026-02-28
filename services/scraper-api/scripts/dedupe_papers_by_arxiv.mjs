import { prisma } from "../src/db/prisma.js";

function extractArxivId(value = "") {
  const s = String(value || "").trim();
  if (!s) return "";

  const fromUrl = s.match(/arxiv\.org\/(?:abs|pdf)\/([^?\s/]+?)(?:\.pdf)?(?:[?#].*)?$/i)?.[1] || "";
  const fromId = s.match(/\b\d{4}\.\d{4,5}(v\d+)?\b/i)?.[0] || "";
  const raw = fromUrl || fromId;
  if (!raw) return "";
  return raw.replace(/v\d+$/i, "");
}

function preferWinner(a, b, canonicalId) {
  const ae = String(a.externalId || "");
  const be = String(b.externalId || "");

  const aExact = ae.toLowerCase() === canonicalId.toLowerCase();
  const bExact = be.toLowerCase() === canonicalId.toLowerCase();
  if (aExact !== bExact) return aExact ? -1 : 1;

  const aVersioned = /v\d+$/i.test(ae);
  const bVersioned = /v\d+$/i.test(be);
  if (aVersioned !== bVersioned) return aVersioned ? 1 : -1;

  const aLen = ae.length || 9999;
  const bLen = be.length || 9999;
  if (aLen !== bLen) return aLen - bLen;

  const at = new Date(a.createdAt).getTime();
  const bt = new Date(b.createdAt).getTime();
  return at - bt;
}

async function moveSearchResults(fromPaperId, toPaperId) {
  const rows = await prisma.userSearchResult.findMany({
    where: { paperId: fromPaperId },
    select: { searchId: true, rank: true },
  });

  if (rows.length) {
    await prisma.userSearchResult.createMany({
      data: rows.map((r) => ({
        searchId: r.searchId,
        paperId: toPaperId,
        rank: r.rank,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.userSearchResult.deleteMany({ where: { paperId: fromPaperId } });
}

async function movePaperRedditLinks(fromPaperId, toPaperId) {
  const rows = await prisma.paperRedditLink.findMany({
    where: { paperId: fromPaperId },
    select: {
      searchId: true,
      redditPostId: true,
      matchedBy: true,
    },
  });

  if (rows.length) {
    await prisma.paperRedditLink.createMany({
      data: rows.map((r) => ({
        searchId: r.searchId,
        paperId: toPaperId,
        redditPostId: r.redditPostId,
        matchedBy: r.matchedBy || null,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.paperRedditLink.deleteMany({ where: { paperId: fromPaperId } });
}

async function moveSimpleForeignKeys(fromPaperId, toPaperId) {
  await prisma.userPaperNote.updateMany({
    where: { paperId: fromPaperId },
    data: { paperId: toPaperId },
  });
  await prisma.userPaperHighlight.updateMany({
    where: { paperId: fromPaperId },
    data: { paperId: toPaperId },
  });
  await prisma.ragChunk.updateMany({
    where: { paperId: fromPaperId },
    data: { paperId: toPaperId },
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = await prisma.paperRecord.findMany({
    where: { source: "arxiv" },
    select: {
      id: true,
      externalId: true,
      url: true,
      createdAt: true,
      title: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map();
  for (const row of rows) {
    const key = extractArxivId(row.externalId) || extractArxivId(row.url);
    if (!key) continue;
    const arr = groups.get(key) || [];
    arr.push(row);
    groups.set(key, arr);
  }

  const duplicates = [...groups.entries()].filter(([, arr]) => arr.length > 1);

  if (!duplicates.length) {
    console.log(JSON.stringify({ ok: true, duplicate_groups: 0, dry_run: dryRun }, null, 2));
    return;
  }

  const report = {
    ok: true,
    dry_run: dryRun,
    duplicate_groups: duplicates.length,
    merged_groups: 0,
    removed_rows: 0,
    details: [],
  };

  for (const [canonicalId, group] of duplicates) {
    const sorted = [...group].sort((a, b) => preferWinner(a, b, canonicalId));
    const winner = sorted[0];
    const losers = sorted.slice(1);

    const detail = {
      arxiv_id: canonicalId,
      winner: { id: winner.id, externalId: winner.externalId },
      losers: losers.map((x) => ({ id: x.id, externalId: x.externalId })),
    };
    report.details.push(detail);

    if (dryRun) continue;

    for (const loser of losers) {
      await prisma.$transaction(async () => {
        await moveSearchResults(loser.id, winner.id);
        await movePaperRedditLinks(loser.id, winner.id);
        await moveSimpleForeignKeys(loser.id, winner.id);
        await prisma.paperRecord.delete({ where: { id: loser.id } });
      });
      report.removed_rows += 1;
    }

    if (String(winner.externalId || "") !== canonicalId) {
      const conflict = await prisma.paperRecord.findFirst({
        where: { source: "arxiv", externalId: canonicalId, id: { not: winner.id } },
        select: { id: true },
      });
      if (!conflict) {
        await prisma.paperRecord.update({
          where: { id: winner.id },
          data: { externalId: canonicalId },
        });
      }
    }

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
