import { fetchJsonRetry, fetchTextRetry } from "../http.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { assertProviderQuota } from "./providerQuota.js";

const BASE = String(process.env.HUGGINGFACE_API_BASE_URL || "https://huggingface.co/api").replace(/\/+$/, "");
const WEB_BASE = String(process.env.HUGGINGFACE_WEB_BASE_URL || "https://huggingface.co").replace(/\/+$/, "");
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const limiter = makeLimiter({
  minIntervalMs: Number(process.env.HUGGINGFACE_MIN_INTERVAL_MS || 700),
  maxConcurrency: Number(process.env.HUGGINGFACE_MAX_CONCURRENCY || 2),
  maxBackoffMs: Number(process.env.HUGGINGFACE_MAX_BACKOFF_MS || 60_000),
});

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

function cleanText(value, max = 7000) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 18))} ...[truncated]` : s;
}

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

function extractGithubRepos(value, out = new Set(), depth = 0) {
  if (depth > 5 || value == null) return out;
  if (typeof value === "string") {
    for (const match of value.matchAll(GITHUB_REPO_URL_RE)) {
      const normalized = normalizeGithubRepoUrl(match[0]);
      if (normalized) out.add(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) extractGithubRepos(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value).slice(0, 80)) {
      extractGithubRepos(k, out, depth + 1);
      extractGithubRepos(v, out, depth + 1);
    }
  }
  return out;
}

function baseArxivId(value = "") {
  return String(value || "")
    .trim()
    .replace(/v\d+$/i, "");
}

function isRateLimited(err) {
  const status = Number(err?.status);
  if (status === 429) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests");
}

async function runJson(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("huggingface");
    return await fetchJsonRetry(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": process.env.HUGGINGFACE_UA || DEFAULT_UA,
      },
      timeoutMs: Number(process.env.HUGGINGFACE_TIMEOUT_MS || 18_000),
      retries: Number(process.env.HUGGINGFACE_RETRIES || 1),
      backoffMs: Number(process.env.HUGGINGFACE_BACKOFF_MS || 900),
      dependency: "huggingface",
    });
  });
}

async function runText(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("huggingface");
    return await fetchTextRetry(url, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": process.env.HUGGINGFACE_UA || DEFAULT_UA,
      },
      timeoutMs: Number(process.env.HUGGINGFACE_TIMEOUT_MS || 18_000),
      retries: Number(process.env.HUGGINGFACE_RETRIES || 1),
      backoffMs: Number(process.env.HUGGINGFACE_BACKOFF_MS || 900),
      dependency: "huggingface",
    });
  });
}

function buildQueries(arxivId, title) {
  const queries = [];
  const id = baseArxivId(arxivId);
  const t = cleanText(title, 180);
  if (id) queries.push(id);
  if (id) queries.push(`arxiv:${id}`);
  if (t) queries.push(t);
  return [...new Set(queries)].filter(Boolean);
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a, b) {
  const aa = normalizeTitle(a);
  const bb = normalizeTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.94;
  const A = new Set(aa.split(" ").filter(Boolean));
  const B = new Set(bb.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePaperContentProps(html) {
  const s = String(html || "");
  if (!s) return null;
  const m =
    s.match(/data-target="PaperContent"\s+data-props="([^"]*)"/i) ||
    s.match(/data-props="([^"]*)"\s+data-target="PaperContent"/i);
  if (!m?.[1]) return null;
  const decoded = decodeHtmlEntities(m[1]);
  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function mapPaperInfoRow(paperInfo, arxivId) {
  const id = baseArxivId(arxivId || paperInfo?.id);
  const githubRepo = normalizeGithubRepoUrl(paperInfo?.githubRepo) || null;
  const projectPage = cleanText(paperInfo?.projectPage || "", 1200) || null;
  const githubRepos = [githubRepo].filter(Boolean);
  const content = [
    paperInfo?.title ? `Paper: ${cleanText(paperInfo.title, 600)}` : "",
    paperInfo?.summary ? `Summary: ${cleanText(paperInfo.summary, 4000)}` : "",
    paperInfo?.ai_summary ? `AI Summary: ${cleanText(paperInfo.ai_summary, 3000)}` : "",
    githubRepo ? `GitHub: ${githubRepo}` : "",
    projectPage ? `Project: ${projectPage}` : "",
    Number.isFinite(Number(paperInfo?.upvotes)) ? `Upvotes: ${Number(paperInfo.upvotes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    source: "huggingface",
    type: "paper_page",
    content: cleanText(content, 7000),
    url: id ? `${WEB_BASE}/papers/${encodeURIComponent(id)}` : null,
    repo: id || null,
    upvotes: Number.isFinite(Number(paperInfo?.upvotes)) ? Number(paperInfo.upvotes) : null,
    githubRepos,
    discussionId: cleanText(paperInfo?.discussionId || "", 120) || null,
    created_at: paperInfo?.publishedAt || null,
    updated_at: paperInfo?.submittedOnDailyAt || null,
  };
}

function mapPaperCommentRows(paperId, payload, limit) {
  const comments = toArray(payload?.comments);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 80));
  const out = [];
  for (const c of comments.slice(0, safeLimit)) {
    const latest = c?.data?.latest && typeof c.data.latest === "object" ? c.data.latest : {};
    const rawText = cleanText(latest?.raw || "", 6000);
    if (!rawText) continue;
    const author = cleanText(c?.author?.name || c?.author?.user || c?.author?.fullname || "", 120);
    const githubRepos = Array.from(extractGithubRepos(rawText)).slice(0, 8);
    const content = [author ? `Comment by ${author}` : "Comment", rawText].join("\n");
    out.push({
      source: "huggingface",
      type: "paper_comment",
      content: cleanText(content, 7000),
      url: paperId ? `${WEB_BASE}/papers/${encodeURIComponent(paperId)}` : `${WEB_BASE}/papers`,
      repo: paperId || null,
      upvotes: Array.isArray(latest?.reactions) ? latest.reactions.length : null,
      githubRepos,
      created_at: c?.createdAt || null,
      updated_at: latest?.updatedAt || c?.createdAt || null,
    });
  }
  return out;
}

async function fetchPaperInfo(arxivId) {
  const id = baseArxivId(arxivId);
  if (!id) return null;
  const url = `${BASE}/papers/${encodeURIComponent(id)}`;
  try {
    const data = await runJson(url);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

async function fetchPaperPagePayload(arxivId) {
  const id = baseArxivId(arxivId);
  if (!id) return null;
  const url = `${WEB_BASE}/papers/${encodeURIComponent(id)}`;
  try {
    const html = await runText(url);
    return parsePaperContentProps(html);
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

async function searchPaperByTitle(title, limit = 5) {
  const q = cleanText(title, 220);
  if (!q) return null;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const url = `${BASE}/papers/search?q=${encodeURIComponent(q)}&limit=${safeLimit}`;
  try {
    const data = await runJson(url);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;
    const ranked = rows
      .map((row) => ({
        row,
        score: titleSimilarity(q, row?.paper?.title || row?.title || ""),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best?.row) return null;
    const minScore = Number(process.env.HUGGINGFACE_PAPER_MIN_TITLE_SCORE || 0.3);
    if (best.score < minScore) return null;
    return best.row;
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return null;
  }
}

function mapModel(model, arxivId) {
  const tags = Array.isArray(model?.tags) ? model.tags.slice(0, 12) : [];
  const cardData = model?.cardData && typeof model.cardData === "object" ? model.cardData : null;
  const papers = Array.isArray(cardData?.papers) ? cardData.papers : [];
  const githubRepos = Array.from(
    extractGithubRepos({
      modelId: model?.id,
      modelUrl: model?.id ? `https://huggingface.co/${model.id}` : null,
      cardData,
      tags,
      model,
    })
  ).slice(0, 8);
  const id = baseArxivId(arxivId).toLowerCase();
  const hasArxivRef =
    id &&
    (tags.some((t) => String(t).toLowerCase().includes(id)) ||
      papers.some((p) => String(p?.id || p?.arxiv || "").toLowerCase().includes(id)));

  const content = [
    model?.id ? `Model: ${model.id}` : "",
    model?.pipeline_tag ? `Task: ${model.pipeline_tag}` : "",
    Number.isFinite(Number(model?.likes)) ? `Likes: ${Number(model.likes)}` : "",
    Number.isFinite(Number(model?.downloads)) ? `Downloads: ${Number(model.downloads)}` : "",
    model?.library_name ? `Library: ${model.library_name}` : "",
    tags.length ? `Tags: ${tags.join(", ")}` : "",
    githubRepos.length ? `GitHub: ${githubRepos.slice(0, 3).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    source: "huggingface",
    type: "model_page",
    content: cleanText(content, 5000),
    url: model?.id ? `https://huggingface.co/${model.id}` : null,
    repo: model?.id || null,
    upvotes: Number.isFinite(Number(model?.likes)) ? Number(model.likes) : null,
    downloads: Number.isFinite(Number(model?.downloads)) ? Number(model.downloads) : null,
    hasArxivReference: Boolean(hasArxivRef),
    githubRepos,
    created_at: model?.createdAt || null,
    updated_at: model?.lastModified || null,
  };
}

async function searchModels(query, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 30));
  const url =
    `${BASE}/models?search=${encodeURIComponent(query)}` +
    `&limit=${safeLimit}&full=true&sort=downloads&direction=-1`;
  try {
    const data = await runJson(url);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return [];
  }
}

function parseDiscussions(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.discussions)) return data.discussions;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function mapDiscussion(repoId, d) {
  const title = cleanText(d?.title || d?.content || "", 300);
  const body = cleanText(d?.description || d?.status || "", 3000);
  const githubRepos = Array.from(
    extractGithubRepos({
      repoId,
      title: d?.title,
      content: d?.content,
      description: d?.description,
      status: d?.status,
      url: d?.url,
      discussion: d,
    })
  ).slice(0, 8);
  const numComments = Number.isFinite(Number(d?.num_comments ?? d?.numComments))
    ? Number(d.num_comments ?? d.numComments)
    : null;
  return {
    source: "huggingface",
    type: "discussion",
    content: cleanText([title ? `Discussion: ${title}` : "", body].filter(Boolean).join("\n"), 7000),
    url:
      d?.url ||
      (repoId && d?.num != null
        ? `https://huggingface.co/${repoId}/discussions/${encodeURIComponent(String(d.num))}`
        : repoId
        ? `https://huggingface.co/${repoId}/discussions`
        : null),
    repo: repoId || null,
    upvotes: Number.isFinite(Number(d?.upvotes)) ? Number(d.upvotes) : null,
    numComments,
    githubRepos,
    created_at: d?.createdAt || d?.created_at || null,
    updated_at: d?.lastEditedAt || d?.updated_at || null,
  };
}

async function fetchModelDiscussions(repoId, limit) {
  const repo = String(repoId || "").trim();
  if (!repo) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 40));
  const urls = [
    `${BASE}/models/${encodeURIComponent(repo)}/discussions?limit=${safeLimit}`,
    `${BASE}/discussions?repo_id=${encodeURIComponent(repo)}&repo_type=model&limit=${safeLimit}`,
  ];

  for (const url of urls) {
    try {
      const data = await runJson(url);
      const rows = parseDiscussions(data).map((d) => mapDiscussion(repo, d)).filter((x) => x.content);
      if (rows.length) return rows;
    } catch (err) {
      if (isRateLimited(err)) limiter.onRateLimited();
    }
  }
  return [];
}

function dedupe(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(row?.url || row?.content || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Returns raw HuggingFace rows:
 *   { type: "paper_page"|"paper_comment"|"discussion"|"model_page", content, url, upvotes }
 */
export async function fetchHuggingFace(arxivId, title, { modelLimit = 8, discussionLimit = 12 } = {}) {
  let paperId = baseArxivId(arxivId);
  if (!paperId) {
    const byTitle = await searchPaperByTitle(title, Number(process.env.HUGGINGFACE_PAPER_SEARCH_LIMIT || 5));
    paperId = baseArxivId(byTitle?.paper?.id || byTitle?.id || "");
  }
  const requirePaperId = String(process.env.HUGGINGFACE_REQUIRE_PAPER_ID || "1") !== "0";
  if (requirePaperId && !paperId) return [];

  const paperCommentLimit = Math.max(
    1,
    Math.min(Number(process.env.HUGGINGFACE_PAPER_COMMENT_LIMIT || 20), 80)
  );
  const [paperInfo, paperPagePayload] = paperId
    ? await Promise.all([fetchPaperInfo(paperId), fetchPaperPagePayload(paperId)])
    : [null, null];

  const paperRows = [];
  if (paperInfo) paperRows.push(mapPaperInfoRow(paperInfo, paperId));
  const pagePaperInfo = paperPagePayload?.paper && typeof paperPagePayload.paper === "object"
    ? paperPagePayload.paper
    : null;
  if (!paperInfo && pagePaperInfo) paperRows.push(mapPaperInfoRow(pagePaperInfo, paperId));
  const paperComments = mapPaperCommentRows(paperId, paperPagePayload, paperCommentLimit);

  const skipModelSearchWithoutPaperSignal =
    String(process.env.HUGGINGFACE_SKIP_MODEL_SEARCH_WITHOUT_PAPER || "1") !== "0";
  const hasPaperSignal = Boolean(paperRows.length || paperComments.length);
  if (skipModelSearchWithoutPaperSignal && !hasPaperSignal) {
    return dedupe([...paperRows, ...paperComments]);
  }

  const queries = buildQueries(paperId || arxivId, title);
  const modelRows = [];
  const modelsSeen = new Map();

  if (queries.length) {
    for (const q of queries) {
      const models = await searchModels(q, modelLimit);
      for (const model of models) {
        const id = String(model?.id || "").trim();
        if (!id || modelsSeen.has(id)) continue;
        modelsSeen.set(id, model);
        modelRows.push(mapModel(model, arxivId));
      }
    }
  }

  const discussionRows = [];
  const topModels = [...modelsSeen.values()].slice(0, 5);
  for (const model of topModels) {
    const rows = await fetchModelDiscussions(model?.id, discussionLimit);
    discussionRows.push(...rows);
  }

  return dedupe([...paperRows, ...paperComments, ...modelRows, ...discussionRows]);
}
