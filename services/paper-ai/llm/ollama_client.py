# services/paper-ai/llm/ollama_client.py
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

import httpx

from utils.json_tools import loads_best_effort
from observability import inc_error, inc_ollama_timeout, observe_ollama_latency

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct")
OLLAMA_TIMEOUT_SECS = int(os.getenv("OLLAMA_TIMEOUT_SECS", "120"))

# Small, safe defaults for 16GB laptops
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
OLLAMA_TEMPERATURE = float(os.getenv("OLLAMA_TEMPERATURE", "0.2"))
OLLAMA_TOP_P = float(os.getenv("OLLAMA_TOP_P", "0.9"))


def get_ollama_status() -> Dict[str, Any]:
    return {
        "base": OLLAMA_BASE,
        "model": OLLAMA_MODEL,
        "timeout_secs": OLLAMA_TIMEOUT_SECS,
        "num_ctx": OLLAMA_NUM_CTX,
        "temperature": OLLAMA_TEMPERATURE,
        "top_p": OLLAMA_TOP_P,
    }


async def chat_json(
    *,
    prompt: str,
    base: Optional[str] = None,
    model: Optional[str] = None,
    timeout_secs: Optional[int] = None,
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    num_ctx: Optional[int] = None,
    retries: int = 1,
) -> Dict[str, Any]:
    """
    Calls Ollama /api/chat and forces JSON output (best-effort).
    Returns parsed JSON dict.

    Robustness:
    - Strips code fences / extracts JSON object if the model adds extra text.
    - Retries once on transient HTTP errors/timeouts.
    """
    base = (base or OLLAMA_BASE).rstrip("/")
    model = model or OLLAMA_MODEL
    timeout_secs = int(timeout_secs or OLLAMA_TIMEOUT_SECS)
    temperature = float(temperature if temperature is not None else OLLAMA_TEMPERATURE)
    top_p = float(top_p if top_p is not None else OLLAMA_TOP_P)
    num_ctx = int(num_ctx if num_ctx is not None else OLLAMA_NUM_CTX)

    url = f"{base}/api/chat"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You MUST output only valid JSON. No markdown. No extra text.",
            },
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": temperature,
            "top_p": top_p,
            "num_ctx": num_ctx,
        },
    }

    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            call_started = time.perf_counter()
            async with httpx.AsyncClient(timeout=timeout_secs) as client:
                r = await client.post(url, json=payload)
                r.raise_for_status()
                data = r.json()
            observe_ollama_latency(model, max(0.0, time.perf_counter() - call_started))

            content = None
            if isinstance(data, dict):
                msg = data.get("message")
                if isinstance(msg, dict):
                    content = msg.get("content")

            if not content or not str(content).strip():
                raise RuntimeError("Ollama returned empty content")

            return loads_best_effort(str(content))

        except Exception as e:
            last_err = e
            elapsed = max(0.0, time.perf_counter() - call_started) if "call_started" in locals() else 0.0
            observe_ollama_latency(model, elapsed)
            if isinstance(e, httpx.TimeoutException) or "timed out" in str(e).lower():
                inc_ollama_timeout(model)
            inc_error(e.__class__.__name__)
            if attempt >= retries:
                break

    raise RuntimeError(f"Ollama chat_json failed after retries. Last error: {last_err}")
