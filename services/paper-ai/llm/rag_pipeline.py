from __future__ import annotations

from typing import Any, Dict, List, Optional

from llm.rag_core import (
    index_rag_to_db as _index_rag_to_db,
    prepare_ingest_chunks as _prepare_ingest_chunks,
    query_rag_from_db as _query_rag_from_db,
)


async def prepare_ingest_chunks(
    docs: List[Dict[str, Any]],
    *,
    max_chars: Optional[int] = None,
    overlap_chars: Optional[int] = None,
) -> Dict[str, Any]:
    # Splits documents into chunks and embeds them before DB write.
    return await _prepare_ingest_chunks(
        docs,
        max_chars=max_chars,
        overlap_chars=overlap_chars,
    )


async def index_rag_to_db(
    *,
    user_id: str,
    search_id: str,
    docs: List[Dict[str, Any]],
    max_chars: Optional[int] = None,
    overlap_chars: Optional[int] = None,
) -> Dict[str, Any]:
    # Stores prepared chunks and embeddings into RagChunk rows.
    return await _index_rag_to_db(
        user_id=user_id,
        search_id=search_id,
        docs=docs,
        max_chars=max_chars,
        overlap_chars=overlap_chars,
    )


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
    # Runs retrieval + synthesis and returns answer with audit metadata.
    return await _query_rag_from_db(
        user_id=user_id,
        question=question,
        search_id=search_id,
        k=k,
        answer=answer,
        intent=intent,
        history=history,
    )


__all__ = ["prepare_ingest_chunks", "index_rag_to_db", "query_rag_from_db"]
