import { fetchJsonRetry, fetchTextRetry } from "../http.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { assertProviderQuota } from "./providerQuota.js";

const BASE = String(process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");
const TOKEN = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();

const limiter = makeLimiter({
  minIntervalMs: Number(process.env.GITHUB_MIN_INTERVAL_MS || 850),
  maxConcurrency: Number(process.env.GITHUB_MAX_CONCURRENCY || 2),
  maxBackoffMs: Number(process.env.GITHUB_MAX_BACKOFF_MS || 60_000),
});

function cleanText(value, max = 8000) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 18))} ...[truncated]` : s;
}

function baseArxivId(value = "") {
  return String(value || "")
    .trim()
    .replace(/v\d+$/i, "");
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleKeywords(title) {
  const words = normalize(title)
    .split(" ")
    .filter((w) => w && w.length >= 3 && !TITLE_STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

function titleKeywordHitCount(text, title) {
  const kws = titleKeywords(title);
  if (!kws.length) return 0;
  const t = normalize(text);
  if (!t) return 0;
  let hits = 0;
  for (const tok of kws) if (t.includes(tok)) hits += 1;
  return hits;
}

function normalizeAlias(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isUsefulAlias(value = "") {
  const v = normalizeAlias(value);
  if (!v) return false;
  if (v.length >= 3) return true;
  return /[a-z]/.test(v) && /\d/.test(v);
}

function buildTitleAliases(title = "") {
  const out = new Set();
  const raw = String(title || "").trim();
  if (!raw) return [];

  const add = (candidate) => {
    if (!isUsefulAlias(candidate)) return;
    out.add(normalizeAlias(candidate));
  };

  const head = raw.split(":")[0].trim();
  if (head && head.length <= 24 && !head.includes(" ")) add(head);

  for (const m of raw.matchAll(/\(([A-Za-z0-9][A-Za-z0-9._-]{1,24})\)/g)) add(m[1]);

  for (const token of raw.split(/[\s:/,_|;()[\]{}]+/).filter(Boolean)) {
    if (token.length > 24) continue;
    if (/[A-Z]{2,}/.test(token) || /[A-Z].*\d|\d.*[A-Z]/.test(token)) add(token);
  }

  return [...out];
}

function hasTitleAliasSignal(repo, title, readme = "") {
  const aliases = buildTitleAliases(title);
  if (!aliases.length) return false;
  const body = normalizeAlias(
    `${repo?.name || ""}\n${repo?.full_name || ""}\n${repo?.description || ""}\n${repo?.homepage || ""}\n${String(
      readme || ""
    ).slice(0, 8000)}`
  );
  if (!body) return false;
  for (const alias of aliases) {
    if (body.includes(alias)) return true;
  }
  return false;
}

function repoAliasNameScore(repo, title = "") {
  const aliases = buildTitleAliases(title);
  if (!aliases.length) return 0;

  const repoName = normalizeAlias(repo?.name || "");
  const fullName = normalizeAlias(repo?.full_name || "");
  if (!repoName && !fullName) return 0;

  let best = 0;
  for (const alias of aliases) {
    if (repoName && repoName === alias) best = Math.max(best, 3);
    else if (repoName && repoName.includes(alias)) best = Math.max(best, 2);
    else if (fullName && fullName.includes(alias)) best = Math.max(best, 1);
  }
  return best;
}

function hasStrongTitleSignal(repo, title, readme = "") {
  const kws = titleKeywords(title);
  if (!kws.length) return false;
  const text = normalize(
    `${repo?.name || ""}\n${repo?.description || ""}\n${String(readme || "").slice(0, 6000)}`
  );
  let matches = 0;
  for (const tok of kws) if (text.includes(tok)) matches += 1;
  return matches >= 4;
}

function hasArxivMention(text, arxivId) {
  const id = baseArxivId(arxivId);
  if (!id) return false;
  const re = new RegExp(`\\b${escapeRegExp(id)}(?:v\\d+)?\\b`, "i");
  return re.test(String(text || ""));
}

function hasArxivLink(text, arxivId) {
  const id = baseArxivId(arxivId);
  if (!id) return false;
  const re = new RegExp(`arxiv\\.org\\/(?:abs|pdf)\\/${escapeRegExp(id)}(?:v\\d+)?`, "i");
  return re.test(String(text || ""));
}

function normalizeDoi(value = "") {
  return String(value || "")
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function hasDoiMention(text, doi = "") {
  const d = normalizeDoi(doi);
  if (!d) return false;
  const body = String(text || "").toLowerCase();
  if (!body) return false;
  return body.includes(d) || body.includes(`doi.org/${d}`) || body.includes(`doi:${d}`);
}

function normalizeUrlSignal(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    url.search = "";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

function hasAnyUrlSignal(text, urls = []) {
  const body = String(text || "").toLowerCase();
  if (!body) return false;
  const seen = new Set();
  for (const value of Array.isArray(urls) ? urls : []) {
    const normalized = normalizeUrlSignal(value);
    if (!normalized || seen.has(normalized) || normalized.length < 12) continue;
    seen.add(normalized);
    const noScheme = normalized.replace(/^https?:\/\//, "");
    if (body.includes(normalized) || (noScheme && body.includes(noScheme))) return true;
  }
  return false;
}

function hasNegatedOfficialClaim(text = "") {
  const s = String(text || "");
  return (
    /\b(?:unofficial|non[-\s]?official|third[-\s]?party|community)\s+(?:implementation|repo|repository|code)\b/i.test(
      s
    ) ||
    /\bnot\s+(?:an?\s+)?official\s+(?:implementation|repo|repository|code)\b/i.test(s) ||
    /\bnot\s+the\s+official\b/i.test(s)
  );
}

function countMatches(text, re) {
  const m = String(text || "").match(re);
  return Array.isArray(m) ? m.length : 0;
}

function isLikelyAggregatorRepo(repo, readme = "") {
  const name = normalize(repo?.name || "");
  const desc = normalize(repo?.description || "");
  const head = `${name} ${desc}`;
  const aggregatorTag = /\b(awesome|resources?|tutorials?|paper\s*list|reading\s*list|survey|collection)\b/i.test(
    head
  );
  const arxivLinks = countMatches(readme, /arxiv\.org\/abs\/\d{4}\.\d{4,5}(?:v\d+)?/gi);
  return aggregatorTag || arxivLinks >= 10;
}

function scoreRepoRelevance(repo, { title = "", arxivId = "", doi = "", paperUrls = [], authors = [], readme = "" } = {}) {
  const fullName = String(repo?.full_name || "");
  const description = String(repo?.description || "");
  const homepage = String(repo?.homepage || "");
  const joined = `${fullName}\n${description}\n${homepage}\n${readme}`;
  const normJoined = normalize(joined);

  let score = 0;

  if (hasArxivMention(joined, arxivId)) score += 140;
  if (hasArxivLink(joined, arxivId)) score += 40;
  if (hasDoiMention(joined, doi)) score += 120;
  if (hasAnyUrlSignal(joined, paperUrls)) score += 80;

  const keywords = titleKeywords(title);
  if (keywords.length) {
    let matches = 0;
    for (const tok of keywords) if (normJoined.includes(tok)) matches += 1;
    if (matches >= 6) score += 85;
    else if (matches >= 4) score += 55;
    else if (matches >= 2) score += 25;
  }

  const normTitle = normalize(title);
  if (normTitle && normTitle.length >= 18 && normJoined.includes(normTitle.slice(0, Math.min(80, normTitle.length)))) {
    score += 35;
  }
  const repoNameNorm = normalize(repo?.name || "");
  if (keywords.length) {
    let repoNameHits = 0;
    for (const tok of keywords) if (repoNameNorm.includes(tok)) repoNameHits += 1;
    if (repoNameHits >= 2) score += 25;
  }

  if (hasAuthorOwnerMatch(repo, authors)) score += 22;
  if (hasTitleAliasSignal(repo, title, readme)) score += 34;

  const hasImplementationSignal = /\b(official|implementation|code|reproduction|reproduce)\b/i.test(joined);
  if (hasImplementationSignal && !hasNegatedOfficialClaim(joined)) score += 12;

  if (isLikelyAggregatorRepo(repo, readme)) score -= 140;

  const stars = Number(repo?.stargazers_count);
  if (Number.isFinite(stars) && stars > 0) score += Math.min(18, Math.log1p(stars));

  return score;
}

function authorTokens(authors = []) {
  const out = new Set();
  for (const author of Array.isArray(authors) ? authors : []) {
    const words = String(author || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) continue;
    const last = normalize(words[words.length - 1]);
    if (last.length >= 3) out.add(last);
    const first = normalize(words[0]);
    if (first.length >= 3) out.add(first);
  }
  return out;
}

function hasAuthorOwnerMatch(repo, authors = []) {
  const tokens = authorTokens(authors);
  if (!tokens.size) return false;
  const owner = normalize(repo?.owner?.login || "");
  const fullName = normalize(repo?.full_name || "");
  const repoName = normalize(repo?.name || "");
  for (const tok of tokens) {
    if (owner === tok || owner.includes(tok) || fullName.includes(tok) || repoName.includes(tok)) {
      return true;
    }
  }
  return false;
}

function isRateLimited(err) {
  const status = Number(err?.status);
  if (status === 429 || status === 403) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("abuse detection");
}

function headers({ raw = false } = {}) {
  const h = {
    accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "user-agent": process.env.GITHUB_UA || "Threadline/1.0",
  };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
  return h;
}

async function runJson(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("github");
    return await fetchJsonRetry(url, {
      method: "GET",
      headers: headers(),
      timeoutMs: Number(process.env.GITHUB_TIMEOUT_MS || 20_000),
      retries: Number(process.env.GITHUB_RETRIES || 1),
      backoffMs: Number(process.env.GITHUB_BACKOFF_MS || 1200),
      dependency: "github",
    });
  });
}

async function runText(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("github");
    return await fetchTextRetry(url, {
      method: "GET",
      headers: headers({ raw: true }),
      timeoutMs: Number(process.env.GITHUB_TIMEOUT_MS || 20_000),
      retries: Number(process.env.GITHUB_RETRIES || 1),
      backoffMs: Number(process.env.GITHUB_BACKOFF_MS || 1200),
      dependency: "github",
    });
  });
}

function buildSearchTerms(title, arxivId, doi = "") {
  const t = cleanText(title, 200);
  const id = baseArxivId(arxivId);
  const d = normalizeDoi(doi);
  const terms = [];
  if (id) terms.push(`"${id}"`);
  if (id) terms.push(`"arxiv ${id}"`);
  if (id) terms.push(`"arxiv.org/abs/${id}"`);
  if (d) terms.push(`"${d}"`);
  if (d) terms.push(`"doi.org/${d}"`);
  if (t) terms.push(`"${t.replace(/"/g, "")}"`);
  if (t) {
    const tokens = titleKeywords(t).slice(0, 6);
    if (tokens.length >= 2) terms.push(tokens.join(" "));
  }
  return [...new Set(terms)].filter(Boolean);
}

function isOfficialRepo(repo, authors = [], arxivId = "", title = "", { readme = "", doi = "", paperUrls = [] } = {}) {
  const surface = `${repo?.full_name || ""}\n${repo?.description || ""}\n${repo?.homepage || ""}`;
  const joined = `${surface}\n${readme || ""}`;
  const hasArxivAny = hasArxivMention(joined, arxivId) || hasArxivLink(joined, arxivId);
  const hasArxivSurface = hasArxivMention(surface, arxivId) || hasArxivLink(surface, arxivId);
  const hasDoiAny = hasDoiMention(joined, doi);
  const hasDoiSurface = hasDoiMention(surface, doi);
  const hasUrlAny = hasAnyUrlSignal(joined, paperUrls);
  const hasUrlSurface = hasAnyUrlSignal(surface, paperUrls);
  const authorMatch = hasAuthorOwnerMatch(repo, authors);
  const aliasMatch = hasTitleAliasSignal(repo, title, readme);
  const strongTitle = hasStrongTitleSignal(repo, title, readme);
  const surfaceTitleHits = titleKeywordHitCount(surface, title);
  const hasArxivId = Boolean(baseArxivId(arxivId));
  const aliasNameScore = repoAliasNameScore(repo, title);

  if (hasArxivId) {
    // Primary official signal: repo surface metadata references this exact arXiv id and repo name matches paper alias.
    if (hasArxivSurface && aliasNameScore >= 3) return true;
    if (hasArxivSurface && authorMatch && (aliasMatch || strongTitle || surfaceTitleHits >= 1)) return true;
    if (hasArxivAny && authorMatch && (aliasMatch || strongTitle || surfaceTitleHits >= 2)) return true;
    if ((hasDoiAny || hasUrlAny) && authorMatch && (aliasMatch || strongTitle || surfaceTitleHits >= 1)) return true;
    return false;
  }

  if ((hasDoiSurface || hasUrlSurface) && aliasNameScore >= 2) return true;
  if ((hasDoiAny || hasUrlAny) && (authorMatch || aliasMatch) && (strongTitle || surfaceTitleHits >= 2)) return true;
  if (authorMatch && (aliasMatch || strongTitle)) return true;
  return false;
}

function mapRepoAsModel(repo, { relevanceScore = null, isOfficial = null } = {}) {
  const content = [
    `Repo: ${repo?.full_name || ""}`,
    repo?.description ? `Description: ${cleanText(repo.description, 1200)}` : "",
    repo?.language ? `Language: ${repo.language}` : "",
    Number.isFinite(Number(repo?.stargazers_count)) ? `Stars: ${Number(repo.stargazers_count)}` : "",
    Number.isFinite(Number(repo?.forks_count)) ? `Forks: ${Number(repo.forks_count)}` : "",
    repo?.homepage ? `Homepage: ${repo.homepage}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    source: "github",
    type: "readme",
    content,
    url: repo?.html_url || null,
    repo: repo?.full_name || null,
    stars: Number.isFinite(Number(repo?.stargazers_count)) ? Number(repo.stargazers_count) : null,
    forks: Number.isFinite(Number(repo?.forks_count)) ? Number(repo.forks_count) : null,
    isOfficial: Boolean(isOfficial),
    relevanceScore: Number.isFinite(Number(relevanceScore)) ? Number(relevanceScore) : null,
    created_at: repo?.created_at || null,
    updated_at: repo?.updated_at || null,
  };
}

async function fetchRepoReadme(repoFullName) {
  const full = String(repoFullName || "").trim();
  if (!full) return "";
  const parts = full.split("/").map((x) => encodeURIComponent(String(x || "").trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
  const url = `${BASE}/repos/${parts[0]}/${parts[1]}/readme`;
  try {
    return cleanText(await runText(url), 12_000);
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return "";
  }
}

function mapIssue(
  item,
  repoMeta = null,
  title = "",
  arxivId = "",
  authors = [],
  { relevanceScore = null, isOfficial = null, readme = "", doi = "", paperUrls = [] } = {}
) {
  const repo = item?.repository_url
    ? String(item.repository_url).replace(/^https:\/\/api\.github\.com\/repos\//, "")
    : repoMeta?.full_name || null;
  const url = item?.html_url || null;
  const body = cleanText(item?.body || "", 6000);
  const content = [
    item?.title ? `Issue: ${cleanText(item.title, 400)}` : "",
    body ? `Body: ${body}` : "",
    item?.state ? `State: ${item.state}` : "",
    Number.isFinite(Number(item?.comments)) ? `Comments: ${Number(item.comments)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    source: "github",
    type: "issue",
    content,
    url,
    repo,
    stars: Number.isFinite(Number(repoMeta?.stargazers_count)) ? Number(repoMeta.stargazers_count) : null,
    forks: Number.isFinite(Number(repoMeta?.forks_count)) ? Number(repoMeta.forks_count) : null,
    isOfficial:
      typeof isOfficial === "boolean"
        ? isOfficial
        : isOfficialRepo(repoMeta || { full_name: repo }, authors, arxivId, title, { readme, doi, paperUrls }),
    relevanceScore: Number.isFinite(Number(relevanceScore)) ? Number(relevanceScore) : null,
    created_at: item?.created_at || null,
    updated_at: item?.updated_at || null,
  };
}

function dedupe(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(row?.url || row?.repo || row?.content || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function searchRepos(terms, repoLimit) {
  const wanted = Math.max(1, Number(repoLimit) || 6);
  const perQuery = Math.max(1, Math.min(wanted * 2, 20));
  const maxPool = wanted * 6;

  const uniqueTerms = [...new Set((Array.isArray(terms) ? terms : []).map((x) => String(x || "").trim()))].filter(
    Boolean
  );
  if (!uniqueTerms.length) return [];

  async function runTermBatch(batchTerms) {
    const settled = await Promise.allSettled(
      batchTerms.map(async (term) => {
        const q = encodeURIComponent(`${term} in:name,description,readme archived:false`);
        const url =
          `${BASE}/search/repositories?q=${q}` +
          `&sort=stars&order=desc&per_page=${perQuery}`;
        try {
          const data = await runJson(url);
          return Array.isArray(data?.items) ? data.items : [];
        } catch (err) {
          if (isRateLimited(err)) limiter.onRateLimited();
          return [];
        }
      })
    );
    const out = [];
    for (const row of settled) {
      if (row?.status !== "fulfilled" || !Array.isArray(row.value)) continue;
      out.push(...row.value);
    }
    return out;
  }

  const seen = new Set();
  const repos = [];
  const primaryBatchSize = Math.max(1, Math.min(Number(process.env.GITHUB_PRIMARY_SEARCH_TERMS || 3), 6));
  const primaryTerms = uniqueTerms.slice(0, primaryBatchSize);
  const fallbackTerms = uniqueTerms.slice(primaryBatchSize);

  const phaseOne = await runTermBatch(primaryTerms);
  for (const item of phaseOne) {
    const key = String(item?.full_name || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    repos.push(item);
    if (repos.length >= maxPool) break;
  }

  if (repos.length < maxPool && fallbackTerms.length) {
    const phaseTwo = await runTermBatch(fallbackTerms);
    for (const item of phaseTwo) {
      const key = String(item?.full_name || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      repos.push(item);
      if (repos.length >= maxPool) break;
    }
  }

  repos.sort((a, b) => Number(b?.stargazers_count || 0) - Number(a?.stargazers_count || 0));
  return repos;
}

async function fetchRepoIssues(repoFullName, issueLimit) {
  const full = String(repoFullName || "").trim();
  if (!full) return [];
  const parts = full.split("/").map((x) => encodeURIComponent(String(x || "").trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return [];
  const perPage = Math.max(1, Math.min(Number(issueLimit) || 12, 40));
  const url =
    `${BASE}/repos/${parts[0]}/${parts[1]}/issues` +
    `?state=all&sort=comments&direction=desc&per_page=${perPage}`;
  try {
    const data = await runJson(url);
    const rows = Array.isArray(data) ? data : [];
    return rows.filter((x) => !x?.pull_request);
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return [];
  }
}

/**
 * Returns raw GitHub evidence rows:
 *   { type: "readme"|"issue", content, url, repo, stars, forks, isOfficial }
 */
export async function fetchGithub(
  title,
  arxivId,
  authors = [],
  { repoLimit = 6, issueLimit = 12, doi = "", paperUrls = [] } = {}
) {
  const terms = buildSearchTerms(title, arxivId, doi);
  if (!terms.length) return [];

  const normalizedPaperUrls = [...new Set((Array.isArray(paperUrls) ? paperUrls : []).map((x) => String(x || "").trim()))]
    .filter(Boolean)
    .slice(0, 8);

  const wantedRepos = Math.max(1, Number(repoLimit) || 6);
  const maxReadmeFetches = Math.max(2, Math.min(Number(process.env.GITHUB_MAX_README_FETCHES || 8), 40));
  const minStarsForReadme = Math.max(0, Number(process.env.GITHUB_MIN_STARS_FOR_README || 50));
  const repos = await searchRepos(terms, wantedRepos);
  const initialRanked = repos
    .map((repo) => ({
      repo,
      score: scoreRepoRelevance(repo, { title, arxivId, doi, paperUrls: normalizedPaperUrls, authors, readme: "" }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(4, wantedRepos * 3));

  const readmeContents = await Promise.all(
    initialRanked.map(async ({ repo }, idx) => {
      const surface = `${repo?.full_name || ""}\n${repo?.description || ""}\n${repo?.homepage || ""}`;
      const stars = Number(repo?.stargazers_count || 0);
      const shouldFetchReadme =
        idx < maxReadmeFetches &&
        (idx < 3 ||
          stars >= minStarsForReadme ||
          hasArxivMention(surface, arxivId) ||
          hasArxivLink(surface, arxivId));
      return shouldFetchReadme ? await fetchRepoReadme(repo?.full_name) : "";
    })
  );

  const scoredRepos = [];
  for (let idx = 0; idx < initialRanked.length; idx += 1) {
    const item = initialRanked[idx];
    const repo = item.repo;
    const readme = readmeContents[idx] || "";
    const surface = `${repo?.full_name || ""}\n${repo?.description || ""}\n${repo?.homepage || ""}`;
    const joined = `${surface}\n${readme || ""}`;
    const strongTitleSignal = hasStrongTitleSignal(repo, title, readme);
    const hasPaperUrlAny = hasAnyUrlSignal(joined, normalizedPaperUrls);
    const hasDoiAny = hasDoiMention(joined, doi);
    if (baseArxivId(arxivId) && !hasArxivMention(joined, arxivId) && !strongTitleSignal && !hasPaperUrlAny && !hasDoiAny) {
      continue;
    }
    const hasArxivSurfaceSignal =
      hasArxivMention(surface, arxivId) ||
      hasArxivLink(surface, arxivId) ||
      hasDoiMention(surface, doi) ||
      hasAnyUrlSignal(surface, normalizedPaperUrls);
    const aggregator = isLikelyAggregatorRepo(repo, readme);
    if (aggregator) continue;
    const titleSurfaceHits = titleKeywordHitCount(surface, title);
    const repoNameTitleHits = titleKeywordHitCount(repo?.name || "", title);
    const aliasSignal = hasTitleAliasSignal(repo, title, readme);
    const hasArxivInReadme =
      hasArxivMention(readme, arxivId) ||
      hasArxivLink(readme, arxivId) ||
      hasDoiMention(readme, doi) ||
      hasAnyUrlSignal(readme, normalizedPaperUrls);
    const official = isOfficialRepo(repo, authors, arxivId, title, {
      readme,
      doi,
      paperUrls: normalizedPaperUrls,
    });

    const relevanceScore = scoreRepoRelevance(repo, {
      title,
      arxivId,
      doi,
      paperUrls: normalizedPaperUrls,
      authors,
      readme,
    });
    const base = mapRepoAsModel(repo, { relevanceScore, isOfficial: official });
    if (readme) {
      base.content = `${base.content}\nREADME: ${readme}`;
    }
    if (baseArxivId(arxivId) && !base.isOfficial) {
      const keepUnofficial =
        hasArxivSurfaceSignal ||
        (hasArxivInReadme && aliasSignal && repoNameTitleHits >= 1 && (strongTitleSignal || titleSurfaceHits >= 2));
      if (!keepUnofficial) continue;
    }
    scoredRepos.push({
      base,
      repo,
      relevanceScore,
      isOfficial: base.isOfficial,
      hasArxivSurfaceSignal,
      hasArxivInReadme,
      aliasSignal,
      repoNameTitleHits,
    });
  }

  // Backfill one likely official repo in arXiv mode when strict author-match rules produce zero official hits.
  if (baseArxivId(arxivId) && !scoredRepos.some((x) => x.isOfficial)) {
    const fallbacks = scoredRepos
      .filter((x) => (x.hasArxivSurfaceSignal || x.hasArxivInReadme) && x.aliasSignal && x.repoNameTitleHits >= 1)
      .sort(
        (a, b) =>
          repoAliasNameScore(b?.repo, title) - repoAliasNameScore(a?.repo, title) ||
          Number(b?.repo?.stargazers_count || 0) - Number(a?.repo?.stargazers_count || 0)
          || b.relevanceScore - a.relevanceScore
      );
    const winner = String(fallbacks[0]?.repo?.full_name || "").toLowerCase();
    if (winner) {
      for (const row of scoredRepos) {
        if (String(row?.repo?.full_name || "").toLowerCase() === winner) {
          row.isOfficial = true;
          row.base.isOfficial = true;
        }
      }
    }
  }

  scoredRepos.sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial) || b.relevanceScore - a.relevanceScore);
  const minRelevantScore = Number(process.env.GITHUB_MIN_RELEVANCE_SCORE || 95);
  let relevantRepos = scoredRepos.filter((x) => x.relevanceScore >= minRelevantScore);
  if (!relevantRepos.length) {
    // No confident matches -> avoid returning random repos.
    return [];
  }
  const officialRepos = relevantRepos.filter((x) => x.isOfficial);
  if (officialRepos.length) {
    const unofficial = relevantRepos.filter((x) => !x.isOfficial && x.hasArxivSurfaceSignal);
    relevantRepos = [...officialRepos, ...unofficial];
  }
  relevantRepos = relevantRepos.slice(0, wantedRepos);

  const readmeRows = relevantRepos.map((x) => x.base);
  const issueRows = [];
  const wantedIssues = Math.max(1, Number(issueLimit) || 12);
  const perRepoIssueLimit = Math.max(1, Math.min(5, wantedIssues));
  const maxIssueRepos = Math.max(1, Math.min(Number(process.env.GITHUB_MAX_ISSUE_REPOS || 2), 6));
  const recentIssueWindowDays = Math.max(0, Number(process.env.GITHUB_ISSUE_RECENT_DAYS || 180));

  const issueCandidates = relevantRepos
    .filter((x) => x.isOfficial || x.relevanceScore >= minRelevantScore + 15)
    .filter((x) => {
      if (!recentIssueWindowDays) return true;
      const updated = Date.parse(x?.repo?.updated_at || "");
      if (!Number.isFinite(updated)) return true;
      return Date.now() - updated <= recentIssueWindowDays * 24 * 60 * 60 * 1000;
    })
    .slice(0, Math.min(maxIssueRepos, relevantRepos.length));

  const issueResults = await Promise.all(
    issueCandidates.map((item) => fetchRepoIssues(item.repo?.full_name, perRepoIssueLimit))
  );

  for (let i = 0; i < issueCandidates.length; i += 1) {
    const item = issueCandidates[i];
    const issues = Array.isArray(issueResults[i]) ? issueResults[i] : [];
    for (const issue of issues) {
      issueRows.push(
        mapIssue(issue, item.repo || null, title, arxivId, authors, {
          relevanceScore: item.relevanceScore,
          isOfficial: item.isOfficial,
          doi,
          paperUrls: normalizedPaperUrls,
        })
      );
      if (issueRows.length >= wantedIssues) break;
    }
    if (issueRows.length >= wantedIssues) break;
  }

  return dedupe([...readmeRows, ...issueRows]);
}
