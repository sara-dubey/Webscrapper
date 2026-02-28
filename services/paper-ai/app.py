# services/paper-ai/app.py
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from llm.summarize_paper import build_paper_blocks, build_paper_summary
from llm.rag_pipeline import (
    prepare_ingest_chunks,
    index_rag_to_db,
    query_rag_from_db,
)
from llm.ollama_client import get_ollama_status
from llm.mcp_layer import get_llm_status
from rag_db import close_pool
from observability import (
    estimate_tokens,
    inc_error,
    json_log,
    make_request_id,
    observe_output_tokens,
    render_metrics,
    request_duration_seconds,
)

def _load_local_env() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key:
                continue
            value = value.strip()
            if value and ((value[0] == value[-1]) and value[0] in {"'", '"'}):
                value = value[1:-1]
            os.environ.setdefault(key, value)
    except Exception:
        # Do not block startup if .env parsing fails.
        return


_load_local_env()

app = FastAPI(title="paper-ai")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct")
OLLAMA_TIMEOUT_SECS = int(os.getenv("OLLAMA_TIMEOUT_SECS", "120"))


class PaperBlocksReq(BaseModel):
    topic: str = Field(..., min_length=1)
    paper: Dict[str, Any]
    candidates: Optional[List[Dict[str, Any]]] = None
    reddit_threads: Optional[List[Dict[str, Any]]] = None


class PaperSummaryReq(BaseModel):
    topic: str = Field(..., min_length=1)
    paper: Dict[str, Any]
    candidates: Optional[List[Dict[str, Any]]] = None
    openreview_rows: Optional[List[Dict[str, Any]]] = None


class EvidencePaperReq(BaseModel):
    doi: Optional[str] = None
    title: Optional[str] = None
    arxivId: Optional[str] = None
    fullText: Optional[str] = None


class EvidenceSourcesReq(BaseModel):
    semantic_scholar: List[Dict[str, Any]] = Field(default_factory=list)
    github: List[Dict[str, Any]] = Field(default_factory=list)
    openreview: List[Dict[str, Any]] = Field(default_factory=list)
    huggingface: List[Dict[str, Any]] = Field(default_factory=list)
    reddit: List[Dict[str, Any]] = Field(default_factory=list)


class EvidenceIngestReq(BaseModel):
    paper: EvidencePaperReq
    sources: EvidenceSourcesReq


class RagIngestDoc(BaseModel):
    sourceType: str = Field(..., min_length=1)
    sourceId: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    metadata: Optional[Dict[str, Any]] = None


class RagIngestReq(BaseModel):
    docs: List[RagIngestDoc] = Field(default_factory=list)
    maxChars: Optional[int] = None
    overlapChars: Optional[int] = None


class RagIndexDbDoc(BaseModel):
    sourceType: str = Field(..., min_length=1)
    sourceId: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    paperId: Optional[str] = None
    redditPostId: Optional[str] = None
    credibilityScore: Optional[float] = None
    metadata: Optional[Dict[str, Any]] = None


class RagIndexDbReq(BaseModel):
    userId: str = Field(..., min_length=1)
    searchId: str = Field(..., min_length=1)
    docs: List[RagIndexDbDoc] = Field(default_factory=list)
    maxChars: Optional[int] = None
    overlapChars: Optional[int] = None


class RagQueryDbReq(BaseModel):
    userId: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    searchId: Optional[str] = None
    k: Optional[int] = Field(default=6, ge=1, le=20)
    answer: Optional[bool] = True
    intent: Optional[str] = None
    history: Optional[List[Dict[str, Any]]] = None


@app.middleware("http")
async def request_observability(request: Request, call_next):
    request_id = make_request_id(request.headers.get("x-request-id"))
    start = time.perf_counter()
    route = request.url.path
    method = request.method

    try:
        response = await call_next(request)
    except Exception as exc:
        elapsed = max(0.0, time.perf_counter() - start)
        request_duration_seconds.observe({"route": route, "method": method}, elapsed)
        inc_error(exc.__class__.__name__)
        json_log(
            "request_error",
            request_id=request_id,
            route=route,
            method=method,
            error_class=exc.__class__.__name__,
            error=str(exc),
            duration_ms=round(elapsed * 1000, 2),
        )
        raise

    elapsed = max(0.0, time.perf_counter() - start)
    request_duration_seconds.observe({"route": route, "method": method}, elapsed)
    response.headers["x-request-id"] = request_id
    if response.status_code >= 500:
        inc_error(f"http_{response.status_code}")

    json_log(
        "request_complete",
        request_id=request_id,
        route=route,
        method=method,
        status=response.status_code,
        duration_ms=round(elapsed * 1000, 2),
    )
    return response


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "paper-ai",
        "llm": get_llm_status(),
        "ollama": get_ollama_status(),
    }


@app.get("/metrics")
def metrics():
    return PlainTextResponse(
        render_metrics(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


# LEGACY (keep for backward compatibility)
@app.post("/paper_blocks")
async def paper_blocks(req: PaperBlocksReq, request: Request):
    try:
        blocks = await build_paper_blocks(
            topic=req.topic,
            paper=req.paper,
            candidates=req.candidates or [],
            reddit_threads=req.reddit_threads or [],
            ollama_base=OLLAMA_BASE,
            ollama_model=OLLAMA_MODEL,
            timeout_secs=OLLAMA_TIMEOUT_SECS,
        )
        return {"ok": True, "blocks": blocks}
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "paper_blocks_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


# NEW: minimal output for your simplified UI/API contract
@app.post("/paper_summary")
async def paper_summary(req: PaperSummaryReq, request: Request):
    try:
        out = await build_paper_summary(
            topic=req.topic,
            paper=req.paper,
            candidates=req.candidates or [],
            openreview_rows=req.openreview_rows or [],
            ollama_base=OLLAMA_BASE,
            ollama_model=OLLAMA_MODEL,
            timeout_secs=OLLAMA_TIMEOUT_SECS,
        )
        token_count = estimate_tokens(str(out.get("summary") or ""))
        observe_output_tokens("summary", token_count)
        return {"ok": True, **out}
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "paper_summary_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/ingest")
async def ingest(req: EvidenceIngestReq, request: Request):
    try:
        by_source = {
            "semantic_scholar": len(req.sources.semantic_scholar),
            "github": len(req.sources.github),
            "openreview": len(req.sources.openreview),
            "huggingface": len(req.sources.huggingface),
            "reddit": len(req.sources.reddit),
        }
        total_rows = sum(by_source.values())
        return {
            "ok": True,
            "summary": {
                "total_rows": total_rows,
                "by_source": by_source,
                "paper": {
                    "doi": req.paper.doi,
                    "title": req.paper.title,
                    "arxivId": req.paper.arxivId,
                    "has_full_text": bool(req.paper.fullText),
                },
            },
        }
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "ingest_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/rag/ingest")
async def rag_ingest(req: RagIngestReq, request: Request):
    try:
        docs = [doc.dict() for doc in req.docs]
        out = await prepare_ingest_chunks(
            docs,
            max_chars=req.maxChars,
            overlap_chars=req.overlapChars,
        )
        return {"ok": True, **out}
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "rag_ingest_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/rag/index-db")
async def rag_index_db(req: RagIndexDbReq, request: Request):
    try:
        docs = [doc.dict() for doc in req.docs]
        out = await index_rag_to_db(
            user_id=req.userId,
            search_id=req.searchId,
            docs=docs,
            max_chars=req.maxChars,
            overlap_chars=req.overlapChars,
        )
        return {"ok": True, **out}
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "rag_index_db_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/rag/query-db")
async def rag_query_db(req: RagQueryDbReq, request: Request):
    try:
        out = await query_rag_from_db(
            user_id=req.userId,
            question=req.question,
            search_id=req.searchId,
            k=req.k or 6,
            answer=bool(req.answer),
            intent=req.intent,
            history=req.history or [],
        )
        return {"ok": True, **out}
    except Exception as e:
        inc_error(e.__class__.__name__)
        json_log(
            "rag_query_db_failed",
            request_id=make_request_id(request.headers.get("x-request-id")),
            error_class=e.__class__.__name__,
            error=str(e),
        )
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.on_event("shutdown")
async def _shutdown() -> None:
    await close_pool()
