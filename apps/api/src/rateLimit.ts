import type { MiddlewareHandler } from "hono";

/**
 * Fixed-window rate limit per client IP.
 * In-memory, so it is per server instance: enough to stop casual abuse of a demo
 * on the free tier. Swap for a shared store (e.g. Upstash) if traffic ever matters.
 */
export function rateLimit(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "local";
    const t = now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= t) {
      hits.set(ip, { count: 1, resetAt: t + opts.windowMs });
    } else if (++entry.count > opts.limit) {
      c.header("retry-after", String(Math.ceil((entry.resetAt - t) / 1000)));
      return c.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } },
        429,
      );
    }
    await next();
  };
}
