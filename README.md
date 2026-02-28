# PAPER-AI (Rivel Research Cockpit)

A multi-service research app for finding papers, summarizing them, reading related Reddit signals, asking RAG questions, and saving PDF highlights across sessions.

Production go-live checklist:
- `/Users/saradubey/Desktop/Scraper/PRODUCTION_TEST_CHECKLIST.md`

## What You Get

- Public home screen + auth screens (`Home`, `Login`, `Create User`, `Forgot Password`, `Reset Password`)
- Email/password auth with:
  - Email verification code for signup
  - Password policy checks
  - Password reset via emailed link
- Google OAuth login
- Logged-in dashboard with:
  - Search + insights
  - History
  - PDF preview + highlights
  - Floating AI assistant: **Lily**
- RAG indexing and retrieval over saved paper + Reddit content using PostgreSQL + `pgvector`
- API rate limiting (Redis-backed, with automatic in-memory fallback)

---

## Tech Stack

- Frontend: Next.js (App Router), React, TypeScript, CSS
- API: Node.js, Express, Prisma ORM, Zod
- Database: PostgreSQL + `pgvector`
- AI services:
  - FastAPI (Python) for paper summarization
  - Ollama (local) or API providers (OpenAI/Anthropic/Gemini) for embeddings/chat
- Auth/Security: JWT, bcrypt, Google OAuth2
- Email: Nodemailer (SMTP or console mode for local dev)
- Caching: Redis + in-memory fallback (LRU)
- Rate limiting: Redis distributed counters + memory fallback
- Queueing: Redis-backed summary queue + memory fallback

---

## Repository Structure

```text
/Users/saradubey/Desktop/Scraper
├─ apps/
│  └─ web-ssr/               # Next.js frontend (active UI)
├─ services/
│  ├─ scraper-api/           # Node/Express API + Prisma
│  └─ paper-ai/              # Python FastAPI summarization service
└─ scraper-frontend/         # Legacy Vite frontend (optional/older)
```

---

## Prerequisites

- Node.js 18+ (20+ recommended)
- Python 3.10+
- PostgreSQL 15+ with `pgvector` extension
- Optional but recommended:
  - Redis (for distributed cache, rate limits, and queueing)
  - Ollama (for local LLM/embedding models)

---

## 1) Database Setup (Postgres + pgvector)

If you use Docker:

```bash
docker run --name paperdb \
  -e POSTGRES_USER=paperuser \
  -e POSTGRES_PASSWORD=paperpass \
  -e POSTGRES_DB=paperdb \
  -p 5432:5432 \
  -d pgvector/pgvector:pg16
```

> `pgvector` is also created by migration `20260215201500_add_rag_chunks_pgvector`.

---

## 2) Configure Environment Variables

### API env (`/Users/saradubey/Desktop/Scraper/services/scraper-api/.env`)

Minimum:

```bash
PORT=3001
CORS_ORIGIN=http://localhost:3000
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://paperuser:paperpass@localhost:5432/paperdb?schema=public
JWT_ACCESS_SECRET=replace_with_long_secret
PY_BASE=http://127.0.0.1:8000
```

Email (choose one mode):

```bash
# Option A: real SMTP (production-like)
AUTH_EMAIL_MODE=smtp
SMTP_SERVICE=gmail
SMTP_USER=your-dev-email@example.com
SMTP_PASS=your_app_password_or_provider_password
SMTP_FROM=your-dev-email@example.com

# Option B: console mode (local testing only)
# AUTH_EMAIL_MODE=console
```

Google OAuth:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:3001/auth/google/callback
```

RAG embedding/chat provider:

```bash
# Global LLM toggle (recommended)
# local -> use local Ollama (default)
# api   -> use external API adapters
LLM_MODE=local

# If LLM_MODE=api, set these once and both summary + Lily use them:
# API_LLM_KIND=openai          # openai | anthropic | gemini
# API_LLM_CHAT_KIND=openai     # optional override
# API_LLM_EMBED_KIND=openai    # optional override
# API_LLM_BASE_URL=https://api.openai.com
# API_LLM_API_KEY=...
# ANTHROPIC_API_KEY=...        # optional provider-specific fallback
# GEMINI_API_KEY=...           # optional provider-specific fallback
# API_LLM_CHAT_MODEL=gpt-4o-mini
# API_LLM_EMBED_MODEL=text-embedding-3-small
# API_LLM_CHAT_PATH=/v1/chat/completions
# API_LLM_EMBED_PATH=/v1/embeddings
# API_LLM_MAX_TOKENS=700
# API_LLM_ANTHROPIC_VERSION=2023-06-01

# Backward-compatible per-feature provider settings (still supported):
# OPENAI_API_KEY=...
# RAG_EMBEDDING_PROVIDER=openai|ollama|api
# RAG_CHAT_PROVIDER=openai|ollama|api
# RAG_OPENAI_EMBED_MODEL=text-embedding-3-small
# RAG_OPENAI_CHAT_MODEL=gpt-4o-mini
# RAG_OLLAMA_BASE_URL=http://127.0.0.1:11434
# RAG_OLLAMA_EMBED_MODEL=nomic-embed-text
# RAG_OLLAMA_CHAT_MODEL=llama3.1
```

Redis + cache/rate/queue standard:

```bash
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_TIMEOUT_MS=450
REDIS_RETRY_MS=10000

# API ingress limit
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# Cache TTLs
QUERY_CACHE_TTL_MS=600000
SUMMARY_CACHE_TTL_MS=21600000
ARXIV_ROUTE_CACHE_TTL_MS=900000
ARXIV_ROUTE_NEGATIVE_TTL_MS=120000
REDDIT_CACHE_TTL_MS=600000

# Provider outbound protection
ARXIV_PROVIDER_RPM=20
REDDIT_PROVIDER_RPM=30

# Summary queue (Qwen protection)
SUMMARY_QUEUE_MAX_ACTIVE=1
SUMMARY_QUEUE_MAX_WAITING=25
SUMMARY_QUEUE_WAIT_TIMEOUT_MS=45000
SUMMARY_QUEUE_POLL_MS=350
```

### Web env (`/Users/saradubey/Desktop/Scraper/apps/web-ssr/.env.local`)

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:3001
```

### Python env (`/Users/saradubey/Desktop/Scraper/services/paper-ai/.env`)

```bash
# same toggle used by summary/novelty generation:
LLM_MODE=local

# local mode (default):
OLLAMA_BASE=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b-instruct
OLLAMA_TIMEOUT_SECS=120

# api mode (same toggle used by summary generation):
# API_LLM_KIND=openai          # openai | anthropic | gemini
# API_LLM_CHAT_KIND=openai     # optional override
# API_LLM_BASE_URL=https://api.openai.com
# API_LLM_API_KEY=...
# ANTHROPIC_API_KEY=...
# GEMINI_API_KEY=...
# API_LLM_CHAT_MODEL=gpt-4o-mini
# API_LLM_CHAT_PATH=/v1/chat/completions
# API_LLM_TIMEOUT_SECS=120
# API_LLM_MAX_TOKENS=1200
```

---

## 3) Install + Run

### Start API (`scraper-api`)

```bash
cd /Users/saradubey/Desktop/Scraper/services/scraper-api
npm install
npx prisma migrate deploy
npx prisma generate
node src/server.js
```

API runs at `http://localhost:3001`.

Runtime resilience test (cache + provider limits + queue busy + Redis fallback):

```bash
cd /Users/saradubey/Desktop/Scraper/services/scraper-api
npm run test:runtime
```

### Start Python AI service (`paper-ai`)

```bash
cd /Users/saradubey/Desktop/Scraper/services/paper-ai
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Python service runs at `http://127.0.0.1:8000`.

### Start Web app (`web-ssr`)

```bash
cd /Users/saradubey/Desktop/Scraper/apps/web-ssr
npm install
npm run dev
```

Frontend runs at `http://localhost:3000`.

---

## 4) Quick Smoke Test

```bash
# API health
curl -s http://127.0.0.1:3001/health

# Python health
curl -s http://127.0.0.1:8000/health
```

---

## Core API Endpoints

Auth:

- `GET /auth/password-rules`
- `POST /auth/register/send-code`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `GET /auth/google/start`
- `GET /auth/google/callback`
- `GET /me`

Search + paper run:

- `POST /api/paper`
- `GET /api/paper/stream`
- `GET /api/search`
- `GET /api/search/:id`

RAG:

- `POST /api/rag/reindex`
- `POST /api/rag/query`

Highlights:

- `GET /api/highlights?paperId=...` or `?source=...&externalId=...`
- `POST /api/highlights`
- `DELETE /api/highlights/:id`

---

## RAG Flow (Current)

1. User runs a paper search (`/api/paper`).
2. API saves search/paper/reddit records.
3. API builds chunks (`RagChunk`), generates embeddings, stores vectors in Postgres.
4. Lily assistant sends question to `/api/rag/query` with top-k context.
5. API retrieves nearest chunks by vector similarity and generates an answer.

---

## Runtime Standard (Recommended)

- Cache what is expensive and reused:
  - Final paper response (`query+filters`) for 10 min
  - Reddit threads per paper for 10 min
  - Paper summary+novelty for 6 h
  - arXiv candidate list for 15 min
  - arXiv negative/empty results for 2 min
- Track session:
  - JWT remains stateless for auth.
  - Keep only lightweight runtime/session metadata in Redis (rate counters, queue state, cache entries).
- Provider safety limits:
  - arXiv: 20 outbound req/min (roughly 1 request every 3 seconds)
  - Reddit: 30 outbound req/min
- LLM overload protection:
  - Summary generation queue with `max_active=1`, bounded waiting queue, and fast `503 busy` response when overloaded.

---

## Common Issues + Fixes

### `Prisma P2022` / missing DB column

Run migrations + regenerate client:

```bash
cd /Users/saradubey/Desktop/Scraper/services/scraper-api
npx prisma migrate deploy
npx prisma generate
```

### `EADDRINUSE: 3001`

Another process is already using the API port. Stop it, then restart server.

### Email errors (`Missing SMTP config`, `EAUTH 535`)

- Set `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, plus `SMTP_SERVICE` (or `SMTP_HOST`/`SMTP_PORT`).
- If using Gmail, `SMTP_PASS` must be a **Google App Password** (not account password).
- Do not leave placeholder values in `.env`.

### Reset link invalid/expired

- Reset tokens expire (`PASSWORD_RESET_TTL_MS`, default 30 min).
- Ensure `APP_BASE_URL` points to your current frontend URL.

### Redis unavailable

Cache, rate limiter, provider quotas, and summary queue automatically fall back to local memory mode and recover when Redis is back.

---

## Notes

- Legacy Vite frontend exists at `/Users/saradubey/Desktop/Scraper/scraper-frontend`; active development is in `/Users/saradubey/Desktop/Scraper/apps/web-ssr`.
- For local testing without real email delivery, use `AUTH_EMAIL_MODE=console` and check API logs for generated links/codes.
