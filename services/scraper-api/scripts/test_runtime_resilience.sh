#!/usr/bin/env bash

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d -t scraper-api-runtime-test.XXXXXX)"

API_PID=""
API_PORT="${API_PORT:-}"
CURRENT_LOG=""
PASS_COUNT=0
FAIL_COUNT=0
MOCK_PY_PID=""
MOCK_PY_PORT="${MOCK_PY_PORT:-18081}"

log() {
  printf '\n[%s] %s\n' "$(date +'%H:%M:%S')" "$1"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  [PASS] %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  [FAIL] %s\n' "$1"
}

stop_api() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  API_PID=""
}

cleanup() {
  stop_api
  if [[ -n "$MOCK_PY_PID" ]] && kill -0 "$MOCK_PY_PID" 2>/dev/null; then
    kill "$MOCK_PY_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PY_PID" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

pick_free_port() {
  if [[ -n "$API_PORT" ]]; then
    return
  fi

  local start_port="${START_PORT:-3101}"
  local end_port=$((start_port + 120))
  local p
  for ((p = start_port; p <= end_port; p++)); do
    if ! lsof -ti "tcp:${p}" >/dev/null 2>&1; then
      API_PORT="$p"
      return
    fi
  done
  echo "Could not find a free port in range ${start_port}-${end_port}" >&2
  exit 1
}

wait_for_api() {
  local attempts=60
  local i
  for ((i = 1; i <= attempts; i++)); do
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${API_PORT}/auth/password-rules" || true)"
    if [[ "$code" == "200" || "$code" == "304" ]]; then
      return 0
    fi

    if [[ -n "$API_PID" ]] && ! kill -0 "$API_PID" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
}

start_api() {
  local name="$1"
  shift

  stop_api
  CURRENT_LOG="${TMP_DIR}/${name}.log"

  (
    cd "$ROOT_DIR" || exit 1
    exec env PORT="$API_PORT" "$@" node src/server.js
  ) >"$CURRENT_LOG" 2>&1 &

  API_PID=$!

  if ! wait_for_api; then
    echo "API failed to start for scenario: ${name}" >&2
    echo "--- ${CURRENT_LOG} ---" >&2
    sed -n '1,120p' "$CURRENT_LOG" >&2 || true
    return 1
  fi
  return 0
}

start_mock_py() {
  if [[ -n "$MOCK_PY_PID" ]] && kill -0 "$MOCK_PY_PID" 2>/dev/null; then
    return 0
  fi

  local mock_log="${TMP_DIR}/mock_py.log"
  node -e '
    const http = require("http");
    const port = Number(process.argv[1]);
    const server = http.createServer((req, res) => {
      if (req.url === "/paper_summary" && req.method === "POST") {
        req.on("data", () => {});
        req.on("end", () => {
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: true,
              summary: "Mock summary from test server.",
              novelty: ["point 1", "point 2", "point 3"],
            }));
          }, 4000);
        });
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    server.listen(port, "127.0.0.1", () => {
      console.log("mock_py_up");
    });
  ' "$MOCK_PY_PORT" >"$mock_log" 2>&1 &
  MOCK_PY_PID=$!

  local i
  for ((i = 1; i <= 30; i++)); do
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${MOCK_PY_PORT}/health" || true)"
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    if ! kill -0 "$MOCK_PY_PID" 2>/dev/null; then
      echo "Mock python server failed to start" >&2
      sed -n '1,120p' "$mock_log" >&2 || true
      return 1
    fi
    sleep 0.2
  done

  echo "Mock python server start timed out" >&2
  sed -n '1,120p' "$mock_log" >&2 || true
  return 1
}

post_paper() {
  local query="$1"
  local out_file="$2"
  curl -s -o "$out_file" -w "%{http_code}" \
    -X POST "http://127.0.0.1:${API_PORT}/api/paper" \
    -H "Content-Type: application/json" \
    --data "{\"query\":\"${query}\",\"limit\":5}"
}

test_health_and_cache() {
  log "Test 1+2: health + query cache"

  local cache_prefix="cache_test_$(date +%s)_$RANDOM"
  if ! start_api "base" "CACHE_KEY_PREFIX=${cache_prefix}" "RATE_LIMIT_MAX=10000"; then
    fail "API startup failed for health/cache test"
    return
  fi

  local health_code
  local health_body="${TMP_DIR}/health.json"
  health_code="$(curl -s -o "$health_body" -w "%{http_code}" "http://127.0.0.1:${API_PORT}/health" || true)"
  if [[ "$health_code" == "200" ]] && grep -q '"ok":true' "$health_body"; then
    pass "Health endpoint is up"
  else
    fail "Health endpoint failed (HTTP ${health_code})"
  fi

  local first_stream="${TMP_DIR}/stream_first.txt"
  local second_stream="${TMP_DIR}/stream_second.txt"
  curl -sS -N --max-time 240 "http://127.0.0.1:${API_PORT}/api/paper/stream?query=1706.03762&limit=5" >"$first_stream" || true
  curl -sS -N --max-time 240 "http://127.0.0.1:${API_PORT}/api/paper/stream?query=1706.03762&limit=5" >"$second_stream" || true

  if grep -q '"stage":"cache_hit"' "$second_stream"; then
    pass "Second identical paper request hit cache"
  else
    fail "Cache hit marker not found in second stream run"
  fi
}

test_provider_limits() {
  log "Test 3: provider outbound limits (arXiv/reddit)"

  local cache_prefix="provider_test_$(date +%s)_$RANDOM"
  local run_tag="rl_${RANDOM}_$(date +%s)"
  if ! start_api \
    "provider_limits" \
    "CACHE_KEY_PREFIX=${cache_prefix}" \
    "RATE_LIMIT_MAX=10000" \
    "ARXIV_PROVIDER_RPM=1" \
    "REDDIT_PROVIDER_RPM=120" \
    "MIN_PAPER_MATCH_SCORE=999999"; then
    fail "API startup failed for provider-limit test"
    return
  fi

  # Use unique non-arXiv tokens so flow cannot short-circuit via history/db cache.
  # This forces outbound arXiv calls and should trip ARXIV_PROVIDER_RPM quickly.
  local queries=(
    "provider quota probe ${run_tag} alpha"
    "provider quota probe ${run_tag} beta"
    "provider quota probe ${run_tag} gamma"
    "provider quota probe ${run_tag} delta"
  )
  local hit=0
  local i=0

  for q in "${queries[@]}"; do
    i=$((i + 1))
    local body="${TMP_DIR}/provider_${i}.json"
    local code
    code="$(post_paper "$q" "$body")"
    if [[ "$code" == "429" ]] && grep -q 'PROVIDER_RATE_LIMITED' "$body"; then
      hit=1
      break
    fi
    if [[ "$code" == "200" ]] && grep -qi 'rate-limited' "$body"; then
      hit=1
      break
    fi
  done

  if [[ "$hit" == "1" ]]; then
    pass "Provider limits engaged (429 PROVIDER_RATE_LIMITED or rate-limited note)"
  else
    fail "Provider limit did not trigger as expected"
  fi
}

test_summary_queue_busy() {
  log "Test 4: summary queue busy protection"

  local cache_prefix="queue_test_$(date +%s)_$RANDOM"
  if ! start_api \
    "queue_busy" \
    "CACHE_KEY_PREFIX=${cache_prefix}" \
    "ENABLE_SUMMARY_QUEUE_PROBE=1" \
    "RATE_LIMIT_MAX=10000" \
    "ARXIV_PROVIDER_RPM=120" \
    "REDDIT_PROVIDER_RPM=120" \
    "SUMMARY_QUEUE_MAX_ACTIVE=1" \
    "SUMMARY_QUEUE_MAX_WAITING=1" \
    "SUMMARY_QUEUE_WAIT_TIMEOUT_MS=800" \
    "SUMMARY_QUEUE_POLL_MS=100"; then
    fail "API startup failed for queue-busy test"
    return
  fi

  local q1="${TMP_DIR}/queue_1.json" q2="${TMP_DIR}/queue_2.json" q3="${TMP_DIR}/queue_3.json"
  local c1f="${TMP_DIR}/queue_1.code" c2f="${TMP_DIR}/queue_2.code" c3f="${TMP_DIR}/queue_3.code"

  (
    curl -s -o "$q1" -w "%{http_code}" \
      -X POST "http://127.0.0.1:${API_PORT}/api/summary/queue-probe" \
      -H "Content-Type: application/json" \
      --data '{"hold_ms":2500}' >"$c1f"
  ) &
  local p1=$!

  (
    curl -s -o "$q2" -w "%{http_code}" \
      -X POST "http://127.0.0.1:${API_PORT}/api/summary/queue-probe" \
      -H "Content-Type: application/json" \
      --data '{"hold_ms":2500}' >"$c2f"
  ) &
  local p2=$!

  (
    curl -s -o "$q3" -w "%{http_code}" \
      -X POST "http://127.0.0.1:${API_PORT}/api/summary/queue-probe" \
      -H "Content-Type: application/json" \
      --data '{"hold_ms":2500}' >"$c3f"
  ) &
  local p3=$!

  wait "$p1" "$p2" "$p3" || true

  local found_busy=0
  local code body
  for idx in 1 2 3; do
    code="$(cat "${TMP_DIR}/queue_${idx}.code" 2>/dev/null || echo "")"
    body="${TMP_DIR}/queue_${idx}.json"
    if [[ "$code" == "503" ]] && grep -q 'SUMMARY_QUEUE_BUSY' "$body"; then
      found_busy=1
      break
    fi
  done

  if [[ "$found_busy" == "1" ]]; then
    pass "Summary queue returns busy signal (503/SUMMARY_QUEUE_BUSY) under overload"
  else
    fail "Summary queue busy signal not observed"
  fi
}

test_redis_fallback() {
  log "Test 5: Redis fallback (memory mode when Redis is down)"

  if ! start_api \
    "redis_fallback" \
    "REDIS_URL=redis://127.0.0.1:6399/0" \
    "RATE_LIMIT_MAX=10000"; then
    fail "API startup failed for Redis fallback test"
    return
  fi

  local out_file="${TMP_DIR}/rules_raw.txt"
  local code
  code="$(curl -s -i -o "$out_file" -w "%{http_code}" "http://127.0.0.1:${API_PORT}/auth/password-rules" || true)"
  sleep 0.4

  if [[ "$code" == "200" || "$code" == "304" ]]; then
    if grep -qi '^X-RateLimit-Backend: memory' "$out_file"; then
      pass "Redis failure fallback works (request served with in-memory rate-limit backend)"
    else
      fail "Request succeeded but did not report memory rate-limit backend"
    fi
  else
    fail "Request failed during Redis fallback test (HTTP ${code})"
  fi
}

main() {
  pick_free_port

  log "Using API test port: ${API_PORT}"
  log "Temp logs: ${TMP_DIR}"

  test_health_and_cache
  test_provider_limits
  test_summary_queue_busy
  test_redis_fallback

  log "Done"
  printf '\nResult: %s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"

  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    printf 'Check logs in: %s\n' "$TMP_DIR"
    exit 1
  fi
}

main "$@"
