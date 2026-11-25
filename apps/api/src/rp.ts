/**
 * Ruimtelijke Plannen v4 client: the old zoning plans (bestemmingsplannen) that still form the
 * "tijdelijk deel" of every omgevingsplan. The key (RP_API_KEY) lives only in the server's
 * environment and is sent as the x-api-key header.
 *
 * One operation: which binding plans apply to a plot, and which plan objects (zoning, double
 * zoning, area designations, measurements) intersect it. All pages are read; an incomplete answer
 * is marked so callers treat it as unknown, never as "nothing applies".
 */
import { z } from "zod";

const BASE = "https://ruimte.omgevingswet.overheid.nl/ruimtelijke-plannen/api/opvragen/v4";

/** A plot outline in RD New: a closed or open ring, at most 500 vertices, inside NL. */
export const PlotPolygon = z.object({
  ring: z
    .array(z.tuple([z.number().min(-7000).max(300000), z.number().min(289000).max(629000)]))
    .min(3)
    .max(500),
});

export interface RpConfig {
  key?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
  /** Retries after "too many requests" (429) or 503; waits retryBaseMs × 2^attempt. */
  retries?: number;
  retryBaseMs?: number;
}

export class RpNotConfigured extends Error {
  constructor() {
    super("No Ruimtelijke Plannen key configured");
  }
}

/** A plan that binds citizens and is in force (not a draft, not a consolidation, not withdrawn). */
export function isBindingPlan(p: Record<string, unknown>): boolean {
  const status = String((p.planstatusInfo as { planstatus?: string } | undefined)?.planstatus);
  return (
    p.regelBinding === "burgerbindend" &&
    p.regelStatus === "geldend" &&
    p.isHistorisch !== true &&
    !["ontwerp", "voorontwerp", "geconsolideerd"].includes(status)
  );
}

export interface ZoningPlan {
  id: string;
  name: string;
  type: string;
  status: string;
  date: string | null;
  authority: string | null;
  rulesUrl: string | null;
}

export interface ZoningObject {
  planId: string;
  id: string;
  /** bestemmingsvlakken, bouwvlakken, gebiedsaanduidingen, maatvoeringen, ... */
  kind: string;
  /** e.g. enkelbestemming, dubbelbestemming. */
  type: string | null;
  name: string;
  mainGroup: string | null;
  article: string | null;
  textIds: string[];
  values: unknown;
  geometry: unknown;
}

/** Every kind of plan object that can carry rules for a location. */
export const OBJECT_KINDS = [
  "bestemmingsvlakken",
  "bouwvlakken",
  "functieaanduidingen",
  "bouwaanduidingen",
  "gebiedsaanduidingen",
  "lettertekenaanduidingen",
  "maatvoeringen",
  "figuren",
] as const;

/** Runs at most n tasks at the same time. */
function pool(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function createRp(cfg: RpConfig) {
  const fetchFn = cfg.fetchFn ?? fetch;
  const cacheMs = cfg.cacheMs ?? 24 * 3600_000;
  const cache = new Map<string, { at: number; value: unknown }>();

  /** One request; on "too many requests" or a temporary failure, waits and tries again. */
  async function post(
    path: string,
    body: unknown,
    attempt = 0,
  ): Promise<{ status: number | null; body: unknown }> {
    if (!cfg.key) throw new RpNotConfigured();
    const res = await fetchFn(BASE + path, {
      method: "POST",
      headers: {
        "x-api-key": cfg.key,
        accept: "application/hal+json, application/json",
        "content-type": "application/json",
        "content-crs": "epsg:28992",
        "accept-crs": "epsg:28992",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 20000),
    }).catch(() => null);
    if ((!res || res.status === 429 || res.status === 503) && attempt < (cfg.retries ?? 4)) {
      const after = Number(res?.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(after) && after > 0
          ? Math.min(after, 10) * 1000
          : (cfg.retryBaseMs ?? 800) * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      return post(path, body, attempt + 1);
    }
    if (!res) return { status: null, body: null };
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { nonJson: text.slice(0, 500) };
    }
    return { status: res.status, body: parsed };
  }

  /** All pages of a search; complete only when every page came back. */
  async function searchAll(path: string, body: unknown, listName?: string) {
    const items: Record<string, unknown>[] = [];
    let complete = true;
    for (let page = 1; page <= 20; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await post(`${path}${sep}page=${page}&pageSize=50`, body);
      if (r.status !== 200) {
        complete = false;
        return { items, complete, error: { status: r.status, body: r.body } };
      }
      const b = r.body as {
        _embedded?: Record<string, Record<string, unknown>[]>;
        _links?: { next?: unknown };
      };
      const lists = Object.entries(b._embedded ?? {}).filter(([k]) => !listName || k === listName);
      for (const [kind, list] of lists) for (const it of list) items.push({ ...it, _kind: kind });
      if (!b._links?.next) return { items, complete };
    }
    return { items, complete: false };
  }

  return {
    configured: () => Boolean(cfg.key),

    async zoningForPlot(ring: [number, number][]) {
      const closed =
        ring[0]![0] === ring.at(-1)![0] && ring[0]![1] === ring.at(-1)![1]
          ? ring
          : [...ring, ring[0]!];
      const geometry = {
        type: "Polygon",
        coordinates: [
          closed.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]),
        ],
      };
      const key = JSON.stringify(geometry);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) return { ...(hit.value as object), cached: true };

      // "Overlaps but does not merely touch": a neighbour's plan that only shares the boundary
      // does not count.
      const geo = { _geo: { intersectAndNotTouches: geometry } };
      const plans = await searchAll("/plannen/_zoek", geo, "plannen");
      const binding = plans.items.filter(isBindingPlan);
      const planList: ZoningPlan[] = binding.map((p) => ({
        id: String(p.id),
        name: String(p.naam ?? ""),
        type: String(p.type ?? ""),
        status: String((p.dossier as { status?: string } | undefined)?.status ?? ""),
        date: str((p.planstatusInfo as { datum?: string } | undefined)?.datum),
        authority: str((p.beleidsmatigVerantwoordelijkeOverheid as { naam?: string })?.naam),
        rulesUrl:
          (
            (p.heeftOnderdelen as { type?: string; externeReferenties?: string[] }[] | undefined) ??
            []
          ).find((o) => o.type === "regels")?.externeReferenties?.[0] ?? null,
      }));
      const objects: ZoningObject[] = [];
      let complete = plans.complete;
      const errors: unknown[] = plans.complete ? [] : [plans.error];
      // Plans and object kinds read 3 at a time (pages of one kind in sequence).
      const limit = pool(3);
      const results = await Promise.all(
        planList.flatMap((p) =>
          OBJECT_KINDS.map((kind) =>
            limit(async () => ({
              plan: p.id,
              kind,
              r: await searchAll(
                `/plannen/${encodeURIComponent(p.id)}/${kind}/_zoek?expand=geometrie`,
                geo,
                kind,
              ),
            })),
          ),
        ),
      );
      for (const { plan, kind, r } of results) {
        if (!r.complete) {
          complete = false;
          errors.push({ plan, kind, error: r.error ?? "incomplete" });
        }
        for (const o of r.items) {
          const links = o._links as { teksten?: { tekstId?: string }[] } | undefined;
          objects.push({
            planId: plan,
            id: String(o.id),
            kind: String(o._kind),
            type: str(o.type),
            name: String(o.naam ?? ""),
            mainGroup: str(o.bestemmingshoofdgroep),
            article: str(o.artikelnummer),
            textIds: (links?.teksten ?? []).map((t) => String(t.tekstId)),
            values: o.omvang ?? o.waarden ?? null,
            geometry: o.geometrie ?? null,
          });
        }
      }
      const value = {
        complete,
        plans: planList,
        objects,
        otherPlansAtPlot: plans.items.length - binding.length,
        ...(errors.length ? { errors } : {}),
      };
      if (complete) cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}
