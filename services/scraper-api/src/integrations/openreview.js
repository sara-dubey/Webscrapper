import { fetchJsonRetry } from "../http.js";
import { makeLimiter } from "../middleware/rateLimit.js";
import { assertProviderQuota } from "./providerQuota.js";

const BASE = String(process.env.OPENREVIEW_BASE_URL || "https://api2.openreview.net").replace(/\/+$/, "");
const BASE_V1 = String(process.env.OPENREVIEW_BASE_URL_V1 || "https://api.openreview.net").replace(/\/+$/, "");

const limiter = makeLimiter({
  minIntervalMs: Number(process.env.OPENREVIEW_MIN_INTERVAL_MS || 2000),
  maxConcurrency: Number(process.env.OPENREVIEW_MAX_CONCURRENCY || 1),
  maxBackoffMs: Number(process.env.OPENREVIEW_MAX_BACKOFF_MS || 60_000),
});

const HEADERS = {
  accept: "application/json",
  "user-agent":
    process.env.OPENREVIEW_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
};

const QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "on",
  "in",
  "to",
  "with",
  "using",
  "via",
  "by",
]);

function cleanText(value, max = 7000) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, Math.max(0, max - 18))} ...[truncated]` : s;
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(query, candidate) {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (q.includes(c) || c.includes(q)) return 0.95;

  const qa = new Set(q.split(" ").filter(Boolean));
  const ca = new Set(c.split(" ").filter(Boolean));
  if (!qa.size || !ca.size) return 0;
  let inter = 0;
  for (const tok of qa) if (ca.has(tok)) inter += 1;
  return inter / (qa.size + ca.size - inter);
}

function buildSearchTerm(title) {
  const raw = cleanText(title, 260);
  if (!raw) return "";

  const normalized = normalizeTitle(raw);
  const words = normalized.split(" ").filter(Boolean);
  if (words.length <= 8) return raw;

  const distilled = words.filter((w) => w.length >= 4 && !QUERY_STOPWORDS.has(w));
  const picked = distilled.length ? distilled.slice(0, 8) : words.slice(0, 8);
  return picked.join(" ");
}

function isRateLimited(err) {
  const status = Number(err?.status);
  if (status === 429 || status === 403) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate") || msg.includes("too many requests");
}

async function runJson(url) {
  return await limiter.schedule(async () => {
    await assertProviderQuota("openreview");
    return await fetchJsonRetry(url, {
      method: "GET",
      headers: HEADERS,
      timeoutMs: Number(process.env.OPENREVIEW_TIMEOUT_MS || 18_000),
      retries: Number(process.env.OPENREVIEW_RETRIES || 1),
      backoffMs: Number(process.env.OPENREVIEW_BACKOFF_MS || 1000),
      dependency: "openreview",
    });
  });
}

function readNotes(data) {
  if (Array.isArray(data?.notes)) return data.notes;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.notes)) return data.data.notes;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function readValue(v) {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v) && v.length) return readValue(v[0]);
  if (typeof v === "object") {
    if (typeof v.value === "string" || typeof v.value === "number") return v.value;
    if (Array.isArray(v.values) && v.values.length) return readValue(v.values[0]);
    if (Array.isArray(v.value) && v.value.length) return readValue(v.value[0]);
  }
  return null;
}

function invitationText(note) {
  const single = String(note?.invitation || "").trim();
  const many = Array.isArray(note?.invitations)
    ? note.invitations.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  return [single, ...many].filter(Boolean).join(" ").toLowerCase();
}

function inferType(note) {
  const invitation = invitationText(note);
  const content = note?.content && typeof note.content === "object" ? note.content : {};

  const hasReviewSignals = [
    "rating",
    "confidence",
    "summary",
    "main_review",
    "strengths",
    "weaknesses",
    "questions",
    "soundness",
    "presentation",
    "contribution",
  ].some((k) => content[k] != null);

  const hasCommentSignals = content.comment != null || content.details != null;

  if (
    invitation.includes("official_review") ||
    invitation.includes("meta_review") ||
    invitation.includes("metareview") ||
    invitation.includes("ethics_review") ||
    invitation.includes("decision") ||
    invitation.includes("review")
  ) {
    return "review";
  }
  if (invitation.includes("comment")) return "comment";
  if (hasReviewSignals) return "review";
  if (hasCommentSignals) return "comment";
  if (note?.replyto) return "comment";
  return null;
}

function parseMaybeNumber(value) {
  if (value == null) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const m = String(value).match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function noteUrl(note) {
  const forumId = String(note?.forum || note?.id || "").trim();
  if (!forumId) return null;
  return `https://openreview.net/forum?id=${encodeURIComponent(forumId)}`;
}

function noteTitle(note) {
  return cleanText(readValue(note?.content?.title) || note?.title || "", 280);
}

function noteEpochMs(note) {
  const n = Number(note?.tmdate || note?.mdate || note?.tcdate || note?.cdate);
  return Number.isFinite(n) ? n : 0;
}

function normalizePerson(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toLastNameSet(values) {
  const set = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const parts = normalizePerson(raw).split(" ").filter(Boolean);
    if (!parts.length) continue;
    set.add(parts[parts.length - 1]);
  }
  return set;
}

function authorOverlapScore(expectedAuthors, noteAuthors) {
  const expected = toLastNameSet(expectedAuthors);
  const candidate = toLastNameSet(noteAuthors);
  if (!expected.size || !candidate.size) return 0;
  let matches = 0;
  for (const ln of expected) if (candidate.has(ln)) matches += 1;
  return matches / expected.size;
}

function toAuthorList(note) {
  const raw = readValue(note?.content?.authors) || note?.content?.authors || note?.authors;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(readValue(x) || x || "").trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(/,| and /i)
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  }
  return [];
}

function extractArxivIdLoose(value) {
  const s = String(value || "");
  const m = s.match(/\b\d{4}\.\d{4,5}(v\d+)?\b/i);
  return m ? m[0].toLowerCase().replace(/v\d+$/i, "") : "";
}

function noteHasArxivId(note, arxivId) {
  const base = extractArxivIdLoose(arxivId);
  if (!base) return false;
  const hay = JSON.stringify(note?.content || {}).toLowerCase();
  return hay.includes(base);
}

function normalizeForumId(note) {
  return String(note?.forum || note?.id || "").trim();
}

function isSubmissionLike(note) {
  const invitation = invitationText(note);
  if (!invitation) return false;
  return invitation.includes("submission");
}

function scoreRootNote(note, queryTitle) {
  const sim = titleSimilarity(queryTitle, noteTitle(note));
  let score = sim * 100;
  const invitation = invitationText(note);

  if (invitation.includes("submission")) score += 6;
  if (invitation.includes("blind_submission")) score += 4;
  if (invitation.includes("review")) score += 4;

  const ms = noteEpochMs(note);
  if (ms > 0) score += Math.min(7, (ms - 1_550_000_000_000) / 100_000_000_000);

  return score;
}

function dedupeRawNotes(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(
      row?.id ||
        `${row?.forum || ""}|${row?.invitation || ""}|${row?.replyto || ""}|${noteTitle(row)}`
    ).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function mapNote(note) {
  const type = inferType(note);
  if (!type) return null;

  const ratingText = readValue(note?.content?.rating);
  const confidenceText = readValue(note?.content?.confidence);
  const rating = parseMaybeNumber(ratingText);
  const confidence = parseMaybeNumber(confidenceText);
  const summary = readValue(note?.content?.summary) || readValue(note?.content?.main_review) || "";
  const strengths = readValue(note?.content?.strengths) || "";
  const weaknesses = readValue(note?.content?.weaknesses) || "";
  const questions = readValue(note?.content?.questions) || "";
  const comment = readValue(note?.content?.comment) || "";
  const details = readValue(note?.content?.details) || "";
  const decision = readValue(note?.content?.decision) || "";
  const soundness = readValue(note?.content?.soundness) || "";
  const presentation = readValue(note?.content?.presentation) || "";
  const contribution = readValue(note?.content?.contribution) || "";
  const title = readValue(note?.content?.title) || "";
  const bodyFields =
    type === "review"
      ? [summary, strengths, weaknesses, questions, decision]
      : [comment, details];
  const body = bodyFields
    .map((x) => cleanText(x, 1600))
    .filter(Boolean)
    .join("\n");

  return {
    source: "openreview",
    noteId: String(note?.id || "").trim() || null,
    forum: String(note?.forum || "").trim() || null,
    parentNoteId: String(note?.replyto || "").trim() || null,
    invitation: String(note?.invitation || "").trim() || null,
    type,
    title: cleanText(title, 400) || null,
    summary: cleanText(summary, 7000) || null,
    strengths: cleanText(strengths, 7000) || null,
    weaknesses: cleanText(weaknesses, 7000) || null,
    questions: cleanText(questions, 7000) || null,
    comment: cleanText(comment, 7000) || null,
    details: cleanText(details, 7000) || null,
    decision: cleanText(decision, 2000) || null,
    soundness: cleanText(soundness, 1200) || null,
    presentation: cleanText(presentation, 1200) || null,
    contribution: cleanText(contribution, 1200) || null,
    content: cleanText([title ? `Title: ${title}` : "", body].filter(Boolean).join("\n"), 7000) || null,
    url: noteUrl(note),
    rating,
    confidence,
    ratingText: ratingText == null ? null : String(ratingText),
    confidenceText: confidenceText == null ? null : String(confidenceText),
    readers: Array.isArray(note?.readers) ? note.readers : null,
    signatures: Array.isArray(note?.signatures) ? note.signatures : null,
    rawContent: note?.content && typeof note.content === "object" ? note.content : null,
    created_at: Number.isFinite(Number(note?.tcdate || note?.cdate))
      ? new Date(Number(note.tcdate || note.cdate)).toISOString()
      : null,
    updated_at: Number.isFinite(Number(note?.tmdate || note?.mdate))
      ? new Date(Number(note.tmdate || note.mdate)).toISOString()
      : null,
  };
}

async function searchNotes(title, limit) {
  const fromV2 = await searchNotesOnBase(BASE, title, limit);
  if (fromV2.length) return dedupeRawNotes(fromV2);

  // Fallback to v1 only when v2 returns no candidates.
  const fromV1 = await searchNotesOnBase(BASE_V1, title, limit);
  return dedupeRawNotes(fromV1);
}

async function searchNotesOnBase(baseUrl, title, limit) {
  const searchTerm = buildSearchTerm(title);
  if (!searchTerm) return [];
  const q = encodeURIComponent(searchTerm);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 40));
  const url = `${baseUrl}/notes/search?term=${q}&limit=${safeLimit}`;
  try {
    const data = await runJson(url);
    const notes = readNotes(data);
    if (notes.length) {
      return dedupeRawNotes(
        notes.map((note) => ({
          ...note,
          _sourceBase: baseUrl,
        }))
      );
    }
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
  }
  return [];
}

async function fetchForumNotesAny(forumId, limit) {
  const v2 = await fetchForumNotesOnBase(BASE, forumId, limit);
  if (v2.length) return v2;
  return await fetchForumNotesOnBase(BASE_V1, forumId, limit);
}

async function fetchForumNotesOnBase(baseUrl, forumId, limit) {
  const forum = String(forumId || "").trim();
  if (!forum) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  const url = `${baseUrl}/notes?forum=${encodeURIComponent(forum)}&limit=${safeLimit}`;
  try {
    const data = await runJson(url);
    return dedupeRawNotes(
      readNotes(data).map((note) => ({
        ...note,
        _sourceBase: baseUrl,
      }))
    );
  } catch (err) {
    if (isRateLimited(err)) limiter.onRateLimited();
    return [];
  }
}

function dedupe(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const key = String(row?.noteId || `${row?.url || ""}|${row?.content || ""}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function normalizeOpenReviewField(value, maxLen = 500) {
  const s = cleanText(readValue(value) || value || "", maxLen).trim();
  return s || null;
}

function isOpenReviewAcceptedVenue({ venue, venueId, decision }) {
  const v = String(venue || "").toLowerCase().trim();
  const vid = String(venueId || "").toLowerCase().trim();
  const d = String(decision || "").toLowerCase().trim();
  const phrase = v.replace(/[^a-z0-9]+/g, " ").trim();
  const compact = v.replace(/[^a-z0-9]/g, "");

  if (!v && !vid && !d) return false;

  if (
    compact === "corr" ||
    compact.includes("computingresearchrepository") ||
    /\bcorr\b/.test(phrase)
  ) {
    return false;
  }
  if (vid.includes("rejected_submission") || vid.includes("withdrawn_submission")) return false;
  if (v.includes("submitted to") || v.includes("withdrawn") || v.includes("rejected")) return false;
  if (d && d.includes("reject") && !d.includes("accept")) return false;

  if (d.includes("accept")) return true;
  if (v.includes(" poster") || v.includes(" oral") || v.includes(" spotlight")) return true;
  if (vid.includes("/conference") || vid.includes("/journal")) return true;

  return false;
}

function selectVerifiedCandidates(rows, title, authors = [], arxivId = null) {
  const q = cleanText(title, 220);
  const minTitleScore = Number(process.env.OPENREVIEW_MIN_TITLE_SCORE || 0.68);
  const exactTitleThreshold = Number(process.env.OPENREVIEW_EXACT_TITLE_SCORE || 0.96);
  const minAuthorOverlap = Number(process.env.OPENREVIEW_MIN_AUTHOR_OVERLAP || 0.25);

  const scored = (Array.isArray(rows) ? rows : [])
    .map((note) => {
      const noteAuthors = toAuthorList(note);
      const sim = titleSimilarity(q, noteTitle(note));
      const titleExact = sim >= exactTitleThreshold || normalizeTitle(q) === normalizeTitle(noteTitle(note));
      const authorOverlap = authorOverlapScore(authors, noteAuthors);
      const arxivMatched = noteHasArxivId(note, arxivId);
      const verified =
        arxivMatched ||
        (titleExact && (!authors?.length || !noteAuthors.length || authorOverlap >= minAuthorOverlap)) ||
        (sim >= minTitleScore && authorOverlap >= minAuthorOverlap);
      return {
        note,
        forumId: normalizeForumId(note),
        title: noteTitle(note),
        sim,
        score: scoreRootNote(note, q),
        noteAuthors,
        authorOverlap,
        titleExact,
        arxivMatched,
        verified,
        sourceBase: String(note?._sourceBase || BASE).trim() || BASE,
      };
    })
    .filter((x) => x.forumId)
    .sort((a, b) => b.score - a.score);

  return scored.filter((x) => x.verified);
}

/**
 * Returns OpenReview evidence rows:
 *   { type: "review"|"comment", content, url, rating, confidence }
 */
export async function fetchOpenReview(title, { limit = 20, forumId = null, authors = [], arxivId = null } = {}) {
  const q = cleanText(title, 220);
  const forcedForum = String(forumId || "").trim();
  if (!q && !forcedForum) return [];

  const forumLimit = Math.max(20, Math.min(Number(process.env.OPENREVIEW_FORUM_LIMIT || 200), 500));
  if (forcedForum) {
    const forumNotes = await fetchForumNotesAny(forcedForum, forumLimit);
    const mapped = forumNotes.map(mapNote).filter((x) => x?.content);
    const comments = mapped.filter((x) => x.type === "comment");
    const prioritized = comments.length ? [...comments, ...mapped.filter((x) => x.type !== "comment")] : mapped;
    const maxRows = Math.max(10, Math.min(Number(process.env.OPENREVIEW_MAX_ROWS || 120), 300));
    return dedupe(prioritized).slice(0, maxRows);
  }

  // Call 1: find best matching paper/forum.
  const searchNotesLimit = Math.max(5, Number(limit) || 20);
  const found = await searchNotes(q, searchNotesLimit);
  if (!found.length) return [];

  const verified = selectVerifiedCandidates(found, q, authors, arxivId);
  const primary = verified.find((x) => isSubmissionLike(x.note)) || verified[0] || null;
  if (!primary) return [];

  // Call 2: load the full forum thread (reviews/comments/replies).
  const forumNotes = await fetchForumNotesOnBase(primary.sourceBase, primary.forumId, forumLimit);
  const mapped = forumNotes.map(mapNote).filter((x) => x?.content);

  const comments = mapped.filter((x) => x.type === "comment");
  const prioritized = comments.length ? [...comments, ...mapped.filter((x) => x.type !== "comment")] : mapped;
  const maxRows = Math.max(10, Math.min(Number(process.env.OPENREVIEW_MAX_ROWS || 120), 300));
  return dedupe(prioritized).slice(0, maxRows);
}

/**
 * Lightweight publication signal lookup from OpenReview search notes.
 * Single call: /notes/search
 */
export async function fetchOpenReviewPublicationByTitle(title, { limit = 20, authors = [], arxivId = null } = {}) {
  const q = cleanText(title, 220);
  if (!q) return null;

  const searchNotesLimit = Math.max(5, Math.min(Number(limit) || 20, 50));
  const found = await searchNotes(q, searchNotesLimit);
  if (!found.length) return null;

  const verified = selectVerifiedCandidates(found, q, authors, arxivId).map((row) => {
      const note = row.note;
      const venue = normalizeOpenReviewField(note?.content?.venue, 300);
      const venueId = normalizeOpenReviewField(note?.content?.venueid, 300);
      const decision = normalizeOpenReviewField(note?.content?.decision, 800);
      return {
        ...row,
        venue,
        venueId,
        decision,
        isPublished: isOpenReviewAcceptedVenue({ venue, venueId, decision }),
      };
    });

  const accepted = verified.find((x) => x.isPublished) || null;
  const primary = accepted || verified[0] || null;
  if (!primary) return null;

  // Decision/venue are often on thread notes, not root search row.
  let venue = primary.venue || null;
  let venueId = primary.venueId || null;
  let decision = primary.decision || null;
  if (!decision || !venue) {
    const thread = await fetchForumNotesOnBase(primary.sourceBase, primary.forumId, 120);
    for (const note of thread) {
      venue = venue || normalizeOpenReviewField(note?.content?.venue, 300);
      venueId = venueId || normalizeOpenReviewField(note?.content?.venueid, 300);
      decision = decision || normalizeOpenReviewField(note?.content?.decision, 800);
      if (venue && venueId && decision) break;
    }
  }
  const isPublished = isOpenReviewAcceptedVenue({ venue, venueId, decision });

  return {
    isPublished: Boolean(isPublished),
    title: primary.title || null,
    forumId: primary.forumId || null,
    forumUrl: primary.forumId ? `https://openreview.net/forum?id=${encodeURIComponent(primary.forumId)}` : null,
    venue: venue || null,
    venueId: venueId || null,
    decision: decision || null,
    similarity: Number.isFinite(Number(primary.sim)) ? Number(primary.sim) : null,
    score: Number.isFinite(Number(primary.score)) ? Number(primary.score) : null,
  };
}
