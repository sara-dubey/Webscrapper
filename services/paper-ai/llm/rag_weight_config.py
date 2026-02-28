from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Tuple

from rag_db import get_pool

# Default values used when DB config is missing or invalid.
DEFAULT_SOURCE_CREDIBILITY: Dict[str, float] = {
    "paper": 0.85,
    "paper_origin": 0.85,
    "openreview_review": 0.80,
    "openreview_rebuttal": 0.60,
    "github_readme": 0.75,
    "github_issue_open": 0.50,
    "github_issue_closed": 0.70,
    "huggingface": 0.65,
    "reddit": 0.35,
    "semantic_scholar_citation": 0.70,
    "diff_engine": 0.90,
}

# Default intent-to-source weights used for retrieval reranking.
DEFAULT_INTENT_WEIGHTS: Dict[str, Dict[str, float]] = {
    "CONCEPTUAL": {
        "paper": 1.0,
        "paper_origin": 0.9,
        "openreview_review": 0.7,
        "semantic_scholar_citation": 0.75,
    },
    "REPRODUCIBILITY": {
        "diff_engine": 1.0,
        "github_issue_open": 0.9,
        "github_issue_closed": 0.85,
        "github_readme": 0.8,
        "openreview_review": 0.8,
        "openreview_rebuttal": 0.7,
    },
    "COMMUNITY": {
        "reddit": 0.8,
        "openreview_review": 0.8,
        "openreview_rebuttal": 0.7,
        "huggingface": 0.6,
    },
    "DEPENDENCIES": {
        "diff_engine": 1.0,
        "github_issue_open": 0.9,
        "github_issue_closed": 0.85,
        "github_readme": 0.8,
    },
    "COMPARISON": {
        "paper": 0.8,
        "paper_origin": 0.7,
        "semantic_scholar_citation": 0.8,
        "openreview_review": 0.75,
    },
}

_CONFIG_CACHE: Dict[str, Any] = {
    "loaded_at": 0.0,
    "source_credibility": dict(DEFAULT_SOURCE_CREDIBILITY),
    "intent_weights": dict(DEFAULT_INTENT_WEIGHTS),
}


# Converts arbitrary JSON-like values to bounded floats.
def _to_float01(value: Any, fallback: float) -> float:
    try:
        n = float(value)
    except Exception:
        return fallback
    if n < 0:
        return 0.0
    if n > 1:
        return 1.0
    return n


# Parses JSON content safely whether it comes as dict or string.
def _to_json_obj(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return {}
        try:
            out = json.loads(s)
            return out if isinstance(out, dict) else {}
        except Exception:
            return {}
    return {}


# Unwraps admin_config payloads like {"value": {...}} when present.
def _unwrap_admin_value(value: Any) -> Any:
    obj = _to_json_obj(value)
    if isinstance(obj.get("value"), dict):
        return obj.get("value")
    return obj


# Validates and normalizes source credibility map from DB payload.
def _normalize_source_credibility(raw: Any) -> Dict[str, float]:
    obj = _unwrap_admin_value(raw)
    if not obj:
        return dict(DEFAULT_SOURCE_CREDIBILITY)
    out: Dict[str, float] = {}
    for key, value in obj.items():
        k = str(key or "").strip()
        if not k:
            continue
        out[k] = _to_float01(value, DEFAULT_SOURCE_CREDIBILITY.get(k, 0.5))
    if not out:
        return dict(DEFAULT_SOURCE_CREDIBILITY)
    merged = dict(DEFAULT_SOURCE_CREDIBILITY)
    merged.update(out)
    return merged


# Validates and normalizes intent weights map from DB payload.
def _normalize_intent_weights(raw: Any) -> Dict[str, Dict[str, float]]:
    obj = _unwrap_admin_value(raw)
    if not obj:
        return dict(DEFAULT_INTENT_WEIGHTS)

    normalized: Dict[str, Dict[str, float]] = {}
    for intent, weights in obj.items():
        label = str(intent or "").strip().upper()
        if not label:
            continue
        if not isinstance(weights, dict):
            continue
        row: Dict[str, float] = {}
        for source_type, weight in weights.items():
            source = str(source_type or "").strip()
            if not source:
                continue
            row[source] = _to_float01(weight, 0.55)
        if row:
            normalized[label] = row

    if not normalized:
        return dict(DEFAULT_INTENT_WEIGHTS)
    merged = dict(DEFAULT_INTENT_WEIGHTS)
    merged.update(normalized)
    return merged


# Reads weight config rows from admin_config table.
async def _fetch_weight_rows_from_db() -> Dict[str, Any]:
    pool = await get_pool()
    keys = ["rag_source_credibility", "rag_intent_weights"]
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            '''
            SELECT "key", "value_json"
            FROM "admin_config"
            WHERE "key" = ANY($1::text[])
            ''',
            keys,
        )
    out: Dict[str, Any] = {}
    for row in rows or []:
        key = str(row["key"]) if row and "key" in row else ""
        if not key:
            continue
        out[key] = row["value_json"]
    return out


# Returns DB-backed weights with TTL cache and safe fallback defaults.
async def get_rag_weight_config() -> Tuple[Dict[str, float], Dict[str, Dict[str, float]]]:
    ttl_sec = max(5, int(os.getenv("RAG_WEIGHT_CONFIG_TTL_SEC", "300")))
    now = time.time()
    loaded_at = float(_CONFIG_CACHE.get("loaded_at") or 0.0)
    if now - loaded_at <= ttl_sec:
        return (
            dict(_CONFIG_CACHE.get("source_credibility") or DEFAULT_SOURCE_CREDIBILITY),
            dict(_CONFIG_CACHE.get("intent_weights") or DEFAULT_INTENT_WEIGHTS),
        )

    try:
        rows = await _fetch_weight_rows_from_db()
        source_credibility = _normalize_source_credibility(rows.get("rag_source_credibility"))
        intent_weights = _normalize_intent_weights(rows.get("rag_intent_weights"))
        _CONFIG_CACHE["loaded_at"] = now
        _CONFIG_CACHE["source_credibility"] = source_credibility
        _CONFIG_CACHE["intent_weights"] = intent_weights
        return dict(source_credibility), dict(intent_weights)
    except Exception:
        return (
            dict(_CONFIG_CACHE.get("source_credibility") or DEFAULT_SOURCE_CREDIBILITY),
            dict(_CONFIG_CACHE.get("intent_weights") or DEFAULT_INTENT_WEIGHTS),
        )
