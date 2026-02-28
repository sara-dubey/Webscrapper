const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function normalizeLabels(labelNames, labels = {}) {
  const out = {};
  for (const name of labelNames) {
    out[name] = String(labels[name] ?? "");
  }
  return out;
}

function labelsKey(labelNames, labels = {}) {
  return labelNames.map((name) => `${name}=${String(labels[name] ?? "")}`).join("|");
}

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabelSet(labels) {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  const body = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
  return `{${body}}`;
}

class CounterMetric {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.type = "counter";
    this.labelNames = labelNames;
    this.samples = new Map();
  }

  inc(labels = {}, value = 1) {
    const inc = Number(value);
    if (!Number.isFinite(inc) || inc < 0) return;
    const normalized = normalizeLabels(this.labelNames, labels);
    const key = labelsKey(this.labelNames, normalized);
    const current = this.samples.get(key);
    if (current) {
      current.value += inc;
      return;
    }
    this.samples.set(key, { labels: normalized, value: inc });
  }

  collectLines() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    if (!this.samples.size) {
      lines.push(`${this.name}${formatLabelSet(normalizeLabels(this.labelNames, {}))} 0`);
      return lines;
    }
    for (const sample of this.samples.values()) {
      lines.push(`${this.name}${formatLabelSet(sample.labels)} ${sample.value}`);
    }
    return lines;
  }
}

class GaugeMetric {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.type = "gauge";
    this.labelNames = labelNames;
    this.samples = new Map();
  }

  set(labels = {}, value = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    const normalized = normalizeLabels(this.labelNames, labels);
    const key = labelsKey(this.labelNames, normalized);
    this.samples.set(key, { labels: normalized, value: num });
  }

  inc(labels = {}, value = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const normalized = normalizeLabels(this.labelNames, labels);
    const key = labelsKey(this.labelNames, normalized);
    const current = this.samples.get(key);
    if (current) {
      current.value += n;
      return;
    }
    this.samples.set(key, { labels: normalized, value: n });
  }

  collectLines() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    if (!this.samples.size) {
      lines.push(`${this.name}${formatLabelSet(normalizeLabels(this.labelNames, {}))} 0`);
      return lines;
    }
    for (const sample of this.samples.values()) {
      lines.push(`${this.name}${formatLabelSet(sample.labels)} ${sample.value}`);
    }
    return lines;
  }
}

class HistogramMetric {
  constructor({ name, help, labelNames = [], buckets = [] }) {
    this.name = name;
    this.help = help;
    this.type = "histogram";
    this.labelNames = labelNames;
    const normalizedBuckets = Array.from(new Set((buckets || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))).sort((a, b) => a - b);
    this.buckets = normalizedBuckets.length
      ? normalizedBuckets
      : [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.samples = new Map();
  }

  observe(labels = {}, value = 0) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;

    const normalized = normalizeLabels(this.labelNames, labels);
    const key = labelsKey(this.labelNames, normalized);
    let sample = this.samples.get(key);
    if (!sample) {
      sample = {
        labels: normalized,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.samples.set(key, sample);
    }

    for (let i = 0; i < this.buckets.length; i += 1) {
      if (n <= this.buckets[i]) sample.counts[i] += 1;
    }
    sample.sum += n;
    sample.count += 1;
  }

  collectLines() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];

    if (!this.samples.size) {
      const labels = normalizeLabels(this.labelNames, {});
      for (const bucket of this.buckets) {
        lines.push(`${this.name}_bucket${formatLabelSet({ ...labels, le: bucket })} 0`);
      }
      lines.push(`${this.name}_bucket${formatLabelSet({ ...labels, le: "+Inf" })} 0`);
      lines.push(`${this.name}_sum${formatLabelSet(labels)} 0`);
      lines.push(`${this.name}_count${formatLabelSet(labels)} 0`);
      return lines;
    }

    for (const sample of this.samples.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(
          `${this.name}_bucket${formatLabelSet({ ...sample.labels, le: this.buckets[i] })} ${sample.counts[i]}`
        );
      }
      lines.push(`${this.name}_bucket${formatLabelSet({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
      lines.push(`${this.name}_sum${formatLabelSet(sample.labels)} ${sample.sum}`);
      lines.push(`${this.name}_count${formatLabelSet(sample.labels)} ${sample.count}`);
    }

    return lines;
  }
}

class MetricsRegistry {
  constructor() {
    this.metrics = [];
  }

  register(metric) {
    this.metrics.push(metric);
    return metric;
  }

  renderPrometheus() {
    const lines = [];
    for (const metric of this.metrics) {
      lines.push(...metric.collectLines());
    }
    lines.push("");
    return lines.join("\n");
  }
}

function assertMetricName(name) {
  if (!METRIC_NAME_RE.test(name)) {
    throw new Error(`Invalid metric name: ${name}`);
  }
}

const registry = new MetricsRegistry();

function createCounter(config) {
  assertMetricName(config.name);
  return registry.register(new CounterMetric(config));
}

function createGauge(config) {
  assertMetricName(config.name);
  return registry.register(new GaugeMetric(config));
}

function createHistogram(config) {
  assertMetricName(config.name);
  return registry.register(new HistogramMetric(config));
}

export const httpRequestDurationSeconds = createHistogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration seconds",
  labelNames: ["route", "method", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = createCounter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["route", "method", "status"],
});

export const dependencyRequestDurationSeconds = createHistogram({
  name: "dependency_request_duration_seconds",
  help: "Dependency request duration seconds",
  labelNames: ["dependency"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2.5, 5, 10, 20],
});

export const dependencyRequestsTotal = createCounter({
  name: "dependency_requests_total",
  help: "Total dependency requests",
  labelNames: ["dependency", "outcome"],
});

export const queueWaitingJobs = createGauge({
  name: "queue_waiting_jobs",
  help: "Queue waiting jobs",
});

export const queueActiveJobs = createGauge({
  name: "queue_active_jobs",
  help: "Queue active jobs",
});

export const queueDelayedJobs = createGauge({
  name: "queue_delayed_jobs",
  help: "Queue delayed jobs",
});

export const queueFailedJobs = createGauge({
  name: "queue_failed_jobs",
  help: "Queue failed jobs",
});

export const queueCompletedJobs = createGauge({
  name: "queue_completed_jobs",
  help: "Queue completed jobs",
});

export const queueOldestJobSeconds = createGauge({
  name: "queue_oldest_job_seconds",
  help: "Age in seconds of the oldest waiting queue job",
});

export const queuePaused = createGauge({
  name: "queue_paused",
  help: "Queue paused flag",
});

export const queueWorkerHeartbeats = createGauge({
  name: "queue_worker_heartbeats",
  help: "Number of workers with fresh heartbeats",
});

export const queueJobsCompletedTotal = createCounter({
  name: "queue_jobs_completed_total",
  help: "Total completed jobs",
  labelNames: ["job_type"],
});

export const queueJobsFailedTotal = createCounter({
  name: "queue_jobs_failed_total",
  help: "Total failed jobs",
  labelNames: ["job_type", "error_type"],
});

export const queueRetryTotal = createCounter({
  name: "queue_retries_total",
  help: "Total queue retries",
  labelNames: ["job_type", "reason"],
});

export const queueJobRuntimeSeconds = createHistogram({
  name: "queue_job_runtime_seconds",
  help: "Queue job runtime in seconds",
  labelNames: ["job_type"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 45, 90, 180],
});

export const cacheHitsTotal = createCounter({
  name: "cache_hits_total",
  help: "Cache hits",
  labelNames: ["cache"],
});

export const cacheMissesTotal = createCounter({
  name: "cache_misses_total",
  help: "Cache misses",
  labelNames: ["cache"],
});

export const activeUsersLast5m = createGauge({
  name: "active_users_last_5m",
  help: "Distinct active users in the last 5 minutes",
});

export const llmRequestsTotal = createCounter({
  name: "llm_requests_total",
  help: "Total LLM requests",
  labelNames: ["capability", "mode", "provider", "outcome"],
});

export const llmRequestDurationSeconds = createHistogram({
  name: "llm_request_duration_seconds",
  help: "LLM request duration seconds",
  labelNames: ["capability", "mode", "provider", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80, 160],
});

export const llmActiveProvider = createGauge({
  name: "llm_active_provider",
  help: "Current active LLM provider by capability",
  labelNames: ["capability", "mode", "provider"],
});

export const llmModeConfigured = createGauge({
  name: "llm_mode_configured",
  help: "Configured LLM mode (1 for active mode label)",
  labelNames: ["mode"],
});

export const llmLastCallTimestampSeconds = createGauge({
  name: "llm_last_call_timestamp_seconds",
  help: "Unix timestamp of last LLM call by capability/provider",
  labelNames: ["capability", "mode", "provider"],
});

const activeUsers = new Map();
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const llmActiveByCapability = new Map();
const KNOWN_LLM_MODES = ["local", "api", "none", "unknown"];

function normalizeLlmLabel(value, fallback = "unknown") {
  const clean = String(value || "").trim().toLowerCase();
  return clean || fallback;
}

function normalizeRoute(req) {
  const routePath = typeof req?.route?.path === "string" ? req.route.path : req?.path;
  const base = typeof req?.baseUrl === "string" ? req.baseUrl : "";
  const raw = `${base}${routePath || ""}` || req?.originalUrl || "unknown";
  const clean = String(raw).split("?")[0] || "unknown";
  return clean || "unknown";
}

export function trackHttpRequest(req, statusCode, durationSeconds) {
  const route = normalizeRoute(req);
  const method = String(req?.method || "GET").toUpperCase();
  const status = String(statusCode || 0);
  httpRequestsTotal.inc({ route, method, status }, 1);
  httpRequestDurationSeconds.observe({ route, method, status }, durationSeconds);
}

export function markActiveUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  activeUsers.set(id, Date.now());
}

export function refreshActiveUsersGauge() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  for (const [id, seenAt] of activeUsers.entries()) {
    if (seenAt < cutoff) activeUsers.delete(id);
  }
  activeUsersLast5m.set({}, activeUsers.size);
}

export function observeDependencyRequest(dependency, durationSeconds, outcome = "success") {
  const dep = String(dependency || "unknown");
  dependencyRequestDurationSeconds.observe({ dependency: dep }, durationSeconds);
  dependencyRequestsTotal.inc({ dependency: dep, outcome: String(outcome || "unknown") }, 1);
}

export function recordCacheHit(cacheName) {
  const cache = String(cacheName || "unknown");
  cacheHitsTotal.inc({ cache }, 1);
}

export function recordCacheMiss(cacheName) {
  const cache = String(cacheName || "unknown");
  cacheMissesTotal.inc({ cache }, 1);
}

export function setLlmConfiguredMode(mode) {
  const m = normalizeLlmLabel(mode, "unknown");
  for (const key of KNOWN_LLM_MODES) {
    llmModeConfigured.set({ mode: key }, key === m ? 1 : 0);
  }
}

export function markLlmActiveProvider({ capability, mode, provider }) {
  const cap = normalizeLlmLabel(capability, "unknown");
  const m = normalizeLlmLabel(mode, "unknown");
  const p = normalizeLlmLabel(provider, "unknown");
  const nextKey = `${cap}|${m}|${p}`;
  const previousKey = llmActiveByCapability.get(cap);
  if (previousKey && previousKey !== nextKey) {
    const [_, prevMode, prevProvider] = String(previousKey).split("|");
    llmActiveProvider.set({ capability: cap, mode: prevMode, provider: prevProvider }, 0);
  }
  llmActiveByCapability.set(cap, nextKey);
  llmActiveProvider.set({ capability: cap, mode: m, provider: p }, 1);
  llmLastCallTimestampSeconds.set({ capability: cap, mode: m, provider: p }, Date.now() / 1000);
}

export function observeLlmRequest({
  capability,
  mode,
  provider,
  outcome = "success",
  durationSeconds = 0,
}) {
  const labels = {
    capability: normalizeLlmLabel(capability, "unknown"),
    mode: normalizeLlmLabel(mode, "unknown"),
    provider: normalizeLlmLabel(provider, "unknown"),
    outcome: normalizeLlmLabel(outcome, "unknown"),
  };
  llmRequestsTotal.inc(labels, 1);
  llmRequestDurationSeconds.observe(labels, Math.max(0, Number(durationSeconds) || 0));
}

export function setQueueMetrics(stats = {}) {
  queueWaitingJobs.set({}, Number(stats.waiting ?? 0));
  queueActiveJobs.set({}, Number(stats.active ?? 0));
  queueDelayedJobs.set({}, Number(stats.delayed ?? 0));
  queueFailedJobs.set({}, Number(stats.failed ?? 0));
  queueCompletedJobs.set({}, Number(stats.completed ?? 0));
  queueOldestJobSeconds.set({}, Number(stats.oldestWaitingSeconds ?? 0));
  queuePaused.set({}, stats.paused ? 1 : 0);
  queueWorkerHeartbeats.set({}, Number(stats.workerHeartbeats ?? 0));
}

export function markQueueCompleted(jobType, runtimeSeconds) {
  const t = String(jobType || "unknown");
  queueJobsCompletedTotal.inc({ job_type: t }, 1);
  if (Number.isFinite(runtimeSeconds) && runtimeSeconds >= 0) {
    queueJobRuntimeSeconds.observe({ job_type: t }, runtimeSeconds);
  }
}

export function markQueueFailed(jobType, errorType) {
  queueJobsFailedTotal.inc(
    { job_type: String(jobType || "unknown"), error_type: String(errorType || "unknown") },
    1
  );
}

export function markQueueRetry(jobType, reason = "manual") {
  queueRetryTotal.inc({ job_type: String(jobType || "unknown"), reason: String(reason || "manual") }, 1);
}

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const elapsedNs = process.hrtime.bigint() - start;
    const durationSeconds = Number(elapsedNs) / 1_000_000_000;
    trackHttpRequest(req, res.statusCode, durationSeconds);
    if (req?.userId) markActiveUser(req.userId);
    refreshActiveUsersGauge();
  });
  next();
}

export function renderMetrics() {
  refreshActiveUsersGauge();
  return registry.renderPrometheus();
}

export function metricsHandler(_req, res) {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.status(200).send(renderMetrics());
}
