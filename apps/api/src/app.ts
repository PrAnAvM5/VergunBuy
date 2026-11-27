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
import { createDso, DsoNotConfigured, RdPoint } from "./dso.ts";
import { createRp, PlotPolygon } from "./rp.ts";
import { createPermits, PermitQuery } from "./permits.ts";
import { createAhn, EchoQuery, GroundQuery } from "./ahn.ts";

export interface AppDeps {
  dso?: ReturnType<typeof createDso>;
  rp?: ReturnType<typeof createRp>;
  permits?: ReturnType<typeof createPermits>;
  ahn?: ReturnType<typeof createAhn>;
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
  app.use("*", cors({ origin: deps.allowedOrigins, allowMethods: ["GET", "POST"] }));
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
  // DSO calls use the key's quota: stricter limit per visitor.
  app.use("/dso/*", rateLimit(deps.rateLimit ?? { limit: 20, windowMs: 60_000 }));
  app.use("/rp/*", rateLimit(deps.rateLimit ?? { limit: 20, windowMs: 60_000 }));
  const dso = deps.dso ?? createDso({ keys: {} });
  const rp = deps.rp ?? createRp({});
  const permits = deps.permits ?? createPermits();
  app.use("/permits", rateLimit(deps.rateLimit ?? { limit: 20, windowMs: 60_000 }));
  const ahn = deps.ahn ?? createAhn();
  app.use("/ahn/*", rateLimit(deps.rateLimit ?? { limit: 20, windowMs: 60_000 }));

  /**
   * Ground points (class 2) in narrow strips, e.g. both sides of a kerb: x, y as cm offsets from
   * (ox, oy), z in mm. Body: { polygons } in RD New.
   */
  app.post("/ahn/ground", async (c) => {
    const parsed = GroundQuery.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message:
              "Give polygons: [[[x, y], …], …] in RD New, within 220 m and at most 1500 m² in all.",
          },
        },
        400,
      );
    try {
      const data = await ahn.ground(parsed.data.polygons);
      return c.json({ data, requestId: c.get("requestId") });
    } catch (err) {
      log({ level: "error", path: "/ahn/ground", message: String(err).slice(0, 300) });
      return c.json(
        {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The laser point cloud could not be read right now.",
            detail: String(err).slice(0, 200),
          },
          requestId: c.get("requestId"),
        },
        502,
      );
    }
  });

  /**
   * Laser-scan echoes around a plot: per 0.5 m cell, non-ground points and how many came from
   * pulses with several echoes (leaves) rather than one (walls, fences, roofs). Body: { bbox }
   * in RD New, at most 220 m per side.
   */
  app.post("/ahn/echoes", async (c) => {
    const parsed = EchoQuery.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Give bbox: [xmin, ymin, xmax, ymax] in RD New, at most 220 m per side.",
          },
        },
        400,
      );
    try {
      const data = await ahn.echoes(parsed.data.bbox);
      return c.json({ data, requestId: c.get("requestId") });
    } catch (err) {
      log({ level: "error", path: "/ahn/echoes", message: String(err).slice(0, 300) });
      return c.json(
        {
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The laser point cloud could not be read right now.",
            // Upstream failure text only (no secrets are involved in this route).
            detail: String(err).slice(0, 200),
          },
          requestId: c.get("requestId"),
        },
        502,
      );
    }
  });

  /**
   * Permit history of a home from the municipality's official publications (Gemeenteblad).
   * Body: { municipality, street, number, letter?, ring: [[x, y], ...] } (plot outline, RD New).
   */
  app.post("/permits", async (c) => {
    const parsed = PermitQuery.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Give municipality, street, number and the plot ring.",
          },
        },
        400,
      );
    return c.json({ data: await permits.historyFor(parsed.data), requestId: c.get("requestId") });
  });

  /**
   * Old zoning plans (tijdelijk deel of the omgevingsplan) at a plot: the binding plans and every
   * plan object that overlaps the plot outline, with geometry. Body: { ring: [[x, y], ...] } in RD.
   */
  app.post("/rp/zoning", async (c) => {
    const parsed = PlotPolygon.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Give the plot outline as ring: [[x, y], ...] in RD New.",
          },
        },
        400,
      );
    if (!rp.configured())
      return c.json(
        { error: { code: "RP_NOT_CONFIGURED", message: "No Ruimtelijke Plannen key is set." } },
        503,
      );
    const data = await rp.zoningForPlot(parsed.data.ring);
    return c.json({ data, requestId: c.get("requestId") });
  });

  /** Whether keys are configured; never the keys themselves. */
  app.get("/dso/status", (c) =>
    c.json({
      data: {
        prod: dso.configured("prod"),
        rp: rp.configured(),
        pre: dso.configured("pre"),
        // Names only (never values) of key-like variables the server can see, to spot typos.
        variablesSeen: Object.keys(process.env)
          .filter((k) => /(^DS|^RP_|API_KEY)/i.test(k))
          .sort(),
      },
    }),
  );

  /** The DSO API's own description, reduced (no key involved in the answer). */
  app.get("/dso/spec", async (c) => {
    try {
      return c.json({ data: await dso.spec("prod") });
    } catch (err) {
      if (err instanceof DsoNotConfigured)
        return c.json(
          { error: { code: "DSO_NOT_CONFIGURED", message: "No DSO key is set." } },
          503,
        );
      throw err;
    }
  });

  /** Rule documents that apply at a point (RD New), valid today or on geldigOp. */
  app.get("/dso/regelingen", async (c) => {
    const parsed = RdPoint.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        { error: { code: "INVALID_INPUT", message: "Give x and y in RD New (EPSG:28992)." } },
        400,
      );
    try {
      const data = await dso.regelingenAt(parsed.data);
      return c.json({ data, requestId: c.get("requestId") }, data.status === null ? 502 : 200);
    } catch (err) {
      if (err instanceof DsoNotConfigured)
        return c.json(
          { error: { code: "DSO_NOT_CONFIGURED", message: `No DSO key is set for ${err.env}.` } },
          503,
        );
      throw err;
    }
  });

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
