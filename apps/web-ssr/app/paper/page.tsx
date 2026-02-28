"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import {
  clearToken,
  createHighlight,
  deleteHighlight,
  getPaperNote,
  getSearch,
  listHighlights,
  listSearches,
  me,
  ragAsk,
  ragReindex,
  runPaper,
  savePaperNote,
} from "../lib/api.js";
import { useRouter } from "next/navigation";
import MiraLogo from "../components/MiraLogo";

function clampText(s: string, max = 220) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim() + "...";
}

function isEditableTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
}

function fmtDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

type SourceLogoKind =
  | "openreview"
  | "huggingface"
  | "arxiv"
  | "reddit"
  | "semantic"
  | "github"
  | "pdf"
  | "external";

function SourceLogo({ kind }: { kind: SourceLogoKind }) {
  if (kind === "openreview") {
    return (
      <span className="sourceLogo sourceLogoOpenreview" aria-label="OpenReview">
        <span className="sourceLogoOpenreviewBold">OpenReview</span>
        <span className="sourceLogoOpenreviewLight">.net</span>
      </span>
    );
  }

  if (kind === "huggingface") {
    return (
      <span className="sourceLogo sourceLogoHf" aria-label="Hugging Face">
        <span className="sourceLogoHfEmoji">🤗</span>
        <span className="sourceLogoHfText">Hugging Face</span>
      </span>
    );
  }

  if (kind === "arxiv") {
    return (
      <span className="sourceLogo sourceLogoArxiv" aria-label="arXiv">
        <span>ar</span>
        <span className="sourceLogoArxivChi">
          <svg viewBox="0 0 28 28" role="presentation" aria-hidden="true">
            <line x1="4" y1="4" x2="24" y2="24" />
            <line x1="24" y1="4" x2="4" y2="24" />
          </svg>
        </span>
        <span>iv</span>
      </span>
    );
  }

  if (kind === "reddit") {
    return (
      <span className="sourceLogo sourceLogoReddit" aria-label="Reddit">
        reddit
      </span>
    );
  }

  if (kind === "semantic") {
    return (
      <span className="sourceLogo sourceLogoSemantic" aria-label="Semantic Scholar">
        <svg viewBox="0 0 80 80" role="presentation" aria-hidden="true">
          <path d="M15 20 L60 20 L60 65 L15 65 Z" fill="none" stroke="white" strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M10 15 L55 15 L55 60 L10 60 Z" fill="none" stroke="white" strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M5 10 L50 10 L50 55 L5 55 Z" fill="#1a2b52" stroke="white" strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M12 42 L22 52 L45 24" fill="none" stroke="#f0c040" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  if (kind === "github") {
    return (
      <span className="sourceLogo sourceLogoGithub" aria-label="GitHub">
        <svg className="sourceLogoGithubMark" viewBox="0 0 16 16" role="presentation" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
        <span className="sourceLogoGithubText">GitHub</span>
      </span>
    );
  }

  if (kind === "external") {
    return <span className="sourceLogo sourceLogoExternal" aria-label="External link">Link</span>;
  }

  return <span className="sourceLogo sourceLogoPdf" aria-label="PDF">PDF</span>;
}

function sourceKindFromUrl(url: string): SourceLogoKind {
  const u = String(url || "").toLowerCase();
  if (!u) return "external";
  if (u.includes("arxiv.org")) return "arxiv";
  if (u.includes("openreview.net")) return "openreview";
  if (u.includes("huggingface.co")) return "huggingface";
  if (u.includes("github.com")) return "github";
  if (u.includes("reddit.com")) return "reddit";
  if (u.includes("semanticscholar.org")) return "semantic";
  if (u.endsWith(".pdf") || u.includes("/pdf")) return "pdf";
  return "external";
}

function sourceLabelFromKind(kind: SourceLogoKind): string {
  if (kind === "arxiv") return "arXiv page";
  if (kind === "openreview") return "OpenReview";
  if (kind === "huggingface") return "Hugging Face";
  if (kind === "github") return "GitHub";
  if (kind === "reddit") return "Reddit";
  if (kind === "semantic") return "Semantic Scholar";
  if (kind === "pdf") return "Paper PDF";
  return "Paper link";
}

function toPdfUrlFromPaper(paper: any) {
  if (!paper) return "";

  const explicit = String(paper.pdf_url || "").trim();
  if (explicit) return explicit;

  const url = String(paper.url || "").trim();
  if (url.includes("arxiv.org/pdf/")) return url.endsWith(".pdf") ? url : `${url}.pdf`;
  if (url.includes("arxiv.org/abs/")) {
    return url.replace("/abs/", "/pdf/").replace(/^http:\/\//, "https://") + ".pdf";
  }

  const ext = String(paper.externalId || "").trim();
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(ext)) {
    return `https://arxiv.org/pdf/${ext}.pdf`;
  }

  return "";
}

function toPaperIdentity(paper: any, runData: any) {
  const paperId = String(runData?.paper_id || paper?.id || "").trim();
  const source = String(paper?.source || runData?.paper?.source || "arxiv").trim() || "arxiv";
  const externalId = String(
    paper?.externalId ||
      paper?.openreview_forum_id ||
      paper?.openreviewForumId ||
      paper?.semantic_scholar_paper_id ||
      paper?.semanticScholarPaperId ||
      paper?.arxiv_id ||
      ""
  ).trim();

  return {
    paperId,
    source,
    externalId,
  };
}

function toViewerPdfUrl(pdfUrl: string) {
  const clean = String(pdfUrl || "").trim();
  if (!clean) return "";
  return `/api/pdf?url=${encodeURIComponent(clean)}`;
}

function toArxivBaseId(value: any) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const direct = raw.match(/\b\d{4}\.\d{4,5}(v\d+)?\b/i);
  if (!direct) return "";
  return String(direct[0]).replace(/v\d+$/i, "");
}

function normalizeInlineText(value: any) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function formatIntentLabel(value: any) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

function toCleanStringList(value: any, max = 4): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, max);
}

function applyOpenReviewSummaryFallback(summary: any) {
  if (!summary || typeof summary !== "object") return summary;

  const topReviewSummaries = toCleanStringList(summary.topReviewSummaries, 3);
  const topStrengths = toCleanStringList(summary.topStrengths, 3);
  const topWeaknesses = toCleanStringList(summary.topWeaknesses, 3);
  const topComments = toCleanStringList(summary.topComments, 3);
  const decision = String(summary.decision || "").replace(/\s+/g, " ").trim();

  const oneLiner = String(summary.oneLiner || "").replace(/\s+/g, " ").trim();
  const overallAssessment = String(summary.overallAssessment || "").replace(/\s+/g, " ").trim();

  const fallbackOneLiner =
    topReviewSummaries[0] || topStrengths[0] || topComments[0] || topWeaknesses[0] || (decision ? `Decision: ${decision}` : "");

  const fallbackOverallParts: string[] = [];
  if (decision) fallbackOverallParts.push(`Decision: ${decision}.`);
  if (topReviewSummaries[0]) fallbackOverallParts.push(`Review summary: ${topReviewSummaries[0]}`);
  if (topStrengths[0]) fallbackOverallParts.push(`Strength: ${topStrengths[0]}`);
  if (topWeaknesses[0]) fallbackOverallParts.push(`Weakness: ${topWeaknesses[0]}`);
  if (topComments[0]) fallbackOverallParts.push(`Community note: ${topComments[0]}`);

  return {
    ...summary,
    topReviewSummaries,
    topStrengths,
    topWeaknesses,
    topComments,
    oneLiner: oneLiner || clampText(fallbackOneLiner, 260),
    overallAssessment: overallAssessment || clampText(fallbackOverallParts.join(" "), 420),
  };
}

function normalizeOpenReviewSummary(raw: any) {
  if (Array.isArray(raw)) {
    const rows = raw.filter((x) => x && typeof x === "object");
    const reviews = rows.filter((x) => String(x?.type || x?.noteType || "").toLowerCase() === "review");
    const comments = rows.filter((x) => String(x?.type || x?.noteType || "").toLowerCase() !== "review");
    const topComments = comments
      .map((x) => String(x?.comment || x?.details || x?.content || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    const topReviewSummaries = reviews
      .map((x) => String(x?.summary || x?.mainReview || x?.content || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    const topStrengths = reviews
      .map((x) => String(x?.strengths || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    const topWeaknesses = reviews
      .map((x) => String(x?.weaknesses || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    const decision = rows.map((x) => String(x?.decision || "").trim()).find(Boolean) || "";
    const forumUrl = rows.map((x) => String(x?.url || x?.forumUrl || "").trim()).find(Boolean) || "";
    return applyOpenReviewSummaryFallback({
      total: rows.length,
      reviews: reviews.length,
      comments: comments.length,
      decision,
      forumUrl,
      topReviewSummaries,
      topComments,
      topStrengths,
      topWeaknesses,
    });
  }

  if (!raw || typeof raw !== "object") return null;

  if (typeof raw.one_liner === "string" || typeof raw.overall_assessment === "string") {
    const counts = raw?.evidence_counts && typeof raw.evidence_counts === "object" ? raw.evidence_counts : {};
    const topReviewSummaries = toCleanStringList(raw.review_summaries || raw.topReviewSummaries, 3);
    const topComments = toCleanStringList(raw.open_questions || raw.topComments, 3);
    const topStrengths = toCleanStringList(raw.strengths || raw.topStrengths, 3);
    const topWeaknesses = toCleanStringList(raw.weaknesses || raw.topWeaknesses, 3);
    const inferredReviews = Math.max(topReviewSummaries.length, topStrengths.length, topWeaknesses.length);
    const inferredComments = topComments.length;
    const reviews = Number(
      counts.reviews ?? counts.reviews_count ?? counts.reviewCount ?? raw.reviews ?? raw.review_count ?? raw.reviewCount
    );
    const comments = Number(
      counts.comments ?? counts.comments_count ?? counts.commentCount ?? raw.comments ?? raw.comment_count ?? raw.commentCount
    );
    const total = Number(
      counts.total ?? counts.total_count ?? counts.totalCount ?? raw.total ?? raw.total_count ?? raw.totalCount
    );
    const threadSummaryObj = raw?.thread_summary && typeof raw.thread_summary === "object" ? raw.thread_summary : null;
    return applyOpenReviewSummaryFallback({
      total: Number.isFinite(total)
        ? Math.max(0, Math.trunc(total))
        : (Number.isFinite(reviews) ? Math.max(0, Math.trunc(reviews)) : inferredReviews) +
          (Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : inferredComments),
      reviews: Number.isFinite(reviews) ? Math.max(0, Math.trunc(reviews)) : inferredReviews,
      comments: Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : inferredComments,
      decision: String(raw.decision_signal || "").trim(),
      forumUrl: String(raw.forumUrl || raw.url || "").trim(),
      oneLiner: String(raw.one_liner || threadSummaryObj?.one_liner || threadSummaryObj?.summary || "").trim(),
      overallAssessment: String(raw.overall_assessment || threadSummaryObj?.overall_assessment || "").trim(),
      topReviewSummaries,
      topComments,
      topStrengths,
      topWeaknesses,
    });
  }

  const topReviewSummaries = toCleanStringList(raw.topReviewSummaries || raw.review_summaries, 3);
  const topComments = toCleanStringList(raw.topComments || raw.open_questions, 3);
  const topStrengths = toCleanStringList(raw.topStrengths || raw.strengths, 3);
  const topWeaknesses = toCleanStringList(raw.topWeaknesses || raw.weaknesses, 3);
  const inferredReviews = Math.max(topReviewSummaries.length, topStrengths.length, topWeaknesses.length);
  const inferredComments = topComments.length;

  const total = Number(raw.total ?? raw.total_count ?? raw.totalCount);
  const reviews = Number(raw.reviews ?? raw.review_count ?? raw.reviewCount);
  const comments = Number(raw.comments ?? raw.comment_count ?? raw.commentCount);

  const threadSummaryObj = raw?.thread_summary && typeof raw.thread_summary === "object" ? raw.thread_summary : null;
  return applyOpenReviewSummaryFallback({
    total: Number.isFinite(total)
      ? Math.max(0, Math.trunc(total))
      : (Number.isFinite(reviews) ? Math.max(0, Math.trunc(reviews)) : inferredReviews) +
        (Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : inferredComments),
    reviews: Number.isFinite(reviews) ? Math.max(0, Math.trunc(reviews)) : inferredReviews,
    comments: Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : inferredComments,
    decision: String(raw.decision || "").trim(),
    forumUrl: String(raw.forumUrl || raw.url || "").trim(),
    oneLiner: String(raw.oneLiner || raw.one_liner || raw.threadSummary || raw.thread_summary || threadSummaryObj?.one_liner || "").trim(),
    overallAssessment: String(raw.overallAssessment || raw.overall_assessment || raw.assessment || threadSummaryObj?.overall_assessment || "").trim(),
    topReviewSummaries,
    topComments,
    topStrengths,
    topWeaknesses,
  });
}

function toYearFromAny(...values: any[]) {
  for (const value of values) {
    if (value == null) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num >= 1600 && num <= 3000) return Math.trunc(num);

    const text = String(value).trim();
    if (!text) continue;
    const match = text.match(/\b(19|20)\d{2}\b/);
    if (match) {
      const year = Number(match[0]);
      if (Number.isFinite(year) && year >= 1600 && year <= 3000) return year;
    }
  }
  return null;
}

function isPreprintVenueLabel(value: any) {
  const s = String(value || "").toLowerCase().trim();
  if (!s) return false;
  const compact = s.replace(/[^a-z0-9]/g, "");
  const phrase = s.replace(/[^a-z0-9]+/g, " ").trim();
  const isCorr = compact === "corr" || compact.includes("computingresearchrepository") || /\bcorr\b/.test(phrase);
  if (isCorr) return true;
  const directTokens = ["arxiv", "biorxiv", "medrxiv", "chemrxiv", "ssrn", "osf", "hal", "zenodo", "figshare"];
  if (directTokens.some((token) => compact.includes(token))) return true;
  return (
    phrase.includes("preprint") ||
    phrase.includes("research square") ||
    phrase.includes("open science framework")
  );
}

function toPublicationMeta(paper: any) {
  if (!paper || typeof paper !== "object") return null;

  const publication =
    paper?.publication && typeof paper.publication === "object"
      ? paper.publication
      : paper?.originSource?.publication && typeof paper.originSource.publication === "object"
        ? paper.originSource.publication
        : null;

  const statusRaw = String(publication?.status || "").trim().toLowerCase();
  let status: "published" | "preprint" | "unknown" = "unknown";
  if (statusRaw === "published") status = "published";
  else if (statusRaw === "preprint") status = "preprint";
  else if (String(paper?.url || "").includes("arxiv.org")) status = "preprint";

  const venue = clampText(
    publication?.venue ||
      publication?.journal ||
      publication?.publicationVenue ||
      publication?.openreview?.venue ||
      "",
    120
  );
  if (isPreprintVenueLabel(venue)) {
    status = "preprint";
  }
  const year = toYearFromAny(paper?.year, publication?.publishedAt, publication?.checkedAt, venue);

  return {
    status,
    statusLabel: status === "published" ? "Published" : status === "preprint" ? "Preprint" : "Unknown",
    venue,
    year,
  };
}

type UserQuotaState = {
  kind: string;
  limit: number;
  remaining: number;
  count: number | null;
  resetAt: string | null;
  resetIn: string | null;
};

function toQuotaState(raw: any): UserQuotaState | null {
  if (!raw || typeof raw !== "object") return null;

  const kind = String(raw.kind || "").trim();
  const limit = Number(raw.limit);
  const remaining = Number(raw.remaining);
  const count = Number(raw.count);
  const resetAtRaw = raw.resetAt ?? raw.reset_at ?? null;
  const resetInRaw = raw.resetIn ?? raw.reset_in ?? null;

  if (!kind || !Number.isFinite(limit) || !Number.isFinite(remaining)) return null;

  return {
    kind,
    limit: Math.max(0, Math.trunc(limit)),
    remaining: Math.max(0, Math.trunc(remaining)),
    count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null,
    resetAt: resetAtRaw ? String(resetAtRaw) : null,
    resetIn: resetInRaw ? String(resetInRaw) : null,
  };
}

function toQuotaRemainingLabel(quota: UserQuotaState | null, fallback = "--") {
  if (!quota) return fallback;
  return `${quota.remaining}/${quota.limit} left`;
}

type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  isError?: boolean;
  chunks?: any[];
  info?: string;
  intent?: string;
  confidence?: number | null;
  conflictsDetected?: any[];
  audit?: any;
};

type LilyThread = {
  id: string;
  title: string;
  createdAt: number;
  searchId: string;
  messages: AssistantMessage[];
};

function makeChatId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeThreadId() {
  return `thread-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function initialAssistantMessage(): AssistantMessage {
  return {
    id: makeChatId(),
    role: "assistant",
    text: "Hi, I am your AI Assistant. Run or open a paper, then ask me anything about contributions, methods, limitations, or implementation.",
  };
}

function makeLilyThread(title = "New thread", searchId = ""): LilyThread {
  return {
    id: makeThreadId(),
    title,
    createdAt: Date.now(),
    searchId,
    messages: [initialAssistantMessage()],
  };
}

const INITIAL_LILY_THREAD = makeLilyThread("Thread 1");

const HISTORY_MAX_ITEMS = 25;

function toQuotedQuestion(quote: string, note = "") {
  const cleanQuote = String(quote || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  const cleanNote = String(note || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const noteLine = cleanNote ? `\nMy note: ${cleanNote}` : "";
  return `Explain this quoted passage from the paper and relate it to the main contribution.\nQuote: "${cleanQuote}"${noteLine}`;
}

function toFriendlyNoteError(err: any) {
  const msg = String(err?.message || err || "").trim();
  if (msg.includes("Cannot PUT /api/notes") || msg.includes("Cannot GET /api/notes")) {
    return "Notes API not available. Restart scraper-api server and try again.";
  }
  return msg || "Could not save note.";
}

function normalizeNovelty(value: any): string[] {
  const toClean = (arr: any[]) =>
    arr
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 12);

  if (Array.isArray(value)) return toClean(value);

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return toClean(parsed);
    } catch {
      // no-op
    }
    return toClean(
      raw
        .split(/\n+/)
        .map((line) => line.replace(/^[\s\-*0-9.)]+/, "").trim())
        .filter(Boolean)
    );
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value.keyPoints)) return toClean(value.keyPoints);
    if (Array.isArray(value.novelty)) return toClean(value.novelty);
    if (Array.isArray(value.items)) return toClean(value.items);
  }

  return [];
}

type RunErrorView = {
  title: string;
  detail: string;
};

function classifyRunError(raw: string): RunErrorView {
  const msg = String(raw || "").trim();
  const lower = msg.toLowerCase();

  if (
    lower.includes("not found") ||
    lower.includes("no paper") ||
    lower.includes("no result") ||
    lower.includes("could not find")
  ) {
    return {
      title: "Paper not found",
      detail: "No matching paper was returned. Try an arXiv id or broader keywords, then retry.",
    };
  }

  if (
    lower.includes("arxiv") &&
    (lower.includes("down") ||
      lower.includes("unavailable") ||
      lower.includes("rate") ||
      lower.includes("429") ||
      lower.includes("503") ||
      lower.includes("timeout"))
  ) {
    return {
      title: "arXiv down",
      detail: "The arXiv provider is temporarily unavailable. Wait a moment, then retry.",
    };
  }

  if (
    lower.includes("backend") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("cannot connect") ||
    lower.includes("service unavailable")
  ) {
    return {
      title: "Backend unavailable",
      detail: "The API is not reachable right now. Confirm services are running, then retry.",
    };
  }

  return {
    title: "Request failed",
    detail: msg || "The request failed. Please retry.",
  };
}

function EmptyStateCard({
  title,
  detail,
  onRunSearch,
}: {
  title: string;
  detail: string;
  onRunSearch: () => void;
}) {
  return (
    <div className="stateCard">
      <div className="stateCardTitle">{title}</div>
      <div className="stateCardText">{detail}</div>
      <button className="btn btnTiny stateCardBtn" onClick={onRunSearch}>
        Run a search
      </button>
    </div>
  );
}

function ErrorStateCard({
  title,
  detail,
  message,
  onRetry,
}: {
  title: string;
  detail: string;
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="stateCard stateCardError">
      <div className="stateCardTitle">{title}</div>
      <div className="stateCardText">{detail}</div>
      {message ? <div className="stateCardMeta">{message}</div> : null}
      <button className="btn btnTiny stateCardBtn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function SkeletonBlock({ width = "100%", height = 12 }: { width?: string; height?: number }) {
  return <div className="skeletonBlock" style={{ width, height }} aria-hidden="true" />;
}

function SkeletonLines({ rows = 3 }: { rows?: number }) {
  const widths = ["96%", "88%", "93%", "78%", "84%"];
  return (
    <div className="skeletonStack">
      {Array.from({ length: rows }).map((_, idx) => (
        <SkeletonBlock key={idx} width={widths[idx % widths.length]} />
      ))}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="historySkeletonList" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, idx) => (
        <div key={idx} className="historySkeletonRow">
          <SkeletonBlock width={`${90 - (idx % 3) * 8}%`} height={12} />
          <SkeletonBlock width="42%" height={10} />
        </div>
      ))}
    </div>
  );
}

function PdfJsViewer({
  pdfUrl,
  onSelectQuote,
  onDocumentInfo,
  compact = false,
  className = "",
}: {
  pdfUrl: string;
  onSelectQuote?: (quote: string, pageNumber: number) => void;
  onDocumentInfo?: (info: { numPages: number }) => void;
  compact?: boolean;
  className?: string;
}) {
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pdfLoadErr, setPdfLoadErr] = useState("");
  const [pdfRenderErr, setPdfRenderErr] = useState("");
  const [pdfComponents, setPdfComponents] = useState<{ Document: any; Page: any } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const docWrapRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState<number>(720);

  useEffect(() => {
    setNumPages(0);
    setPageNumber(1);
    setPdfRenderErr("");
  }, [pdfUrl]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.body.style.setProperty("--react-pdf-text-layer", "1");
      document.body.style.setProperty("--react-pdf-annotation-layer", "1");
    }

    let cancelled = false;

    async function loadPdfModule() {
      try {
        const mod = await import("react-pdf");
        mod.pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        if (cancelled) return;
        setPdfLoadErr("");
        setPdfComponents({ Document: mod.Document, Page: mod.Page });
      } catch (e: any) {
        if (cancelled) return;
        setPdfLoadErr(e?.message || "Could not initialize PDF viewer.");
      }
    }

    void loadPdfModule();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = docWrapRef.current;
    if (!el || typeof window === "undefined") return;

    const updateWidth = () => {
      const style = window.getComputedStyle(el);
      const left = Number.parseFloat(style.paddingLeft || "0") || 0;
      const right = Number.parseFloat(style.paddingRight || "0") || 0;
      const next = Math.max(240, Math.floor(el.clientWidth - left - right));
      setPageWidth(next);
    };

    updateWidth();
    let ro: ResizeObserver | null = null;

    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(updateWidth);
      ro.observe(el);
    }

    window.addEventListener("resize", updateWidth);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, []);

  const safePage = Math.min(Math.max(pageNumber, 1), Math.max(numPages, 1));
  const DocumentCmp = pdfComponents?.Document;
  const PageCmp = pdfComponents?.Page;

  function handleSelectQuote() {
    if (!onSelectQuote) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection
      .toString()
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 6) return;

    const anchorNode = selection.anchorNode;
    const anchorEl =
      anchorNode instanceof Element
        ? anchorNode
        : anchorNode && "parentElement" in anchorNode
          ? anchorNode.parentElement
          : null;
    if (!anchorEl || !wrapRef.current?.contains(anchorEl)) return;

    const pageEl = anchorEl.closest("[data-page-number]");
    const pageAttr = Number(pageEl?.getAttribute("data-page-number") || "");
    const selectedPage = Number.isFinite(pageAttr) && pageAttr > 0 ? pageAttr : safePage;

    onSelectQuote(text, selectedPage);

    // Clear native PDF text-layer selection to avoid persistent blocky overlays.
    setTimeout(() => {
      try {
        selection.removeAllRanges();
      } catch {
        // no-op
      }
    }, 0);
  }

  return (
    <div className={`pdfJsViewer ${compact ? "pdfJsViewerCompact" : ""} ${className}`} ref={wrapRef} onMouseUp={handleSelectQuote}>
      <div className="pdfJsToolbar">
        <button className="btn btnTiny" type="button" onClick={() => setPageNumber((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
          Prev
        </button>
        <div className="pdfJsPageMeta">
          Page {safePage} / {numPages || 1}
        </div>
        <button
          className="btn btnTiny"
          type="button"
          onClick={() => setPageNumber((p) => Math.min(Math.max(numPages, 1), p + 1))}
          disabled={numPages > 0 ? safePage >= numPages : true}
        >
          Next
        </button>
      </div>

      <div className="pdfJsDocWrap" ref={docWrapRef}>
        {!DocumentCmp || !PageCmp ? (
          <div className="pdfJsLoading">
            <SkeletonLines rows={4} />
          </div>
        ) : pdfLoadErr ? (
          <div className="stateCard stateCardError">
            <div className="stateCardTitle">Could not load PDF</div>
            <div className="stateCardText">{pdfLoadErr}</div>
          </div>
        ) : (
          <DocumentCmp
            file={pdfUrl}
            onLoadSuccess={(x: any) => {
              const total = Number(x?.numPages || 0);
              setNumPages(total);
              setPageNumber((p) => Math.min(Math.max(1, p), Math.max(1, total)));
              setPdfRenderErr("");
              onDocumentInfo?.({ numPages: total });
            }}
            onLoadError={(e: any) => {
              const msg = String(e?.message || e || "Failed to render PDF.");
              setPdfRenderErr(msg);
            }}
            loading={
              <div className="pdfJsLoading">
                <SkeletonLines rows={4} />
              </div>
            }
            error={
              <div className="stateCard stateCardError">
                <div className="stateCardTitle">Could not load PDF</div>
                <div className="stateCardText">
                  {pdfRenderErr || "The PDF could not be rendered. Try another paper or open the source link."}
                </div>
              </div>
            }
          >
            <PageCmp
              pageNumber={safePage}
              width={pageWidth}
              renderAnnotationLayer={false}
              renderTextLayer
              className="pdfJsPage"
            />
          </DocumentCmp>
        )}
      </div>
    </div>
  );
}

function Modal({
  open,
  title,
  size = "default",
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  size?: "default" | "wide";
  children: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modalBackdrop" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className={`modal ${size === "wide" ? "modalWide" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <div className="modalTitle">{title}</div>
          <button className="iconBtn" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="modalBody">{children}</div>
      </div>
    </div>
  );
}

export default function PaperDashboard() {
  const router = useRouter();

  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<any>(null);

  const [query, setQuery] = useState("1706.03762");
  const limit = 5;
  const [note, setNote] = useState("");
  const [noteInfo, setNoteInfo] = useState("");

  const [loading, setLoading] = useState(false);
  const [runErr, setRunErr] = useState("");
  const [data, setData] = useState<any>(null);
  const [openingSearchId, setOpeningSearchId] = useState("");

  const [searches, setSearches] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedSearch, setSelectedSearch] = useState<any>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const routeInitHandledRef = useRef(false);

  const [ragQuestion, setRagQuestion] = useState("");
  const [lilyThreads, setLilyThreads] = useState<LilyThread[]>(() => [{ ...INITIAL_LILY_THREAD, messages: [...INITIAL_LILY_THREAD.messages] }]);
  const [activeLilyThreadId, setActiveLilyThreadId] = useState(INITIAL_LILY_THREAD.id);
  const [ragLoading, setRagLoading] = useState(false);
  const [lilyOpen, setLilyOpen] = useState(false);
  const [paperQuota, setPaperQuota] = useState<UserQuotaState | null>(null);
  const [lilyQuota, setLilyQuota] = useState<UserQuotaState | null>(null);
  const lilyMessagesRef = useRef<HTMLDivElement | null>(null);

  const [highlightQuote, setHighlightQuote] = useState("");
  const [highlightNote, setHighlightNote] = useState("");
  const [highlights, setHighlights] = useState<any[]>([]);
  const [highlightErr, setHighlightErr] = useState("");
  const [highlightInfo, setHighlightInfo] = useState("");
  const [highlightLoading, setHighlightLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalType, setModalType] = useState<"generic" | "reader">("generic");
  const [modalTitle, setModalTitle] = useState("");
  const [modalSize, setModalSize] = useState<"default" | "wide">("default");
  const [modalContent, setModalContent] = useState<React.ReactNode>(null);

  const activeThread = useMemo(
    () => lilyThreads.find((thread) => thread.id === activeLilyThreadId) || lilyThreads[0] || null,
    [lilyThreads, activeLilyThreadId]
  );
  const assistantMessages = activeThread?.messages || [];

  function applyUserQuota(raw: any) {
    const quota = toQuotaState(raw);
    if (!quota) return null;

    if (quota.kind === "paper_search") setPaperQuota(quota);
    if (quota.kind === "lily_message") setLilyQuota(quota);
    return quota;
  }

  function maybeToastLowQuota(quota: UserQuotaState | null) {
    if (!quota) return;
    if (quota.remaining > 3) return;
    const label = quota.kind === "paper_search" ? "Paper searches" : "AI Assistant messages";
    toast(`${label} remaining today: ${quota.remaining}/${quota.limit}`);
  }

  function deriveThreadTitle(question: string) {
    const clean = String(question || "").replace(/\s+/g, " ").trim();
    if (!clean) return "New thread";
    return clampText(clean, 42);
  }

  function setThreadSearchId(threadId: string, searchId: string) {
    const sid = String(searchId || "").trim();
    if (!threadId || !sid) return;
    setLilyThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              searchId: sid,
            }
          : thread
      )
    );
  }

  function pushThreadMessage(
    threadId: string,
    message: Omit<AssistantMessage, "id">,
    options?: {
      updateTitleFromUser?: boolean;
      bindSearchId?: string;
    }
  ) {
    if (!threadId) return;
    const bindSearchId = String(options?.bindSearchId || "").trim();
    setLilyThreads((prev) =>
      prev.map((thread) => {
        if (thread.id !== threadId) return thread;
        return {
          ...thread,
          title: options?.updateTitleFromUser && message.role === "user" ? deriveThreadTitle(message.text) : thread.title,
          searchId: bindSearchId || thread.searchId,
          messages: [...thread.messages, { id: makeChatId(), ...message }],
        };
      })
    );
  }

  function resetAssistant(seedTitle = "New thread", seedSearchId = "") {
    const thread = makeLilyThread(deriveThreadTitle(seedTitle), seedSearchId);
    setLilyThreads([thread]);
    setActiveLilyThreadId(thread.id);
    setRagQuestion("");
    return thread.id;
  }

  async function loadMe() {
    try {
      const out = await me();
      if (out?.ok) {
        setUser(out.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  }

  async function loadSearches() {
    if (!user) {
      setSearches([]);
      setSelectedSearch(null);
      setHistoryLoading(false);
      return;
    }

    setHistoryLoading(true);
    try {
      const out = await listSearches();
      if (out?.ok) {
        const items = Array.isArray(out.items) ? out.items : [];
        const sorted = [...items].sort((a: any, b: any) => {
          const at = new Date(String(a?.createdAt || 0)).getTime();
          const bt = new Date(String(b?.createdAt || 0)).getTime();
          if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
          return bt - at;
        });
        setSearches(sorted.slice(0, HISTORY_MAX_ITEMS));
      }
      else setSearches([]);
    } catch (e: any) {
      setSearches([]);
      setSelectedSearch(null);
      if (e?.status === 401) setUser(null);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authChecked && !user) {
      router.replace("/auth/login");
    }
  }, [authChecked, user, router]);

  useEffect(() => {
    loadSearches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!activeThread && lilyThreads.length) {
      setActiveLilyThreadId(lilyThreads[0].id);
    }
  }, [activeThread, lilyThreads]);

  useEffect(() => {
    if (!lilyOpen) return;
    const el = lilyMessagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [assistantMessages, lilyOpen]);

  function closeModal() {
    setModalOpen(false);
    setModalType("generic");
    setModalSize("default");
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (e.key === "Enter" && document.activeElement === searchInputRef.current) {
        e.preventDefault();
        void onRun();
        return;
      }

      if (e.key !== "Escape") return;
      if (modalOpen) {
        e.preventDefault();
        closeModal();
        return;
      }
      if (lilyOpen) {
        e.preventDefault();
        setLilyOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lilyOpen, modalOpen, query, loading, openingSearchId]);

  async function runQuery(overrideQuery?: string) {
    const q = String(overrideQuery !== undefined ? overrideQuery : query).trim();
    setRunErr("");
    setData(null);
    setSelectedSearch(null);
    setOpeningSearchId("");

    if (!q) {
      const msg = "Enter a paper title / arXiv id / keywords first.";
      setRunErr(msg);
      toast.error(msg);
      return;
    }

    if (q !== query) setQuery(q);

    const threadId = resetAssistant(q || "New thread", "");
    setLoading(true);

    try {
      const out = await runPaper(q, limit, "");
      setLoading(false);
      const quota = applyUserQuota(out?._quota);
      maybeToastLowQuota(quota);

      if (!out?.ok) {
        setRunErr(out?.error || "Failed to run.");
        return;
      }

      setData(out);
      setHighlightQuote("");
      setHighlightNote("");
      setHighlightErr("");
      setHighlightInfo("");
      setThreadSearchId(threadId, String(out?.search_id || "").trim());
      if (!out?.paper) {
        const msg = String(
          out?.note ||
            out?.error ||
            "No paper matched this query in history/DB/arXiv yet. Try an arXiv id or refine the title."
        );
        setRunErr(msg);
        toast.error(msg);
      }
      if (out?.history_saved === false) {
        const msg = "Result loaded, but history was not saved because your login session is missing/expired. Please login again.";
        setRunErr(msg);
        toast.error(msg);
      }
      await loadSearches();
    } catch (e: any) {
      setLoading(false);
      const quota = applyUserQuota(e?.quota || e?.data?.quota || null);
      if (e?.status === 401) {
        setUser(null);
        setSearches([]);
        setSelectedSearch(null);
        const msg = "Please login first.";
        setRunErr(msg);
        toast.error(msg);
        router.replace("/auth/login");
        return;
      }
      if (e?.status === 429 && quota?.kind === "paper_search") {
        const msg = e?.message || "Daily paper search limit reached.";
        setRunErr(msg);
        toast.error(msg);
        return;
      }
      setRunErr(e?.message || "Failed to run.");
    }
  }

  async function onRun() {
    await runQuery();
  }

  async function openSearch(id: string) {
    setRunErr("");
    setOpeningSearchId(id);
    setData(null);
    setSelectedSearch(null);
    try {
      const out = await getSearch(id);
      if (out?.ok) {
        setSelectedSearch(out);
        setQuery(String(out?.paper?.title || out?.search?.title || out?.search?.query || query));
        resetAssistant(String(out?.paper?.title || out?.search?.title || "New thread"), String(out?.search?.id || ""));
        if (!out?.paper) {
          const msg = String(
            out?.history_refresh_reason ||
              "This history item has no saved paper context yet. Click Run to refresh from DB/web."
          );
          setRunErr(msg);
          toast(msg);
        }
        setHighlightQuote("");
        setHighlightNote("");
        setHighlightErr("");
        setHighlightInfo("");
        await loadSearches();
      } else {
        const msg = String(out?.error || "Could not open selected search.");
        setRunErr(msg);
        toast.error(msg);
      }
    } catch (e: any) {
      const msg = e?.message || "Could not open selected search.";
      setRunErr(msg);
      toast.error(msg);
    } finally {
      setOpeningSearchId("");
    }
  }

  useEffect(() => {
    if (!authChecked || !user || routeInitHandledRef.current) return;

    const params = new URLSearchParams(window.location.search);
    const initialSearchId = String(params.get("searchId") || "").trim();
    const initialQuery = String(params.get("q") || "").trim();

    if (!initialSearchId && !initialQuery) {
      routeInitHandledRef.current = true;
      return;
    }

    routeInitHandledRef.current = true;
    if (initialSearchId) {
      void openSearch(initialSearchId);
      return;
    }

    if (initialQuery) {
      setQuery(initialQuery);
      void runQuery(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, user?.id]);

  function openModal(title: string, content: React.ReactNode, size: "default" | "wide" = "default") {
    setModalType("generic");
    setModalTitle(title);
    setModalContent(content);
    setModalSize(size);
    setModalOpen(true);
  }

  function openHistoryPopup() {
    openModal(
      "History",
      historyLoading ? (
        <HistorySkeleton />
      ) : !searches.length ? (
        <EmptyStateCard
          title="No history"
          detail="No searches are saved yet. Run a search to start your history."
          onRunSearch={() => {
            closeModal();
            void onRun();
          }}
        />
      ) : (
        <div className="modalScrollList">
          <div className="list">
            {searches.map((s) => (
              <button
                key={s.id}
                className={`historyRow ${selectedSearch?.search?.id === s.id || data?.search_id === s.id ? "active" : ""}`}
                disabled={panelLoading}
                onClick={() => {
                  closeModal();
                  void openSearch(s.id);
                }}
              >
                <div className="historyTitle">{clampText(String(s.title || s.query || ""), 72)}</div>
                <div className="historyMeta">{fmtDate(s.createdAt)}</div>
              </button>
            ))}
          </div>
        </div>
      )
    );
  }

  function startNewSession() {
    setData(null);
    setSelectedSearch(null);
    setRunErr("");
    setNote("");
    setNoteInfo("");
    resetAssistant();
    setHighlightQuote("");
    setHighlightNote("");
    setHighlights([]);
    setHighlightErr("");
    setHighlightInfo("");
  }

  function logout() {
    clearToken();
    setUser(null);
    setSearches([]);
    setSelectedSearch(null);
    setData(null);
    setRunErr("");
    setNote("");
    setNoteInfo("");
    const thread = makeLilyThread("Thread 1");
    setLilyThreads([thread]);
    setActiveLilyThreadId(thread.id);
    setRagQuestion("");
    setHighlightQuote("");
    setHighlightNote("");
    setHighlights([]);
    setHighlightErr("");
    setHighlightInfo("");
    router.replace("/auth/login");
  }

  async function saveNote() {
    const paperId = String(activeIdentity.paperId || "").trim();
    if (!paperId) {
      const msg = "Open a paper first to save notes.";
      setNoteInfo(msg);
      toast.error(msg);
      return;
    }

    try {
      await savePaperNote(paperId, note);
      const msg = note.trim() ? "Note saved." : "Note cleared.";
      setNoteInfo(msg);
      toast.success(msg);
    } catch (e: any) {
      const msg = toFriendlyNoteError(e);
      setNoteInfo(msg);
      toast.error(msg);
    }
  }

  async function clearNote() {
    setNote("");
    const paperId = String(activeIdentity.paperId || "").trim();
    if (!paperId) {
      const msg = "Note cleared.";
      setNoteInfo(msg);
      toast.success(msg);
      return;
    }
    try {
      await savePaperNote(paperId, "");
      const msg = "Note cleared.";
      setNoteInfo(msg);
      toast.success(msg);
    } catch (e: any) {
      const msg = toFriendlyNoteError(e);
      setNoteInfo(msg);
      toast.error(msg);
    }
  }

  const activePaper = data?.paper || selectedSearch?.paper || null;
  const activeSummary =
    typeof data?.summary === "string"
      ? data.summary
      : typeof selectedSearch?.summary?.summaryMd === "string"
        ? selectedSearch.summary.summaryMd
        : "";
  const activeNovelty: string[] = normalizeNovelty(
    data?.novelty ??
      selectedSearch?.novelty ??
      selectedSearch?.summary?.keyPoints ??
      selectedSearch?.summary?.novelty ??
      null
  );
  const noveltyPreview = activeNovelty.slice(0, 4);
  const showNoveltyViewMore = activeNovelty.length > 4;
  const activeReddit = Array.isArray(data?.reddit_threads)
    ? data.reddit_threads
    : Array.isArray(selectedSearch?.reddit_threads)
      ? selectedSearch.reddit_threads
      : [];
  const activeSearchId = String(data?.search_id || selectedSearch?.search?.id || "").trim();
  const activePdfUrl = toPdfUrlFromPaper(activePaper);
  const activePdfViewerUrl = toViewerPdfUrl(activePdfUrl);
  const activeRepoUrl = String(activePaper?.repo_url || activePaper?.repoUrl || "").trim();
  const activeIdentity = toPaperIdentity(activePaper, data || selectedSearch);
  const activeArxivBaseId =
    toArxivBaseId(activePaper?.arxiv_id) ||
    toArxivBaseId(activePaper?.externalId) ||
    toArxivBaseId(activeIdentity?.externalId) ||
    toArxivBaseId(activePaper?.url) ||
    "";
  const activeHuggingFaceUrl = String(activePaper?.huggingface_url || activePaper?.huggingfaceUrl || "").trim();
  const activeHuggingFacePaperUrl = activeHuggingFaceUrl || (activeArxivBaseId ? `https://huggingface.co/papers/${activeArxivBaseId}` : "");
  const activeSemanticScholarUrl = String(
    activePaper?.semantic_scholar_url ||
      activePaper?.semanticScholarUrl ||
      activePaper?.publication?.semantic_scholar_url ||
      activePaper?.publication?.semanticScholarUrl ||
      activePaper?.originSource?.publication?.semantic_scholar_url ||
      activePaper?.originSource?.publication?.semanticScholarUrl ||
      ""
  ).trim();
  const activePaperPageUrl = String(activePaper?.url || "").trim();
  const activePaperPageKind = sourceKindFromUrl(activePaperPageUrl);
  const activePaperPageLabel = sourceLabelFromKind(activePaperPageKind);
  const redditTopUrl = String(activeReddit[0]?.url || activeReddit[0]?.permalink || "").trim();
  const redditTopTitle = clampText(String(activeReddit[0]?.title || "thread"), 72);
  const openReviewSummary = normalizeOpenReviewSummary(
    data?.openreview_summary ??
      selectedSearch?.openreview_summary ??
      activePaper?.openreview_summary ??
      null
  );
  const openReviewPublication =
    (activePaper?.publication &&
    typeof activePaper.publication === "object" &&
    activePaper.publication.openreview &&
    typeof activePaper.publication.openreview === "object")
      ? activePaper.publication.openreview
      : (activePaper?.originSource &&
        typeof activePaper.originSource === "object" &&
        activePaper.originSource.publication &&
        typeof activePaper.originSource.publication === "object" &&
        activePaper.originSource.publication.openreview &&
        typeof activePaper.originSource.publication.openreview === "object")
        ? activePaper.originSource.publication.openreview
        : null;
  const openReviewForumUrl = String(
    openReviewSummary?.forumUrl || openReviewPublication?.forumUrl || ""
  ).trim();
  const openReviewDecision = String(
    openReviewSummary?.decision || openReviewPublication?.decision || ""
  ).trim();
  const quickLinks: Array<{ kind: SourceLogoKind; label: string; url: string; meta?: string }> = [
    ...(activePdfUrl ? [{ kind: "pdf" as SourceLogoKind, label: "Paper PDF", url: activePdfUrl }] : []),
    ...(activePaperPageUrl
      ? [{ kind: activePaperPageKind, label: activePaperPageLabel, url: activePaperPageUrl }]
      : []),
    ...(activeRepoUrl ? [{ kind: "github" as SourceLogoKind, label: "GitHub", url: activeRepoUrl }] : []),
    ...(activeHuggingFacePaperUrl
      ? [{ kind: "huggingface" as SourceLogoKind, label: "Hugging Face", url: activeHuggingFacePaperUrl }]
      : []),
    ...(activeSemanticScholarUrl
      ? [{ kind: "semantic" as SourceLogoKind, label: "Semantic Scholar", url: activeSemanticScholarUrl }]
      : []),
    ...(openReviewForumUrl ? [{ kind: "openreview" as SourceLogoKind, label: "OpenReview", url: openReviewForumUrl }] : []),
    ...(redditTopUrl
      ? [{ kind: "reddit" as SourceLogoKind, label: "Reddit", url: redditTopUrl, meta: redditTopTitle }]
      : []),
  ];
  const openReviewHasContent = Boolean(
    openReviewDecision ||
      openReviewForumUrl ||
      Number(openReviewSummary?.total || 0) > 0 ||
      (openReviewSummary?.topComments || []).length ||
      (openReviewSummary?.topStrengths || []).length ||
      (openReviewSummary?.topWeaknesses || []).length
  );
  const openReviewReviewCount = Math.max(
    Number.isFinite(Number(openReviewSummary?.reviews)) ? Number(openReviewSummary?.reviews) : 0,
    Array.isArray(openReviewSummary?.topReviewSummaries) ? openReviewSummary.topReviewSummaries.length : 0,
    Array.isArray(openReviewSummary?.topStrengths) ? openReviewSummary.topStrengths.length : 0,
    Array.isArray(openReviewSummary?.topWeaknesses) ? openReviewSummary.topWeaknesses.length : 0
  );
  const openReviewCommentCount = Math.max(
    Number.isFinite(Number(openReviewSummary?.comments)) ? Number(openReviewSummary?.comments) : 0,
    Array.isArray(openReviewSummary?.topComments) ? openReviewSummary.topComments.length : 0
  );
  const isSuperadmin = String(user?.role || "").trim().toLowerCase() === "superadmin";
  const panelLoading = loading || Boolean(openingSearchId);
  const runErrorView = runErr ? classifyRunError(runErr) : null;
  const publicationMeta = toPublicationMeta(activePaper);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!user) {
        setNote("");
        setNoteInfo("");
        return;
      }

      const paperId = String(activeIdentity.paperId || "").trim();
      if (!paperId) {
        setNote("");
        setNoteInfo("");
        return;
      }

      try {
        const out = await getPaperNote(paperId);
        if (cancelled) return;
        setNote(String(out?.item?.note || ""));
        setNoteInfo("");
      } catch {
        if (cancelled) return;
        setNote("");
        setNoteInfo("");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id, activeIdentity.paperId]);

  useEffect(() => {
    async function run() {
      if (!user) {
        setHighlights([]);
        return;
      }

      const paperId = String(activeIdentity.paperId || "").trim();
      const source = String(activeIdentity.source || "").trim();
      const externalId = String(activeIdentity.externalId || "").trim();

      if (!paperId && !externalId) {
        setHighlights([]);
        return;
      }

      try {
        const out = await listHighlights({ paperId, source, externalId });
        if (out?.ok) setHighlights(Array.isArray(out.items) ? out.items : []);
      } catch {
        setHighlights([]);
      }
    }
    run();
  }, [user?.id, activeIdentity.paperId, activeIdentity.externalId, activeIdentity.source]);

  function pushAssistantMessage(threadId: string, msg: Omit<AssistantMessage, "id">) {
    pushThreadMessage(threadId, msg);
  }

  function renderChunks(chunks: any[]) {
    return (
      <div className="list">
        {chunks.map((chunk: any, idx: number) => (
          <div key={`${chunk.id || chunk.sourceType || "chunk"}-${idx}`} className="listItem">
            <div className="listTitle">
              [{chunk.sourceType}] score {Number(chunk.score || 0).toFixed(3)}
            </div>
            <div className="listMeta">{String(chunk.content || "")}</div>
          </div>
        ))}
      </div>
    );
  }

  function renderAudit(audit: any, conflicts: any[]) {
    const safeAudit = audit && typeof audit === "object" ? audit : {};
    const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
    return (
      <div className="list">
        {safeConflicts.length ? (
          <div className="listItem">
            <div className="listTitle">Conflict Signals ({safeConflicts.length})</div>
            <pre className="listMeta" style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(safeConflicts, null, 2)}
            </pre>
          </div>
        ) : null}
        <div className="listItem">
          <div className="listTitle">Audit</div>
          <pre className="listMeta" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(safeAudit, null, 2)}
          </pre>
        </div>
      </div>
    );
  }

  async function onAskRag(customQuestion?: string) {
    if (ragLoading) return;
    setLilyOpen(true);

    let threadId = String(activeThread?.id || "").trim();
    if (!threadId) threadId = resetAssistant(query || "New thread", "");

    const thread = lilyThreads.find((x) => x.id === threadId);
    const threadSearchId = String(thread?.searchId || activeSearchId || "").trim();

    const question = String(customQuestion ?? ragQuestion).trim();
    if (!question) {
      pushAssistantMessage(threadId, {
        role: "assistant",
        text: "Type a question first.",
        isError: true,
      });
      return;
    }

    if (!threadSearchId) {
      pushAssistantMessage(threadId, {
        role: "assistant",
        text: "Run a paper search first so I can answer from indexed context.",
        isError: true,
      });
      return;
    }

    const historyForFollowUp = assistantMessages
      .map((msg) => ({
        role: msg?.role === "assistant" ? "assistant" : msg?.role === "user" ? "user" : "",
        text: String(msg?.text || "").trim(),
      }))
      .filter((msg) => (msg.role === "assistant" || msg.role === "user") && msg.text)
      .slice(-8);

    pushThreadMessage(
      threadId,
      { role: "user", text: question },
      { updateTitleFromUser: true, bindSearchId: threadSearchId }
    );
    setRagQuestion("");
    setRagLoading(true);

    try {
      let out = await ragAsk(question, threadSearchId, 6, historyForFollowUp);
      const quota = applyUserQuota(out?._quota);
      maybeToastLowQuota(quota);

      // If legacy history rows were never indexed (or indexing failed earlier),
      // rebuild index once and retry the question automatically.
      if (out?.ok && Number(out?.count || 0) === 0 && threadSearchId) {
        try {
          const reindexed = await ragReindex(threadSearchId);
          if (reindexed?.ok) {
            out = await ragAsk(question, threadSearchId, 6, historyForFollowUp);
            const quotaAfterRetry = applyUserQuota(out?._quota);
            maybeToastLowQuota(quotaAfterRetry);
          }
        } catch {
          // keep original zero-chunk response path below
        }
      }

      if (!out?.ok) {
        pushAssistantMessage(threadId, {
          role: "assistant",
          text: out?.error || "I could not answer that right now.",
          isError: true,
        });
        return;
      }

      const chunks = Array.isArray(out.chunks) ? out.chunks : [];
      const conflictsDetected = Array.isArray(out.conflicts_detected) ? out.conflicts_detected : [];
      const intent = formatIntentLabel(out.intent);
      const confidence = Number(out.confidence);
      const confidencePct = Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence * 100))) : null;
      const auditSources = Array.isArray(out?.audit?.sources) ? out.audit.sources.length : 0;
      const infoParts = [
        chunks.length ? `${chunks.length} context chunks used.` : "No chunks retrieved.",
        intent ? `Intent: ${intent}` : "",
        confidencePct != null ? `Confidence: ${confidencePct}%` : "",
        conflictsDetected.length ? `Conflict signals: ${conflictsDetected.length}` : "",
        auditSources ? `Audit sources: ${auditSources}` : "",
      ].filter(Boolean);
      pushAssistantMessage(threadId, {
        role: "assistant",
        text: String(out.answer || "I did not find enough context to answer confidently."),
        chunks,
        info: infoParts.join(" "),
        intent: String(out.intent || ""),
        confidence: Number.isFinite(confidence) ? confidence : null,
        conflictsDetected,
        audit: out.audit && typeof out.audit === "object" ? out.audit : null,
      });
    } catch (e: any) {
      const quota = applyUserQuota(e?.quota || e?.data?.quota || null);
      if (e?.status === 429 && quota?.kind === "lily_message") {
        toast.error(e?.message || "Daily AI Assistant message limit reached.");
      }
      pushAssistantMessage(threadId, {
        role: "assistant",
        text: e?.message || "RAG query failed.",
        isError: true,
      });
    } finally {
      setRagLoading(false);
    }
  }

  function renderPdfReaderContent() {
    return (
      <div className="pdfReaderLayout">
        <div className="pdfReaderMain">
          <PdfJsViewer
            pdfUrl={activePdfViewerUrl}
            className="pdfReaderViewer"
            onSelectQuote={(quote, pageNumber) => {
              setHighlightQuote(quote);
              setHighlightErr("");
              setHighlightInfo(`Selected quote from page ${pageNumber}.`);
            }}
          />
        </div>
        <aside className="pdfReaderSide">
          <div className="insightLabel">Notes</div>
          <div className="muted tiny">Edit and save notes for this paper here.</div>
          <textarea
            className="notesInput"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Write notes while reading..."
          />
          <div className="oauthRow" style={{ marginTop: 10 }}>
            <button className="btn btnTiny" onClick={saveNote} disabled={!activeIdentity.paperId}>
              Save notes
            </button>
            <button className="btn btnTiny" onClick={clearNote} disabled={!activeIdentity.paperId}>
              Clear notes
            </button>
          </div>
          {noteInfo ? <div className="muted tiny" style={{ marginTop: 10 }}>{noteInfo}</div> : null}

          <div className="insightLabel">Save highlight</div>
          <div className="muted tiny">Select text directly in the PDF viewer or paste text below.</div>

          <textarea
            className="notesInput highlightQuoteInput"
            value={highlightQuote}
            onChange={(e) => setHighlightQuote(e.target.value)}
            placeholder="Paste highlighted text snippet..."
          />

          <input
            className="input highlightNoteInput"
            value={highlightNote}
            onChange={(e) => setHighlightNote(e.target.value)}
            placeholder="Optional note"
          />

          <div className="oauthRow" style={{ marginTop: 10 }}>
            <button
              className="btn btnTiny"
              onClick={onSaveHighlight}
              disabled={highlightLoading || (!activeIdentity.paperId && !activeIdentity.externalId)}
            >
              {highlightLoading ? "Saving..." : "Save highlight"}
            </button>
            <button className="btn btnTiny" onClick={() => askBotAboutQuote(highlightQuote, highlightNote)} disabled={ragLoading || !highlightQuote.trim()}>
              Ask AI Assistant about quote
            </button>
          </div>

          {highlightErr ? <div className="alert alertErr" style={{ marginTop: 10 }}>{highlightErr}</div> : null}
          {highlightInfo ? <div className="muted tiny" style={{ marginTop: 10 }}>{highlightInfo}</div> : null}

          <div className="highlightBlock">
            <div className="insightLabel">Saved highlights</div>
            {highlights.length ? (
              <div className="list">
                {highlights.map((h: any) => (
                  <div key={h.id} className="listItem highlightItem">
                    <div className="listMeta">{fmtDate(h.createdAt)}</div>
                    <div className="listTitle">{clampText(String(h.quote || ""), 220)}</div>
                    {h.note ? <div className="listMeta">{h.note}</div> : null}
                    <div className="oauthRow" style={{ marginTop: 8 }}>
                      <button
                        className="btn btnTiny"
                        disabled={ragLoading}
                        onClick={() => {
                          closeModal();
                          askBotAboutQuote(String(h.quote || ""), String(h.note || ""));
                        }}
                      >
                        Ask AI Assistant
                      </button>
                      <button className="btn btnTiny" onClick={() => onDeleteHighlight(h.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">No highlights yet for this paper.</div>
            )}
          </div>
        </aside>
      </div>
    );
  }

  function openPdfReader() {
    if (!activePdfViewerUrl) return;
    setModalType("reader");
    setModalTitle(activePaper?.title ? `PDF Reader: ${activePaper.title}` : "PDF Reader");
    setModalSize("wide");
    setModalContent(null);
    setModalOpen(true);
  }

  async function onSaveHighlight() {
    const quote = highlightQuote.trim();
    if (!quote) {
      const msg = "Paste highlighted text first.";
      setHighlightErr(msg);
      toast.error(msg);
      return;
    }

    const payload: any = {
      paperId: activeIdentity.paperId || undefined,
      source: activeIdentity.source || undefined,
      externalId: activeIdentity.externalId || undefined,
      pdfUrl: activePdfUrl || undefined,
      quote,
      note: highlightNote.trim() || undefined,
      color: "#ffe066",
    };

    setHighlightLoading(true);
    setHighlightErr("");
    setHighlightInfo("");
    try {
      const out = await createHighlight(payload);
      if (!out?.ok || !out?.item) {
        const msg = out?.error || "Could not save highlight.";
        setHighlightErr(msg);
        toast.error(msg);
        return;
      }
      setHighlights((prev) => [out.item, ...prev]);
      setHighlightQuote("");
      setHighlightNote("");
      setHighlightInfo("Highlight saved.");
      toast.success("Highlight saved");
    } catch (e: any) {
      const msg = e?.message || "Could not save highlight.";
      setHighlightErr(msg);
      toast.error(msg);
    } finally {
      setHighlightLoading(false);
    }
  }

  function askBotAboutQuote(quote: string, note = "") {
    const cleanQuote = String(quote || "").trim();
    if (!cleanQuote) {
      const msg = "Paste or select a quote first.";
      setHighlightErr(msg);
      toast.error(msg);
      return;
    }
    void onAskRag(toQuotedQuestion(cleanQuote, note));
  }

  async function onDeleteHighlight(id: string) {
    const hid = String(id || "").trim();
    if (!hid) return;
    try {
      await deleteHighlight(hid);
      setHighlights((prev) => prev.filter((x) => x.id !== hid));
      toast.success("Highlight deleted");
    } catch {
      toast.error("Could not delete highlight.");
    }
  }

  if (!authChecked) {
    return (
      <div className="shell dashboardShell">
        <header className="topbar">
          <div className="brand">
            <MiraLogo variant="nav" />
          </div>
        </header>
        <main className="container">
          <div className="card">
            <div className="cardBody">Loading dashboard...</div>
          </div>
        </main>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="shell dashboardShell">
      <header className="topbar">
        <div className="brand">
          <MiraLogo variant="nav" />
        </div>

        <nav className="topnav">
          <Link className="toplink" href="/">
            Home
          </Link>
          <Link className="toplink active" href="/paper">
            Dashboard
          </Link>
          <Link className="toplink" href="/analytics">
            Analytics
          </Link>
          {isSuperadmin ? (
            <>
              <Link className="toplink" href="/admin/users">
                Admin Users
              </Link>
              <Link className="toplink" href="/admin/ops">
                Admin Ops
              </Link>
            </>
          ) : null}
          <button className="toplink btnLink" onClick={logout}>
            Logout
          </button>
        </nav>
      </header>

      <main className="container cockpitPage">
        <div className="cockpitGrid">
          <section className="cockpitCol leftCol">
            <article className="card cockpitCard panelNotesCard">
              <div className="cardHead">
                <div>
                  <div className="cardTitle sourceCardTitle">
                    <SourceLogo kind="openreview" />
                  </div>
                  <div className="cardSub">Comments summary</div>
                </div>
              </div>
              <div className="cardBody">
                {!activePaper ? (
                  <EmptyStateCard
                    title="No paper loaded"
                    detail="Open a result from history or run a search to load OpenReview context."
                    onRunSearch={() => {
                      void onRun();
                    }}
                  />
                ) : !openReviewHasContent ? (
                  <EmptyStateCard
                    title="No OpenReview comments"
                    detail="No OpenReview discussion is available for this paper yet."
                    onRunSearch={() => {
                      void onRun();
                    }}
                  />
                ) : (
                  <div>
                    <div className="muted tiny">
                      {`Reviews: ${openReviewReviewCount} · Comments: ${openReviewCommentCount}`}
                    </div>
                    {openReviewDecision ? (
                      <div className="muted tiny" style={{ marginTop: 6 }}>
                        {`Decision: ${openReviewDecision}`}
                      </div>
                    ) : null}
                    {openReviewSummary?.oneLiner ? (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted tiny" style={{ marginBottom: 4 }}>Thread summary</div>
                        <div>{openReviewSummary.oneLiner}</div>
                      </div>
                    ) : null}
                    {openReviewSummary?.overallAssessment &&
                    String(openReviewSummary.overallAssessment).trim().toLowerCase() !==
                      String(openReviewSummary.oneLiner || "").trim().toLowerCase() ? (
                      <div style={{ marginTop: 8 }}>
                        <div>{openReviewSummary.overallAssessment}</div>
                      </div>
                    ) : null}
                    {openReviewForumUrl ? (
                      <div style={{ marginTop: 8 }}>
                        <a href={openReviewForumUrl} target="_blank" rel="noreferrer" className="linkItem">
                          Open forum
                        </a>
                      </div>
                    ) : null}

                    {Array.isArray(openReviewSummary?.topReviewSummaries) && openReviewSummary.topReviewSummaries.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div className="muted tiny" style={{ marginBottom: 4 }}>Review highlights</div>
                        <ul className="bullets">
                          {openReviewSummary.topReviewSummaries.map((text: string, idx: number) => (
                            <li key={`or-review-${idx}`}>{clampText(text, 180)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {Array.isArray(openReviewSummary?.topComments) && openReviewSummary.topComments.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div className="muted tiny" style={{ marginBottom: 4 }}>Comment highlights</div>
                        <ul className="bullets">
                          {openReviewSummary.topComments.map((text: string, idx: number) => (
                            <li key={`or-comment-${idx}`}>{clampText(text, 180)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {Array.isArray(openReviewSummary?.topWeaknesses) && openReviewSummary.topWeaknesses.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div className="muted tiny" style={{ marginBottom: 4 }}>Common weaknesses</div>
                        <ul className="bullets">
                          {openReviewSummary.topWeaknesses.map((text: string, idx: number) => (
                            <li key={`or-weak-${idx}`}>{clampText(text, 180)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </article>
          </section>

          <section className="cockpitCol middleCol">
            <section className="searchSlim">
              <label className="searchSlimLabel">Paper Title / DOI</label>
              <div className="searchSlimRow">
                <input
                  ref={searchInputRef}
                  className="searchSlimInput"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Proximal Policy Optimization Algorithms"
                  disabled={panelLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRun();
                  }}
                />
                <button className="btn btnPrimary searchSlimBtn" onClick={onRun} disabled={panelLoading}>
                  {loading ? "Running..." : "Run"}
                </button>
                <button className="btn btnTiny" onClick={startNewSession} disabled={panelLoading}>
                  + New
                </button>
              </div>
              <div className="muted tiny" style={{ marginTop: 8 }}>
                Daily quota: Paper {toQuotaRemainingLabel(paperQuota)} · AI Assistant {toQuotaRemainingLabel(lilyQuota)}
              </div>

              {runErrorView ? (
                <ErrorStateCard
                  title={runErrorView.title}
                  detail={runErrorView.detail}
                  message={runErr}
                  onRetry={() => {
                    void onRun();
                  }}
                />
              ) : null}

              {activePaper ? (
                <div style={{ marginTop: 10 }}>
                  <span className="paperTag">
                    <span className="paperTagDot" />
                    Active paper: <span className="mono">{activePaper.externalId || query}</span>
                  </span>
                  {publicationMeta ? (
                    <div className="publicationMetaRow">
                      <span
                        className={`publicationBadge ${
                          publicationMeta.status === "published"
                            ? "publicationBadgePublished"
                            : publicationMeta.status === "preprint"
                              ? "publicationBadgePreprint"
                              : "publicationBadgeUnknown"
                        }`}
                      >
                        {publicationMeta.statusLabel}
                      </span>
                      {publicationMeta.year ? <span className="publicationBadge publicationMetaNeutral">{publicationMeta.year}</span> : null}
                      {publicationMeta.venue ? (
                        <span className="publicationBadge publicationMetaNeutral" title={publicationMeta.venue}>
                          {publicationMeta.venue}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <article className="card cockpitCard panelInsightsCard">
              <div className="cardHead">
                <div>
                  <div className="cardTitle">Insights</div>
                </div>
              </div>
              <div className="cardBody">
                <div className="insightBlock insightBlockFlat">
                  <div className="insightLabel">Summary</div>
                  {panelLoading ? (
                    <SkeletonLines rows={4} />
                  ) : activeSummary ? (
                    <p className="bodyTextSmall" style={{ whiteSpace: "pre-wrap" }}>
                      {activeSummary}
                    </p>
                  ) : (
                    <EmptyStateCard
                      title={activePaper ? "No summary available" : "No paper loaded"}
                      detail={activePaper ? "Summary was not generated for this result." : "Run a search to load a paper summary."}
                      onRunSearch={() => {
                        void onRun();
                      }}
                    />
                  )}
                </div>

                <div className="insightBlock insightBlockFlat">
                  <div className="insightLabel">Novelty</div>
                  {panelLoading ? (
                    <SkeletonLines rows={3} />
                  ) : activeNovelty.length ? (
                    <>
                      <ul className="bullets noveltyPointsPreview">
                        {noveltyPreview.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                      {showNoveltyViewMore ? (
                        <button
                          className="btn btnTiny"
                          onClick={() =>
                            openModal(
                              "All Novelty Points",
                              <ul className="bullets">
                                {activeNovelty.map((item, idx) => (
                                  <li key={idx}>{item}</li>
                                ))}
                              </ul>
                            )
                          }
                        >
                          View more
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <EmptyStateCard
                      title={activePaper ? "No novelty points" : "No paper loaded"}
                      detail={activePaper ? "No novelty bullets were extracted for this paper." : "Run a search to load novelty points."}
                      onRunSearch={() => {
                        void onRun();
                      }}
                    />
                  )}
                </div>

              </div>
            </article>
          </section>

          <section className="cockpitCol rightCol">
            <article className="card cockpitCard rightTallCard">
              <div className="cardHead pdfPreviewHead">
                <div className="pdfPreviewHeadMain">
                  <div className="cardTitle">Reader</div>
                </div>
                <div className="oauthRow pdfPreviewActions">
                  <button className="btn btnTiny" onClick={openPdfReader} disabled={!activePdfViewerUrl || panelLoading}>
                    Reader mode
                  </button>
                </div>
              </div>
              <div className="cardBody">
                <div className="insightBlock insightBlockFlat">
                  <div className="insightLabel">History</div>
                  <button className="btn btnTiny" onClick={openHistoryPopup} disabled={historyLoading}>
                    {historyLoading ? "Loading..." : `Open history (${searches.length})`}
                  </button>
                </div>

                <div className="insightBlock">
                  <div className="insightLabel">Quick links</div>
                  {panelLoading ? (
                    <SkeletonLines rows={4} />
                  ) : !activeReddit.length && !quickLinks.length ? (
                    <EmptyStateCard
                      title={activePaper ? "No links loaded" : "No paper loaded"}
                      detail={activePaper ? "No quick links or Reddit threads are available yet." : "Run a search to load quick links and threads."}
                      onRunSearch={() => {
                        void onRun();
                      }}
                    />
                  ) : null}

                  {!panelLoading && quickLinks.length ? (
                    <div className="links">
                      {quickLinks.map((link, idx) => (
                        <a key={`${link.url}-${idx}`} className="link" href={link.url} target="_blank" rel="noreferrer">
                          <span className="sourceLinkBrand">
                            <SourceLogo kind={link.kind} />
                          </span>
                          <span className="sourceLinkMeta">
                            {link.label}
                            {link.meta ? ` · ${link.meta}` : ""}
                          </span>
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {!panelLoading && activeReddit.length > 1 ? (
                    <button
                      className="btn btnTiny"
                      style={{ marginTop: 10 }}
                      onClick={() =>
                        openModal(
                          "All Reddit Threads",
                          <div className="modalScrollList">
                            <div className="list">
                              {activeReddit.map((x: any, i: number) => (
                                <a key={i} className="listItem" href={x.url} target="_blank" rel="noreferrer">
                                  <div className="listTitle">{x.title}</div>
                                  <div className="listMeta">
                                    {x.subreddit ? `r/${x.subreddit}` : "reddit"} · score {x.score ?? "-"} · comments{" "}
                                    {x.num_comments ?? x.numComments ?? "-"}
                                  </div>
                                </a>
                              ))}
                            </div>
                          </div>
                        )
                      }
                    >
                      View more threads
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          </section>
        </div>
      </main>

      <footer className="dashFooterBar">
        <div className="dashFooterInner">
          <div className="dashFooterLeft">
            <span className="dashFooterAvatar">N</span>
            <span>© Sara Dubey 2026</span>
          </div>
          <div className="dashFooterLinks">
            <a href="https://github.com/sara-dubey" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://www.linkedin.com/in/sara-dubey" target="_blank" rel="noreferrer">
              LinkedIn
            </a>
            <a href="mailto:saradubey98@gmail.com">saradubey98@gmail.com</a>
          </div>
        </div>
      </footer>

      <button className="lilyFab" onClick={() => setLilyOpen((v) => !v)}>
        {lilyOpen ? "Hide AI Assistant" : "Ask AI Assistant"}
      </button>

      <aside className={`lilyWidget ${lilyOpen ? "lilyWidgetOpen" : "lilyWidgetClosed"}`} aria-label="AI Assistant" aria-hidden={!lilyOpen}>
        <div className="lilyWidgetHead">
          <div className="lilyHeadDecor lilyHeadDecorLeft" />
          <div className="lilyHeadDecor lilyHeadDecorRight" />
          <div className="lilyHeadMain">
            <span className="lilyHeadAvatar" aria-hidden="true">
              🌸
            </span>
            <div>
              <div className="lilyWidgetTitle">AI Assistant</div>
              <div className="lilyHeadStatus">
                <span className="lilyOnlineDot" />
                Online · Ready to help
              </div>
            </div>
          </div>
          <button className="lilyCloseBtn" onClick={() => setLilyOpen(false)} aria-label="Close AI Assistant">
            ×
          </button>
        </div>

        <div className="lilyMessages" ref={lilyMessagesRef}>
          {assistantMessages.map((msg) => (
            <div key={msg.id} className={`lilyMsgRow ${msg.role === "user" ? "lilyMsgRowUser" : ""}`}>
              {msg.role === "assistant" ? (
                <span className="lilyAvatar lilyAvatarBot" aria-hidden="true">
                  🌸
                </span>
              ) : null}
              <div
                className={`lilyBubble ${
                  msg.role === "user" ? "lilyBubbleUser" : msg.isError ? "lilyBubbleError" : "lilyBubbleBot"
                }`}
              >
                {msg.role === "assistant" ? <div className="lilyWho">AI ASSISTANT</div> : null}
                <div className="lilyText">{msg.text}</div>
                {msg.info ? <div className="lilyInfo">{msg.info}</div> : null}
                {msg.role === "assistant" && Array.isArray(msg.chunks) && msg.chunks.length ? (
                  <button className="btn btnTiny" style={{ marginTop: 8 }} onClick={() => openModal("Assistant Sources", renderChunks(msg.chunks || []))}>
                    View sources
                  </button>
                ) : null}
                {msg.role === "assistant" && (msg.audit || (Array.isArray(msg.conflictsDetected) && msg.conflictsDetected.length)) ? (
                  <button
                    className="btn btnTiny"
                    style={{ marginTop: 8, marginLeft: 8 }}
                    onClick={() => openModal("Answer Audit", renderAudit(msg.audit, msg.conflictsDetected || []))}
                  >
                    View audit
                  </button>
                ) : null}
              </div>
              {msg.role === "user" ? (
                <span className="lilyAvatar lilyAvatarUser" aria-hidden="true">
                  👤
                </span>
              ) : null}
            </div>
          ))}
          {ragLoading ? (
            <div className="lilyMsgRow">
              <span className="lilyAvatar lilyAvatarBot" aria-hidden="true">
                🌸
              </span>
              <div className="lilyBubble lilyBubbleBot">
                <div className="lilyTyping" aria-label="AI Assistant is typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <form
          className="lilyComposer"
          onSubmit={(e) => {
            e.preventDefault();
            if (ragLoading) return;
            void onAskRag();
          }}
        >
          <input
            className="input lilyComposerInput"
            value={ragQuestion}
            onChange={(e) => setRagQuestion(e.target.value)}
            placeholder={ragLoading ? "AI Assistant is responding..." : "Ask AI Assistant anything about the paper..."}
            disabled={ragLoading}
          />
          <button className="btn lilySendBtn" type="submit" disabled={ragLoading || !ragQuestion.trim()} aria-label="Send message">
            {ragLoading ? "..." : "✈"}
          </button>
        </form>
      </aside>

      <Modal
        open={modalOpen}
        title={modalTitle}
        size={modalSize}
        onClose={closeModal}
      >
        {modalType === "reader" ? renderPdfReaderContent() : modalContent}
      </Modal>
    </div>
  );
}
