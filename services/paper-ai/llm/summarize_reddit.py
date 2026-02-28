# services/paper-ai/llm/summarize_reddit.py
from __future__ import annotations

import re
from typing import Any, Dict, List


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def _dedupe_preserve(items: List[str]) -> List[str]:
    seen = set()
    out = []
    for x in items:
        k = _clean(x).lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(_clean(x))
    return out


def _keywordize(text: str, k: int = 10) -> List[str]:
    # very simple keyword-ish extraction; just for fallback
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9\-\+]{2,}", (text or "").lower())
    stop = {
        "the","and","for","with","from","that","this","are","was","were","have","has","had",
        "you","your","they","their","about","paper","research","using","use","into","over",
        "can","will","would","could","should","also","than","then","when","where","what",
    }
    freq: Dict[str, int] = {}
    for w in words:
        if w in stop:
            continue
        freq[w] = freq.get(w, 0) + 1
    return [w for w, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:k]]


def build_reddit_block(
    *,
    topic: str,
    reddit_threads: List[Dict[str, Any]],
    paper: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Deterministic fallback block for /paper_blocks so the UI always has something.
    NOT used for /paper_summary.
    """
    threads = []
    for t in (reddit_threads or [])[:6]:
        threads.append(
            {
                "title": t.get("title") or "",
                "url": t.get("url") or t.get("link") or "",
                "subreddit": t.get("subreddit") or "",
                "score": int(t.get("score") or 0),
                "num_comments": int(t.get("num_comments") or t.get("comments") or 0),
            }
        )

    title = paper.get("title") or topic
    para = f"Top Reddit threads discussing “{_clean(title)}”. (Links only; no summarization.)"
    highlights = [f"{x['subreddit']}: {x['title']}" for x in threads[:5] if x.get("title")]
    keywords = _keywordize(" ".join([x.get("title", "") for x in threads]), k=10)

    return {
        "paragraph": para,
        "highlights": _dedupe_preserve(highlights)[:8],
        "keywords": keywords[:10],
        "top_threads": threads,
    }
