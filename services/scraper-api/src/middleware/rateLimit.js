const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(ms, pct = 0.2) {
  const j = ms * pct;
  return Math.max(0, Math.floor(ms - j + Math.random() * (2 * j)));
}

export function makeLimiter({
  minIntervalMs = 1000,
  maxConcurrency = 1,
  maxBackoffMs = 30000,
} = {}) {
  let inFlight = 0;
  let nextAllowedAt = 0;
  let backoffMs = 0;

  const queue = [];

  async function runNext() {
    if (inFlight >= maxConcurrency) return;
    const job = queue.shift();
    if (!job) return;

    inFlight++;
    try {
      const now = Date.now();
      const waitFor = Math.max(0, nextAllowedAt - now);
      if (waitFor > 0) await sleep(waitFor);

      nextAllowedAt = Date.now() + jitter(minIntervalMs);

      const result = await job.fn();
      backoffMs = Math.max(0, Math.floor(backoffMs * 0.5));
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      inFlight--;
      runNext();
    }
  }

  function schedule(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  }

  function onRateLimited(retryAfterMs) {
    const base = retryAfterMs ?? (backoffMs ? backoffMs : 2000);
    backoffMs = Math.min(maxBackoffMs, Math.max(1500, Math.floor(base * 2)));
    nextAllowedAt = Math.max(nextAllowedAt, Date.now() + jitter(backoffMs, 0.15));
  }

  return { schedule, onRateLimited };
}
