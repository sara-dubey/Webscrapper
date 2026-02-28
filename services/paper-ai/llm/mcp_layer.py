from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

import httpx

from llm.ollama_client import chat_json
from observability import inc_error, observe_ollama_latency
from utils.json_tools import loads_best_effort


def _clean_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode in {"local", "api"}:
        return mode
    return "local"


def _clean_kind(value: str, fallback: str = "openai") -> str:
    kind = str(value or "").strip().lower()
    if kind in {"openai", "anthropic", "gemini"}:
        return kind
    return fallback


def _resolve_api_kind() -> str:
    return _clean_kind(
        os.getenv("API_LLM_CHAT_KIND") or os.getenv("API_LLM_KIND") or "openai",
        "openai",
    )


def _default_api_base(kind: str) -> str:
    if kind == "anthropic":
        return "https://api.anthropic.com"
    if kind == "gemini":
        return "https://generativelanguage.googleapis.com"
    return "https://api.openai.com"


def _resolve_api_base(kind: str) -> str:
    return str(os.getenv("API_LLM_BASE_URL") or _default_api_base(kind)).strip().rstrip("/")


def _resolve_api_key(kind: str) -> str:
    explicit = str(os.getenv("API_LLM_API_KEY", "")).strip()
    if explicit:
        return explicit
    if kind == "anthropic":
        return str(os.getenv("ANTHROPIC_API_KEY", "")).strip()
    if kind == "gemini":
        return str(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
    return str(os.getenv("OPENAI_API_KEY", "")).strip()


def _require_api_key(kind: str) -> str:
    key = _resolve_api_key(kind)
    if key:
        return key
    if kind == "anthropic":
        raise RuntimeError("Missing API key for Anthropic. Set API_LLM_API_KEY or ANTHROPIC_API_KEY.")
    if kind == "gemini":
        raise RuntimeError("Missing API key for Gemini. Set API_LLM_API_KEY or GEMINI_API_KEY.")
    raise RuntimeError("Missing API key for API mode. Set API_LLM_API_KEY.")


def _resolve_chat_model(kind: str, model: Optional[str]) -> str:
    default_model = (
        "claude-3-5-sonnet-latest"
        if kind == "anthropic"
        else "gemini-1.5-flash"
        if kind == "gemini"
        else "gpt-4o-mini"
    )
    resolved = str(model or os.getenv("API_LLM_CHAT_MODEL") or os.getenv("API_LLM_MODEL") or default_model).strip()
    if not resolved:
        raise RuntimeError("API_LLM_CHAT_MODEL (or API_LLM_MODEL) is required when LLM_MODE=api.")
    return resolved


def _resolve_chat_path(kind: str, model: str) -> str:
    custom = str(os.getenv("API_LLM_CHAT_PATH", "")).strip()
    if custom:
        return custom if custom.startswith("/") else f"/{custom}"
    if kind == "anthropic":
        return "/v1/messages"
    if kind == "gemini":
        return f"/v1beta/models/{quote(model, safe='-_.')}:" + "generateContent"
    return "/v1/chat/completions"


def _build_api_headers(kind: str, key: str) -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if kind == "anthropic":
        headers["x-api-key"] = key
        headers["anthropic-version"] = str(
            os.getenv("API_LLM_ANTHROPIC_VERSION") or os.getenv("ANTHROPIC_VERSION") or "2023-06-01"
        ).strip()
        return headers
    if kind == "gemini":
        headers["x-goog-api-key"] = key
        return headers
    headers["Authorization"] = f"Bearer {key}"
    return headers


def _extract_openai_content(data: Dict[str, Any]) -> str:
    msg = ((data or {}).get("choices") or [{}])[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "\n".join(parts).strip()
    return ""


def _extract_anthropic_content(data: Dict[str, Any]) -> str:
    blocks = (data or {}).get("content")
    if not isinstance(blocks, list):
        return ""
    text_parts = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            text_parts.append(block["text"])
    return "\n".join(text_parts).strip()


def _extract_gemini_content(data: Dict[str, Any]) -> str:
    candidates = (data or {}).get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    cand = candidates[0] if isinstance(candidates[0], dict) else {}
    content = cand.get("content") if isinstance(cand.get("content"), dict) else {}
    parts = content.get("parts") if isinstance(content.get("parts"), list) else []
    text_parts = []
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            text_parts.append(part["text"])
    if text_parts:
        return "\n".join(text_parts).strip()
    fallback = cand.get("output_text")
    return str(fallback or "").strip()


def _extract_text(kind: str, data: Dict[str, Any]) -> str:
    if kind == "anthropic":
        return _extract_anthropic_content(data)
    if kind == "gemini":
        return _extract_gemini_content(data)
    return _extract_openai_content(data)


def _build_chat_payload(kind: str, *, model: str, prompt: str, temperature: float, top_p: float) -> Dict[str, Any]:
    system = "You MUST output only valid JSON. No markdown. No extra text."
    max_tokens = int(os.getenv("API_LLM_MAX_TOKENS", "1200"))
    if kind == "anthropic":
        return {
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
    if kind == "gemini":
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "topP": top_p,
                "maxOutputTokens": max_tokens,
            },
        }
    return {
        "model": model,
        "temperature": temperature,
        "top_p": top_p,
        "messages": [
            {
                "role": "system",
                "content": system,
            },
            {"role": "user", "content": prompt},
        ],
    }


async def _chat_json_api(
    *,
    prompt: str,
    model: Optional[str] = None,
    timeout_secs: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
) -> Dict[str, Any]:
    kind = _resolve_api_kind()
    resolved_model = _resolve_chat_model(kind, model)
    resolved_timeout = int(timeout_secs or int(os.getenv("API_LLM_TIMEOUT_SECS", "120")))
    resolved_temperature = float(temperature if temperature is not None else os.getenv("API_LLM_TEMPERATURE", "0.2"))
    resolved_top_p = float(top_p if top_p is not None else os.getenv("API_LLM_TOP_P", "0.9"))

    key = _require_api_key(kind)
    base = _resolve_api_base(kind)
    path = _resolve_chat_path(kind, resolved_model)
    url = f"{base}{path if path.startswith('/') else f'/{path}'}"
    payload = _build_chat_payload(
        kind,
        model=resolved_model,
        prompt=prompt,
        temperature=resolved_temperature,
        top_p=resolved_top_p,
    )

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=resolved_timeout) as client:
            r = await client.post(url, json=payload, headers=_build_api_headers(kind, key))
            r.raise_for_status()
            data = r.json()
        observe_ollama_latency(resolved_model, max(0.0, time.perf_counter() - started))

        content = _extract_text(kind, data if isinstance(data, dict) else {})
        if not content:
            raise RuntimeError("API provider returned empty content")
        return loads_best_effort(content)
    except Exception as e:
        observe_ollama_latency(resolved_model, max(0.0, time.perf_counter() - started))
        inc_error(e.__class__.__name__)
        raise


async def run_via_mcp_layer(
    *,
    capability: str,
    provider: str,
    prompt: str,
    base: Optional[str] = None,
    model: Optional[str] = None,
    timeout_secs: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    num_ctx: Optional[int] = None,
    retries: int = 1,
) -> Dict[str, Any]:
    _ = (capability, provider)
    mode = _clean_mode(os.getenv("LLM_MODE", "local"))
    if mode == "api":
        return await _chat_json_api(
            prompt=prompt,
            model=model,
            timeout_secs=timeout_secs,
            temperature=temperature,
            top_p=top_p,
        )
    return await chat_json(
        prompt=prompt,
        base=base,
        model=model,
        timeout_secs=timeout_secs,
        temperature=temperature,
        top_p=top_p,
        num_ctx=num_ctx,
        retries=retries,
    )


def get_llm_status() -> Dict[str, Any]:
    mode = _clean_mode(os.getenv("LLM_MODE", "local"))
    status: Dict[str, Any] = {
        "mode": mode,
        "local": {
            "base": str(os.getenv("OLLAMA_BASE", "http://127.0.0.1:11434")).strip(),
            "model": str(os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct")).strip(),
        },
    }
    if mode == "api":
        kind = _resolve_api_kind()
        status["api"] = {
            "kind": kind,
            "base": _resolve_api_base(kind),
            "chat_path": _resolve_chat_path(kind, _resolve_chat_model(kind, None)),
            "model": _resolve_chat_model(kind, None),
            "auth_configured": bool(_resolve_api_key(kind)),
        }
    return status

