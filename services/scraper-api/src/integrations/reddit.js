// scraper-api/src/integrations/reddit.js
import { makeLimiter } from "../middleware/rateLimit.js";
import { fetchJsonRetry } from "../http.js";
import { assertProviderQuota } from "./providerQuota.js";

function cleanUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString();
  } catch {
    return u;
  }
}

function isImageOrLowValueUrl(u = "") {
  const s = String(u).toLowerCase();
  return (
    s.includes("i.redd.it/") ||
    s.includes("v.redd.it/") ||
    s.includes("imgur.com/") ||
    s.endsWith(".png") ||
    s.endsWith(".jpg") ||
    s.endsWith(".jpeg") ||
    s.endsWith(".gif") ||
    s.endsWith(".webp")
  );
}

function normalizeText(s = "") {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTitleKey(s = "") {
  return normalizeText(s)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

// IMPORTANT: 1706.03762v7 -> 1706.03762
function baseArxivId(id = "") {
  const s = String(id || "").trim();
  return s.replace(/v\d+$/i, "");
}

const redditLimiter = makeLimiter({
  minIntervalMs: 1400,
  maxConcurrency: 1,
  maxBackoffMs: 45000,
});

// Subreddit allowlist for “paper discussion”
const ALLOW_SUBS = new Set([
  "MachineLearning",
  "deeplearning",
  "learnmachinelearning",
  "ArtificialInteligence",
  "LocalLLaMA",
  // If you feel OpenAI is too news/meme-y, remove it:
  "OpenAI",
  "LanguageTechnology",
  "nlp",
  "computervision",
  "datascience",
  "MLQuestions",
  "learnAI",
]);

// Noisy subs to hard reject
const DENY_SUBS = new Set([
  "Bigme",
  "LaTeX",
  "BetterOffline",
]);

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "for", "with", "on", "by",
  "from", "at", "as", "is", "are", "be", "this", "that", "we", "our", "their",
  "paper", "method", "model", "models", "approach", "using", "use", "based",
  "via", "new", "learning",
]);

function titleKeywords(title = "") {
  const toks = normalizeText(title)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter((t) => t.length > 3 && !STOP.has(t));
  return [...new Set(toks)].slice(0, 18);
}

function keywordHits(paperTitle, hay) {
  const keys = titleKeywords(paperTitle);
  if (!keys.length) return 0;
  let hit = 0;
  for (const k of keys) if (hay.includes(k)) hit++;
  return hit;
}

function buildQueries(paperOrQuery) {
  if (typeof paperOrQuery === "string") {
    const q = paperOrQuery.trim();
    return q ? [q] : [];
  }

  const title = String(paperOrQuery?.title || "").trim();
  const arxivIdFull = String(paperOrQuery?.arxiv_id || "").trim();
  const arxivId = baseArxivId(arxivIdFull);

  const queries = [];
  if (title) queries.push(`"${title.replace(/"/g, "")}"`); // strongest
  if (arxivId) queries.push(arxivId); // base id works best on reddit
  if (arxivId) queries.push(`arXiv:${arxivId}`);
  if (arxivId) queries.push(`arxiv ${arxivId}`);
  if (title) queries.push(title); // fallback

  return [...new Set(queries)].slice(0, 4);
}

function is429(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("http 429") || msg.includes("too many requests") || msg.includes("rate");
}

async function redditSearchOnce(qstr, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 25));
  const q = encodeURIComponent(qstr.slice(0, 180));
  const api = `https://www.reddit.com/search.json?q=${q}&limit=${safeLimit}&sort=relevance&t=all`;

  await assertProviderQuota("reddit");

  const data = await fetchJsonRetry(api, {
    headers: { "user-agent": process.env.REDDIT_UA || "Threadline/1.0 (local dev)" },
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 1200,
    dependency: "reddit",
  });

  const posts = (data?.data?.children || [])
    .map((c) => c?.data)
    .filter(Boolean)
    .slice(0, safeLimit);

  return posts.map((p) => {
    const permalink = p?.permalink ? `https://www.reddit.com${p.permalink}` : "";
    const url = cleanUrl(p?.url_overridden_by_dest || permalink || "");
    return {
      title: p?.title || "",
      url,
      permalink,
      subreddit: p?.subreddit || "",
      score: p?.score ?? 0,
      num_comments: p?.num_comments ?? 0,
      selftext: (p?.selftext || "").slice(0, 2500),
    };
  });
}

function hasStrongArxivProof(post, arxivIdFull) {
  const idFull = String(arxivIdFull || "").toLowerCase().trim();
  const idBase = baseArxivId(arxivIdFull).toLowerCase().trim();
  if (!idFull && !idBase) return false;

  const hay = `${normalizeText(post?.title)} ${normalizeText(post?.selftext)} ${normalizeText(
    post?.url
  )} ${normalizeText(post?.permalink)}`;

  // Direct contains (full or base)
  if (idFull && hay.includes(idFull)) return true;
  if (idBase && hay.includes(idBase)) return true;

  // Common arXiv link forms usually omit version
  if (idBase && hay.includes(`arxiv.org/abs/${idBase}`)) return true;
  if (idBase && hay.includes(`arxiv.org/pdf/${idBase}`)) return true;

  // Also accept "arxiv:1706.03762"
  if (idBase && hay.includes("arxiv:") && hay.includes(idBase)) return true;

  return false;
}

function isRelevant(post, paperTitle, arxivIdFull) {
  const sub = String(post?.subreddit || "").trim();
  if (!post?.title) return false;

  if (DENY_SUBS.has(sub)) return false;

  const title = normalizeText(post?.title);
  const text = normalizeText(post?.selftext);
  const hay = `${title} ${text} ${normalizeText(post?.url)} ${normalizeText(post?.permalink)}`;

  // allowlisted subs: moderate threshold
  if (ALLOW_SUBS.has(sub)) {
    if (hasStrongArxivProof(post, arxivIdFull)) return true;

    // For famous titles, 2 hits is too weak -> raises noise.
    // Still allow, but require a bit more overlap.
    const hits = keywordHits(paperTitle || "", hay);
    return hits >= 4;
  }

  // off-allowlist: strict
  if (hasStrongArxivProof(post, arxivIdFull)) return true;

  const hits = keywordHits(paperTitle || "", hay);
  const mentionsArxiv = hay.includes("arxiv") || hay.includes("arxiv.org");
  return mentionsArxiv && hits >= 4;
}

function scorePost(post, paperTitle, arxivIdFull) {
  const hay = `${normalizeText(post?.title)} ${normalizeText(post?.selftext)}`;
  let s = 0;

  if (isImageOrLowValueUrl(post?.url)) s -= 60;
  if ((post?.num_comments || 0) === 0 && (post?.score || 0) < 3) s -= 15;

  if (hasStrongArxivProof(post, arxivIdFull)) s += 90;

  const hits = keywordHits(paperTitle || "", hay);
  s += Math.min(36, hits * 6);

  s += Math.min(18, Math.log10((post?.score || 0) + 1) * 7);
  s += Math.min(18, Math.log10((post?.num_comments || 0) + 1) * 7);

  return s;
}

function diversify(posts, desired, { maxPerSub = 2 } = {}) {
  const subCount = new Map();
  const titleSeen = new Set();
  const out = [];

  for (const p of posts) {
    const sub = String(p.subreddit || "").trim();
    const tkey = normalizeTitleKey(p.title || "");

    if (titleSeen.has(tkey)) continue;
    if ((subCount.get(sub) || 0) >= maxPerSub) continue;

    titleSeen.add(tkey);
    subCount.set(sub, (subCount.get(sub) || 0) + 1);
    out.push(p);

    if (out.length >= desired) break;
  }

  return out;
}

async function _redditSearch(paperOrQuery, limit = 5) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const queries = buildQueries(paperOrQuery);
  if (!queries.length) return [];

  const paperTitle = typeof paperOrQuery === "string" ? "" : (paperOrQuery?.title || "");
  const arxivIdFull = typeof paperOrQuery === "string" ? "" : (paperOrQuery?.arxiv_id || "");

  const seen = new Set();
  const all = [];

  const perQuery = Math.max(18, safeLimit * 4);

  for (const q of queries) {
    try {
      const batch = await redditSearchOnce(q, perQuery);
      for (const p of batch) {
        const key = (p?.permalink || p?.url || p?.title || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(p);
      }
    } catch (e) {
      if (is429(e)) redditLimiter.onRateLimited();
    }
  }

  const step1 = all.filter((p) => {
    if (!p?.title) return false;
    if (isImageOrLowValueUrl(p?.url) && !(p?.permalink || "").includes("reddit.com/r/")) return false;
    return true;
  });

  const step2 = step1.filter((p) => isRelevant(p, paperTitle, arxivIdFull));

  step2.sort((a, b) => scorePost(b, paperTitle, arxivIdFull) - scorePost(a, paperTitle, arxivIdFull));

  const final = diversify(step2, safeLimit, { maxPerSub: 2 });

  return final.map((p) => ({
    title: p.title,
    url: p.permalink || p.url,
    subreddit: p.subreddit,
    score: p.score,
    num_comments: p.num_comments,
    selftext: p.selftext,
  }));
}

export async function redditSearch(paperOrQuery, limit = 5) {
  return redditLimiter.schedule(() => _redditSearch(paperOrQuery, limit));
}
