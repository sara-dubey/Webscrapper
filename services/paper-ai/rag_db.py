from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

try:
    import asyncpg  # type: ignore
except Exception:  # pragma: no cover
    asyncpg = None

_pool: Optional[Any] = None
_pool_lock = asyncio.Lock()


def _require_asyncpg() -> Any:
    if asyncpg is None:
        raise RuntimeError("asyncpg is required for DB-backed RAG endpoints. Install asyncpg in paper-ai env.")
    return asyncpg


def _resolve_database_url() -> str:
    url = str(os.getenv("DATABASE_URL", "")).strip()
    if url:
        return url
    raise RuntimeError("DATABASE_URL is required for DB-backed RAG endpoints.")


async def get_pool():
    global _pool
    pg = _require_asyncpg()

    if _pool is not None and not _pool._closed:  # pylint: disable=protected-access
        return _pool

    async with _pool_lock:
        if _pool is not None and not _pool._closed:  # pylint: disable=protected-access
            return _pool
        _pool = await pg.create_pool(
            dsn=_resolve_database_url(),
            min_size=max(1, int(os.getenv("RAG_DB_POOL_MIN", "1"))),
            max_size=max(1, int(os.getenv("RAG_DB_POOL_MAX", "8"))),
            command_timeout=max(5, int(os.getenv("RAG_DB_COMMAND_TIMEOUT_SECS", "120"))),
        )
        return _pool


async def close_pool() -> None:
    global _pool
    if _pool is None:
        return
    try:
        await _pool.close()
    finally:
        _pool = None

