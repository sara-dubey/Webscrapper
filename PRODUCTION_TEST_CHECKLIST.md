# Production Test Checklist (PAPER-AI / Rivel Research)

Use this checklist before every production release.

## 0) Environment Preflight

Pass criteria:
- API, Web, Python, Postgres, and Redis all start cleanly.
- No `EADDRINUSE` port conflicts.
- No missing required env vars.

Commands:

```bash
# API
cd /Users/saradubey/Desktop/Scraper/services/scraper-api
npx prisma migrate deploy
npx prisma generate
node src/server.js

# Web
cd /Users/saradubey/Desktop/Scraper/apps/web-ssr
npm run build
npm run start

# Python
cd /Users/saradubey/Desktop/Scraper/services/paper-ai
source .venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8000
```

Required env sanity:
- `NODE_ENV=production`
- `DATABASE_URL` points to production DB
- `REDIS_URL` points to production Redis
- `APP_BASE_URL` points to production web URL
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` set
- `AUTH_EMAIL_MODE=smtp` and SMTP credentials set

## 1) Health and Core Smoke

Pass criteria:
- Health endpoint shows Node and Python healthy.
- Auth login works and protected endpoints return data.

Commands:

```bash
curl -s http://127.0.0.1:3001/health

curl -s -X POST http://127.0.0.1:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"password123"}'
```

## 2) Authentication Flows

Pass criteria:
- Signup with verification code works.
- Forgot password email is sent and reset link/token works once.
- Google OAuth login returns user to app and creates/updates user.

Manual checks:
- `Create User` page: send code -> register -> redirected to `/paper`.
- `Forgot Password` page: receives email -> reset succeeds -> old password fails, new password works.
- `Login` page: valid creds succeed, invalid creds fail with clean message.

API checks:

```bash
curl -s -X POST http://127.0.0.1:3001/auth/register/send-code \
  -H "Content-Type: application/json" \
  -d '{"email":"your_test_user@example.com"}'

curl -s -X POST http://127.0.0.1:3001/auth/password/forgot \
  -H "Content-Type: application/json" \
  -d '{"email":"your_test_user@example.com"}'
```

Google OAuth checklist:
- In Google Cloud OAuth client, Authorized JavaScript origins include:
  - `http://localhost:3000`
  - `http://127.0.0.1:3000`
- Authorized redirect URIs include:
  - `http://localhost:3001/auth/google/callback`
  - `http://127.0.0.1:3001/auth/google/callback`
  - `http://localhost:3001/auth/callback`
  - `http://127.0.0.1:3001/auth/callback`
- Test user emails are added in OAuth Audience/Test users.

Debug command:

```bash
curl -s http://127.0.0.1:3001/auth/google/config
```

## 3) Paper Search + History + Insights

Pass criteria:
- Running a paper query saves search history in DB.
- Opening an old history entry loads summary/novelty/reddit links.
- History list appears for logged-in user only.

Command pattern:

```bash
TOKEN="<bearer_token>"

curl -s -X POST http://127.0.0.1:3001/api/paper \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"1706.03762","limit":5,"note":""}'

curl -s http://127.0.0.1:3001/api/search \
  -H "Authorization: Bearer $TOKEN"
```

## 4) Notes + Highlights + Reader Mode

Pass criteria:
- Notes persist per user + paper.
- Highlights save and reload after refresh.
- Reader mode works and quick-links `View more` modal has internal scrollbar.

API checks:

```bash
curl -s -X PUT http://127.0.0.1:3001/api/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paperId":"<paper_id>","note":"production note test"}'

curl -s "http://127.0.0.1:3001/api/notes?paperId=<paper_id>" \
  -H "Authorization: Bearer $TOKEN"
```

## 5) RAG + Lily Assistant

Pass criteria:
- Reindex works.
- Ask returns answer with chunks.
- Graceful error when search is missing.

Commands:

```bash
curl -s -X POST http://127.0.0.1:3001/api/rag/reindex \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchId":"<search_id>"}'

curl -s -X POST http://127.0.0.1:3001/api/rag/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"What is the main contribution?","searchId":"<search_id>","k":6}'
```

## 6) Rate Limits, Queue, and Backpressure

Pass criteria:
- API returns rate limit headers.
- Summary queue rejects overload with clear `busy` error.
- Redis fallback behavior is safe when Redis is unavailable.

Commands:

```bash
cd /Users/saradubey/Desktop/Scraper/services/scraper-api
npm run test:runtime
```

Manual checks:
- Burst requests to `/api/paper` and confirm no crash.
- When overloaded, UI shows meaningful busy/retry message.

## 7) Provider Safety (arXiv + Reddit)

Pass criteria:
- arXiv and Reddit calls are throttled to configured RPM.
- Cache reduces repeated provider calls.
- No provider ban/lockouts during load test.

Key env:
- `ARXIV_PROVIDER_RPM=20`
- `REDDIT_PROVIDER_RPM=30`
- `QUERY_CACHE_TTL_MS=600000`
- `SUMMARY_CACHE_TTL_MS=21600000`

## 8) Security Hardening

Pass criteria:
- Secrets are not committed in repo.
- JWT secrets rotated from defaults.
- CORS is restricted to known origins.
- Password reset tokens and verification codes expire correctly.
- Users cannot access another user’s data.

Mandatory actions:
- Rotate compromised secrets immediately (Google client secret, SMTP pass, JWT secrets).
- Store production secrets in a secret manager or deployment env store.

## 9) Observability and Recovery

Pass criteria:
- Request IDs visible in logs.
- 4xx/5xx errors are actionable.
- Restart procedure documented and tested.

Runbook basics:
- If `3001` busy: kill process on that port, restart API.
- If Redis down: ensure API degrades safely (fallback mode).
- If Python down: API should return clear summarization error, not hang.

## 10) Release Gate

Production release is allowed only if:
- All critical flows in sections 1-5 pass.
- `npm run test:runtime` passes.
- No open P0/P1 issues.
- Google OAuth, SMTP, DB, Redis are confirmed against production endpoints.

