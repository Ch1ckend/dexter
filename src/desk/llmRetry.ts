/**
 * Shared rate-limit-aware retry. Free OpenRouter models return sporadic 429s
 * ("Provider returned error") that Dexter's built-in retry (0.5–2s) backs off
 * too briefly to clear. Waiting 5/12/25s lets the per-minute window reset, which
 * makes multi-call pipelines reliable on the free tier. Non-rate-limit errors
 * propagate immediately.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  const backoffMs = [5000, 12000, 25000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const rateLimited = /429|rate.?limit|provider returned error|temporarily/i.test(msg);
      if (!rateLimited || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, backoffMs[i] ?? 25000));
    }
  }
  throw lastErr;
}
