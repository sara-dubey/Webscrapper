from __future__ import annotations

import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from rag_db import get_pool
from llm.rag_weight_config import (
    DEFAULT_INTENT_WEIGHTS,
    DEFAULT_SOURCE_CREDIBILITY,
    get_rag_weight_config,
)

DEFAULT_INTENT_LABELS = tuple(DEFAULT_INTENT_WEIGHTS.keys())


# Turn any value into lowercase text.
def _lower(value: Any) -> str:
    return str(value or "").strip().lower()


# Read a positive integer with fallback.
def _to_positive_int(value: Any, fallback: int) -> int:
    try:
        n = int(float(value))
    except Exception:
        return fallback
    return n if n > 0 else fallback


# Read a safe finite float with fallback.
def _to_float(value: Any, fallback: Optional[float] = None) -> Optional[float]:
    try:
        n = float(value)
    except Exception:
        return fallback
    if not math.isfinite(n):
        return fallback
    return n


# Clamp a number to the 0 to 1 range.
def _clamp01(value: Any, fallback: Optional[float] = None) -> Optional[float]:
    n = _to_float(value, fallback)
    if n is None:
        return fallback
    if n < 0.0:
        return 0.0
    if n > 1.0:
        return 1.0
    return n


# Read a boolean flag from environment variables.
def _env_enabled(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


# Parse a timestamp into UTC datetime.
def _parse_timestamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None
    s = str(value or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# Get age in days from a timestamp.
def _age_days(value: Any) -> Optional[float]:
    dt = _parse_timestamp(value)
    if dt is None:
        return None
    now = datetime.now(timezone.utc)
    delta = (now - dt).total_seconds() / 86400.0
    return max(0.0, float(delta))


# Extract a JSON object from raw text output.
def _extract_json_object(raw: Any) -> Dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}

    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()

    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
        if isinstance(data, dict):
            return data
    except Exception:
        return {}
    return {}


# Get the active set of intent labels.
def _intent_labels(intent_weights: Optional[Dict[str, Dict[str, float]]] = None) -> tuple[str, ...]:
    # Returns the active list of allowed intent labels.
    labels = tuple((intent_weights or {}).keys())
    return labels if labels else DEFAULT_INTENT_LABELS


# Normalize intent text to a supported label.
def _normalize_intent(value: Any, intent_weights: Optional[Dict[str, Dict[str, float]]] = None) -> str:
    # Normalizes an intent value to one supported label.
    s = str(value or "").strip().upper()
    labels = set(_intent_labels(intent_weights))
    if s in labels:
        return s
    return "CONCEPTUAL"


# Parse loose label text into one intent.
def _parse_intent_label(value: Any, intent_weights: Optional[Dict[str, Dict[str, float]]] = None) -> Optional[str]:
    # Parses free-form intent text into one of the supported labels.
    raw = str(value or "").strip().upper()
    if not raw:
        return None
    compact = re.sub(r"[^A-Z]", "", raw)
    direct = raw.replace("-", "_").replace(" ", "_")
    labels = set(_intent_labels(intent_weights))
    if direct in labels:
        return direct
    if compact in {"REPRODUCIBILITY", "REPRODUCE", "REPLICATION", "FAILURE", "BUG"}:
        return "REPRODUCIBILITY"
    if compact in {"DEPENDENCIES", "DEPENDENCY", "INSTALL", "SETUP", "ENVIRONMENT"}:
        return "DEPENDENCIES"
    if compact in {"COMMUNITY", "DISCUSSION", "SENTIMENT"}:
        return "COMMUNITY"
    if compact in {"COMPARISON", "COMPARE", "VERSUS", "VS"}:
        return "COMPARISON"
    if compact in {"CONCEPTUAL", "METHOD", "METHODS", "OVERVIEW"}:
        return "CONCEPTUAL"
    for label in _intent_labels(intent_weights):
        if label in raw:
            return label
    return None


# Classify intent with regex fallback.
def _classify_intent_heuristic(question: Any) -> str:
    q = str(question or "").strip().lower()
    if not q:
        return "CONCEPTUAL"
    if re.search(r"(dependency|dependencies|cuda|torch|version|install|requirements|environment|setup|package|pip|conda)", q):
        return "DEPENDENCIES"
    if re.search(r"(reproduc|replicat|failed|failure|bug|issue|error|unstable|break|not work|crash|hallucinat)", q):
        return "REPRODUCIBILITY"
    if re.search(r"(reddit|community|discussion|opinion|sentiment|hype|practitioner|people say)", q):
        return "COMMUNITY"
    if re.search(r"(compare|comparison|vs\.?|versus|better than|difference between|baseline)", q):
        return "COMPARISON"
    return "CONCEPTUAL"


# Keep clean recent chat turns only.
def _sanitize_history(history: Any, *, max_items: int = 8) -> List[Dict[str, str]]:
    if not isinstance(history, list):
        return []
    cleaned: List[Dict[str, str]] = []
    for row in history[-max_items:]:
        if not isinstance(row, dict):
            continue
        role = _lower(row.get("role"))
        if role not in {"user", "assistant"}:
            continue
        text = " ".join(str(row.get("text") or "").split()).strip()
        if not text:
            continue
        cleaned.append({"role": role, "text": text[:1400]})
    return cleaned


# Check if this looks like a follow-up question.
def _looks_like_follow_up_question(question: Any) -> bool:
    q = str(question or "").strip().lower()
    if not q:
        return False
    if len(re.findall(r"[a-z0-9]+", q)) <= 7:
        return True
    if re.search(r"\b(it|this|that|these|those|they|them|its|their|there|here|above|previous|same)\b", q):
        return True
    return bool(re.match(r"^(why|how|what about|and|also|then|so|is it|does it|was it|are they)\b", q))


# Rewrite follow-up question with prior context.
def _compose_contextual_question(question: str, history: Any) -> str:
    q = str(question or "").strip()
    if not q:
        return q
    cleaned = _sanitize_history(history)
    if not cleaned or not _looks_like_follow_up_question(q):
        return q

    prev_user = next((x["text"] for x in reversed(cleaned) if x.get("role") == "user"), "")
    prev_assistant = next((x["text"] for x in reversed(cleaned) if x.get("role") == "assistant"), "")
    if not prev_user and not prev_assistant:
        return q

    lines = ["Follow-up question with prior chat context."]
    if prev_user:
        lines.append(f"Previous user question: {prev_user[:400]}")
    if prev_assistant:
        lines.append(f"Previous assistant answer: {prev_assistant[:650]}")
    lines.append(f"Current user question: {q}")
    return "\n".join(lines)


# Get credibility score for a source type.
def _source_credibility(
    source_type: Any,
    override: Any = None,
    source_credibility: Optional[Dict[str, float]] = None,
) -> float:
    # Returns credibility score for one source type with optional row override.
    override_val = _clamp01(override, None)
    if override_val is not None:
        return override_val
    key = str(source_type or "").strip()
    mapped = (source_credibility or DEFAULT_SOURCE_CREDIBILITY).get(key, 0.50)
    return float(_clamp01(mapped, 0.50) or 0.50)


# Get retrieval weight for intent and source type.
def _source_weight(
    intent: Any,
    source_type: Any,
    intent_weights: Optional[Dict[str, Dict[str, float]]] = None,
) -> float:
    # Returns retrieval weight for (intent, source_type) pair.
    key = str(source_type or "").strip()
    active_weights = intent_weights or DEFAULT_INTENT_WEIGHTS
    weights = active_weights.get(_normalize_intent(intent, active_weights), {})
    if key in weights:
        return float(weights[key])
    return 0.55


# Pick source types to prioritize for an intent.
def _preferred_sources_for_intent(
    intent: Any,
    intent_weights: Optional[Dict[str, Dict[str, float]]] = None,
) -> List[str]:
    # Returns preferred source types to narrow retrieval for a given intent.
    active_weights = intent_weights or DEFAULT_INTENT_WEIGHTS
    key = _normalize_intent(intent, active_weights)
    from_weights = list((active_weights.get(key) or {}).keys())
    if from_weights:
        return from_weights
    if key == "COMMUNITY":
        return ["reddit", "huggingface", "openreview_review", "openreview_rebuttal"]
    if key == "REPRODUCIBILITY":
        return [
            "diff_engine",
            "github_issue",
            "github_issue_open",
            "github_issue_closed",
            "github_readme",
            "openreview_review",
            "openreview_rebuttal",
            "reddit",
            "huggingface",
        ]
    if key == "DEPENDENCIES":
        return [
            "diff_engine",
            "github_issue",
            "github_issue_open",
            "github_issue_closed",
            "github_readme",
            "openreview_review",
        ]
    if key == "COMPARISON":
        return ["paper_origin", "paper", "semantic_scholar_citation", "openreview_review"]
    return []


# Infer source priorities directly from lexical hints in question text.
def _source_hints_from_question(question: Any) -> List[str]:
    q = _lower(question)
    if not q:
        return []

    github_issue_pattern = re.compile(
        r"\b(github|repo|repository|readme|issue|issues|bug|bugs|error|errors|fix|fixes|crash|failing|failure)\b"
    )
    if github_issue_pattern.search(q):
        return ["github_issue", "github_issue_open", "github_issue_closed", "github_readme", "diff_engine"]

    return []


# Detect whether a question is explicitly asking for GitHub issues/repo debugging context.
def _is_github_issue_question(question: Any) -> bool:
    q = _lower(question)
    if not q:
        return False
    return bool(
        re.search(
            r"\b(github|repo|repository|readme|issue|issues|bug|bugs|error|errors|fix|fixes|crash|failing|failure)\b",
            q,
        )
    )


def _is_github_issue_chunk(
    source_type: Any,
    source_id: Any = None,
    content: Any = None,
    metadata: Any = None,
) -> bool:
    st = str(source_type or "").strip().lower()
    if st in {"github_issue", "github_issue_open", "github_issue_closed"}:
        return True
    if st.startswith("github_issue_"):
        return True

    meta = metadata if isinstance(metadata, dict) else {}
    raw_type = str(meta.get("rawType") or meta.get("type") or "").strip().lower()
    if raw_type == "issue":
        return True

    sid = str(source_id or "")
    if re.search(r"/issues/\d+\b", sid, re.IGNORECASE):
        return True

    text = str(content or "")
    if re.search(r"\bType:\s*issue\b", text, re.IGNORECASE):
        return True
    if re.search(r"/issues/\d+\b", text, re.IGNORECASE):
        return True
    return False


def _issue_status_from_chunk(
    source_type: Any,
    content: Any = None,
    metadata: Any = None,
) -> str:
    text = str(content or "")
    m_status = re.search(r"\bState:\s*(open|closed)\b", text, re.IGNORECASE)
    if m_status:
        return m_status.group(1).lower()

    meta = metadata if isinstance(metadata, dict) else {}
    for key in ("state", "status"):
        raw = str(meta.get(key) or "").strip().lower()
        if raw in {"open", "closed"}:
            return raw

    return _normalize_issue_status(source_type)


# Down-weight old open issue evidence over time.
def _source_temporal_weight(source_type: Any, metadata: Any) -> float:
    st = str(source_type or "").strip()
    if st != "github_issue_open":
        return 1.0
    meta = metadata if isinstance(metadata, dict) else {}
    ts = meta.get("updatedAt") or meta.get("createdAt")
    age_days = _age_days(ts)
    if age_days is None:
        return 0.9
    half_life_days = float(_to_positive_int(os.getenv("RAG_OPEN_ISSUE_HALF_LIFE_DAYS"), 180))
    floor = float(_clamp01(os.getenv("RAG_OPEN_ISSUE_DECAY_FLOOR"), 0.35) or 0.35)
    decay = math.exp((-math.log(2.0) * age_days) / max(7.0, half_life_days))
    return max(floor, min(1.0, decay))


# Resolve LLM mode setting.
def _resolve_llm_mode() -> str:
    mode = _lower(os.getenv("LLM_MODE"))
    if mode in {"local", "api"}:
        return mode
    return ""


# Normalize provider kind string.
def _clean_api_kind(value: Any, fallback: str = "openai") -> str:
    kind = _lower(value)
    if kind in {"openai", "anthropic", "gemini"}:
        return kind
    return fallback


# Resolve provider for chat API calls.
def _resolve_api_chat_kind() -> str:
    return _clean_api_kind(
        os.getenv("API_LLM_CHAT_KIND") or os.getenv("RAG_API_CHAT_KIND") or os.getenv("API_LLM_KIND"),
        "openai",
    )


# Resolve provider for embedding API calls.
def _resolve_api_embed_kind() -> str:
    return _clean_api_kind(
        os.getenv("API_LLM_EMBED_KIND") or os.getenv("RAG_API_EMBED_KIND") or os.getenv("API_LLM_KIND"),
        "openai",
    )


# Remove trailing slash from a string URL.
def _trim_slash(value: Any) -> str:
    return str(value or "").rstrip("/")


# Return default base URL for a provider.
def _default_api_base(kind: str) -> str:
    if kind == "anthropic":
        return "https://api.anthropic.com"
    if kind == "gemini":
        return "https://generativelanguage.googleapis.com"
    return "https://api.openai.com"


# Resolve final base URL from config.
def _resolve_api_base(kind: str) -> str:
    return _trim_slash(os.getenv("API_LLM_BASE_URL") or os.getenv("RAG_API_BASE_URL") or _default_api_base(kind))


# Resolve API key for selected provider.
def _resolve_api_key_for_kind(kind: str) -> str:
    explicit = str(os.getenv("API_LLM_API_KEY", "")).strip()
    if explicit:
        return explicit
    if kind == "anthropic":
        return str(os.getenv("ANTHROPIC_API_KEY", "")).strip()
    if kind == "gemini":
        return str(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
    return str(os.getenv("OPENAI_API_KEY", "")).strip()


# Ensure API key is present, else raise clear error.
def _require_api_key(kind: str) -> str:
    key = _resolve_api_key_for_kind(kind)
    if key:
        return key
    if kind == "anthropic":
        raise RuntimeError("Missing API key for Anthropic. Set API_LLM_API_KEY or ANTHROPIC_API_KEY.")
    if kind == "gemini":
        raise RuntimeError("Missing API key for Gemini. Set API_LLM_API_KEY or GEMINI_API_KEY.")
    raise RuntimeError("Missing API key for API mode. Set API_LLM_API_KEY.")


# Build HTTP headers for provider request.
def _build_api_headers(kind: str) -> Dict[str, str]:
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    key = _resolve_api_key_for_kind(kind)
    if kind == "anthropic":
        if key:
            headers["x-api-key"] = key
        headers["anthropic-version"] = str(
            os.getenv("API_LLM_ANTHROPIC_VERSION") or os.getenv("ANTHROPIC_VERSION") or "2023-06-01"
        )
        return headers
    if kind == "gemini":
        if key:
            headers["x-goog-api-key"] = key
        return headers
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


# Normalize endpoint path format.
def _normalize_api_path(path_value: Any) -> str:
    path = str(path_value or "").strip()
    if not path:
        return ""
    return path if path.startswith("/") else f"/{path}"


# Resolve chat endpoint path.
def _resolve_chat_path(kind: str, model: str) -> str:
    custom = _normalize_api_path(os.getenv("API_LLM_CHAT_PATH") or os.getenv("RAG_API_CHAT_PATH"))
    if custom:
        return custom
    if kind == "anthropic":
        return "/v1/messages"
    if kind == "gemini":
        return f"/v1beta/models/{quote(str(model or ''), safe='-_.')}:generateContent"
    return "/v1/chat/completions"


# Resolve embedding endpoint path.
def _resolve_embed_path(kind: str, model: str) -> str:
    custom = _normalize_api_path(os.getenv("API_LLM_EMBED_PATH") or os.getenv("RAG_API_EMBED_PATH"))
    if custom:
        return custom
    if kind == "gemini":
        return f"/v1beta/models/{quote(str(model or ''), safe='-_.')}:embedContent"
    return "/v1/embeddings"


# Resolve API timeout in milliseconds.
def _resolve_api_timeout_ms() -> int:
    return _to_positive_int(os.getenv("API_LLM_TIMEOUT_MS") or os.getenv("RAG_API_TIMEOUT_MS"), 60_000)


# Attach Gemini key query param if needed.
def _append_gemini_key(url: str, kind: str) -> str:
    if kind != "gemini":
        return url
    key = _resolve_api_key_for_kind(kind)
    if not key:
        return url
    sep = "&" if "?" in url else "?"
    if "key=" in url:
        return url
    return f"{url}{sep}key={key}"


# Choose embedding backend provider.
def _resolve_embedding_provider() -> str:
    mode = _resolve_llm_mode()
    if mode == "local":
        return "ollama"
    if mode == "api":
        return "api"
    explicit = _lower(os.getenv("RAG_EMBEDDING_PROVIDER"))
    if explicit:
        return explicit
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("OLLAMA_EMBED_MODEL") or os.getenv("RAG_OLLAMA_EMBED_MODEL"):
        return "ollama"
    return "none"


# Choose chat backend provider.
def _resolve_chat_provider() -> str:
    mode = _resolve_llm_mode()
    if mode == "local":
        return "ollama"
    if mode == "api":
        return "api"
    explicit = _lower(os.getenv("RAG_CHAT_PROVIDER"))
    if explicit:
        return explicit
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("OLLAMA_CHAT_MODEL") or os.getenv("RAG_OLLAMA_CHAT_MODEL"):
        return "ollama"
    return "none"


# Make HTTP request and return parsed JSON.
async def _fetch_json(
    url: str,
    *,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout_ms: int = 45_000,
) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=max(1.0, timeout_ms / 1000.0)) as client:
        response = await client.request(method=method, url=url, headers=headers or {}, json=body)
        text = response.text
        try:
            data: Dict[str, Any] = response.json() if text else {}
        except Exception:
            data = {"raw": text}
        if response.status_code >= 400:
            msg = data.get("error", {}).get("message") if isinstance(data.get("error"), dict) else None
            if not msg:
                msg = data.get("message") or data.get("error") or f"HTTP {response.status_code}"
            err = RuntimeError(str(msg))
            setattr(err, "status", response.status_code)
            raise err
        return data


# Validate embedding vector values.
def _normalize_embedding(vector: Any) -> List[float]:
    if not isinstance(vector, list) or not vector:
        raise RuntimeError("Embedding provider returned an empty vector.")
    out: List[float] = []
    for n in vector:
        try:
            v = float(n)
        except Exception as e:
            raise RuntimeError("Embedding provider returned invalid vector values.") from e
        if not math.isfinite(v):
            raise RuntimeError("Embedding provider returned invalid vector values.")
        out.append(v)
    return out


# Create embeddings with OpenAI.
async def _embed_with_openai(texts: List[str]) -> Dict[str, Any]:
    key = str(os.getenv("OPENAI_API_KEY", "")).strip()
    if not key:
        raise RuntimeError("Missing OPENAI_API_KEY for RAG embeddings.")
    model = str(os.getenv("RAG_OPENAI_EMBED_MODEL") or "text-embedding-3-small")
    data = await _fetch_json(
        "https://api.openai.com/v1/embeddings",
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        body={"model": model, "input": texts},
        timeout_ms=_to_positive_int(os.getenv("RAG_OPENAI_TIMEOUT_MS"), 45_000),
    )
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    if not rows:
        raise RuntimeError("OpenAI embeddings response is empty.")
    return {"model": model, "vectors": [_normalize_embedding(row.get("embedding")) for row in rows if isinstance(row, dict)]}


# Create embeddings with configured API provider.
async def _embed_with_api(texts: List[str]) -> Dict[str, Any]:
    kind = _resolve_api_embed_kind()
    if kind == "anthropic":
        raise RuntimeError(
            "Anthropic does not provide embeddings in this integration. Use API_LLM_EMBED_KIND=openai|gemini or LLM_MODE=local."
        )

    model = str(
        os.getenv("API_LLM_EMBED_MODEL")
        or os.getenv("RAG_API_EMBED_MODEL")
        or os.getenv("API_LLM_MODEL")
        or ("text-embedding-004" if kind == "gemini" else "text-embedding-3-small")
    )
    _require_api_key(kind)
    base = _resolve_api_base(kind)
    path = _resolve_embed_path(kind, model)
    url = _append_gemini_key(f"{base}{path}", kind)

    if kind == "gemini":
        vectors: List[List[float]] = []
        for text in texts:
            data = await _fetch_json(
                url,
                method="POST",
                headers=_build_api_headers(kind),
                body={"content": {"parts": [{"text": text}]}},
                timeout_ms=_resolve_api_timeout_ms(),
            )
            vectors.append(_normalize_embedding(((data.get("embedding") or {}).get("values"))))
        return {"model": model, "vectors": vectors}

    data = await _fetch_json(
        url,
        method="POST",
        headers=_build_api_headers(kind),
        body={"model": model, "input": texts},
        timeout_ms=_resolve_api_timeout_ms(),
    )
    rows = data.get("data") if isinstance(data.get("data"), list) else []
    if not rows:
        raise RuntimeError("API embedding response is empty.")
    return {"model": model, "vectors": [_normalize_embedding(row.get("embedding")) for row in rows if isinstance(row, dict)]}


# Create embeddings with local Ollama.
async def _embed_with_ollama(texts: List[str]) -> Dict[str, Any]:
    model = str(os.getenv("RAG_OLLAMA_EMBED_MODEL") or os.getenv("OLLAMA_EMBED_MODEL") or "nomic-embed-text")
    base = str(os.getenv("RAG_OLLAMA_BASE_URL") or os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip(
        "/"
    )
    vectors: List[List[float]] = []
    timeout_ms = _to_positive_int(os.getenv("RAG_OLLAMA_TIMEOUT_MS"), 45_000)
    for text in texts:
        data = await _fetch_json(
            f"{base}/api/embeddings",
            method="POST",
            headers={"Content-Type": "application/json"},
            body={"model": model, "prompt": text},
            timeout_ms=timeout_ms,
        )
        vectors.append(_normalize_embedding(data.get("embedding")))
    return {"model": model, "vectors": vectors}


# Public helper to embed one or more texts.
async def embed_texts(texts: List[str]) -> Dict[str, Any]:
    clean = [str(x or "").strip() for x in (texts or []) if str(x or "").strip()]
    if not clean:
        return {"model": None, "vectors": []}
    provider = _resolve_embedding_provider()
    if provider == "openai":
        return await _embed_with_openai(clean)
    if provider == "api":
        return await _embed_with_api(clean)
    if provider == "ollama":
        return await _embed_with_ollama(clean)
    raise RuntimeError(
        "No embedding provider configured. Use LLM_MODE=local or LLM_MODE=api, or set RAG_EMBEDDING_PROVIDER."
    )


# Normalize spaces in text.
def _normalize_text(text: Any) -> str:
    return " ".join(str(text or "").split()).strip()


# Split text into overlapping chunks.
def split_into_chunks(text: Any, *, max_chars: Optional[int] = None, overlap_chars: Optional[int] = None) -> List[str]:
    normalized = _normalize_text(text)
    if not normalized:
        return []

    max_chars = _to_positive_int(max_chars or os.getenv("RAG_CHUNK_MAX_CHARS"), 1200)
    overlap_chars = min(
        max(0, _to_positive_int(overlap_chars or os.getenv("RAG_CHUNK_OVERLAP_CHARS"), 180)),
        max(1, max_chars // 2),
    )

    if len(normalized) <= max_chars:
        return [normalized]

    words = normalized.split(" ")
    chunks: List[str] = []
    start = 0

    while start < len(words):
        end = start
        length = 0
        while end < len(words):
            next_len = len(words[end]) + (1 if end > start else 0)
            if length + next_len > max_chars and end > start:
                break
            length += next_len
            end += 1
            if length >= max_chars:
                break
        if end <= start:
            end = start + 1

        chunk = " ".join(words[start:end]).strip()
        if chunk:
            chunks.append(chunk)

        if end >= len(words):
            break

        next_start = end
        overlap_len = 0
        while next_start > start and overlap_len < overlap_chars:
            next_start -= 1
            overlap_len += len(words[next_start]) + 1
        start = max(start + 1, next_start)

    return chunks


# Ensure metadata is a dictionary.
def _to_chunk_metadata(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


# Extract dependency versions from text.
def _extract_dependency_versions(text: Any) -> Dict[str, str]:
    body = str(text or "")
    if not body:
        return {}

    out: Dict[str, str] = {}
    pat = re.compile(r"\b([a-zA-Z][a-zA-Z0-9_.-]{1,40})\s*(==|>=|<=|~=|!=|>|<)\s*([0-9][a-zA-Z0-9_.+-]{0,20})\b")
    for name, op, version in pat.findall(body):
        key = _normalize_dependency_name(name)
        if not key:
            continue
        out[key] = f"{op}{version}"
    return out


# Normalize dependency name for matching.
def _normalize_dependency_name(name: Any) -> str:
    key = str(name or "").strip().lower()
    if not key:
        return ""
    aliases = {
        "pytorch": "torch",
        "python3": "python",
        "python-3": "python",
        "flash_attn": "flash-attn",
    }
    return aliases.get(key, key)


# Normalize version expression text.
def _normalize_version_expr(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    m = re.search(r"(==|>=|<=|~=|!=|>|<)\s*([0-9][a-zA-Z0-9_.+-]{0,20})", text)
    if not m:
        return ""
    return f"{m.group(1)}{m.group(2)}"


# Extract dependency mentions from issue text.
def _extract_dependency_mentions(text: Any) -> List[str]:
    body = str(text or "").lower()
    if not body:
        return []
    known = [
        "python",
        "cuda",
        "cudnn",
        "pytorch",
        "torch",
        "torchvision",
        "deepspeed",
        "transformers",
        "accelerate",
        "xformers",
        "flash-attn",
        "numpy",
    ]
    out: List[str] = []
    seen = set()
    for k in known:
        if k not in body:
            continue
        dep = _normalize_dependency_name(k)
        if not dep or dep in seen:
            continue
        seen.add(dep)
        out.append(dep)
    return out


# Normalize issue status using source type.
def _normalize_issue_status(source_type: Any) -> str:
    st = str(source_type or "").strip().lower()
    if st.endswith("_closed"):
        return "closed"
    if st.endswith("_open"):
        return "open"
    return "unknown"


# Use LLM to extract paper dependency versions.
async def _extract_paper_versions_with_llm(paper_text: str) -> Dict[str, str]:
    clean = str(paper_text or "").strip()
    if not clean:
        return {}
    max_chars = _to_positive_int(os.getenv("RAG_DIFF_PAPER_TEXT_MAX_CHARS"), 18_000)
    snippet = clean[:max_chars]
    if not snippet:
        return {}

    prompt = (
        "Extract explicit dependency version claims from the paper text.\n"
        "Return strict JSON only.\n"
        "Format: {\"claims\":[{\"dependency\":\"torch\",\"version\":\">=2.1\",\"evidence\":\"short quote\"}]}\n"
        "Rules: include only claims explicitly written in the paper. "
        "Do not infer hidden dependencies.\n"
        "Paper text:\n"
        f"{snippet}"
    )

    out = await _chat_text(
        prompt,
        system_prompt="You extract machine learning dependency version claims from research papers.",
        temperature=0.0,
        max_tokens=_to_positive_int(os.getenv("RAG_DIFF_LLM_MAX_TOKENS"), 900),
    )
    parsed = _extract_json_object(out.get("answer"))
    claims = parsed.get("claims") if isinstance(parsed.get("claims"), list) else []

    versions: Dict[str, str] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        dep = _normalize_dependency_name(claim.get("dependency"))
        ver = _normalize_version_expr(claim.get("version"))
        if not dep or not ver:
            continue
        versions[dep] = ver
    return versions


# Build diff-engine evidence doc from paper and code.
async def _run_diff_engine_docs(
    search_id: str,
    docs: List[Dict[str, Any]],
    source_credibility: Optional[Dict[str, float]] = None,
) -> Optional[Dict[str, Any]]:
    # Builds a synthetic diff chunk that compares paper claims vs code dependencies.
    if not isinstance(docs, list) or not docs:
        return None

    paper_docs = [d for d in docs if str(d.get("sourceType") or "") in {"paper_origin", "paper"}]
    if not paper_docs:
        return None
    paper_doc = max(paper_docs, key=lambda d: len(str(d.get("content") or "")))
    paper_text = str(paper_doc.get("content") or "")
    if not paper_text:
        return None

    github_readmes = [d for d in docs if str(d.get("sourceType") or "") == "github_readme"]
    github_issues = [
        d
        for d in docs
        if _is_github_issue_chunk(
            d.get("sourceType"),
            d.get("sourceId"),
            d.get("content"),
            d.get("metadata"),
        )
    ]
    if not github_readmes and not github_issues:
        return None

    paper_versions_regex = _extract_dependency_versions(paper_text)
    paper_versions_llm: Dict[str, str] = {}
    if _env_enabled("RAG_DIFF_USE_LLM", True):
        try:
            paper_versions_llm = await _extract_paper_versions_with_llm(paper_text)
        except Exception:
            paper_versions_llm = {}
    paper_versions = dict(paper_versions_regex)
    paper_versions.update(paper_versions_llm)

    code_versions: Dict[str, str] = {}
    for d in github_readmes:
        code_versions.update(_extract_dependency_versions(d.get("content")))

    issue_mentions: Dict[str, Dict[str, int]] = {}
    unresolved_keywords = (
        "error",
        "fail",
        "failed",
        "broken",
        "cannot",
        "can't",
        "does not work",
        "not work",
        "issue",
        "mismatch",
    )
    for issue in github_issues:
        content = str(issue.get("content") or "").lower()
        status = _issue_status_from_chunk(issue.get("sourceType"), issue.get("content"), issue.get("metadata"))
        has_problem_signal = any(k in content for k in unresolved_keywords)
        for dep in _extract_dependency_mentions(content):
            if dep not in issue_mentions:
                issue_mentions[dep] = {"open": 0, "closed": 0, "total": 0, "problem": 0}
            issue_mentions[dep]["total"] += 1
            if status == "closed":
                issue_mentions[dep]["closed"] += 1
            else:
                issue_mentions[dep]["open"] += 1
            if has_problem_signal:
                issue_mentions[dep]["problem"] += 1

    findings: List[Dict[str, Any]] = []
    deps = sorted(set([*paper_versions.keys(), *code_versions.keys(), *issue_mentions.keys()]))
    for dep in deps:
        paper_v = paper_versions.get(dep)
        code_v = code_versions.get(dep)
        issue_stat = issue_mentions.get(dep, {})
        open_cnt = int(issue_stat.get("open", 0))
        closed_cnt = int(issue_stat.get("closed", 0))
        problem_cnt = int(issue_stat.get("problem", 0))

        if code_v and not paper_v:
            status = "UNDOCUMENTED"
        elif paper_v and code_v and paper_v != code_v:
            status = "CONFLICT"
        elif problem_cnt > 0 and open_cnt > 0:
            status = "UNRESOLVED"
        elif closed_cnt > 0:
            status = "RESOLVED"
        else:
            continue

        findings.append(
            {
                "dependency": dep,
                "paper_version": paper_v,
                "code_version": code_v,
                "status": status,
                "open_issues": open_cnt,
                "closed_issues": closed_cnt,
                "problem_mentions": problem_cnt,
            }
        )

    if not findings:
        return None

    findings.sort(
        key=lambda x: (
            {"CONFLICT": 0, "UNDOCUMENTED": 1, "UNRESOLVED": 2, "RESOLVED": 3}.get(str(x.get("status")), 9),
            -int(x.get("open_issues") or 0),
            str(x.get("dependency") or ""),
        )
    )

    lines = ["Dependency cross-reference audit between paper claims and code reality:"]
    for row in findings[:40]:
        lines.append(
            "- {dep}: {status} (paper={paper}, code={code}, open_issues={open_i}, closed_issues={closed_i})".format(
                dep=row.get("dependency"),
                status=row.get("status"),
                paper=row.get("paper_version") or "n/a",
                code=row.get("code_version") or "n/a",
                open_i=row.get("open_issues") or 0,
                closed_i=row.get("closed_issues") or 0,
            )
        )

    return {
        "sourceType": "diff_engine",
        "sourceId": f"{str(search_id or '').strip()}:diff-engine",
        "content": "\n".join(lines),
        "paperId": paper_doc.get("paperId"),
        "redditPostId": None,
        "credibilityScore": _source_credibility("diff_engine", None, source_credibility),
        "metadata": {
            "engine": "cross_reference_diff_v1",
            "paper_claims_extractor": "llm+regex" if paper_versions_llm else "regex",
            "findings": findings[:80],
        },
    }


# Chunk and embed docs before DB write.
async def prepare_ingest_chunks(
    docs: List[Dict[str, Any]],
    *,
    max_chars: Optional[int] = None,
    overlap_chars: Optional[int] = None,
) -> Dict[str, Any]:
    staged: List[Dict[str, Any]] = []
    texts: List[str] = []

    for doc in docs or []:
        if not isinstance(doc, dict):
            continue
        source_type = str(doc.get("sourceType") or "").strip()
        source_id = str(doc.get("sourceId") or "").strip()
        content = str(doc.get("content") or "").strip()
        if not source_type or not source_id or not content:
            continue
        metadata = _to_chunk_metadata(doc.get("metadata"))
        parts = split_into_chunks(content, max_chars=max_chars, overlap_chars=overlap_chars)
        for idx, part in enumerate(parts):
            row = {
                "sourceType": source_type,
                "sourceId": source_id,
                "chunkIndex": idx,
                "content": part,
                "metadata": metadata,
            }
            staged.append(row)
            texts.append(part)

    if not staged:
        return {"model": None, "chunks": [], "count": 0}

    embedded = await embed_texts(texts)
    vectors = embedded.get("vectors") if isinstance(embedded.get("vectors"), list) else []
    if len(vectors) != len(staged):
        raise RuntimeError("Embedding response count does not match chunk count.")

    out_chunks: List[Dict[str, Any]] = []
    for idx, row in enumerate(staged):
        out = dict(row)
        out["embedding"] = vectors[idx]
        out_chunks.append(out)

    return {"model": embedded.get("model"), "chunks": out_chunks, "count": len(out_chunks)}


# Parse vector to list of floats.
def _parse_vector(value: Any) -> List[float]:
    if isinstance(value, list):
        return _normalize_embedding(value)
    s = str(value or "").strip()
    if not s:
        return []
    if s.startswith("[") and s.endswith("]"):
        body = s[1:-1].strip()
        if not body:
            return []
        parts = [p.strip() for p in body.split(",")]
        out = []
        for p in parts:
            if not p:
                continue
            try:
                n = float(p)
            except Exception:
                return []
            if not math.isfinite(n):
                return []
            out.append(n)
        return out
    return []


# Build prompt from question and retrieved chunks.
def _build_rag_prompt(question: str, chunks: List[Dict[str, Any]]) -> str:
    context_blocks = []
    for idx, chunk in enumerate(chunks):
        score = chunk.get("score")
        score_str = f"{float(score):.3f}" if isinstance(score, (int, float)) else "0.000"
        context_blocks.append(
            f"Context {idx + 1} [{chunk.get('sourceType')}] (score {score_str}):\n{chunk.get('content') or ''}"
        )
    context = "\n\n".join(context_blocks)
    return (
        "Use only the supplied context to answer the question. If context is missing, say what is missing.\n\n"
        f"Question:\n{question}\n\nContext:\n{context}"
    )


# Read text content from OpenAI-style response.
def _extract_openai_like_message_content(data: Dict[str, Any]) -> str:
    raw = (((data.get("choices") or [{}])[0] or {}).get("message") or {}).get("content")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts: List[str] = []
        for part in raw:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
                elif isinstance(part.get("content"), str):
                    parts.append(part["content"])
        return "\n".join(parts).strip()
    return ""


# Read text content from Anthropic response.
def _extract_anthropic_message_content(data: Dict[str, Any]) -> str:
    blocks = data.get("content")
    if not isinstance(blocks, list):
        return ""
    out: List[str] = []
    for b in blocks:
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
            out.append(b["text"])
    return "\n".join(out).strip()


# Read text content from Gemini response.
def _extract_gemini_message_content(data: Dict[str, Any]) -> str:
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content") if isinstance(first.get("content"), dict) else {}
    parts = content.get("parts") if isinstance(content.get("parts"), list) else []
    text_parts: List[str] = []
    for p in parts:
        if isinstance(p, dict) and isinstance(p.get("text"), str):
            text_parts.append(p["text"])
    if text_parts:
        return "\n".join(text_parts).strip()
    fallback = first.get("output_text")
    return str(fallback or "").strip()


# Route response parsing by provider kind.
def _extract_api_message_content(kind: str, data: Dict[str, Any]) -> str:
    if kind == "anthropic":
        return _extract_anthropic_message_content(data)
    if kind == "gemini":
        return _extract_gemini_message_content(data)
    return _extract_openai_like_message_content(data)


# Run one chat call for prompt-based tasks.
async def _chat_text(
    prompt: str,
    *,
    system_prompt: str,
    temperature: float = 0.0,
    max_tokens: int = 300,
) -> Dict[str, Any]:
    provider = _resolve_chat_provider()
    if provider == "none":
        return {"model": None, "answer": ""}

    if provider == "openai":
        key = str(os.getenv("OPENAI_API_KEY", "")).strip()
        if not key:
            return {"model": None, "answer": ""}
        model = str(os.getenv("RAG_OPENAI_CHAT_MODEL") or "gpt-4o-mini")
        data = await _fetch_json(
            "https://api.openai.com/v1/chat/completions",
            method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            body={
                "model": model,
                "temperature": max(0.0, min(1.0, float(temperature))),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": max(64, int(max_tokens)),
            },
            timeout_ms=_to_positive_int(os.getenv("RAG_OPENAI_TIMEOUT_MS"), 60_000),
        )
        answer = str(_extract_openai_like_message_content(data) or "").strip()
        return {"model": model, "answer": answer}

    if provider == "api":
        kind = _resolve_api_chat_kind()
        model = str(
            os.getenv("API_LLM_CHAT_MODEL")
            or os.getenv("RAG_API_CHAT_MODEL")
            or os.getenv("API_LLM_MODEL")
            or ("gemini-1.5-flash" if kind == "gemini" else "claude-3-5-sonnet-latest" if kind == "anthropic" else "gpt-4o-mini")
        )
        _require_api_key(kind)
        base = _resolve_api_base(kind)
        path = _resolve_chat_path(kind, model)
        url = _append_gemini_key(f"{base}{path}", kind)

        if kind == "anthropic":
            body: Dict[str, Any] = {
                "model": model,
                "temperature": max(0.0, min(1.0, float(temperature))),
                "max_tokens": max(64, int(max_tokens)),
                "system": system_prompt,
                "messages": [{"role": "user", "content": prompt}],
            }
        elif kind == "gemini":
            body = {
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": max(0.0, min(1.0, float(temperature))),
                    "topP": 0.9,
                    "maxOutputTokens": max(64, int(max_tokens)),
                },
            }
        else:
            body = {
                "model": model,
                "temperature": max(0.0, min(1.0, float(temperature))),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": max(64, int(max_tokens)),
            }

        data = await _fetch_json(
            url,
            method="POST",
            headers=_build_api_headers(kind),
            body=body,
            timeout_ms=_resolve_api_timeout_ms(),
        )
        answer = str(_extract_api_message_content(kind, data) or "").strip()
        return {"model": model, "answer": answer}

    if provider == "ollama":
        model = str(os.getenv("RAG_OLLAMA_CHAT_MODEL") or os.getenv("OLLAMA_CHAT_MODEL") or "qwen2.5:7b-instruct")
        base = str(os.getenv("RAG_OLLAMA_BASE_URL") or os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip(
            "/"
        )
        data = await _fetch_json(
            f"{base}/api/chat",
            method="POST",
            headers={"Content-Type": "application/json"},
            body={
                "model": model,
                "stream": False,
                "options": {
                    "temperature": max(0.0, min(1.0, float(temperature))),
                    "num_predict": max(64, int(max_tokens)),
                },
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
            },
            timeout_ms=_to_positive_int(os.getenv("RAG_OLLAMA_TIMEOUT_MS"), 60_000),
        )
        answer = str(((data.get("message") or {}).get("content")) or "").strip()
        return {"model": model, "answer": answer}

    return {"model": None, "answer": ""}


# Classify intent using a strict LLM prompt.
async def _classify_intent_with_prompt(
    question: str,
    intent_weights: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, Any]:
    # Uses LLM once to classify question intent into supported labels.
    prompt = (
        "Classify the user question into exactly one intent label.\n"
        "Allowed labels: CONCEPTUAL, REPRODUCIBILITY, COMMUNITY, DEPENDENCIES, COMPARISON.\n"
        "Return strict JSON only: {\"intent\":\"<LABEL>\",\"reason\":\"<short reason>\"}.\n"
        "Question:\n"
        f"{str(question or '').strip()}"
    )
    out = await _chat_text(
        prompt,
        system_prompt="You are an intent classification engine for research-paper QA.",
        temperature=0.0,
        max_tokens=180,
    )
    parsed = _extract_json_object(out.get("answer"))
    parsed_intent = _parse_intent_label(parsed.get("intent"), intent_weights) if parsed else None
    if parsed_intent:
        return {
            "intent": parsed_intent,
            "model": out.get("model"),
            "reason": str(parsed.get("reason") or "").strip()[:200],
        }

    fallback_intent = _parse_intent_label(out.get("answer"), intent_weights)
    if fallback_intent:
        return {"intent": fallback_intent, "model": out.get("model"), "reason": "free_text_parse"}
    return {"intent": None, "model": out.get("model"), "reason": "unparsed"}


# Resolve final intent from LLM, client, or regex.
async def _resolve_query_intent(
    question: str,
    requested_intent: Any = None,
    intent_weights: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, Any]:
    # Resolves final intent with priority: LLM -> requested value -> heuristic.
    requested = _parse_intent_label(requested_intent, intent_weights)
    use_llm = _env_enabled("RAG_INTENT_USE_LLM", True)

    if use_llm:
        try:
            out = await _classify_intent_with_prompt(question, intent_weights)
            resolved = _parse_intent_label(out.get("intent"), intent_weights)
            if resolved:
                return {
                    "intent": resolved,
                    "source": "llm",
                    "model": out.get("model"),
                    "reason": out.get("reason"),
                }
        except Exception:
            pass

    if requested:
        return {"intent": requested, "source": "client", "model": None, "reason": "client_fallback"}

    heuristic = _classify_intent_heuristic(question)
    return {"intent": heuristic, "source": "heuristic", "model": None, "reason": "regex"}


# Generate answer from context using OpenAI.
async def _chat_with_openai(question: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    key = str(os.getenv("OPENAI_API_KEY", "")).strip()
    if not key:
        raise RuntimeError("Missing OPENAI_API_KEY for RAG answers.")
    model = str(os.getenv("RAG_OPENAI_CHAT_MODEL") or "gpt-4o-mini")
    data = await _fetch_json(
        "https://api.openai.com/v1/chat/completions",
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        body={
            "model": model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a retrieval QA assistant. Answer only from provided context. "
                        "If uncertain, explicitly say you do not have enough context."
                    ),
                },
                {"role": "user", "content": _build_rag_prompt(question, chunks)},
            ],
        },
        timeout_ms=_to_positive_int(os.getenv("RAG_OPENAI_TIMEOUT_MS"), 60_000),
    )
    answer = str((((data.get("choices") or [{}])[0] or {}).get("message") or {}).get("content") or "").strip()
    if not answer:
        raise RuntimeError("OpenAI returned an empty answer.")
    return {"model": model, "answer": answer}


# Generate answer from context using API provider.
async def _chat_with_api(question: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    kind = _resolve_api_chat_kind()
    model = str(
        os.getenv("API_LLM_CHAT_MODEL")
        or os.getenv("RAG_API_CHAT_MODEL")
        or os.getenv("API_LLM_MODEL")
        or ("gemini-1.5-flash" if kind == "gemini" else "claude-3-5-sonnet-latest" if kind == "anthropic" else "gpt-4o-mini")
    )
    _require_api_key(kind)
    base = _resolve_api_base(kind)
    path = _resolve_chat_path(kind, model)
    url = _append_gemini_key(f"{base}{path}", kind)
    prompt = _build_rag_prompt(question, chunks)

    if kind == "anthropic":
        body: Dict[str, Any] = {
            "model": model,
            "temperature": 0.2,
            "max_tokens": _to_positive_int(os.getenv("API_LLM_MAX_TOKENS"), 700),
            "system": (
                "You are a retrieval QA assistant. Answer only from provided context. "
                "If uncertain, explicitly say you do not have enough context."
            ),
            "messages": [{"role": "user", "content": prompt}],
        }
    elif kind == "gemini":
        body = {
            "systemInstruction": {
                "parts": [
                    {
                        "text": (
                            "You are a retrieval QA assistant. Answer only from provided context. "
                            "If uncertain, explicitly say you do not have enough context."
                        )
                    }
                ]
            },
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "topP": 0.9,
                "maxOutputTokens": _to_positive_int(os.getenv("API_LLM_MAX_TOKENS"), 700),
            },
        }
    else:
        body = {
            "model": model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a retrieval QA assistant. Answer only from provided context. "
                        "If uncertain, explicitly say you do not have enough context."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
        }

    data = await _fetch_json(
        url,
        method="POST",
        headers=_build_api_headers(kind),
        body=body,
        timeout_ms=_resolve_api_timeout_ms(),
    )
    answer = str(_extract_api_message_content(kind, data) or "").strip()
    if not answer:
        raise RuntimeError("API provider returned an empty answer.")
    return {"model": model, "answer": answer}


# Generate answer from context using Ollama.
async def _chat_with_ollama(question: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    model = str(os.getenv("RAG_OLLAMA_CHAT_MODEL") or os.getenv("OLLAMA_CHAT_MODEL") or "qwen2.5:7b-instruct")
    base = str(os.getenv("RAG_OLLAMA_BASE_URL") or os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip(
        "/"
    )
    data = await _fetch_json(
        f"{base}/api/chat",
        method="POST",
        headers={"Content-Type": "application/json"},
        body={
            "model": model,
            "stream": False,
            "options": {"temperature": 0.2},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a retrieval QA assistant. Answer only from provided context. "
                        "If uncertain, say context is insufficient."
                    ),
                },
                {"role": "user", "content": _build_rag_prompt(question, chunks)},
            ],
        },
        timeout_ms=_to_positive_int(os.getenv("RAG_OLLAMA_TIMEOUT_MS"), 60_000),
    )
    answer = str(((data.get("message") or {}).get("content")) or "").strip()
    if not answer:
        raise RuntimeError("Ollama returned an empty answer.")
    return {"model": model, "answer": answer}


# Route answer generation to active provider.
async def answer_from_context(question: str, chunks: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(chunks, list) or not chunks:
        return {"model": None, "answer": ""}
    provider = _resolve_chat_provider()
    if provider == "none":
        return {
            "model": None,
            "answer": (
                "Retrieved relevant context, but no chat model is configured yet. "
                "Set LLM_MODE=local (Ollama) or LLM_MODE=api with API_LLM_* settings."
            ),
        }
    if provider == "api":
        return await _chat_with_api(question, chunks)
    if provider == "openai":
        return await _chat_with_openai(question, chunks)
    if provider == "ollama":
        return await _chat_with_ollama(question, chunks)
    raise RuntimeError(f"Unsupported RAG chat provider: {provider}")


# Return output template by intent type.
def _intent_synthesis_template(intent: Any, question: Any = None) -> str:
    if _is_github_issue_question(question):
        return (
            "Output concise markdown with these headers exactly:\n"
            "## GitHub Issue Snapshot\n## Issue Details\n## Recommended Actions\n"
            "Rules:\n"
            "- Prefer github_issue_open/github_issue_closed/github_readme evidence.\n"
            "- In Issue Details, use one bullet per issue with: issue id or title, status (open/closed/unknown), and main problem.\n"
            "- If an issue URL or number appears in context, include it.\n"
            "- In Recommended Actions, give practical next steps tied to issue evidence.\n"
            "- Do not include generic placeholders like 'context is insufficient' when issue evidence is present."
        )

    key = _normalize_intent(intent)
    if key == "REPRODUCIBILITY":
        return (
            "Output markdown with these headers exactly:\n"
            "## Paper Claims\n## Code Reality\n## Known Failure Modes\n## Setup Guidance\n"
            "For each claim, anchor to specific quote evidence and mention source_type in parentheses."
        )
    if key == "COMMUNITY":
        return (
            "Output markdown with these headers exactly:\n"
            "## Community Consensus\n## Disagreements\n## Practical Tips\n"
            "Separate hype/opinion from evidence-backed observations."
        )
    if key == "DEPENDENCIES":
        return (
            "Output markdown with these headers exactly:\n"
            "## Required Dependencies\n## Version Risks\n## Resolution Steps\n"
            "Prioritize explicit version constraints and unresolved compatibility issues."
        )
    if key == "COMPARISON":
        return (
            "Output markdown with these headers exactly:\n"
            "## Key Differences\n## Trade-offs\n## When To Choose Each Approach\n"
            "Only compare dimensions supported by retrieved evidence."
        )
    return (
        "Output markdown with these headers exactly:\n"
        "## Method Summary\n## Evidence\n## Caveats\n"
        "Do not invent details beyond provided quotes."
    )


# Parse quote bullets from model output.
def _parse_quote_lines(raw_text: Any) -> List[str]:
    text = str(raw_text or "")
    if not text:
        return []
    out: List[str] = []
    seen = set()
    for line in text.splitlines():
        s = line.strip().strip("`")
        if not s:
            continue
        if s.startswith(("-", "*")):
            s = s[1:].strip()
        elif s[:2].isdigit() and "." in s[:4]:
            s = s.split(".", 1)[1].strip()
        s = s.strip('"').strip("'").strip()
        if len(s) < 16:
            continue
        if len(s) > 480:
            s = s[:480].rstrip() + " ..."
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= 8:
            break
    return out


def _clean_inline_text(value: Any, max_len: int = 220) -> str:
    text = str(value or "").replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)
    if len(text) <= max_len:
        return text
    return text[: max(0, max_len - 3)].rstrip() + "..."


def _extract_github_issue_entries(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    issue_map: Dict[str, Dict[str, Any]] = {}
    for c in chunks or []:
        st = str(c.get("sourceType") or "").strip()
        metadata = c.get("metadata") if isinstance(c.get("metadata"), dict) else {}
        source_id = str(c.get("sourceId") or "").strip()
        content = str(c.get("content") or "").strip()
        if not _is_github_issue_chunk(st, source_id, content, metadata):
            continue
        if not source_id or not content:
            if not source_id and isinstance(metadata, dict):
                source_id = str(metadata.get("url") or "").strip()
            if not content:
                continue

        issue_no = ""
        m_no = re.search(r"/issues/(\d+)\b", source_id, re.IGNORECASE)
        if not m_no:
            m_no = re.search(r"/issues/(\d+)\b", content, re.IGNORECASE)
        if m_no:
            issue_no = m_no.group(1)

        status = _issue_status_from_chunk(st, content, metadata)

        m_title = re.search(r"\bIssue:\s*(.+?)(?:\s+Body:|$)", content, re.IGNORECASE | re.DOTALL)
        title = _clean_inline_text(m_title.group(1) if m_title else "")
        if not title:
            title = _clean_inline_text(c.get("title") or metadata.get("title") or "", 140)

        m_url = re.search(r"\bURL:\s*(https?://\S+)", content, re.IGNORECASE)
        url = str(m_url.group(1)).strip() if m_url else ""
        if not url:
            sid_url = source_id if re.match(r"^https?://", source_id, re.IGNORECASE) else ""
            url = sid_url or str(c.get("url") or metadata.get("url") or "").strip()
        if not url:
            m_url2 = re.search(r"(https?://[^\s)]+/issues/\d+\b)", content, re.IGNORECASE)
            if m_url2:
                url = str(m_url2.group(1)).strip()

        m_repo = re.search(r"\bRepo:\s*([^\n]+)", content, re.IGNORECASE)
        repo = _clean_inline_text(m_repo.group(1) if m_repo else "", 120)
        if not repo:
            repo = _clean_inline_text(metadata.get("repo") or "", 120)
        if not repo and url:
            m_repo2 = re.search(r"github\.com/([^/\s]+/[^/\s]+)/issues/\d+\b", url, re.IGNORECASE)
            if m_repo2:
                repo = _clean_inline_text(m_repo2.group(1), 120)

        m_body = re.search(r"\bBody:\s*(.+)", content, re.IGNORECASE | re.DOTALL)
        problem = _clean_inline_text(m_body.group(1) if m_body else "", 220)
        if not problem:
            problem = _clean_inline_text(content, 220)

        key = issue_no or source_id
        row = issue_map.get(key)
        if not row:
            issue_map[key] = {
                "issue_no": issue_no,
                "title": title or "Issue",
                "status": status,
                "url": url,
                "repo": repo,
                "problem": problem,
                "source_id": source_id,
            }
            continue

        if not row.get("title") and title:
            row["title"] = title
        if not row.get("url") and url:
            row["url"] = url
        if not row.get("repo") and repo:
            row["repo"] = repo
        if len(problem) > len(str(row.get("problem") or "")):
            row["problem"] = problem
        if row.get("status") != "open" and status == "open":
            row["status"] = "open"

    rows = list(issue_map.values())
    rows.sort(
        key=lambda x: (
            0 if str(x.get("status")) == "open" else 1,
            int(x.get("issue_no") or 10**9),
            str(x.get("title") or ""),
        )
    )
    return rows


def _render_github_issue_answer(chunks: List[Dict[str, Any]]) -> str:
    issues = _extract_github_issue_entries(chunks)
    if not issues:
        return ""

    open_count = sum(1 for x in issues if str(x.get("status")) == "open")
    closed_count = sum(1 for x in issues if str(x.get("status")) == "closed")
    repo = next((str(x.get("repo") or "").strip() for x in issues if str(x.get("repo") or "").strip()), "")

    lines: List[str] = [
        "## GitHub Issue Snapshot",
        f"- Repo: {repo or 'N/A'}",
        f"- Issues referenced: {len(issues)}",
        f"- Open: {open_count}",
        f"- Closed: {closed_count}",
        "",
        "## Issue Details",
    ]

    for row in issues[:8]:
        issue_no = str(row.get("issue_no") or "").strip()
        title = _clean_inline_text(row.get("title"), 140) or "Issue"
        status = str(row.get("status") or "unknown").strip().lower() or "unknown"
        url = str(row.get("url") or "").strip()
        problem = _clean_inline_text(row.get("problem"), 220) or "Problem details not found in context."
        issue_label = f"#{issue_no}" if issue_no else title
        if url:
            lines.append(f"- {issue_label} [{title}]({url}) - **{status}** - {problem}")
        else:
            lines.append(f"- {issue_label} - **{status}** - {problem}")

    lines.extend(
        [
            "",
            "## Recommended Actions",
            "- Reproduce each reported issue with the exact command/settings from the issue thread.",
            "- Compare local config with repository defaults (model, block size, sequence length, prompt template).",
            "- For unresolved behavior, capture logs and post a minimal repro in the corresponding issue.",
        ]
    )
    return "\n".join(lines).strip()


def _render_missing_github_issue_answer(chunks: List[Dict[str, Any]]) -> str:
    source_types = sorted(
        {
            str((row or {}).get("sourceType") or "").strip()
            for row in (chunks or [])
            if isinstance(row, dict) and str((row or {}).get("sourceType") or "").strip()
        }
    )
    source_preview = ", ".join(source_types[:6]) if source_types else "none"
    lines = [
        "## GitHub Issue Snapshot",
        "- No indexed GitHub issue entries were found for this paper/search.",
        f"- Retrieved source types: {source_preview}",
        "",
        "## Issue Details",
        "- Missing: `github_issue_open` / `github_issue_closed` chunks in current context.",
        "",
        "## Recommended Actions",
        "- Re-run indexing for this search with GitHub issue ingestion enabled.",
        "- Confirm the repository has public Issues and they are accessible.",
    ]
    return "\n".join(lines).strip()


# Extract focused quotes before synthesis.
async def _extract_quote_chunks(
    *,
    question: str,
    chunks: List[Dict[str, Any]],
    intent: Optional[str] = None,
) -> Dict[str, Any]:
    if not chunks:
        return {"chunks": [], "model": None, "raw": ""}

    # For GitHub issue questions, keep direct source snippets so synthesis can present issue status clearly.
    if _is_github_issue_question(question):
        preferred_order = ["github_issue_open", "github_issue_closed", "github_issue", "github_readme", "diff_engine"]
        by_pref = {k: [] for k in preferred_order}
        other: List[Dict[str, Any]] = []
        for src in chunks:
            st = str(src.get("sourceType") or "")
            if st in by_pref:
                by_pref[st].append(src)
            else:
                if _is_github_issue_chunk(st, src.get("sourceId"), src.get("content"), src.get("metadata")):
                    by_pref["github_issue"].append(src)
                    continue
                other.append(src)

        ordered: List[Dict[str, Any]] = []
        for key in preferred_order:
            ordered.extend(by_pref[key])
        ordered.extend(other)

        out_chunks: List[Dict[str, Any]] = []
        seen = set()
        for src in ordered:
            content = str(src.get("content") or "").strip()
            source_id = str(src.get("sourceId") or "").strip()
            if not content or not source_id or source_id in seen:
                continue
            seen.add(source_id)
            out_chunks.append(
                {
                    "sourceType": str(src.get("sourceType") or "quote_extract"),
                    "sourceId": source_id,
                    "content": content[:900],
                    "score": src.get("score"),
                    "weightedScore": src.get("weightedScore"),
                    "credibilityScore": src.get("credibilityScore"),
                    "metadata": src.get("metadata") if isinstance(src.get("metadata"), dict) else {},
                }
            )
            if len(out_chunks) >= 10:
                break

        if out_chunks:
            return {"chunks": out_chunks, "model": None, "raw": "direct_issue_snippets"}

    prompt = (
        "Extract up to 8 short, verbatim quotes from context that directly answer the user question.\n"
        "Return only bullet points.\n"
        f"Intent: {_normalize_intent(intent)}\n"
        f"Question: {question}"
    )
    out = await answer_from_context(prompt, chunks)
    raw = str(out.get("answer") or "")
    quotes = _parse_quote_lines(raw)
    quote_chunks: List[Dict[str, Any]] = []
    if quotes:
        for idx, quote in enumerate(quotes):
            src = chunks[min(idx, len(chunks) - 1)] if chunks else {}
            quote_chunks.append(
                {
                    "sourceType": "quote_extract",
                    "sourceId": f"quote:{idx + 1}",
                    "content": quote,
                    "score": src.get("score"),
                    "weightedScore": src.get("weightedScore"),
                    "credibilityScore": src.get("credibilityScore"),
                    "metadata": src.get("metadata") if isinstance(src.get("metadata"), dict) else {},
                }
            )
    if not quote_chunks:
        for idx, src in enumerate(chunks[:4]):
            content = str(src.get("content") or "").strip()
            if not content:
                continue
            quote_chunks.append(
                {
                    "sourceType": "quote_extract",
                    "sourceId": f"fallback:{idx + 1}",
                    "content": content[:420],
                    "score": src.get("score"),
                    "weightedScore": src.get("weightedScore"),
                    "credibilityScore": src.get("credibilityScore"),
                    "metadata": src.get("metadata") if isinstance(src.get("metadata"), dict) else {},
                }
            )
    return {"chunks": quote_chunks, "model": out.get("model"), "raw": raw}


# Generate final answer from quote chunks.
async def _synthesize_from_quotes(
    *,
    question: str,
    quote_chunks: List[Dict[str, Any]],
    intent: Optional[str] = None,
) -> Dict[str, Any]:
    if not quote_chunks:
        return {"answer": "", "model": None}
    prompt = (
        "Answer using only the provided quote evidence.\n"
        "If evidence is insufficient, state what is missing.\n"
        f"{_intent_synthesis_template(intent, question)}\n"
        f"Question: {question}"
    )
    return await answer_from_context(prompt, quote_chunks)


# Compute confidence score from chunk signals.
def _compute_confidence(
    chunks: List[Dict[str, Any]],
    source_credibility: Optional[Dict[str, float]] = None,
) -> float:
    # Computes overall answer confidence from retrieved chunk scores.
    if not chunks:
        return 0.0
    vals: List[float] = []
    for c in chunks:
        weighted = _to_float(c.get("weightedScore"), None)
        if weighted is not None:
            vals.append(max(0.0, min(1.0, weighted)))
            continue
        score = _to_float(c.get("score"), 0.0) or 0.0
        cred = _source_credibility(
            c.get("sourceType"),
            c.get("credibilityScore"),
            source_credibility,
        )
        vals.append(max(0.0, min(1.0, score * cred)))
    if not vals:
        return 0.0
    return float(sum(vals) / len(vals))


# Extract conflict findings from diff-engine chunks.
def _extract_conflicts(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for c in chunks or []:
        if str(c.get("sourceType") or "") != "diff_engine":
            continue
        meta = c.get("metadata") if isinstance(c.get("metadata"), dict) else {}
        findings = meta.get("findings") if isinstance(meta.get("findings"), list) else []
        for f in findings:
            if not isinstance(f, dict):
                continue
            status = str(f.get("status") or "").upper()
            if status in {"CONFLICT", "UNDOCUMENTED", "UNRESOLVED"}:
                out.append(
                    {
                        "dependency": f.get("dependency"),
                        "status": status,
                        "paper_version": f.get("paper_version"),
                        "code_version": f.get("code_version"),
                        "open_issues": f.get("open_issues"),
                    }
                )
            if len(out) >= 20:
                return out
    return out


# Build response audit block from selected chunks.
def _build_audit(
    chunks: List[Dict[str, Any]],
    source_credibility: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    # Builds compact per-source audit block returned with each answer.
    entries: List[Dict[str, Any]] = []
    for c in chunks[:20]:
        meta = c.get("metadata") if isinstance(c.get("metadata"), dict) else {}
        entries.append(
            {
                "source_type": c.get("sourceType"),
                "source_id": c.get("sourceId"),
                "url": meta.get("url"),
                "credibility_score": _source_credibility(
                    c.get("sourceType"),
                    c.get("credibilityScore"),
                    source_credibility,
                ),
                "temporal_weight": _to_float(c.get("temporalWeight"), None),
                "weighted_score": _to_float(c.get("weightedScore"), None),
                "similarity_score": _to_float(c.get("score"), None),
            }
        )
    return {"sources": entries}


# Convert vector to pgvector SQL literal.
def _vector_literal(vector: Any) -> str:
    clean = _normalize_embedding(vector)
    if not clean:
        raise RuntimeError("Vector is empty.")
    return "[" + ",".join(str(float(v)) for v in clean) + "]"


# Normalize optional id value.
def _safe_doc_id(value: Any) -> Optional[str]:
    s = str(value or "").strip()
    return s or None


# Serialize metadata as JSON string.
def _metadata_json(value: Any) -> str:
    if isinstance(value, dict):
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return "{}"
    return "{}"


# Index docs into RagChunk with embeddings.
async def index_rag_to_db(
    *,
    user_id: str,
    search_id: str,
    docs: List[Dict[str, Any]],
    max_chars: Optional[int] = None,
    overlap_chars: Optional[int] = None,
) -> Dict[str, Any]:
    # Stores all evidence chunks, scores them, and writes embeddings into RagChunk.
    uid = str(user_id or "").strip()
    sid = str(search_id or "").strip()
    if not uid or not sid:
        return {"indexed": False, "reason": "missing_user_or_search", "chunks": 0, "model": None}

    source_credibility_map, _ = await get_rag_weight_config()
    docs_for_index = [doc for doc in (docs or []) if isinstance(doc, dict)]
    diff_doc = await _run_diff_engine_docs(
        sid,
        docs_for_index,
        source_credibility=source_credibility_map,
    )
    if diff_doc:
        docs_for_index.append(diff_doc)

    # Mirror JS cleanup behavior for a legacy source type.
    pool = await get_pool()
    prepared = await prepare_ingest_chunks(
        docs_for_index,
        max_chars=max_chars,
        overlap_chars=overlap_chars,
    )

    chunks = prepared.get("chunks") if isinstance(prepared.get("chunks"), list) else []
    model = prepared.get("model")
    if not chunks:
        return {"indexed": True, "chunks": 0, "model": model}

    doc_map: Dict[str, Dict[str, Any]] = {}
    for doc in docs_for_index:
        if not isinstance(doc, dict):
            continue
        source_type = str(doc.get("sourceType") or "").strip()
        source_id = str(doc.get("sourceId") or "").strip()
        if not source_type or not source_id:
            continue
        doc_map[f"{source_type}::{source_id}"] = doc

    staged: List[Dict[str, Any]] = []
    chunk_count_by_doc: Dict[str, int] = {}

    async with pool.acquire() as conn:
        await conn.execute(
            'DELETE FROM "rag_chunk" WHERE "userId" = $1 AND "searchId" = $2 AND "sourceType" = $3',
            uid,
            sid,
            "paper_meta",
        )

        for chunk in chunks:
            source_type = str(chunk.get("sourceType") or "").strip()
            source_id = str(chunk.get("sourceId") or "").strip()
            if not source_type or not source_id:
                continue

            doc_key = f"{source_type}::{source_id}"
            source_doc = doc_map.get(doc_key)
            if not source_doc:
                continue

            chunk_index = int(chunk.get("chunkIndex") or 0)
            content = str(chunk.get("content") or "").strip()
            if not content:
                continue

            metadata_val = chunk.get("metadata")
            if not isinstance(metadata_val, dict):
                metadata_val = source_doc.get("metadata")

            paper_id = _safe_doc_id(source_doc.get("paperId"))
            reddit_post_id = _safe_doc_id(source_doc.get("redditPostId"))
            credibility_score = _source_credibility(
                source_type,
                source_doc.get("credibilityScore"),
                source_credibility_map,
            )
            if isinstance(metadata_val, dict) and metadata_val.get("credibilityScore") is None:
                metadata_val["credibilityScore"] = credibility_score

            chunk_id = str(uuid.uuid4())
            row = await conn.fetchrow(
                '''
                INSERT INTO "rag_chunk"
                ("id","userId","searchId","paperId","redditPostId","sourceType","credibilityScore","sourceId","chunkIndex","content","metadata","embeddingModel")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NULL)
                ON CONFLICT ("userId","sourceType","sourceId","chunkIndex")
                DO UPDATE SET
                  "searchId" = EXCLUDED."searchId",
                  "paperId" = EXCLUDED."paperId",
                  "redditPostId" = EXCLUDED."redditPostId",
                  "credibilityScore" = EXCLUDED."credibilityScore",
                  "content" = EXCLUDED."content",
                  "metadata" = EXCLUDED."metadata",
                  "updatedAt" = NOW()
                RETURNING "id"
                ''',
                chunk_id,
                uid,
                sid,
                paper_id,
                reddit_post_id,
                source_type,
                credibility_score,
                source_id,
                chunk_index,
                content,
                _metadata_json(metadata_val),
            )
            if not row:
                continue

            staged.append({"id": str(row["id"]), "embedding": chunk.get("embedding")})
            prev = chunk_count_by_doc.get(doc_key, 0)
            if chunk_index + 1 > prev:
                chunk_count_by_doc[doc_key] = chunk_index + 1

        for doc in docs_for_index:
            if not isinstance(doc, dict):
                continue
            source_type = str(doc.get("sourceType") or "").strip()
            source_id = str(doc.get("sourceId") or "").strip()
            if not source_type or not source_id:
                continue
            expected = int(chunk_count_by_doc.get(f"{source_type}::{source_id}", 0))
            await conn.execute(
                '''
                DELETE FROM "rag_chunk"
                WHERE "userId" = $1
                  AND "sourceType" = $2
                  AND "sourceId" = $3
                  AND "chunkIndex" >= $4
                ''',
                uid,
                source_type,
                source_id,
                expected,
            )

        has_origin = any(str((doc or {}).get("sourceType") or "") == "paper_origin" for doc in docs_for_index)
        if not has_origin:
            await conn.execute(
                '''
                DELETE FROM "rag_chunk"
                WHERE "userId" = $1
                  AND "searchId" = $2
                  AND "sourceType" = 'paper_origin'
                ''',
                uid,
                sid,
            )

        if staged:
            for row in staged:
                vector = _vector_literal(row.get("embedding"))
                await conn.execute(
                    '''
                    UPDATE "rag_chunk"
                    SET "embedding" = $1::vector,
                        "embeddingModel" = $2,
                        "updatedAt" = NOW()
                    WHERE "id" = $3
                    ''',
                    vector,
                    str(model or "") if model is not None else None,
                    row.get("id"),
                )

    return {"indexed": True, "chunks": len(staged), "model": model}


# Retrieve and rerank chunks from database.
async def _retrieve_rag_context_from_db(
    *,
    user_id: str,
    question: str,
    search_id: Optional[str] = None,
    k: int = 6,
    intent: Optional[str] = None,
    source_credibility: Optional[Dict[str, float]] = None,
    intent_weights: Optional[Dict[str, Dict[str, float]]] = None,
) -> Dict[str, Any]:
    # Retrieves chunks by vector distance, then reranks by intent and credibility weights.
    uid = str(user_id or "").strip()
    q = str(question or "").strip()
    if not uid:
        raise RuntimeError("Missing userId for RAG retrieval.")
    if not q:
        raise RuntimeError("Question is required.")

    normalized_intent = _normalize_intent(intent, intent_weights)
    hinted_sources = set(_source_hints_from_question(q))
    issue_query = _is_github_issue_question(q)
    top_k = max(1, min(int(k or 6), 20))
    retrieval_pool_k = max(top_k * 3, top_k + 6)
    retrieval_pool_k = min(120, retrieval_pool_k)
    hinted_pool_k = min(60, max(top_k * 4, 12))
    issue_pool_k = min(24, max(top_k, 6))
    embedding = await embed_texts([q])
    qv = _parse_vector((embedding.get("vectors") or [None])[0])
    vector = _vector_literal(qv)
    sid = str(search_id or "").strip()

    pool = await get_pool()
    rows: List[Any] = []
    paper_rows: List[Any] = []
    hinted_rows: List[Any] = []
    issue_rows: List[Any] = []
    issue_fallback_rows: List[Any] = []
    async with pool.acquire() as conn:
        if sid:
            rows = await conn.fetch(
                '''
                SELECT
                  "id",
                  "searchId",
                  "paperId",
                  "redditPostId",
                  "sourceType",
                  "credibilityScore",
                  "sourceId",
                  "content",
                  "metadata",
                  "embeddingModel",
                  ("embedding" <=> $1::vector) AS "distance"
                FROM "rag_chunk"
                WHERE "userId" = $2
                  AND "embedding" IS NOT NULL
                  AND "searchId" = $3
                ORDER BY "embedding" <=> $1::vector
                LIMIT $4
                ''',
                vector,
                uid,
                sid,
                retrieval_pool_k,
            )

            paper_rows = await conn.fetch(
                '''
                SELECT
                  "id",
                  "searchId",
                  "paperId",
                  "redditPostId",
                  "sourceType",
                  "credibilityScore",
                  "sourceId",
                  "content",
                  "metadata",
                  "embeddingModel",
                  ("embedding" <=> $1::vector) AS "distance"
                FROM "rag_chunk"
                WHERE "userId" = $2
                  AND "embedding" IS NOT NULL
                  AND "searchId" = $3
                  AND "sourceType" IN ('paper_origin', 'paper')
                ORDER BY "embedding" <=> $1::vector
                LIMIT 1
                ''',
                vector,
                uid,
                sid,
            )

            if hinted_sources:
                hinted_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      ("embedding" <=> $1::vector) AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $2
                      AND "embedding" IS NOT NULL
                      AND "searchId" = $3
                      AND "sourceType" = ANY($4::text[])
                    ORDER BY "embedding" <=> $1::vector
                    LIMIT $5
                    ''',
                    vector,
                    uid,
                    sid,
                    list(hinted_sources),
                    hinted_pool_k,
                )

            if issue_query:
                issue_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      ("embedding" <=> $1::vector) AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $2
                      AND "embedding" IS NOT NULL
                      AND "searchId" = $3
                      AND (
                        "sourceType" IN ('github_issue_open','github_issue_closed','github_issue')
                        OR COALESCE("metadata"->>'rawType','') = 'issue'
                        OR "sourceId" ILIKE '%/issues/%'
                        OR "content" ILIKE '%Type: issue%'
                        OR "content" ILIKE '%/issues/%'
                      )
                    ORDER BY "embedding" <=> $1::vector
                    LIMIT $4
                    ''',
                    vector,
                    uid,
                    sid,
                    issue_pool_k,
                )
                issue_fallback_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      NULL::double precision AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $1
                      AND "searchId" = $2
                      AND (
                        "sourceType" IN ('github_issue_open','github_issue_closed','github_issue')
                        OR COALESCE("metadata"->>'rawType','') = 'issue'
                        OR "sourceId" ILIKE '%/issues/%'
                        OR "content" ILIKE '%Type: issue%'
                        OR "content" ILIKE '%/issues/%'
                      )
                    ORDER BY "updatedAt" DESC
                    LIMIT $3
                    ''',
                    uid,
                    sid,
                    issue_pool_k,
                )
        else:
            rows = await conn.fetch(
                '''
                SELECT
                  "id",
                  "searchId",
                  "paperId",
                  "redditPostId",
                  "sourceType",
                  "credibilityScore",
                  "sourceId",
                  "content",
                  "metadata",
                  "embeddingModel",
                  ("embedding" <=> $1::vector) AS "distance"
                FROM "rag_chunk"
                WHERE "userId" = $2
                  AND "embedding" IS NOT NULL
                ORDER BY "embedding" <=> $1::vector
                LIMIT $3
                ''',
                vector,
                uid,
                retrieval_pool_k,
            )

            if hinted_sources:
                hinted_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      ("embedding" <=> $1::vector) AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $2
                      AND "embedding" IS NOT NULL
                      AND "sourceType" = ANY($3::text[])
                    ORDER BY "embedding" <=> $1::vector
                    LIMIT $4
                    ''',
                    vector,
                    uid,
                    list(hinted_sources),
                    hinted_pool_k,
                )

            if issue_query:
                issue_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      ("embedding" <=> $1::vector) AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $2
                      AND "embedding" IS NOT NULL
                      AND (
                        "sourceType" IN ('github_issue_open','github_issue_closed','github_issue')
                        OR COALESCE("metadata"->>'rawType','') = 'issue'
                        OR "sourceId" ILIKE '%/issues/%'
                        OR "content" ILIKE '%Type: issue%'
                        OR "content" ILIKE '%/issues/%'
                      )
                    ORDER BY "embedding" <=> $1::vector
                    LIMIT $3
                    ''',
                    vector,
                    uid,
                    issue_pool_k,
                )
                issue_fallback_rows = await conn.fetch(
                    '''
                    SELECT
                      "id",
                      "searchId",
                      "paperId",
                      "redditPostId",
                      "sourceType",
                      "credibilityScore",
                      "sourceId",
                      "content",
                      "metadata",
                      "embeddingModel",
                      NULL::double precision AS "distance"
                    FROM "rag_chunk"
                    WHERE "userId" = $1
                      AND (
                        "sourceType" IN ('github_issue_open','github_issue_closed','github_issue')
                        OR COALESCE("metadata"->>'rawType','') = 'issue'
                        OR "sourceId" ILIKE '%/issues/%'
                        OR "content" ILIKE '%Type: issue%'
                        OR "content" ILIKE '%/issues/%'
                      )
                    ORDER BY "updatedAt" DESC
                    LIMIT $2
                    ''',
                    uid,
                    issue_pool_k,
                )

    merged: List[Dict[str, Any]] = []
    seen = set()
    for row in [*(issue_rows or []), *(issue_fallback_rows or []), *(rows or []), *(paper_rows or []), *(hinted_rows or [])]:
        rid = str(row.get("id") if isinstance(row, dict) else row["id"])
        if not rid or rid in seen:
            continue
        seen.add(rid)
        r = dict(row)
        merged.append(r)

    preferred_sources = set(_preferred_sources_for_intent(normalized_intent, intent_weights))
    if hinted_sources:
        preferred_sources.update(hinted_sources)
    if preferred_sources:
        narrowed = [row for row in merged if str(row.get("sourceType") or "") in preferred_sources]
        if narrowed:
            merged = narrowed

    mapped: List[Dict[str, Any]] = []
    for row in merged:
        distance_raw = row.get("distance")
        try:
            distance = float(distance_raw)
            if not math.isfinite(distance):
                distance = None
        except Exception:
            distance = None
        score = max(0.0, 1.0 - distance) if distance is not None else 0.0
        source_type = str(row.get("sourceType") or "")
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        credibility_score = _source_credibility(
            source_type,
            row.get("credibilityScore")
            if row.get("credibilityScore") is not None
            else metadata.get("credibilityScore"),
            source_credibility,
        )
        source_weight = _source_weight(normalized_intent, source_type, intent_weights)
        if hinted_sources and source_type in hinted_sources:
            hint_boost = _to_float(os.getenv("RAG_HINTED_SOURCE_WEIGHT_BOOST"), 0.20) or 0.20
            source_weight = min(1.25, max(0.0, float(source_weight) + max(0.0, float(hint_boost))))
        if issue_query:
            if _is_github_issue_chunk(source_type, row.get("sourceId"), row.get("content"), metadata):
                source_weight = min(1.5, max(0.0, float(source_weight) + 0.45))
            elif source_type == "github_readme":
                source_weight = min(1.4, max(0.0, float(source_weight) + 0.20))
            elif source_type == "diff_engine":
                source_weight = min(1.35, max(0.0, float(source_weight) + 0.10))
        temporal_weight = _source_temporal_weight(source_type, metadata)
        weighted_score = score * source_weight * credibility_score * temporal_weight
        mapped.append(
            {
                "id": row.get("id"),
                "searchId": row.get("searchId"),
                "paperId": row.get("paperId"),
                "redditPostId": row.get("redditPostId"),
                "sourceType": source_type,
                "sourceId": row.get("sourceId"),
                "content": row.get("content"),
                "metadata": metadata,
                "distance": distance,
                "score": score,
                "sourceWeight": source_weight,
                "credibilityScore": credibility_score,
                "temporalWeight": temporal_weight,
                "weightedScore": weighted_score,
                "embeddingModel": row.get("embeddingModel") or embedding.get("model"),
            }
        )

    mapped.sort(
        key=lambda x: (
            -(float(x.get("weightedScore") or 0.0)),
            x.get("distance") if isinstance(x.get("distance"), (int, float)) else 999.0,
        )
    )
    out_chunks = mapped[:top_k]

    if issue_query:
        issue_candidates = [
            x
            for x in mapped
            if _is_github_issue_chunk(
                x.get("sourceType"),
                x.get("sourceId"),
                x.get("content"),
                x.get("metadata"),
            )
        ]
        if issue_candidates:
            must_keep = min(max(1, top_k // 2), 4)
            keep = issue_candidates[:must_keep]
            merged_chunks: List[Dict[str, Any]] = []
            seen_ids = set()
            for row in [*keep, *out_chunks, *mapped]:
                rid = str(row.get("id") or "")
                if not rid or rid in seen_ids:
                    continue
                seen_ids.add(rid)
                merged_chunks.append(row)
                if len(merged_chunks) >= top_k:
                    break
            out_chunks = merged_chunks

    best_paper = next(
        (x for x in mapped if str(x.get("sourceType") or "") in {"paper_origin", "paper"}),
        None,
    )
    if best_paper and not any(str(x.get("sourceType") or "") in {"paper_origin", "paper"} for x in out_chunks):
        out_chunks = out_chunks[: max(0, top_k - 1)] + [best_paper]
        out_chunks.sort(
            key=lambda x: (
                -(float(x.get("weightedScore") or 0.0)),
                x.get("distance") if isinstance(x.get("distance"), (int, float)) else 999.0,
            )
        )

    return {"model": embedding.get("model"), "chunks": out_chunks, "intent": normalized_intent}


# Run full RAG flow and return answer plus audit.
async def query_rag_from_db(
    *,
    user_id: str,
    question: str,
    search_id: Optional[str] = None,
    k: int = 6,
    answer: bool = True,
    intent: Optional[str] = None,
    history: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    # Runs the full RAG query: intent resolve -> retrieve -> quote extract -> synthesize.
    source_credibility_map, intent_weights_map = await get_rag_weight_config()
    effective_question = _compose_contextual_question(question, history)
    intent_meta = await _resolve_query_intent(effective_question, intent, intent_weights_map)
    normalized_intent = _normalize_intent(intent_meta.get("intent"), intent_weights_map)
    ctx = await _retrieve_rag_context_from_db(
        user_id=user_id,
        question=effective_question,
        search_id=search_id,
        k=k,
        intent=normalized_intent,
        source_credibility=source_credibility_map,
        intent_weights=intent_weights_map,
    )
    rag_answer = ""
    answer_model = None
    quote_chunks: List[Dict[str, Any]] = []
    if answer and _is_github_issue_question(effective_question) and not (ctx.get("chunks") or []):
        rag_answer = _render_missing_github_issue_answer([])
        answer_model = "rule_github_issue_renderer_v1_empty"
    if answer and isinstance(ctx.get("chunks"), list) and ctx.get("chunks"):
        if _is_github_issue_question(effective_question):
            direct = _render_github_issue_answer(ctx.get("chunks") or [])
            if direct:
                rag_answer = direct
                answer_model = "rule_github_issue_renderer_v1"
                quote_chunks = [
                    {
                        "sourceType": c.get("sourceType"),
                        "sourceId": c.get("sourceId"),
                        "content": str(c.get("content") or "")[:420],
                        "score": c.get("score"),
                        "weightedScore": c.get("weightedScore"),
                        "credibilityScore": c.get("credibilityScore"),
                        "metadata": c.get("metadata") if isinstance(c.get("metadata"), dict) else {},
                    }
                    for c in (ctx.get("chunks") or [])[:6]
                ]
            else:
                rag_answer = _render_missing_github_issue_answer(ctx.get("chunks") or [])
                answer_model = "rule_github_issue_renderer_v1_empty"
                quote_chunks = [
                    {
                        "sourceType": c.get("sourceType"),
                        "sourceId": c.get("sourceId"),
                        "content": str(c.get("content") or "")[:420],
                        "score": c.get("score"),
                        "weightedScore": c.get("weightedScore"),
                        "credibilityScore": c.get("credibilityScore"),
                        "metadata": c.get("metadata") if isinstance(c.get("metadata"), dict) else {},
                    }
                    for c in (ctx.get("chunks") or [])[:6]
                ]

        if not rag_answer:
            extracted = await _extract_quote_chunks(
                question=effective_question,
                chunks=ctx.get("chunks") or [],
                intent=normalized_intent,
            )
            quote_chunks = extracted.get("chunks") if isinstance(extracted.get("chunks"), list) else []
            out = await _synthesize_from_quotes(
                question=effective_question,
                quote_chunks=quote_chunks,
                intent=normalized_intent,
            )
            rag_answer = str(out.get("answer") or "")
            answer_model = out.get("model") or extracted.get("model")
    confidence = _compute_confidence(ctx.get("chunks") or [], source_credibility_map)
    conflicts = _extract_conflicts(ctx.get("chunks") or [])
    return {
        "question": question,
        "answer": rag_answer,
        "answerModel": answer_model,
        "embeddingModel": ctx.get("model"),
        "intent": ctx.get("intent") or normalized_intent,
        "intent_source": intent_meta.get("source"),
        "intent_model": intent_meta.get("model"),
        "confidence": confidence,
        "conflicts_detected": conflicts,
        "audit": _build_audit(ctx.get("chunks") or [], source_credibility_map),
        "quotes": quote_chunks,
        "chunks": ctx.get("chunks") or [],
        "count": len(ctx.get("chunks") or []),
    }
