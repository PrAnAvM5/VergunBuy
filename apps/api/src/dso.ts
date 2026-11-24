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

/** Fields worth keeping from items whose format is still being learned (drafts). */
const KEEP =
  /identificatie|technischid|type|opschrift|citeertitel|titel|bevoegdgezag|aangeleverd|versie|expressi|geregistreerd|inwerking|geldig|datum|status|naam|code|waarde|bestuurslaag|publicatie|procedure|ontwerp/i;

function compact(item: unknown, depth = 0): unknown {
  if (depth > 3 || item === null || typeof item !== "object") return item;
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

/**
 * One rule document as we keep it: every field needed to say exactly which version was used.
 * workId names the document across versions; expressionId names this one version. A rule record
 * verified against one expressionId is "changed since verified" as soon as the DSO reports another.
 */
export interface DsoDocument {
  workId: string;
  expressionId: string | null;
  technischId: string | null;
  title: string;
  citeerTitel: string | null;
  kind: string | null;
  authority: { code: string | null; name: string | null; level: string | null };
  version: number | null;
  inForceSince: string | null;
  validSince: string | null;
  registeredAt: string | null;
  publicationId: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toDocument(item: unknown): DsoDocument {
  const i = (item ?? {}) as Record<string, unknown>;
  const by = (i.aangeleverdDoorEen ?? i.bevoegdGezag ?? {}) as Record<string, unknown>;
  const reg = (i.geregistreerdMet ?? {}) as Record<string, unknown>;
  const type = (i.type ?? {}) as Record<string, unknown>;
  return {
    workId: str(i.identificatie) ?? str(i.technischId) ?? "unknown",
    expressionId: str(i.expressionId),
    technischId: str(i.technischId),
    title: str(i.officieleTitel) ?? str(i.opschrift) ?? str(i.citeerTitel) ?? "(no title)",
    citeerTitel: str(i.citeerTitel),
    kind: str(type.waarde),
    authority: { code: str(by.code), name: str(by.naam), level: str(by.bestuurslaag) },
    version: typeof reg.versie === "number" ? reg.versie : null,
    inForceSince: str(reg.beginInwerking),
    validSince: str(reg.beginGeldigheid),
    registeredAt: str(reg.tijdstipRegistratie),
    publicationId: str(i.publicatieID),
  };
}

/** The answer of one complete (all pages) search. */
export interface DsoSearch {
  status: number | null;
  /** Items as the DSO sent them, all pages joined. */
  items: unknown[];
  /** What the DSO says the total is; null when it did not say. */
  totalElements: number | null;
  pages: number;
  /** True only when every page came back and the count matches the DSO's own total. */
  complete: boolean;
  /** The moment the search looked at ("beschikbaarOp"), the same for every page. */
  asOf: string;
  error?: unknown;
}

/** Page size (the DSO's maximum is 200) and a hard stop, so a runaway answer cannot loop. */
export const DSO_PAGING = { size: 200, maxPages: 25 };

export function createDso(cfg: DsoConfig) {
  const fetchFn = cfg.fetchFn ?? fetch;
  const cache = new Map<string, { at: number; value: unknown }>();
  const cacheMs = cfg.cacheMs ?? 6 * 3600_000;
  const searches = new Map<string, { at: number; value: DsoSearch }>();

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
    if (hit && !("beschikbaarOp" in query) && Date.now() - hit.at < cacheMs) {
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
    // Whole searches are cached by searchAll; single pages pinned to a moment are not.
    if (res.ok && !("beschikbaarOp" in query))
      cache.set(cacheKey, { at: Date.now(), value: parsed });
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

    /**
     * Every rule document (regelingen) in force at a point, and every draft (ontwerpregelingen),
     * all pages. Each document carries its exact version (expressionId), so rule records can be
     * checked against it. "complete" is false when any page is missing; callers must then treat
     * the list as unknown, never as "nothing applies".
     */
    async regelingenAt(p: z.infer<typeof RdPoint>) {
      const calls: DsoCall[] = [];
      const point = {
        type: "Point",
        coordinates: [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000],
      };
      const dates: Record<string, string> = p.geldigOp
        ? { geldigOp: p.geldigOp, inWerkingOp: p.geldigOp }
        : {};
      const [inForce, drafts] = await Promise.all([
        searchAll(p.env, "/regelingen/_zoek", { geometrie: point }, dates, calls),
        searchAll(p.env, "/ontwerpregelingen/_zoek", { geometrie: point }, {}, calls),
      ]);
      const documents = inForce.items.map(toDocument);
      return {
        status: inForce.status,
        point: point.coordinates,
        asOf: inForce.asOf,
        complete: inForce.complete && drafts.complete,
        regelingen: {
          status: inForce.status,
          complete: inForce.complete,
          totalElements: inForce.totalElements,
          pages: inForce.pages,
          fingerprint: fingerprint(documents),
          documents,
          ...(inForce.error ? { error: inForce.error } : {}),
        },
        drafts: {
          status: drafts.status,
          complete: drafts.complete,
          totalElements: drafts.totalElements,
          pages: drafts.pages,
          documents: drafts.items.map(toDocument),
          // Draft answers are still being learned: keep the useful fields of each as sent.
          raw: drafts.items.map((i) => compact(i)),
          ...(drafts.error ? { error: drafts.error } : {}),
        },
        calls,
      };
    },
  };

  /**
   * One search, all pages. Every page is asked "as of" the same moment (beschikbaarOp), so a
   * publication that lands between two page requests cannot shift items between pages. The
   * joined answer is cached as a whole (keyed without that moment).
   */
  async function searchAll(
    env: DsoEnv,
    path: string,
    body: unknown,
    query: Record<string, string>,
    calls: DsoCall[],
  ): Promise<DsoSearch> {
    const cacheKey = `all ${env} ${path} ${JSON.stringify(query)} ${JSON.stringify(body)}`;
    const hit = searches.get(cacheKey);
    if (hit && Date.now() - hit.at < cacheMs) {
      calls.push({ operation: path, status: 200, ms: 0, cached: true });
      return hit.value;
    }
    const asOf = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const items: unknown[] = [];
    let totalElements: number | null = null;
    let totalPages = 1;
    let pages = 0;
    let status: number | null = null;
    let error: unknown;
    for (let page = 1; page <= Math.min(totalPages, DSO_PAGING.maxPages); page++) {
      const res = await post(
        env,
        `${path} page ${page}`,
        path,
        { ...query, beschikbaarOp: asOf, page: String(page), size: String(DSO_PAGING.size) },
        body,
        calls,
      );
      status = res.status;
      if (res.status !== 200) {
        error = truncate(res.body);
        break;
      }
      pages++;
      for (const list of Object.values(embedded(res.body))) items.push(...list);
      const info = (res.body as { page?: { totalElements?: unknown; totalPages?: unknown } })?.page;
      if (typeof info?.totalElements === "number") totalElements = info.totalElements;
      if (typeof info?.totalPages === "number") totalPages = info.totalPages;
    }
    const complete =
      error === undefined &&
      pages >= totalPages &&
      (totalElements === null || totalElements === items.length);
    const value: DsoSearch = {
      status,
      items,
      totalElements,
      pages,
      complete,
      asOf,
      ...(error !== undefined ? { error } : {}),
    };
    if (complete) searches.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}

/**
 * A short fingerprint of a set of document versions: changes exactly when a document is added,
 * removed, or gets a new version. Order-independent.
 */
export function fingerprint(docs: DsoDocument[]): string {
  const text = docs
    .map((d) => `${d.workId}@${d.expressionId ?? d.version ?? "?"}`)
    .sort()
    .join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
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
