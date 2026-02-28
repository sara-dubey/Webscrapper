# services/paper-ai/llm/summarize_paper.py
from __future__ import annotations

import time
from typing import Any, Dict, List

from llm.prompts import build_blocks_prompt, build_openreview_summary_prompt, build_summary_prompt
from llm.mcp_layer import run_via_mcp_layer
from llm.summarize_reddit import build_reddit_block
from observability import observe_stage
from utils.text import pick_paper_minimal


def _clamp_list(xs: Any, max_n: int) -> List[Any]:
    if not isinstance(xs, list):
        return []
    return xs[:max_n]


def _normalize_line(s: str) -> str:
    return " ".join(str(s or "").strip().split())


def _clean_summary_text(value: Any) -> str:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [_normalize_line(line) for line in raw.split("\n")]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    return "\n".join(lines[:16])


def _clean_novelty_list(xs: Any, max_n: int = 6) -> List[str]:
    if not isinstance(xs, list):
        return []

    out: List[str] = []
    seen = set()
    generic_phrases = [
        "improves performance",
        "state of the art",
        "novel approach",
        "better results",
        "outperforms existing methods",
    ]

    for item in xs:
        s = _normalize_line(str(item or ""))
        if not s:
            continue
        s = s.lstrip("-• ").strip()
        if not s:
            continue
        if len(s.split()) < 3:
            continue
        lower = s.lower()
        if any(p in lower for p in generic_phrases) and not any(ch.isdigit() for ch in s):
            continue
        key = lower
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= max_n:
            break

    return out


# ---------------- LEGACY blocks shape ----------------
def _ensure_blocks_shape(obj: Any) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        obj = {}

    digest = obj.get("digest") if isinstance(obj.get("digest"), dict) else {}
    different = obj.get("different") if isinstance(obj.get("different"), dict) else {}
    reddit = obj.get("reddit") if isinstance(obj.get("reddit"), dict) else {}

    return {
        "digest": {
            "paragraph": str(digest.get("paragraph") or ""),
            "highlights": _clamp_list(digest.get("highlights"), 8),
            "keywords": _clamp_list(digest.get("keywords"), 10),
        },
        "different": {
            "paragraph": str(different.get("paragraph") or ""),
            "bullets": _clamp_list(different.get("bullets"), 8),
        },
        "reddit": {
            "paragraph": str(reddit.get("paragraph") or ""),
            "highlights": _clamp_list(reddit.get("highlights"), 8),
            "keywords": _clamp_list(reddit.get("keywords"), 10),
            "top_threads": _clamp_list(reddit.get("top_threads"), 6),
        },
    }


def _build_related_from_candidates(
    paper: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    max_n: int = 4,
) -> Dict[str, Any]:
    main_id = (paper.get("arxiv_id") or paper.get("url") or paper.get("title") or "").strip()
    items = []
    for c in candidates or []:
        cid = (c.get("arxiv_id") or c.get("url") or c.get("title") or "").strip()
        if not cid or cid == main_id:
            continue
        items.append(
            {
                "title": c.get("title") or "",
                "url": c.get("url")
                or (f"http://arxiv.org/abs/{c.get('arxiv_id')}" if c.get("arxiv_id") else ""),
                "arxiv_id": c.get("arxiv_id") or None,
                "year": str(c.get("year") or ""),
                "source": c.get("source") or "arxiv",
                "why_related": "High keyword overlap with the primary paper.",
            }
        )
        if len(items) >= max_n:
            break
    return {"items": items}


def _pick_candidates_minimal(candidates: List[Dict[str, Any]], max_n: int = 6) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for c in candidates or []:
        if not isinstance(c, dict):
            continue
        item = {
            "title": c.get("title") or "",
            "year": c.get("year") or "",
            "arxiv_id": c.get("arxiv_id") or "",
            "url": c.get("url") or "",
            "primaryCategory": c.get("primaryCategory") or "",
        }
        out.append(item)
        if len(out) >= max_n:
            break
    return out


async def build_paper_blocks(
    *,
    topic: str,
    paper: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    reddit_threads: List[Dict[str, Any]],
    ollama_base: str,
    ollama_model: str,
    timeout_secs: int = 120,
) -> Dict[str, Any]:
    """
    LEGACY: Returns blocks = {digest, different, related, reddit}
    """
    fetch_start = time.perf_counter()
    if not isinstance(paper, dict) or not paper.get("title"):
        observe_stage("fetch", max(0.0, time.perf_counter() - fetch_start))
        return {
            "digest": {"paragraph": "", "highlights": [], "keywords": []},
            "different": {"paragraph": "", "bullets": []},
            "related": {"items": []},
            "reddit": {"paragraph": "", "highlights": [], "keywords": [], "top_threads": []},
        }
    observe_stage("fetch", max(0.0, time.perf_counter() - fetch_start))

    reddit_block_fallback = build_reddit_block(
        topic=topic, reddit_threads=reddit_threads or [], paper=paper
    )

    chunk_start = time.perf_counter()
    prompt = build_blocks_prompt(topic=topic, paper=paper, reddit_threads=reddit_threads or [])
    observe_stage("chunk", max(0.0, time.perf_counter() - chunk_start))

    summarize_start = time.perf_counter()
    llm_obj = await run_via_mcp_layer(
        capability="paper_blocks",
        provider="ollama",
        prompt=prompt,
        base=ollama_base,
        model=ollama_model,
        timeout_secs=timeout_secs,
        temperature=0.2,
        retries=1,
    )
    observe_stage("summarize", max(0.0, time.perf_counter() - summarize_start))

    store_start = time.perf_counter()
    shaped = _ensure_blocks_shape(llm_obj)

    if not shaped["reddit"].get("top_threads"):
        shaped["reddit"]["top_threads"] = reddit_block_fallback["top_threads"]
    if not shaped["reddit"].get("paragraph"):
        shaped["reddit"]["paragraph"] = reddit_block_fallback["paragraph"]
    if not shaped["reddit"].get("highlights"):
        shaped["reddit"]["highlights"] = reddit_block_fallback["highlights"]
    if not shaped["reddit"].get("keywords"):
        shaped["reddit"]["keywords"] = reddit_block_fallback["keywords"]

    related = _build_related_from_candidates(paper, candidates or [], max_n=4)
    observe_stage("store", max(0.0, time.perf_counter() - store_start))

    return {
        "digest": shaped["digest"],
        "different": shaped["different"],
        "reddit": shaped["reddit"],
        "related": related,
    }


# ---------------- NEW summary+novelty shape ----------------
def _ensure_summary_shape(obj: Any) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        obj = {}

    summary = _clean_summary_text(obj.get("summary"))
    if len(summary) > 3000:
        summary = summary[:3000].rstrip() + "…"

    nov = _clean_novelty_list(obj.get("novelty"), max_n=6)

    return {"summary": summary, "novelty": nov}


def _normalize_short_line(value: Any, max_len: int = 220) -> str:
    s = _normalize_line(str(value or ""))
    if not s:
        return ""
    return s[:max_len].rstrip()


def _clean_short_bullets(values: Any, max_n: int, max_len: int = 120) -> List[str]:
    if not isinstance(values, list):
        return []
    out: List[str] = []
    seen = set()
    for value in values:
        s = _normalize_short_line(value, max_len=max_len)
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= max_n:
            break
    return out


def _ensure_openreview_summary_shape(obj: Any, *, note_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(obj, dict):
        obj = {}

    def _as_int(value: Any, fallback: int = 0) -> int:
        try:
            n = int(float(value))
            return max(0, n)
        except Exception:
            return fallback

    def _as_float01(value: Any, fallback: float = 0.0) -> float:
        try:
            n = float(value)
        except Exception:
            return fallback
        if n < 0:
            return 0.0
        if n > 1:
            return 1.0
        return n

    signal = str(obj.get("decision_signal") or "").strip().lower()
    if signal not in {"accept", "lean_accept", "mixed", "lean_reject", "reject", "not_stated"}:
        signal = "not_stated"

    rebuttal = str(obj.get("rebuttal_outcome") or "").strip().lower()
    if rebuttal not in {"improved_confidence", "partially_addressed", "not_addressed", "not_stated"}:
        rebuttal = "not_stated"

    counts = obj.get("evidence_counts") if isinstance(obj.get("evidence_counts"), dict) else {}
    citations = obj.get("citations") if isinstance(obj.get("citations"), dict) else {}
    review_count = _as_int(counts.get("reviews"))
    comment_count = _as_int(counts.get("comments"))
    rebuttal_count = _as_int(counts.get("rebuttals"))
    total_count = len(note_rows or [])
    if review_count + comment_count + rebuttal_count == 0 and total_count:
        review_count = sum(
            1 for row in (note_rows or []) if str(row.get("type") or row.get("noteType") or "").strip().lower() == "review"
        )
        comment_count = max(0, total_count - review_count)

    return {
        "one_liner": _normalize_short_line(obj.get("one_liner"), max_len=180),
        "overall_assessment": _normalize_short_line(obj.get("overall_assessment"), max_len=520),
        "decision_signal": signal,
        "strengths": _clean_short_bullets(obj.get("strengths"), max_n=5, max_len=180),
        "weaknesses": _clean_short_bullets(obj.get("weaknesses"), max_n=5, max_len=180),
        "rebuttal_outcome": rebuttal,
        "open_questions": _clean_short_bullets(obj.get("open_questions"), max_n=3, max_len=180),
        "confidence": _as_float01(obj.get("confidence"), 0.0),
        "evidence_counts": {
            "reviews": review_count,
            "comments": comment_count,
            "rebuttals": rebuttal_count,
            "total": total_count,
        },
        "citations": {
            "strengths": _clean_short_bullets(citations.get("strengths"), max_n=8, max_len=80),
            "weaknesses": _clean_short_bullets(citations.get("weaknesses"), max_n=8, max_len=80),
            "rebuttal_outcome": _clean_short_bullets(citations.get("rebuttal_outcome"), max_n=8, max_len=80),
        },
    }


async def _build_openreview_summary(
    *,
    paper: Dict[str, Any],
    openreview_rows: List[Dict[str, Any]],
    ollama_base: str,
    ollama_model: str,
    timeout_secs: int,
) -> Dict[str, Any] | None:
    rows = [row for row in (openreview_rows or []) if isinstance(row, dict)]
    if not rows:
        return None

    prompt = build_openreview_summary_prompt(paper=paper, openreview_rows=rows)
    llm_obj = await run_via_mcp_layer(
        capability="openreview_summary",
        provider="ollama",
        prompt=prompt,
        base=ollama_base,
        model=ollama_model,
        timeout_secs=timeout_secs,
        temperature=0.1,
        retries=1,
    )
    out = _ensure_openreview_summary_shape(llm_obj, note_rows=rows)
    out["summary_model"] = str(ollama_model or "").strip() or None
    out["summary_prompt_version"] = "openreview_summary_v1"
    return out


async def build_paper_summary(
    *,
    topic: str,
    paper: Dict[str, Any],
    candidates: List[Dict[str, Any]],
    openreview_rows: List[Dict[str, Any]] | None = None,
    ollama_base: str,
    ollama_model: str,
    timeout_secs: int = 120,
) -> Dict[str, Any]:
    """
    NEW: Returns {summary, novelty}
    """
    fetch_start = time.perf_counter()
    if not isinstance(paper, dict) or not paper.get("title"):
        observe_stage("fetch", max(0.0, time.perf_counter() - fetch_start))
        return {"summary": "", "novelty": []}
    observe_stage("fetch", max(0.0, time.perf_counter() - fetch_start))

    chunk_start = time.perf_counter()
    prompt = build_summary_prompt(topic=topic, paper=paper, candidates=candidates or [])
    paper_min = pick_paper_minimal(paper or {})
    candidates_min = _pick_candidates_minimal(candidates or [], max_n=6)
    observe_stage("chunk", max(0.0, time.perf_counter() - chunk_start))

    summarize_start = time.perf_counter()
    llm_obj = await run_via_mcp_layer(
        capability="paper_summary",
        provider="ollama",
        prompt=prompt,
        base=ollama_base,
        model=ollama_model,
        timeout_secs=timeout_secs,
        temperature=0.1,
        retries=1,
    )
    observe_stage("summarize", max(0.0, time.perf_counter() - summarize_start))

    store_start = time.perf_counter()
    out = _ensure_summary_shape(llm_obj)
    out["summary_model"] = str(ollama_model or "").strip() or None
    out["summary_prompt_version"] = "paper_summary_v3"
    out["summary_prompt"] = str(prompt or "")
    out["summary_source"] = {
        "topic": str(topic or ""),
        "paper": paper_min,
        "candidates": candidates_min,
        "llm_output": llm_obj if isinstance(llm_obj, dict) else {"raw": str(llm_obj)},
    }

    # OpenReview summary is generated separately so the UI can show reviewer/comment consensus.
    try:
        openreview_summary = await _build_openreview_summary(
            paper=paper,
            openreview_rows=openreview_rows or [],
            ollama_base=ollama_base,
            ollama_model=ollama_model,
            timeout_secs=timeout_secs,
        )
    except Exception:
        openreview_summary = None

    if openreview_summary:
        out["openreview_summary"] = openreview_summary
    observe_stage("store", max(0.0, time.perf_counter() - store_start))
    return out
