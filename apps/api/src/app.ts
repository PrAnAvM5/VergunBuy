/**
 * The API, built as a factory so tests can inject a fake fetch and fixed settings.
 *
 * Every plot-related response has the same envelope:
 *   { data?, error?, trace, requestId }
 * so the frontend and the System view page always get the trace, also when a step fails.
 */
import { AddressQuery, findAddress, type FetchFn } from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { toErrorBody } from "./errors.ts";
import { rateLimit } from "./rateLimit.ts";

export interface AppDeps {
  fetchFn?: FetchFn;
  allowedOrigins: string[];
  version: string;
  rateLimit?: { limit: number; windowMs: number };
  log?: (entry: Record<string, unknown>) => void;
}

export function createApp(deps: AppDeps) {
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const app = new Hono().basePath("/api");

  app.use("*", requestId());
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: deps.allowedOrigins, allowMethods: ["GET"] }));
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    log({
      level: c.res.status >= 500 ? "error" : "info",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });
  app.use("/search", rateLimit(deps.rateLimit ?? { limit: 30, windowMs: 60_000 }));

  app.get("/health", (c) =>
    c.json({ status: "ok", version: deps.version, time: new Date().toISOString() }),
  );

  app.get("/search", async (c) => {
    const tracer = new Tracer();
    const parsed = AddressQuery.safeParse(c.req.query());
    if (!parsed.success) {
      tracer.skip("find-address", "Find address", "Input was not valid.");
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: parsed.error.issues[0]?.message ?? "Invalid input.",
          },
          trace: tracer.steps,
          requestId: c.get("requestId"),
        },
        400,
      );
    }
    try {
      const address = await tracer.step(
        "find-address",
        "Find address (PDOK Locatieserver)",
        (ctx) => findAddress(parsed.data, ctx, deps.fetchFn),
      );
      return c.json({ data: { address }, trace: tracer.steps, requestId: c.get("requestId") });
    } catch (err) {
      const { status, body } = toErrorBody(err);
      return c.json({ error: body, trace: tracer.steps, requestId: c.get("requestId") }, status);
    }
  });

  return app;
}
