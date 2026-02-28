import "dotenv/config";

import { prisma } from "../src/db/prisma.js";
import { indexSearchRun } from "../src/rag/store.js";

const DEFAULTS = {
  pyBase: process.env.PY_BASE || "http://127.0.0.1:8000",
  userEmail: process.env.REINDEX_USER_EMAIL || "",
  userId: process.env.REINDEX_USER_ID || "",
  searchId: process.env.REINDEX_SEARCH_ID || "",
  offset: toInt(process.env.REINDEX_OFFSET, 0),
  maxRows: toInt(process.env.REINDEX_MAX_ROWS, 0),
  batchSize: toInt(process.env.REINDEX_BATCH_SIZE, 25),
  requestDelaySec: toNum(process.env.REINDEX_DELAY_SEC, 0.2),
  stopOnError: String(process.env.REINDEX_STOP_ON_ERROR || "0") === "1",
  dryRun: false,
};

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value) {
  return String(value || "").trim();
}

function clampText(value, max = 32000) {
  const s = safeString(value);
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 18))} ...[truncated]` : s;
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--stop-on-error") {
      opts.stopOnError = true;
      continue;
    }
    if (arg === "--user-email" && next) {
      opts.userEmail = next;
      i += 1;
      continue;
    }
    if (arg === "--user-id" && next) {
      opts.userId = next;
      i += 1;
      continue;
    }
    if (arg === "--search-id" && next) {
      opts.searchId = next;
      i += 1;
      continue;
    }
    if (arg === "--offset" && next) {
      opts.offset = toInt(next, opts.offset);
      i += 1;
      continue;
    }
    if (arg === "--max-rows" && next) {
      opts.maxRows = toInt(next, opts.maxRows);
      i += 1;
      continue;
    }
    if (arg === "--batch-size" && next) {
      opts.batchSize = toInt(next, opts.batchSize);
      i += 1;
      continue;
    }
    if (arg === "--request-delay-sec" && next) {
      opts.requestDelaySec = toNum(next, opts.requestDelaySec);
      i += 1;
      continue;
    }
    if (arg === "--py-base" && next) {
      opts.pyBase = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`
Reindex RAG chunks from existing DB rows only (no external API fetch).

Usage:
  node scripts/reindex_rag_from_db_only.mjs [options]

Options:
  --user-email <email>         Only this user
  --user-id <uuid>             Only this user id
  --search-id <uuid>           Only this single search
  --offset <n>                 Start offset in selected searches (default: 0)
  --max-rows <n>               Process at most n searches, 0 = all (default: 0)
  --batch-size <n>             DB fetch batch size (default: 25)
  --request-delay-sec <sec>    Delay between reindex calls (default: 0.2)
  --py-base <url>              Python service base URL (default: PY_BASE or http://127.0.0.1:8000)
  --stop-on-error              Stop run on first indexing failure
  --dry-run                    Print selected search count only
  --help                       Show help
`);
}

function normalizeOpenReviewRows(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map((row) => ({
    noteId: row.noteId,
    forum: row.forumId,
    parentNoteId: row.parentNoteId,
    invitation: row.invitation,
    type: row.noteType,
    title: clampText(row.title, 8000),
    summary: clampText(row.summary, 32000),
    strengths: clampText(row.strengths, 32000),
    weaknesses: clampText(row.weaknesses, 32000),
    questions: clampText(row.questions, 32000),
    comment: clampText(row.comment, 32000),
    details: clampText(row.details, 32000),
    decision: clampText(row.decision, 8000),
    soundness: clampText(row.soundness, 2000),
    presentation: clampText(row.presentation, 2000),
    contribution: clampText(row.contribution, 2000),
    rating: Number.isFinite(Number(row.ratingScore)) ? Number(row.ratingScore) : null,
    confidence: Number.isFinite(Number(row.confidenceScore)) ? Number(row.confidenceScore) : null,
    ratingText: safeString(row.ratingText) || null,
    confidenceText: safeString(row.confidenceText) || null,
    url: safeString(row.url) || null,
    content: [
      row.title,
      row.summary,
      row.strengths,
      row.weaknesses,
      row.questions,
      row.comment,
      row.details,
    ]
      .map((x) => clampText(x, 32000))
      .filter(Boolean)
      .join("\n"),
    created_at: row.createdAtRemote ? new Date(row.createdAtRemote).toISOString() : null,
    updated_at: row.updatedAtRemote ? new Date(row.updatedAtRemote).toISOString() : null,
  }));
}

function normalizeSemanticScholarRows(citations) {
  if (!Array.isArray(citations)) return [];
  return citations.map((row) => {
    const payload = row?.rawPayload && typeof row.rawPayload === "object" ? row.rawPayload : {};
    const authors = Array.isArray(payload?.authors)
      ? payload.authors
          .map((x) =>
            typeof x === "string" ? safeString(x) : x && typeof x === "object" ? safeString(x.name) : ""
          )
          .filter(Boolean)
      : [];
    return {
      sourcePaperId: safeString(row.sourcePaperId) || null,
      direction: safeString(row.direction) || "forward",
      citedPaperId: safeString(row.citedPaperId) || null,
      arxivId: safeString(payload?.arxivId) || null,
      title: clampText(row.title || payload?.title, 2000),
      abstract: clampText(payload?.abstract, 8000) || null,
      year: Number.isFinite(Number(payload?.year)) ? Math.trunc(Number(payload.year)) : null,
      venue: clampText(payload?.venue, 500) || null,
      url: safeString(row.url || payload?.url) || null,
      citationCount: Number.isFinite(Number(payload?.citationCount))
        ? Math.trunc(Number(payload.citationCount))
        : null,
      influentialCitationCount: Number.isFinite(Number(row?.influentialCitationCount))
        ? Math.trunc(Number(row.influentialCitationCount))
        : Number.isFinite(Number(payload?.influentialCitationCount))
        ? Math.trunc(Number(payload.influentialCitationCount))
        : null,
      authors,
    };
  });
}

function normalizeGithubRowsFromRepoResolution(repoResolution, paper) {
  const rows = [];
  const repoUrl = safeString(paper?.repoUrl);
  if (repoUrl) {
    rows.push({
      type: "readme",
      repo: repoUrl.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, ""),
      url: repoUrl,
      isOfficial: true,
      relevanceScore: 1000,
      stars: null,
      forks: null,
      created_at: null,
      updated_at: null,
      content: `Repo URL: ${repoUrl}\nSource: paper_record.repoUrl`,
    });
  }

  const candidates = Array.isArray(repoResolution?.candidates) ? repoResolution.candidates : [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i] || {};
    const candidateRepo = safeString(c?.repoUrl);
    if (!candidateRepo) continue;
    rows.push({
      type: "readme",
      repo: candidateRepo.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, ""),
      url: candidateRepo,
      isOfficial: i === 0,
      relevanceScore: Number.isFinite(Number(c?.score)) ? Number(c.score) : null,
      stars: Number.isFinite(Number(c?.stars)) ? Number(c.stars) : null,
      forks: Number.isFinite(Number(c?.forks)) ? Number(c.forks) : null,
      created_at: c?.createdAt || null,
      updated_at: c?.createdAt || null,
      content: [
        `Repo URL: ${candidateRepo}`,
        Number.isFinite(Number(c?.score)) ? `Score: ${Number(c.score)}` : "",
        c?.confidence ? `Confidence: ${String(c.confidence)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  return rows;
}

function normalizeHuggingFaceRowsFromComments(comments) {
  if (!Array.isArray(comments)) return [];
  const rows = [];
  for (const row of comments) {
    const content = clampText(row?.content, 12000);
    if (!content) continue;
    rows.push({
      type: safeString(row?.type || "paper_comment") || "paper_comment",
      url: safeString(row?.url) || null,
      upvotes: Number.isFinite(Number(row?.upvotes)) ? Number(row.upvotes) : null,
      repo: safeString(row?.repo) || null,
      created_at: row?.created_at || null,
      updated_at: row?.updated_at || null,
      content,
    });
  }
  return rows;
}

function buildOutFromSearchRow(searchRow) {
  const results = Array.isArray(searchRow?.results) ? searchRow.results : [];
  const paper = results.find((r) => r?.paper)?.paper || null;
  const redditThreads = Array.isArray(searchRow?.redditLinks)
    ? searchRow.redditLinks.map((x) => x?.redditPost).filter(Boolean)
    : [];

  if (!paper) {
    return { out: { paper: null }, paperId: null };
  }

  const repoResolution =
    paper?.repoResolution && typeof paper.repoResolution === "object" ? paper.repoResolution : null;
  const huggingfaceComments = Array.isArray(paper?.huggingfaceComments) ? paper.huggingfaceComments : [];

  return {
    out: {
      paper: {
        title: paper.title,
        abstract: paper.abstract,
        year: paper.year,
        url: paper.url,
        externalId: paper.externalId,
      },
      summary: typeof paper.summaryMd === "string" ? paper.summaryMd : null,
      novelty: Array.isArray(paper.keyPoints) ? paper.keyPoints : [],
      reddit_threads: redditThreads,
      _openreviewRows: normalizeOpenReviewRows(paper.openReviewNotes),
      _semanticScholarRows: normalizeSemanticScholarRows(paper.semanticScholarCitations),
      _githubRows: normalizeGithubRowsFromRepoResolution(repoResolution, paper),
      _huggingfaceRows: normalizeHuggingFaceRowsFromComments(huggingfaceComments),
    },
    paperId: paper.id,
  };
}

async function resolveUserId(opts) {
  if (safeString(opts.searchId)) return null;
  if (safeString(opts.userId)) return safeString(opts.userId);
  if (!safeString(opts.userEmail)) return null;
  const user = await prisma.userAccount.findUnique({
    where: { email: safeString(opts.userEmail) },
    select: { id: true, email: true },
  });
  if (!user?.id) {
    throw new Error(`User not found for email: ${opts.userEmail}`);
  }
  return user.id;
}

async function countSelectedSearches(where) {
  return prisma.userSearch.count({ where });
}

async function fetchBatch(where, skip, take) {
  return prisma.userSearch.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip,
    take,
    include: {
      results: {
        orderBy: { rank: "asc" },
        include: {
          paper: {
            include: {
              openReviewNotes: {
                orderBy: { createdAtRemote: "desc" },
                take: 160,
              },
              semanticScholarCitations: {
                orderBy: { updatedAt: "desc" },
                take: 240,
              },
            },
          },
        },
      },
      redditLinks: {
        orderBy: { createdAt: "desc" },
        include: { redditPost: true },
        take: 20,
      },
    },
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const selectedUserId = await resolveUserId(opts);
  const where = {};
  if (safeString(opts.searchId)) where.id = safeString(opts.searchId);
  if (selectedUserId) where.userId = selectedUserId;

  const totalSelected = await countSelectedSearches(where);
  const offset = Math.max(0, opts.offset);
  const maxRows = Math.max(0, opts.maxRows);
  const batchSize = Math.max(1, Math.min(opts.batchSize, 200));
  const rowsPlanned =
    maxRows > 0 ? Math.max(0, Math.min(maxRows, Math.max(0, totalSelected - offset))) : Math.max(0, totalSelected - offset);

  console.log(`PY_BASE: ${opts.pyBase}`);
  console.log(`Total selected searches: ${totalSelected}`);
  console.log(`Rows planned: ${rowsPlanned} (offset=${offset}, maxRows=${maxRows || "all"})`);

  if (opts.dryRun || rowsPlanned <= 0) {
    return;
  }

  const stats = {
    ok: 0,
    failed: 0,
    skippedNoPaper: 0,
  };

  const failures = [];
  let processed = 0;
  while (processed < rowsPlanned) {
    const remaining = rowsPlanned - processed;
    const take = Math.min(batchSize, remaining);
    const batch = await fetchBatch(where, offset + processed, take);
    if (!batch.length) break;

    for (const searchRow of batch) {
      processed += 1;
      const { out, paperId } = buildOutFromSearchRow(searchRow);
      const progress = `${processed}/${rowsPlanned}`;

      if (!paperId || !out?.paper) {
        stats.skippedNoPaper += 1;
        console.log(`[skip] ${progress} search=${searchRow.id}: no paper row attached.`);
        continue;
      }

      try {
        const indexed = await indexSearchRun({
          userId: searchRow.userId,
          searchId: searchRow.id,
          query: searchRow.query || out.paper.title || "",
          out,
          paperId,
          pyBase: opts.pyBase,
        });
        stats.ok += 1;
        console.log(
          `[ok] ${progress} search=${searchRow.id} paper=${paperId} chunks=${Number(indexed?.chunks || 0)}`
        );
      } catch (err) {
        stats.failed += 1;
        const message = safeString(err?.message || err) || "unknown error";
        failures.push({
          searchId: searchRow.id,
          paperId,
          message,
        });
        console.error(`[fail] ${progress} search=${searchRow.id} paper=${paperId}: ${message}`);
        if (opts.stopOnError) {
          throw err;
        }
      }

      if (opts.requestDelaySec > 0) {
        await sleep(Math.trunc(opts.requestDelaySec * 1000));
      }
    }
  }

  console.log("");
  console.log("Reindex finished.");
  console.log(`Success: ${stats.ok}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Skipped (no paper): ${stats.skippedNoPaper}`);
  if (failures.length) {
    console.log("Failure details:");
    for (const row of failures.slice(0, 50)) {
      console.log(
        `- search=${row.searchId} paper=${row.paperId || "null"} error=${row.message}`
      );
    }
    if (failures.length > 50) {
      console.log(`... ${failures.length - 50} more`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`[fatal] ${String(err?.message || err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

