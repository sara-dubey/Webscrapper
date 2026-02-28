# services/paper-ai/llm/prompts.py
from __future__ import annotations

from typing import Any, Dict, List

from utils.text import safe_json, pick_paper_minimal


def build_blocks_prompt(
    *,
    topic: str,
    paper: Dict[str, Any],
    reddit_threads: List[Dict[str, Any]],
) -> str:
    """
    LEGACY prompt for /paper_blocks.

    Return STRICT JSON:
    {
      "digest": {"paragraph": "...", "highlights": [...], "keywords":[...]},
      "different": {"paragraph":"...", "bullets":[...]},
      "reddit": {"paragraph":"...", "highlights":[...], "keywords":[...], "top_threads":[...]}
    }
    """
    paper_min = pick_paper_minimal(paper or {})
    paper_json = safe_json(paper_min, max_chars=12000)
    reddit_json = safe_json((reddit_threads or [])[:10], max_chars=6000)

    return f"""You are an assistant that summarizes research papers and highlights novelty.

Return ONLY valid JSON (no markdown, no commentary). The JSON MUST match exactly:

{{
  "digest": {{
    "paragraph": "1 tight paragraph summary",
    "highlights": ["5-8 bullets"],
    "keywords": ["8-10 keywords"]
  }},
  "different": {{
    "paragraph": "What is new/different vs prior work",
    "bullets": ["5-8 bullets"]
  }},
  "reddit": {{
    "paragraph": "What Reddit discussions emphasize (if present)",
    "highlights": ["3-8 bullets"],
    "keywords": ["6-10 keywords"],
    "top_threads": [{{"title":"...","url":"...","subreddit":"...","score":123,"num_comments":45}}]
  }}
}}

Rules:
- Be accurate. If unsure, say "Not specified in the abstract/metadata."
- Use ONLY the provided PAPER fields. Do not fabricate results/metrics.
- Do not claim you read the PDF.
- Keep it concise.

TOPIC: {topic}

PAPER:
{paper_json}

REDDIT_THREADS:
{reddit_json}
""".strip()


def build_summary_prompt(
    *,
    topic: str,
    paper: Dict[str, Any],
    candidates: List[Dict[str, Any]] | None = None,
) -> str:
    """
    NEW prompt for /paper_summary.

    Return STRICT JSON:
    { "summary": "...", "novelty": ["...", "..."] }
    """
    paper_min = pick_paper_minimal(paper or {})
    paper_json = safe_json(paper_min, max_chars=12000)

    cand_min: List[Dict[str, Any]] = []
    for c in (candidates or [])[:6]:
        cand_min.append(
            {
                "title": c.get("title") or "",
                "year": c.get("year") or "",
                "arxiv_id": c.get("arxiv_id") or "",
            }
        )
    cand_json = safe_json(cand_min, max_chars=4000)

    return f"""You are a careful research-paper analyst.

Return ONLY valid JSON (no markdown, no commentary). The JSON MUST match exactly:

{{
  "summary": "- Problem: ...\\n- Proposed approach: ...\\n- How it works: ...\\n- Evidence/results: ...\\n- Limitations/assumptions: ...",
  "novelty": [
    "3-6 concise bullets, each with a concrete technical anchor",
    "Anchor examples: method/component, dataset/task, metric, theorem, training strategy, deployment property"
  ]
}}

Rules:
- Be accurate and conservative. If uncertain, write "Not specified in provided metadata/text."
- Use ONLY provided fields in PAPER and CANDIDATES. Never fabricate numbers, results, or claims.
- If PAPER contains origin_text_excerpt, prioritize it over abstract-only cues.
- Every novelty bullet must include at least one concrete technical detail from PAPER.
- Avoid generic statements like "improves performance" unless evidence is present.
- Keep novelty bullets unique, specific, and <= 24 words each.
- Summary lines should be short, factual, and non-redundant.
- Use CANDIDATES only for weak relative framing; if comparison is unclear, say not specified.

TOPIC: {topic}

PAPER:
{paper_json}

CANDIDATES (optional context; may be empty):
{cand_json}
""".strip()


def build_openreview_summary_prompt(
    *,
    paper: Dict[str, Any],
    openreview_rows: List[Dict[str, Any]] | None = None,
) -> str:
    """
    Prompt for OpenReview thread summarization.

    Return STRICT JSON only.
    """
    paper_min = pick_paper_minimal(paper or {})
    paper_json = safe_json(paper_min, max_chars=8000)

    rows_min: List[Dict[str, Any]] = []
    for row in (openreview_rows or [])[:180]:
        if not isinstance(row, dict):
            continue
        rows_min.append(
            {
                "note_id": row.get("noteId") or row.get("id") or "",
                "type": row.get("type") or row.get("noteType") or "",
                "summary": row.get("summary") or "",
                "strengths": row.get("strengths") or "",
                "weaknesses": row.get("weaknesses") or "",
                "questions": row.get("questions") or "",
                "comment": row.get("comment") or "",
                "details": row.get("details") or "",
                "decision": row.get("decision") or "",
                "rating_text": row.get("ratingText") or "",
                "confidence_text": row.get("confidenceText") or "",
                "created_at": row.get("created_at") or row.get("createdAtRemote") or "",
                "updated_at": row.get("updated_at") or row.get("updatedAtRemote") or "",
                "url": row.get("url") or "",
            }
        )
    rows_json = safe_json(rows_min, max_chars=30000)

    return f"""You summarize ONE paper's OpenReview thread using ONLY the provided notes.

Return STRICT JSON only (no markdown, no extra text):
{{
  "one_liner": "string, <= 28 words",
  "overall_assessment": "string, <= 60 words",
  "decision_signal": "accept|lean_accept|mixed|lean_reject|reject|not_stated",
  "strengths": ["1-5 bullets"],
  "weaknesses": ["1-5 bullets"],
  "rebuttal_outcome": "improved_confidence|partially_addressed|not_addressed|not_stated",
  "open_questions": ["0-3 bullets"],
  "confidence": 0.0,
  "evidence_counts": {{
    "reviews": 0,
    "comments": 0,
    "rebuttals": 0
  }},
  "citations": {{
    "strengths": ["note_id..."],
    "weaknesses": ["note_id..."],
    "rebuttal_outcome": ["note_id..."]
  }}
}}

Hard rules:
- Use only given evidence. No outside facts.
- If evidence is missing, use "not stated".
- No repetition, no fluff.
- Bullet length <= 18 words.
- Confidence high (>=0.75): multiple independent reviews and consistent signals.
- Confidence medium (0.45-0.74): mixed or sparse signals.
- Confidence low (<0.45): very few or weak notes.

PAPER:
{paper_json}

OPENREVIEW_NOTES:
{rows_json}
""".strip()
