# services/paper-ai/utils/json_tools.py
from __future__ import annotations

import json
import re
from typing import Any, Dict

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _strip_fences(s: str) -> str:
    return _FENCE_RE.sub("", (s or "").strip()).strip()


def extract_first_json_object(text: str) -> str:
    """Best-effort: extract the first top-level JSON object from a string."""
    s = _strip_fences(text)
    if not s:
        return s

    # fast path
    if s[0] == "{" and s.endswith("}"):
        return s

    # find outer-most { ... }
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        return s[start : end + 1]
    return s


def loads_best_effort(text: str) -> Dict[str, Any]:
    raw = extract_first_json_object(text)
    try:
        obj = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"Failed to parse JSON. Error={e}. Raw head={raw[:200]!r}") from e
    if not isinstance(obj, dict):
        raise RuntimeError("JSON root must be an object/dict.")
    return obj
