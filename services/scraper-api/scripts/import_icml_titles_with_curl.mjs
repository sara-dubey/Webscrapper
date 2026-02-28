import "dotenv/config";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { prisma } from "../src/db/prisma.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULTS = {
  apiBase: process.env.API_BASE_URL || "http://127.0.0.1:3001",
  endpoint: "/api/paper",
  csvPath: "",
  queryColumn: process.env.QUERY_COLUMN || "",
  authToken: process.env.AUTH_TOKEN || process.env.ACCESS_TOKEN || "",
  userId: process.env.IMPORT_USER_ID || process.env.USER_ID || "",
  userEmail: process.env.IMPORT_USER_EMAIL || "",
  jwtSecret: process.env.IMPORT_JWT_SECRET || process.env.JWT_SECRET || process.env.JWT_ACCESS_SECRET || "",
  accessTtl: process.env.IMPORT_ACCESS_TTL || process.env.JWT_ACCESS_TTL || process.env.ACCESS_TOKEN_TTL || "7d",
  email: process.env.LOGIN_EMAIL || "",
  password: process.env.LOGIN_PASSWORD || "",
  perRequestDelaySec: toNumber(process.env.REQUEST_DELAY_SEC, 3),
  maxRetries: toInteger(process.env.MAX_RETRIES, 8),
  timeoutSec: toNumber(process.env.CURL_TIMEOUT_SEC, 180),
  offset: toInteger(process.env.START_OFFSET, 0),
  maxRows: toInteger(process.env.MAX_ROWS, 0),
  paperLimit: toInteger(process.env.PAPER_LIMIT, 0),
  note: process.env.IMPORT_NOTE || "",
  maxWaitSec: toInteger(process.env.MAX_WAIT_SEC, 0),
  stopOnHistorySaveFailure: String(process.env.STOP_ON_HISTORY_SAVE_FAILURE || "0") === "1",
  dryRun: false,
};

function toInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNumber(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--stop-on-history-save-failure") {
      opts.stopOnHistorySaveFailure = true;
      continue;
    }
    if (arg === "--csv" && next) {
      opts.csvPath = next;
      i += 1;
      continue;
    }
    if (arg === "--query-column" && next) {
      opts.queryColumn = next;
      i += 1;
      continue;
    }
    if (arg === "--api-base" && next) {
      opts.apiBase = next;
      i += 1;
      continue;
    }
    if (arg === "--endpoint" && next) {
      opts.endpoint = next;
      i += 1;
      continue;
    }
    if (arg === "--auth-token" && next) {
      opts.authToken = next;
      i += 1;
      continue;
    }
    if (arg === "--user-id" && next) {
      opts.userId = next;
      i += 1;
      continue;
    }
    if (arg === "--user-email" && next) {
      opts.userEmail = next;
      i += 1;
      continue;
    }
    if (arg === "--jwt-secret" && next) {
      opts.jwtSecret = next;
      i += 1;
      continue;
    }
    if (arg === "--access-ttl" && next) {
      opts.accessTtl = next;
      i += 1;
      continue;
    }
    if (arg === "--email" && next) {
      opts.email = next;
      i += 1;
      continue;
    }
    if (arg === "--password" && next) {
      opts.password = next;
      i += 1;
      continue;
    }
    if (arg === "--request-delay-sec" && next) {
      opts.perRequestDelaySec = toNumber(next, opts.perRequestDelaySec);
      i += 1;
      continue;
    }
    if (arg === "--max-retries" && next) {
      opts.maxRetries = toInteger(next, opts.maxRetries);
      i += 1;
      continue;
    }
    if (arg === "--timeout-sec" && next) {
      opts.timeoutSec = toNumber(next, opts.timeoutSec);
      i += 1;
      continue;
    }
    if (arg === "--offset" && next) {
      opts.offset = toInteger(next, opts.offset);
      i += 1;
      continue;
    }
    if (arg === "--max-rows" && next) {
      opts.maxRows = toInteger(next, opts.maxRows);
      i += 1;
      continue;
    }
    if (arg === "--paper-limit" && next) {
      opts.paperLimit = toInteger(next, opts.paperLimit);
      i += 1;
      continue;
    }
    if (arg === "--note" && next) {
      opts.note = next;
      i += 1;
      continue;
    }
    if (arg === "--max-wait-sec" && next) {
      opts.maxWaitSec = toInteger(next, opts.maxWaitSec);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`
Batch import ICML titles using curl + /api/paper

Usage:
  node scripts/import_icml_titles_with_curl.mjs [options]

Options:
  --csv <path>                CSV file path (default: auto-detect icml_2025.csv)
  --query-column <name>       CSV column used as query (e.g. title, paper_title, doc_id)
  --api-base <url>            API base URL (default: http://127.0.0.1:3001)
  --endpoint <path>           Endpoint path (default: /api/paper)
  --auth-token <token>        Bearer token (preferred)
  --user-id <uuid>            Sign token for this user id (no login password needed)
  --user-email <email>        Resolve user id from DB by email, then sign token
  --jwt-secret <secret>       Secret used when signing token for --user-id/--user-email
  --access-ttl <dur>          Signed token ttl (default from env or 7d)
  --email <email>             Login email (if token is not provided)
  --password <password>       Login password (if token is not provided)
  --request-delay-sec <sec>   Delay between successful requests (default: 3)
  --max-retries <n>           Retry count per title on 429/503 (default: 8)
  --timeout-sec <sec>         curl timeout per request (default: 180)
  --offset <n>                Start from CSV data row index n (default: 0)
  --max-rows <n>              Process at most n rows, 0 = all (default: 0)
  --paper-limit <n>           Optional 'limit' field sent to /api/paper
  --note <text>               Optional note field sent to /api/paper
  --max-wait-sec <sec>        Abort if computed wait exceeds this, 0 = unlimited
  --stop-on-history-save-failure
                              Stop the whole run if an item returns history_saved=false
  --dry-run                   Parse CSV and print counts only
  --help                      Show help

Environment alternatives:
  AUTH_TOKEN / ACCESS_TOKEN
  IMPORT_USER_ID / IMPORT_USER_EMAIL
  IMPORT_JWT_SECRET / IMPORT_ACCESS_TTL
  QUERY_COLUMN
  STOP_ON_HISTORY_SAVE_FAILURE=1
  LOGIN_EMAIL / LOGIN_PASSWORD
  API_BASE_URL
`);
}

function autoDetectCsv() {
  const candidates = [
    path.resolve(process.cwd(), "icml_2025.csv"),
    path.resolve(process.cwd(), "../icml_2025.csv"),
    path.resolve(process.cwd(), "../../icml_2025.csv"),
    path.resolve(__dirname, "../../../icml_2025.csv"),
  ];
  return candidates;
}

async function resolveCsvPath(inputPath) {
  if (inputPath) {
    const abs = path.resolve(process.cwd(), inputPath);
    await fs.access(abs);
    return abs;
  }

  for (const p of autoDetectCsv()) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }

  throw new Error("Could not find icml_2025.csv. Pass --csv <path>.");
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function extractQueries(csvText, queryColumnHint = "") {
  const rows = parseCsvRows(csvText);
  if (!rows.length) throw new Error("CSV file is empty");

  const header = rows[0].map((x) => String(x || "").replace(/^\uFEFF/, "").trim().toLowerCase());
  const hinted = String(queryColumnHint || "").trim().toLowerCase();
  const preferred = hinted
    ? [hinted]
    : ["title", "paper_title", "doc_id", "arxiv_id", "arxiv_url", "paper_url"];
  const queryIdx = preferred.map((name) => ({ name, idx: header.indexOf(name) })).find((x) => x.idx >= 0);
  if (!queryIdx) {
    throw new Error(
      `CSV must include one of query columns: ${preferred.join(", ")}`
    );
  }

  const queries = [];
  for (let i = 1; i < rows.length; i += 1) {
    const value = String(rows[i]?.[queryIdx.idx] || "").trim();
    queries.push({ csvRowNumber: i + 1, title: value });
  }
  return { queries, queryColumnUsed: queryIdx.name };
}

function parseHeaders(rawHeaderText) {
  const blocks = String(rawHeaderText || "")
    .split(/\r?\n\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  const block = blocks[blocks.length - 1] || "";
  const lines = block ? block.split(/\r?\n/) : [];
  const statusLine = lines[0] || "";
  const headers = {};

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (headers[key]) {
      headers[key] = `${headers[key]}, ${value}`;
    } else {
      headers[key] = value;
    }
  }

  return { statusLine, headers };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function runProcess(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

async function curlJson({
  url,
  method = "POST",
  body = undefined,
  headers = {},
  timeoutSec = 180,
}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "icml-curl-"));
  const headersPath = path.join(tmpDir, "headers.txt");
  const bodyPath = path.join(tmpDir, "body.txt");

  try {
    const args = [
      "-sS",
      "-X",
      method,
      url,
      "--connect-timeout",
      "15",
      "--max-time",
      String(timeoutSec),
      "-D",
      headersPath,
      "-o",
      bodyPath,
      "-w",
      "%{http_code}",
    ];

    for (const [k, v] of Object.entries(headers)) {
      args.push("-H", `${k}: ${v}`);
    }

    if (body !== undefined) {
      args.push("--data", JSON.stringify(body));
    }

    const out = await runProcess("curl", args);
    if (out.code !== 0) {
      throw new Error(out.stderr.trim() || `curl exited with code ${out.code}`);
    }

    const status = toInteger(out.stdout.trim(), 0);
    const [rawHeaders, rawBody] = await Promise.all([
      fs.readFile(headersPath, "utf8"),
      fs.readFile(bodyPath, "utf8"),
    ]);
    const parsedHeaders = parseHeaders(rawHeaders);

    return {
      status,
      headers: parsedHeaders.headers,
      statusLine: parsedHeaders.statusLine,
      bodyText: rawBody,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function toPositiveSeconds(value) {
  const n = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n);
}

function pickWaitSeconds({ status, headers, bodyObj, attempt, perRequestDelaySec }) {
  const waitValues = [];

  const retryAfterHeader = toPositiveSeconds(headers["retry-after"]);
  if (retryAfterHeader > 0) waitValues.push(retryAfterHeader);

  const bodyRetryAfter = toPositiveSeconds(bodyObj?.retry_after_sec);
  if (bodyRetryAfter > 0) waitValues.push(bodyRetryAfter);

  if (status === 429) {
    const rlResetSec = toPositiveSeconds(headers["ratelimit-reset"]);
    if (rlResetSec > 0) waitValues.push(rlResetSec);

    const xResetEpochSec = toPositiveSeconds(headers["x-ratelimit-reset"]);
    if (xResetEpochSec > 0) {
      const delta = Math.ceil(xResetEpochSec - Date.now() / 1000);
      if (delta > 0) waitValues.push(delta);
    }
  }

  const jitter = Math.floor(Math.random() * 2);
  const fallback = Math.min(300, Math.max(1, perRequestDelaySec) * 2 ** (attempt - 1)) + jitter;
  waitValues.push(fallback);

  return Math.max(...waitValues);
}

async function requestWithRetry({ makeRequest, label, maxRetries, perRequestDelaySec, maxWaitSec }) {
  let attempt = 0;

  while (true) {
    attempt += 1;

    let response;
    try {
      response = await makeRequest();
    } catch (err) {
      if (attempt > maxRetries) throw err;
      const fallbackWait = Math.min(300, Math.max(1, perRequestDelaySec) * 2 ** (attempt - 1));
      console.log(`[retry] ${label}: curl error "${String(err.message || err)}". Waiting ${fallbackWait}s.`);
      await sleep(fallbackWait * 1000);
      continue;
    }

    const bodyObj = safeJsonParse(response.bodyText);
    const isRetryable = response.status === 429 || response.status === 503;
    if (!isRetryable) return { response, bodyObj, attempt };
    if (attempt > maxRetries) return { response, bodyObj, attempt };

    const waitSec = pickWaitSeconds({
      status: response.status,
      headers: response.headers,
      bodyObj,
      attempt,
      perRequestDelaySec,
    });

    if (maxWaitSec > 0 && waitSec > maxWaitSec) {
      throw new Error(
        `${label}: computed retry wait ${waitSec}s exceeds max wait ${maxWaitSec}s.`
      );
    }

    const reason = String(bodyObj?.error || "rate-limited").replace(/\s+/g, " ").trim();
    console.log(`[retry] ${label}: HTTP ${response.status} (${reason}). Waiting ${waitSec}s.`);
    await sleep(waitSec * 1000);
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizePath(value) {
  const p = String(value || "").trim();
  if (!p) return "/api/paper";
  return p.startsWith("/") ? p : `/${p}`;
}

async function getAuthToken(opts) {
  if (opts.authToken) return opts.authToken;

  const directUserId = String(opts.userId || "").trim();
  const directUserEmail = String(opts.userEmail || "").trim().toLowerCase();
  if (directUserId || directUserEmail) {
    const userId = directUserId || (await resolveUserIdByEmail(directUserEmail));
    const secret = String(opts.jwtSecret || "").trim();
    if (!secret) {
      throw new Error("Missing JWT secret for --user-id/--user-email signing.");
    }
    const token = jwt.sign({ userId }, secret, { expiresIn: String(opts.accessTtl || "7d") });
    await assertTokenUsable({ token, opts });
    return token;
  }

  if (!opts.email || !opts.password) {
    throw new Error(
      "Missing auth. Provide --auth-token, --user-id/--user-email, or --email + --password."
    );
  }

  const loginUrl = `${normalizeBaseUrl(opts.apiBase)}/auth/login`;
  const login = await requestWithRetry({
    label: "login",
    maxRetries: opts.maxRetries,
    perRequestDelaySec: opts.perRequestDelaySec,
    maxWaitSec: opts.maxWaitSec,
    makeRequest: () =>
      curlJson({
        url: loginUrl,
        method: "POST",
        timeoutSec: opts.timeoutSec,
        headers: { "Content-Type": "application/json" },
        body: { email: opts.email, password: opts.password },
      }),
  });

  const loginBody = login.bodyObj;
  if (login.response.status < 200 || login.response.status >= 300 || !loginBody?.ok) {
    throw new Error(
      `Login failed: HTTP ${login.response.status}, body=${String(login.response.bodyText || "").slice(0, 300)}`
    );
  }

  const token = String(loginBody.accessToken || loginBody.token || "").trim();
  if (!token) throw new Error("Login succeeded but no access token was returned.");
  return token;
}

async function resolveUserIdByEmail(email) {
  if (!email) throw new Error("Missing --user-email value.");
  const row = await prisma.userAccount.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!row?.id) {
    throw new Error(`No user found for email: ${email}`);
  }
  return row.id;
}

async function assertTokenUsable({ token, opts }) {
  const meUrl = `${normalizeBaseUrl(opts.apiBase)}/me`;
  const me = await requestWithRetry({
    label: "token-check",
    maxRetries: opts.maxRetries,
    perRequestDelaySec: opts.perRequestDelaySec,
    maxWaitSec: opts.maxWaitSec,
    makeRequest: () =>
      curlJson({
        url: meUrl,
        method: "GET",
        timeoutSec: opts.timeoutSec,
        headers: { Authorization: `Bearer ${token}` },
      }),
  });

  const body = me.bodyObj;
  if (me.response.status >= 200 && me.response.status < 300 && body?.ok) return;

  const msg = String(body?.error || me.response.bodyText || "token validation failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

  if (me.response.status === 401) {
    throw new Error(`Signed token was rejected (401). Check JWT secret. ${msg}`);
  }
  if (me.response.status === 404) {
    throw new Error(`Signed token user not found in API DB (404). ${msg}`);
  }
  throw new Error(`Token validation via /me failed (HTTP ${me.response.status}). ${msg}`);
}

function limitTitles(titles, offset, maxRows) {
  const safeOffset = Math.max(0, offset);
  const sliced = titles.slice(safeOffset);
  if (maxRows > 0) return sliced.slice(0, maxRows);
  return sliced;
}

function canRefreshAuthToken(opts) {
  if (String(opts.authToken || "").trim()) return false;
  if (String(opts.userId || "").trim()) return true;
  if (String(opts.userEmail || "").trim()) return true;
  if (String(opts.email || "").trim() && String(opts.password || "").trim()) return true;
  return false;
}

function isInvalidBearerHistorySave(bodyObj) {
  if (!bodyObj || bodyObj.ok !== true || bodyObj.history_saved !== false) return false;
  const reason = String(bodyObj.history_reason || "").toLowerCase();
  return reason.includes("missing or invalid bearer token");
}

function isAuthHttpFailure(response, bodyObj) {
  if (Number(response?.status) === 401) return true;
  if (Number(response?.status) === 403) {
    const msg = String(bodyObj?.error || "").toLowerCase();
    if (msg.includes("token")) return true;
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const csvPath = await resolveCsvPath(opts.csvPath);
  const csvRaw = await fs.readFile(csvPath, "utf8");
  const { queries: parsedTitles, queryColumnUsed } = extractQueries(csvRaw, opts.queryColumn);
  const batch = limitTitles(parsedTitles, opts.offset, opts.maxRows);

  if (!batch.length) {
    console.log("No rows to process.");
    return;
  }

  console.log(`CSV: ${csvPath}`);
  console.log(`Total data rows: ${parsedTitles.length}`);
  console.log(`Query column: ${queryColumnUsed}`);
  console.log(`Rows selected: ${batch.length} (offset=${Math.max(0, opts.offset)}, maxRows=${opts.maxRows || "all"})`);

  if (opts.dryRun) {
    const preview = batch
      .slice(0, 3)
      .map((x) => `[row ${x.csvRowNumber}] ${x.title}`)
      .join("\n");
    console.log("Dry run enabled. Sample titles:");
    console.log(preview || "(empty)");
    return;
  }

  let token = await getAuthToken(opts);
  const url = `${normalizeBaseUrl(opts.apiBase)}${normalizePath(opts.endpoint)}`;

  let okCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const failures = [];
  let stopRequested = false;

  for (let i = 0; i < batch.length; i += 1) {
    if (stopRequested) break;

    const row = batch[i];
    const title = String(row.title || "").trim();
    const rowLabel = `row ${row.csvRowNumber} (${i + 1}/${batch.length})`;

    if (!title) {
      skippedCount += 1;
      console.log(`[skip] ${rowLabel}: empty title`);
      continue;
    }

    const requestBody = {
      query: title,
    };
    if (opts.paperLimit > 0) requestBody.limit = opts.paperLimit;
    if (opts.note) requestBody.note = opts.note;

    let processed = false;
    let refreshedForRow = false;
    while (!processed) {
      const result = await requestWithRetry({
        label: rowLabel,
        maxRetries: opts.maxRetries,
        perRequestDelaySec: opts.perRequestDelaySec,
        maxWaitSec: opts.maxWaitSec,
        makeRequest: () =>
          curlJson({
            url,
            method: "POST",
            timeoutSec: opts.timeoutSec,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: requestBody,
          }),
      });

      const { response, bodyObj, attempt } = result;
      const shouldRefreshAndRetry =
        !refreshedForRow &&
        canRefreshAuthToken(opts) &&
        (isInvalidBearerHistorySave(bodyObj) || isAuthHttpFailure(response, bodyObj));

      if (shouldRefreshAndRetry) {
        refreshedForRow = true;
        console.log(`[auth] ${rowLabel}: token invalid/expired; refreshing token and retrying row.`);
        token = await getAuthToken(opts);
        continue;
      }

      if (response.status >= 200 && response.status < 300 && bodyObj?.ok) {
        if (bodyObj.history_saved === false) {
          failCount += 1;
          const historyReason = String(bodyObj?.history_reason || "").trim();
          failures.push({
            row: row.csvRowNumber,
            title,
            status: response.status,
            reason: historyReason
              ? `history_saved=false (${historyReason})`
              : "history_saved=false",
          });
          console.error(
            `[fail] ${rowLabel}: history_saved=false${historyReason ? ` (${historyReason})` : ""}.`
          );
          if (opts.stopOnHistorySaveFailure) {
            console.error("[stop] Stopping run because --stop-on-history-save-failure is enabled.");
            stopRequested = true;
          }
        } else {
          okCount += 1;
          const paperTitle = String(bodyObj?.paper?.title || "").trim();
          const searchId = String(bodyObj?.search_id || "").trim();
          console.log(
            `[ok] ${rowLabel}: saved search_id=${searchId || "n/a"}; title="${paperTitle || title}" (attempt ${attempt})`
          );
        }
      } else {
        failCount += 1;
        const errorText = String(bodyObj?.error || response.bodyText || "request failed")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        failures.push({
          row: row.csvRowNumber,
          title,
          status: response.status,
          reason: errorText,
        });
        console.error(`[fail] ${rowLabel}: HTTP ${response.status} ${errorText}`);
      }

      processed = true;
    }

    const isLastItem = i >= batch.length - 1;
    if (!isLastItem && opts.perRequestDelaySec > 0 && !stopRequested) {
      await sleep(opts.perRequestDelaySec * 1000);
    }
  }

  console.log("");
  console.log("Import finished.");
  console.log(`Success: ${okCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Skipped: ${skippedCount}`);

  if (failures.length) {
    const outPath = path.resolve(
      process.cwd(),
      `icml_import_failures_${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
    await fs.writeFile(outPath, JSON.stringify(failures, null, 2), "utf8");
    console.log(`Failure details: ${outPath}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`[fatal] ${String(err?.message || err)}`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
