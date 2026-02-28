# services/paper-ai/utils/text.py
from __future__ import annotations

import re
from typing import Any, Dict

WS_RE = re.compile(r"\s+")


def clean_ws(s: str) -> str:
    return WS_RE.sub(" ", (s or "").strip())


def clamp_str(s: str, max_chars: int) -> str:
    s = s or ""
    if len(s) <= max_chars:
        return s
    # keep head+tail so ids/metrics survive
    head = max_chars // 2
    tail = max_chars - head - 32
    return s[:head] + "\n...<truncated>...\n" + s[-max(0, tail):]


def safe_json(obj: Any, max_chars: int = 12000) -> str:
    import json

    try:
        s = json.dumps(obj, ensure_ascii=False, indent=2)
    except Exception:
        s = json.dumps(str(obj), ensure_ascii=False)
    return clamp_str(s, max_chars=max_chars)


def pick_paper_minimal(paper: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only fields the LLM needs (reduces context + improves quality)."""
    if not isinstance(paper, dict):
        return {}
    keep = [
        "title",
        "abstract",
        "authors",
        "published",
        "updated",
        "primaryCategory",
        "categories",
        "arxiv_id",
        "url",
        "pdf_url",
        "year",
    ]
    out: Dict[str, Any] = {}
    for k in keep:
        if k in paper and paper[k] not in (None, "", [], {}):
            out[k] = paper[k]

    # Optional long-form body text (if caller provided it).
    # We pass a bounded excerpt so prompt size stays controllable.
    origin_text = str(paper.get("originText") or paper.get("origin_text") or "").strip()
    if origin_text:
        out["origin_text_excerpt"] = clamp_str(clean_ws(origin_text), max_chars=20000)
    origin_source = paper.get("originSource") or paper.get("origin_source")
    if origin_source not in (None, "", [], {}):
        out["origin_source"] = origin_source
    return out
