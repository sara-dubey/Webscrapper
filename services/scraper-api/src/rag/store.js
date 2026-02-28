import { prisma } from "../db/prisma.js";
import { fetchJsonRetry } from "../http.js";

function safeString(value) {
  return String(value || "").trim();
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (Number.isFinite(min) && v < min) return fallback;
  if (Number.isFinite(max) && v > max) return fallback;
  return v;
}

const SOURCE_CREDIBILITY = Object.freeze({
  paper: 0.85,
  paper_origin: 0.85,
  openreview_review: 0.8,
  openreview_rebuttal: 0.6,
  github_readme: 0.75,
  github_issue_open: 0.5,
  github_issue_closed: 0.7,
  huggingface: 0.65,
  reddit: 0.35,
  semantic_scholar_citation: 0.7,
  diff_engine: 0.9,
});

function clampCredibility(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function resolveCredibility(sourceType, override = null) {
  const direct = clampCredibility(override, null);
  if (direct != null) return direct;
  const key = safeString(sourceType);
  const mapped = SOURCE_CREDIBILITY[key];
  return clampCredibility(mapped, 0.5);
}

function sourceIdPart(value, fallback = "x") {
  const raw = safeString(value) || safeString(fallback) || "x";
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-zA-Z0-9._:/-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function githubSourceType(row) {
  const t = safeString(row?.type).toLowerCase();
  if (t !== "issue") return "github_readme";
  const content = String(row?.content || "");
  const m = content.match(/\bstate:\s*(open|closed)\b/i);
  const state = safeString(m?.[1]).toLowerCase();
  return state === "closed" ? "github_issue_closed" : "github_issue_open";
}

function openreviewSourceType(row) {
  const t = safeString(row?.type || row?.noteType).toLowerCase();
  return t === "review" ? "openreview_review" : "openreview_rebuttal";
}

function normalizeSemanticDirection(value) {
  return safeString(value).toLowerCase() === "backward" ? "backward" : "forward";
}

function semanticEdgeLabel(direction) {
  return direction === "backward" ? "anchor references neighbor" : "neighbor cites anchor";
}

function semanticEdgeExpression(direction, anchorNode, neighborNode) {
  if (direction === "backward") return `${anchorNode} -> ${neighborNode}`;
  return `${neighborNode} -> ${anchorNode}`;
}

function normalizeAuthorList(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  for (const item of value) {
    const name =
      typeof item === "string"
        ? safeString(item)
        : item && typeof item === "object"
        ? safeString(item.name || item.author || "")
        : "";
    if (!name) continue;
    names.push(name);
    if (names.length >= 30) break;
  }
  return names;
}

function pickSemanticNeighborMapEntry(map, citationRow) {
  if (!map || typeof map !== "object") return null;
  const candidates = [
    citationRow?.citedPaperId,
    citationRow?.paperId,
    citationRow?.sourcePaperId,
  ]
    .map((x) => safeString(x))
    .filter(Boolean);
  for (const key of candidates) {
    const hit = map[key];
    if (hit && typeof hit === "object") return hit;
  }
  return null;
}

function normalizeSemanticCitationRows(outRows = [], dbRows = []) {
  const merged = [];
  const seen = new Set();

  const pushRow = (raw) => {
    if (!raw || typeof raw !== "object") return;
    const direction = normalizeSemanticDirection(raw.direction);
    const citedPaperId = safeString(raw.citedPaperId || raw.paperId);
    const sourcePaperId = safeString(raw.sourcePaperId || raw.anchorPaperId);
    const title = safeString(raw.title);
    const url = safeString(raw.url);
    const dedupeKey = `${direction}::${citedPaperId || title.toLowerCase()}::${url}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    merged.push({
      direction,
      citedPaperId: citedPaperId || null,
      sourcePaperId: sourcePaperId || null,
      arxivId: safeString(raw.arxivId) || null,
      title: title || (citedPaperId || null),
      abstract: safeString(raw.abstract) || null,
      year: toFiniteNumber(raw.year, null),
      venue: safeString(raw.venue) || null,
      url: url || null,
      citationCount: toFiniteNumber(raw.citationCount, null),
      influentialCitationCount: toFiniteNumber(raw.influentialCitationCount, null),
      authors: normalizeAuthorList(raw.authors),
    });
  };

  for (const row of Array.isArray(outRows) ? outRows : []) pushRow(row);

  for (const row of Array.isArray(dbRows) ? dbRows : []) {
    const payload = row?.rawPayload && typeof row.rawPayload === "object" ? row.rawPayload : {};
    pushRow({
      direction: row?.direction,
      citedPaperId: row?.citedPaperId,
      sourcePaperId: row?.sourcePaperId,
      arxivId: payload?.arxivId,
      title: row?.title || payload?.title,
      abstract: payload?.abstract,
      year: payload?.year,
      venue: payload?.venue,
      url: row?.url || payload?.url,
      citationCount: payload?.citationCount,
      influentialCitationCount: row?.influentialCitationCount ?? payload?.influentialCitationCount,
      authors: payload?.authors,
    });
  }

  return merged;
}

function toMetadata(doc) {
  const merged = doc?.metadata && typeof doc.metadata === "object" ? { ...doc.metadata } : {};
  const out = {
    ...merged,
    title: doc.title || null,
    url: doc.url || null,
    subreddit: doc.subreddit || null,
    score: Number.isFinite(doc.score) ? doc.score : null,
    numComments: Number.isFinite(doc.numComments) ? doc.numComments : null,
    originTextFormat: doc.originTextFormat || null,
    credibilityScore: clampCredibility(doc.credibilityScore, null),
  };
  return out;
}

function resolvePyBase(pyBase = null) {
  const base = String(pyBase || process.env.PY_BASE || "http://127.0.0.1:8000").trim();
  return base.replace(/\/+$/, "");
}

async function requestPythonRagIndexDb({ userId, searchId, docs, pyBase = null }) {
  const payload = {
    userId: safeString(userId),
    searchId: safeString(searchId),
    docs: (Array.isArray(docs) ? docs : []).map((doc) => ({
      sourceType: doc.sourceType,
      sourceId: doc.sourceId,
      content: doc.content,
      paperId: doc.paperId || null,
      redditPostId: doc.redditPostId || null,
      credibilityScore: clampCredibility(doc.credibilityScore, null),
      metadata: toMetadata(doc),
    })),
  };

  const maxChars = Number(process.env.RAG_CHUNK_MAX_CHARS);
  const overlapChars = Number(process.env.RAG_CHUNK_OVERLAP_CHARS);
  if (Number.isFinite(maxChars) && maxChars > 0) payload.maxChars = Math.trunc(maxChars);
  if (Number.isFinite(overlapChars) && overlapChars >= 0) payload.overlapChars = Math.trunc(overlapChars);

  const out = await fetchJsonRetry(`${resolvePyBase(pyBase)}/rag/index-db`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 240_000,
    dependency: "paper_ai",
  });

  if (!out?.ok) {
    throw new Error(`Python rag index-db failed: ${String(out?.error || out?.detail || "ok=false")}`);
  }
  return out;
}

async function requestPythonRagQueryDb({
  userId,
  question,
  searchId = null,
  k = 6,
  answer = true,
  intent = null,
  history = [],
  pyBase = null,
}) {
  const cleanHistory = Array.isArray(history)
    ? history
        .map((row) => ({
          role: safeString(row?.role).toLowerCase(),
          text: safeString(row?.text),
        }))
        .filter((row) => (row.role === "user" || row.role === "assistant") && row.text)
        .slice(-8)
    : [];

  const out = await fetchJsonRetry(`${resolvePyBase(pyBase)}/rag/query-db`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: safeString(userId),
      question: safeString(question),
      searchId: safeString(searchId) || null,
      k: toInt(k, 6, 1, 20),
      answer: Boolean(answer),
      intent: safeString(intent) || null,
      history: cleanHistory.length ? cleanHistory : undefined,
    }),
    timeoutMs: 240_000,
    dependency: "paper_ai",
  });

  if (!out?.ok) {
    throw new Error(`Python rag query-db failed: ${String(out?.error || out?.detail || "ok=false")}`);
  }
  return out;
}

export function buildRagDocuments({
  searchId,
  query,
  out,
  paperId = null,
  paperOriginText = null,
  paperOriginTextFormat = null,
  citationGraphRows = [],
  citationNeighborMap = null,
}) {
  const docs = [];
  const seen = new Set();

  const pushDoc = (doc) => {
    const sourceType = safeString(doc?.sourceType);
    const sourceId = safeString(doc?.sourceId);
    const content = safeString(doc?.content);
    if (!sourceType || !sourceId || !content) return;
    const key = `${sourceType}::${sourceId}::${content.slice(0, 160)}`;
    if (seen.has(key)) return;
    seen.add(key);
    docs.push({
      ...doc,
      sourceType,
      sourceId,
      content,
      credibilityScore: resolveCredibility(sourceType, doc?.credibilityScore),
    });
  };

  const paper = out?.paper || null;
  const redditThreads = Array.isArray(out?.reddit_threads) ? out.reddit_threads : [];
  const githubRows = Array.isArray(out?._githubRows) ? out._githubRows : [];
  const openreviewRows = Array.isArray(out?._openreviewRows) ? out._openreviewRows : [];
  const huggingfaceRows = Array.isArray(out?._huggingfaceRows) ? out._huggingfaceRows : [];
  const semanticScholarRows = normalizeSemanticCitationRows(
    Array.isArray(out?._semanticScholarRows) ? out._semanticScholarRows : [],
    citationGraphRows
  );

  if (paper) {
    const paperText = [
      `Query: ${safeString(query)}`,
      `Title: ${safeString(paper.title)}`,
      paper?.year ? `Year: ${paper.year}` : "",
      paper?.url ? `URL: ${paper.url}` : "",
      paper?.abstract ? `Abstract: ${safeString(paper.abstract)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (paperText) {
      pushDoc({
        sourceType: "paper",
        sourceId: `${searchId}:paper`,
        paperId: paperId || null,
        redditPostId: null,
        title: safeString(paper.title),
        url: safeString(paper.url),
        content: paperText,
        credibilityScore: SOURCE_CREDIBILITY.paper,
      });
    }

    const originBody = safeString(paperOriginText);
    if (originBody) {
      const originText = [
        `Query: ${safeString(query)}`,
        `Title: ${safeString(paper.title)}`,
        paper?.year ? `Year: ${paper.year}` : "",
        paper?.url ? `URL: ${safeString(paper.url)}` : "",
        `Full Paper Text:`,
        originBody,
      ]
        .filter(Boolean)
        .join("\n");

      pushDoc({
        sourceType: "paper_origin",
        sourceId: `${searchId}:paper:origin`,
        paperId: paperId || null,
        redditPostId: null,
        title: safeString(paper.title),
        url: safeString(paper.url),
        originTextFormat: safeString(paperOriginTextFormat),
        content: originText,
        credibilityScore: SOURCE_CREDIBILITY.paper_origin,
      });
    }
  }

  for (let i = 0; i < redditThreads.length; i += 1) {
    const t = redditThreads[i] || {};
    const sourceBase = safeString(t.id || t.platformId || t.url || t.permalink || i + 1);
    const text = [
      `Query: ${safeString(query)}`,
      `Reddit title: ${safeString(t.title)}`,
      t?.subreddit ? `Subreddit: r/${safeString(t.subreddit)}` : "",
      Number.isFinite(Number(t?.score)) ? `Score: ${Number(t.score)}` : "",
      Number.isFinite(Number(t?.numComments ?? t?.num_comments))
        ? `Comments: ${Number(t.numComments ?? t.num_comments)}`
        : "",
      t?.url ? `URL: ${safeString(t.url)}` : "",
      t?.snippet ? `Snippet: ${safeString(t.snippet)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (!text) continue;

    pushDoc({
      sourceType: "reddit",
      sourceId: `${searchId}:reddit:${sourceBase}`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(t.title),
      url: safeString(t.url || t.permalink),
      subreddit: safeString(t.subreddit),
      score: toFiniteNumber(t.score, null),
      numComments: toFiniteNumber(t.numComments ?? t.num_comments, null),
      content: text,
      credibilityScore: SOURCE_CREDIBILITY.reddit,
    });
  }

  const githubLimit = toInt(process.env.RAG_GITHUB_DOC_LIMIT, 80, 1, 400);
  const githubCandidates = githubRows.slice(0, githubLimit);
  for (let i = 0; i < githubCandidates.length; i += 1) {
    const row = githubCandidates[i] || {};
    const sourceType = githubSourceType(row);
    const sourceBase = sourceIdPart(row?.url || row?.repo || `g${i + 1}`);
    const ghText = [
      row?.repo ? `Repo: ${safeString(row.repo)}` : "",
      row?.url ? `URL: ${safeString(row.url)}` : "",
      row?.type ? `Type: ${safeString(row.type)}` : "",
      row?.content ? safeString(row.content) : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!ghText) continue;
    let credibility = null;
    if (sourceType === "github_readme" && row?.isOfficial === true) credibility = 0.82;
    if (sourceType === "github_issue_closed" && row?.isOfficial === true) credibility = 0.74;
    pushDoc({
      sourceType,
      sourceId: `${searchId}:github:${sourceBase}`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(row?.repo || row?.url || "GitHub evidence"),
      url: safeString(row?.url),
      credibilityScore: credibility,
      metadata: {
        repo: row?.repo || null,
        isOfficial: row?.isOfficial === true,
        relevanceScore: toFiniteNumber(row?.relevanceScore, null),
        stars: toFiniteNumber(row?.stars, null),
        forks: toFiniteNumber(row?.forks, null),
        rawType: safeString(row?.type) || null,
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      },
      content: ghText,
    });
  }

  const openreviewLimit = toInt(process.env.RAG_OPENREVIEW_DOC_LIMIT, 120, 1, 500);
  const openreviewCandidates = openreviewRows.slice(0, openreviewLimit);
  for (let i = 0; i < openreviewCandidates.length; i += 1) {
    const row = openreviewCandidates[i] || {};
    const sourceType = openreviewSourceType(row);
    const sourceBase = sourceIdPart(row?.noteId || row?.url || row?.forum || `or${i + 1}`);
    const orText = [
      row?.title ? `Title: ${safeString(row.title)}` : "",
      row?.ratingText ? `Rating: ${safeString(row.ratingText)}` : "",
      row?.confidenceText ? `Confidence: ${safeString(row.confidenceText)}` : "",
      row?.decision ? `Decision: ${safeString(row.decision)}` : "",
      row?.content ? safeString(row.content) : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!orText) continue;
    pushDoc({
      sourceType,
      sourceId: `${searchId}:openreview:${sourceBase}`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(row?.title || "OpenReview note"),
      url: safeString(row?.url),
      metadata: {
        noteId: row?.noteId || null,
        forum: row?.forum || null,
        parentNoteId: row?.parentNoteId || null,
        noteType: row?.type || null,
        invitation: row?.invitation || null,
        rating: toFiniteNumber(row?.rating, null),
        confidence: toFiniteNumber(row?.confidence, null),
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      },
      content: orText,
    });
  }

  const hfLimit = toInt(process.env.RAG_HUGGINGFACE_DOC_LIMIT, 80, 1, 400);
  const hfCandidates = huggingfaceRows.slice(0, hfLimit);
  for (let i = 0; i < hfCandidates.length; i += 1) {
    const row = hfCandidates[i] || {};
    const sourceBase = sourceIdPart(row?.url || row?.repo || `hf${i + 1}`);
    const hfText = [
      row?.type ? `Type: ${safeString(row.type)}` : "",
      row?.url ? `URL: ${safeString(row.url)}` : "",
      row?.content ? safeString(row.content) : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!hfText) continue;
    pushDoc({
      sourceType: "huggingface",
      sourceId: `${searchId}:huggingface:${sourceBase}`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(row?.repo || row?.url || "Hugging Face evidence"),
      url: safeString(row?.url),
      metadata: {
        repo: row?.repo || null,
        rawType: row?.type || null,
        upvotes: toFiniteNumber(row?.upvotes, null),
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      },
      content: hfText,
      credibilityScore: SOURCE_CREDIBILITY.huggingface,
    });
  }

  const s2Limit = toInt(process.env.RAG_SEMANTIC_SCHOLAR_DOC_LIMIT, 120, 1, 1000);
  const graphEdgeListLimit = toInt(process.env.RAG_SEMANTIC_SCHOLAR_GRAPH_EDGE_LIST_LIMIT, 400, 1, 3000);
  const fulltextDocLimit = toInt(process.env.RAG_SEMANTIC_SCHOLAR_FULLTEXT_DOC_LIMIT, 30, 0, 500);
  const semanticCandidates = semanticScholarRows.slice(0, s2Limit);
  const semanticGraphEdges = [];
  let forwardCount = 0;
  let backwardCount = 0;
  let fulltextDocs = 0;

  for (let i = 0; i < semanticCandidates.length; i += 1) {
    const row = semanticCandidates[i] || {};
    const direction = normalizeSemanticDirection(row?.direction);
    if (direction === "backward") backwardCount += 1;
    else forwardCount += 1;

    const citedPaperId = safeString(row?.citedPaperId || row?.paperId) || null;
    const sourcePaperId = safeString(row?.sourcePaperId) || null;
    const title = safeString(row?.title) || citedPaperId || "Semantic Scholar paper";
    const neighborNode = citedPaperId || title;
    const anchorNode = sourcePaperId || safeString(paper?.title) || safeString(query) || "anchor-paper";
    const edgeText = semanticEdgeExpression(direction, anchorNode, neighborNode);
    semanticGraphEdges.push({
      direction,
      edgeText,
      title,
      citedPaperId,
      sourcePaperId,
    });

    const sourceBase = sourceIdPart(
      `${direction}:${citedPaperId || row?.sourcePaperId || row?.url || row?.title || `s2${i + 1}`}`
    );
    const s2Text = [
      `Direction: ${direction}`,
      `Graph relation: ${semanticEdgeLabel(direction)}`,
      `Edge: ${edgeText}`,
      sourcePaperId ? `Source Paper ID: ${sourcePaperId}` : "",
      citedPaperId ? `Neighbor Paper ID: ${citedPaperId}` : "",
      row?.arxivId ? `Neighbor arXiv ID: ${safeString(row.arxivId)}` : "",
      title ? `Neighbor Title: ${title}` : "",
      row?.year ? `Year: ${safeString(row.year)}` : "",
      row?.venue ? `Venue: ${safeString(row.venue)}` : "",
      row?.url ? `URL: ${safeString(row.url)}` : "",
      Number.isFinite(Number(row?.citationCount)) ? `Citation Count: ${Number(row.citationCount)}` : "",
      Number.isFinite(Number(row?.influentialCitationCount))
        ? `Influential Citation Count: ${Number(row.influentialCitationCount)}`
        : "",
      Array.isArray(row?.authors) && row.authors.length ? `Authors: ${row.authors.join(", ")}` : "",
      row?.abstract ? `Abstract: ${safeString(row.abstract)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!s2Text) continue;
    pushDoc({
      sourceType: "semantic_scholar_citation",
      sourceId: `${searchId}:semantic-scholar:${sourceBase}`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(row?.title || "Semantic Scholar citation"),
      url: safeString(row?.url),
      metadata: {
        graphRole: "edge",
        edge: edgeText,
        direction,
        citedPaperId,
        sourcePaperId,
        arxivId: row?.arxivId || null,
        authors: Array.isArray(row?.authors) ? row.authors : [],
        abstract: row?.abstract || null,
        citationCount: toFiniteNumber(row?.citationCount, null),
        influentialCitationCount: toFiniteNumber(row?.influentialCitationCount, null),
        year: toFiniteNumber(row?.year, null),
        venue: row?.venue || null,
      },
      content: s2Text,
    });

    const neighbor = pickSemanticNeighborMapEntry(citationNeighborMap, row);
    const neighborOriginText = safeString(neighbor?.originText);
    if (neighborOriginText && fulltextDocs < fulltextDocLimit) {
      fulltextDocs += 1;
      const fullTextDoc = [
        "Citation graph node full text",
        `Direction: ${direction}`,
        `Graph relation: ${semanticEdgeLabel(direction)}`,
        `Edge: ${edgeText}`,
        citedPaperId ? `Neighbor Paper ID: ${citedPaperId}` : "",
        neighbor?.title ? `Neighbor Title: ${safeString(neighbor.title)}` : "",
        neighbor?.url ? `Neighbor URL: ${safeString(neighbor.url)}` : "",
        "Neighbor Full Paper Text:",
        neighborOriginText,
      ]
        .filter(Boolean)
        .join("\n");

      pushDoc({
        sourceType: "semantic_scholar_citation",
        sourceId: `${searchId}:semantic-scholar:fulltext:${sourceBase}`,
        paperId: paperId || null,
        redditPostId: null,
        title: safeString(neighbor?.title || title),
        url: safeString(neighbor?.url || row?.url),
        metadata: {
          graphRole: "node_fulltext",
          edge: edgeText,
          direction,
          citedPaperId,
          sourcePaperId,
          semanticScholarPaperId: safeString(neighbor?.semanticScholarPaperId) || null,
          source: safeString(neighbor?.source) || null,
          originTextPresent: true,
        },
        content: fullTextDoc,
      });
    }
  }

  if (semanticGraphEdges.length) {
    const edgesList = semanticGraphEdges
      .slice(0, graphEdgeListLimit)
      .map(
        (edge, idx) =>
          `${idx + 1}. ${edge.direction} | ${edge.edgeText}${edge.title ? ` | ${edge.title}` : ""}`
      );
    const graphText = [
      "Citation and reference graph",
      paper?.title ? `Anchor Title: ${safeString(paper.title)}` : "",
      paper?.url ? `Anchor URL: ${safeString(paper.url)}` : "",
      `Total graph edges: ${semanticGraphEdges.length}`,
      `Forward edges (neighbor cites anchor): ${forwardCount}`,
      `Backward edges (anchor references neighbor): ${backwardCount}`,
      "Edges:",
      ...edgesList,
    ]
      .filter(Boolean)
      .join("\n");

    pushDoc({
      sourceType: "semantic_scholar_citation",
      sourceId: `${searchId}:semantic-scholar:graph`,
      paperId: paperId || null,
      redditPostId: null,
      title: safeString(paper?.title || "Citation graph"),
      url: safeString(paper?.url),
      metadata: {
        graphRole: "graph_overview",
        edgeCount: semanticGraphEdges.length,
        forwardCount,
        backwardCount,
      },
      content: graphText,
    });
  }

  return docs;
}

export async function indexSearchRun({ userId, searchId, query, out, paperId = null, pyBase = null }) {
  const uid = safeString(userId);
  const sid = safeString(searchId);
  if (!uid || !sid) return { indexed: false, reason: "missing_user_or_search" };

  let paperOriginText = null;
  let paperOriginTextFormat = null;
  let citationGraphRows = [];
  let citationNeighborMap = {};

  if (paperId) {
    const citationContextLimit = toInt(process.env.RAG_SEMANTIC_SCHOLAR_CONTEXT_LIMIT, 240, 1, 1200);
    const [paper, semanticRows] = await Promise.all([
      prisma.paperRecord.findUnique({
        where: { id: paperId },
        select: { originText: true, originSource: true },
      }),
      prisma.paperSemanticScholarCitation.findMany({
        where: { paperId },
        orderBy: { updatedAt: "desc" },
        take: citationContextLimit,
        select: {
          sourcePaperId: true,
          direction: true,
          citedPaperId: true,
          title: true,
          url: true,
          influentialCitationCount: true,
          rawPayload: true,
        },
      }),
    ]);
    paperOriginText = safeString(paper?.originText);
    paperOriginTextFormat = safeString(paper?.originSource?.origin_text_format);

    citationGraphRows = Array.isArray(semanticRows) ? semanticRows : [];
    const citedIds = Array.from(
      new Set(
        citationGraphRows
          .map((row) => safeString(row?.citedPaperId))
          .filter(Boolean)
          .slice(0, citationContextLimit)
      )
    );

    if (citedIds.length) {
      const neighbors = await prisma.paperRecord.findMany({
        where: {
          OR: [
            { semanticScholarPaperId: { in: citedIds } },
            { source: "semantic_scholar", externalId: { in: citedIds } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: Math.max(citedIds.length, citationContextLimit),
        select: {
          source: true,
          externalId: true,
          semanticScholarPaperId: true,
          title: true,
          url: true,
          originText: true,
        },
      });

      const map = {};
      for (const row of neighbors) {
        if (!row || typeof row !== "object") continue;
        const record = {
          source: safeString(row.source) || null,
          semanticScholarPaperId: safeString(row.semanticScholarPaperId) || null,
          title: safeString(row.title) || null,
          url: safeString(row.url) || null,
          originText: safeString(row.originText),
        };
        if (!record.originText) continue;
        const keys = [safeString(row.semanticScholarPaperId), safeString(row.externalId)].filter(Boolean);
        for (const key of keys) {
          if (!map[key]) map[key] = record;
        }
      }
      citationNeighborMap = map;
    }
  }

  const docs = buildRagDocuments({
    searchId: sid,
    query,
    out,
    paperId,
    paperOriginText,
    paperOriginTextFormat,
    citationGraphRows,
    citationNeighborMap,
  });
  if (!docs.length) return { indexed: true, chunks: 0, model: null };

  const outIndex = await requestPythonRagIndexDb({
    userId: uid,
    searchId: sid,
    docs,
    pyBase,
  });

  return {
    indexed: outIndex?.indexed !== false,
    chunks: Number.isFinite(Number(outIndex?.chunks)) ? Number(outIndex.chunks) : 0,
    model: outIndex?.model || null,
  };
}

export async function queryRagViaPython({
  userId,
  question,
  searchId = null,
  k = 6,
  answer = true,
  intent = null,
  history = [],
  pyBase = null,
}) {
  const out = await requestPythonRagQueryDb({
    userId,
    question,
    searchId,
    k,
    answer,
    intent,
    history,
    pyBase,
  });
  return {
    model: out?.embeddingModel || null,
    answerModel: out?.answerModel || null,
    answer: out?.answer || "",
    intent: out?.intent || null,
    confidence: Number.isFinite(Number(out?.confidence)) ? Number(out.confidence) : null,
    conflictsDetected: Array.isArray(out?.conflicts_detected) ? out.conflicts_detected : [],
    audit: out?.audit || null,
    chunks: Array.isArray(out?.chunks) ? out.chunks : [],
    count: Number.isFinite(Number(out?.count)) ? Number(out.count) : Array.isArray(out?.chunks) ? out.chunks.length : 0,
  };
}
