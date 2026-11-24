/**
 * DSO (Digitaal Stelsel Omgevingswet) client. The API key lives only in the server's environment
 * (Vercel: DSO_API_KEY / DSO_API_KEY_PRE) and is sent as the x-api-key header; it never reaches
 * the browser, the logs or a response.
 *
 * Only a fixed list of operations exists (no pass-through of arbitrary paths), each with a
 * timeout, and answers are cached for a while so the key is not overused.
 *
 * Presenteren v8, per the DSO functional documentation: POST /regelingen/_zoek with a GeoJSON
 * geometry in RD New (Content-Crs), optional geldigOp / inWerkingOp / beschikbaarOp dates.
 * Field names in the answers are recorded as they come ("discovery") until they are pinned down.
 */
import { z } from "zod";

export type DsoEnv = "prod" | "pre";

const BASES: Record<DsoEnv, string> = {
  prod: "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8",
  pre: "https://service.pre.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8",
};
const RD = "http://www.opengis.net/def/crs/EPSG/0/28992";

/** A point inside the Netherlands in RD New; at most 3 decimals (a DSO requirement). */
export const RdPoint = z.object({
  x: z.coerce.number().min(-7000).max(300000),
  y: z.coerce.number().min(289000).max(629000),
  env: z.enum(["prod", "pre"]).default("prod"),
  /** Date the rules must be valid on (yyyy-mm-dd); default today. */
  geldigOp: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export interface DsoCall {
  operation: string;
  status: number | null;
  ms: number;
  cached: boolean;
}

export interface DsoConfig {
  keys: Partial<Record<DsoEnv, string>>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
}

/** Fields worth keeping from each regeling while we learn the exact answer format. */
const KEEP =
  /identificatie|technischid|type|opschrift|citeertitel|titel|bevoegdgezag|versie|expressie|geregistreerd|inwerking|geldig|datum|status|naam|code|waarde/i;

function compact(item: unknown, depth = 0): unknown {
  if (depth > 2 || item === null || typeof item !== "object") return item;
  if (Array.isArray(item)) return item.slice(0, 5).map((x) => compact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "_links" || k === "geometrie") continue;
    if (KEEP.test(k) || (typeof v === "object" && depth < 2)) out[k] = compact(v, depth + 1);
  }
  return out;
}

/** All arrays under _embedded (the HAL envelope the DSO uses), flattened by name. */
function embedded(body: unknown): Record<string, unknown[]> {
  const e = (body as { _embedded?: Record<string, unknown> } | null)?._embedded ?? {};
  return Object.fromEntries(
    Object.entries(e).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][],
  );
}

export function createDso(cfg: DsoConfig) {
  const fetchFn = cfg.fetchFn ?? fetch;
  const cache = new Map<string, { at: number; value: unknown }>();
  const cacheMs = cfg.cacheMs ?? 6 * 3600_000;

  async function post(
    env: DsoEnv,
    operation: string,
    path: string,
    query: Record<string, string>,
    body: unknown,
    calls: DsoCall[],
  ): Promise<{ status: number | null; body: unknown }> {
    const key = cfg.keys[env];
    if (!key) throw new DsoNotConfigured(env);
    const url = new URL(BASES[env] + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const cacheKey = `${env} ${url.toString()} ${JSON.stringify(body)}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < cacheMs) {
      calls.push({ operation, status: 200, ms: 0, cached: true });
      return { status: 200, body: hit.value };
    }
    const started = performance.now();
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          accept: "application/hal+json, application/json",
          "content-crs": RD,
          "accept-crs": RD,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
      });
    } catch {
      calls.push({
        operation,
        status: null,
        ms: Math.round(performance.now() - started),
        cached: false,
      });
      return {
        status: null,
        body: { error: "DSO could not be reached or did not answer in time" },
      };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { nonJson: text.slice(0, 2000) };
    }
    calls.push({
      operation,
      status: res.status,
      ms: Math.round(performance.now() - started),
      cached: false,
    });
    if (res.ok) cache.set(cacheKey, { at: Date.now(), value: parsed });
    return { status: res.status, body: parsed };
  }

  return {
    configured: (env: DsoEnv) => Boolean(cfg.keys[env]),

    /**
     * The API's own description (OpenAPI), reduced to what we need: the paths, and the request
     * and response schemas of the location search. Used to match the request format exactly.
     */
    async spec(env: DsoEnv) {
      const key = cfg.keys[env];
      if (!key) throw new DsoNotConfigured(env);
      const tried: { path: string; status: number | null }[] = [];
      for (const path of ["/openapi.json", "/api-docs", "/v3/api-docs", "/openapi.yaml"]) {
        try {
          const res = await fetchFn(BASES[env] + path, {
            headers: { "x-api-key": key, accept: "application/json" },
            signal: AbortSignal.timeout(cfg.timeoutMs ?? 15000),
          });
          tried.push({ path, status: res.status });
          if (!res.ok) continue;
          const doc = (await res.json()) as {
            paths?: Record<string, Record<string, unknown>>;
            components?: { schemas?: Record<string, unknown> };
          };
          const zoek = doc.paths?.["/regelingen/_zoek"];
          const refs = new Set<string>();
          JSON.stringify(zoek ?? {}).replace(
            /#\/components\/schemas\/([\w.-]+)/g,
            (_m, n: string) => {
              refs.add(n);
              return "";
            },
          );
          // Follow schema references two levels deep, so the request body is fully visible.
          for (let round = 0; round < 3; round++)
            for (const n of [...refs])
              JSON.stringify(doc.components?.schemas?.[n] ?? {}).replace(
                /#\/components\/schemas\/([\w.-]+)/g,
                (_m, m: string) => {
                  refs.add(m);
                  return "";
                },
              );
          return {
            from: path,
            paths: Object.keys(doc.paths ?? {}),
            regelingenZoek: zoek,
            schemas: Object.fromEntries([...refs].map((n) => [n, doc.components?.schemas?.[n]])),
          };
        } catch {
          tried.push({ path, status: null });
        }
      }
      return { tried };
    },

    /** Which rule documents (regelingen) apply at a point, valid on a date. */
    async regelingenAt(p: z.infer<typeof RdPoint>) {
      const calls: DsoCall[] = [];
      const point = {
        type: "Point",
        coordinates: [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000],
      };
      const query: Record<string, string> = { size: "50" };
      if (p.geldigOp) {
        query.geldigOp = p.geldigOp;
        query.inWerkingOp = p.geldigOp;
      }
      const res = await post(
        p.env,
        "regelingen/_zoek",
        "/regelingen/_zoek",
        query,
        { geo: { geometrie: point, spatialOperator: "intersects" } },
        calls,
      );
      const lists = embedded(res.body);
      return {
        status: res.status,
        calls,
        regelingen: Object.fromEntries(
          Object.entries(lists).map(([name, items]) => [name, items.map((i) => compact(i))]),
        ),
        // While the answer format is being learned: the error body, or the first keys.
        ...(res.status !== 200
          ? { error: truncate(res.body) }
          : { topLevelKeys: Object.keys((res.body as object) ?? {}) }),
      };
    },
  };
}

/** The DSO's own error answer, cut to a safe size (it never contains the key). */
function truncate(body: unknown): unknown {
  const text = JSON.stringify(body);
  return text.length <= 4000 ? body : { truncated: text.slice(0, 4000) };
}

export class DsoNotConfigured extends Error {
  constructor(public env: DsoEnv) {
    super(`No DSO key configured for ${env}`);
  }
}
