/**
 * Legal facts about a plot from public registers:
 *  - old zoning plans (Ruimtelijke Plannen v4, through our server, which holds the key);
 *  - national monuments and protected town/village views (RCE, via PDOK);
 *  - municipal monuments (the municipality's register, kept as versioned data in this repo).
 */
import {
  contains,
  distanceBetween,
  type LegalFacts,
  type MonumentFact,
  type Point,
  type Polygon,
  type StepContext,
  type ZoningObjectFact,
} from "@vergunbuy/engine";
import { z } from "zod";
import { getJson, VERGUNBUY_API, type FetchFn } from "../http.ts";
import { MUNICIPAL_MONUMENTS } from "../registers/municipalMonuments.ts";
import { ogcItems, outerRings, type Bbox } from "./ogc.ts";

/** Zoning is read this far around the plot: the largest Bal safety distance (22.39 c). */
export const ZONING_MARGIN_M = 120;

const RCE = "https://api.pdok.nl/rce/beschermde-gebieden-cultuurhistorie/ogc/v1";

const ZoningAnswer = z.object({
  data: z.object({
    complete: z.boolean(),
    plans: z.array(
      z.object({ id: z.string(), name: z.string(), date: z.string().nullable() }).passthrough(),
    ),
    objects: z.array(
      z
        .object({
          planId: z.string(),
          kind: z.string(),
          type: z.string().nullable(),
          name: z.string(),
          mainGroup: z.string().nullable(),
          geometry: z.unknown(),
        })
        .passthrough(),
    ),
  }),
});

const GeoJson = z.object({
  type: z.enum(["Point", "Polygon", "MultiPolygon", "LineString", "MultiLineString"]),
  coordinates: z.unknown(),
});

export async function fetchZoning(
  plot: Polygon,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<LegalFacts["zoning"]> {
  const xs = plot.map((p) => p[0]);
  const ys = plot.map((p) => p[1]);
  const m = ZONING_MARGIN_M;
  const ring: [number, number][] = [
    [Math.min(...xs) - m, Math.min(...ys) - m],
    [Math.max(...xs) + m, Math.min(...ys) - m],
    [Math.max(...xs) + m, Math.max(...ys) + m],
    [Math.min(...xs) - m, Math.max(...ys) + m],
  ];
  const answer = await getJson({
    url: new URL(`${VERGUNBUY_API}/api/rp/zoning`),
    schema: ZoningAnswer,
    ctx,
    ...(fetchFn ? { fetchFn } : {}),
    timeoutMs: 45000,
    serviceName: "the zoning plan service",
    postBody: { ring },
  });
  const names = new Map(answer.data.plans.map((p) => [p.id, p.name]));
  const objects: ZoningObjectFact[] = answer.data.objects.map((o) => {
    const g = GeoJson.safeParse(o.geometry);
    return {
      planId: o.planId,
      planName: names.get(o.planId) ?? o.planId,
      kind: o.kind,
      type: o.type,
      name: o.name,
      mainGroup: o.mainGroup,
      outlines: g.success ? outerRings(g.data) : [],
    };
  });
  // An object without a usable outline cannot be placed: the answer is then incomplete.
  const missingGeometry = objects.some(
    (o) => o.outlines.length === 0 && o.kind !== "maatvoeringen",
  );
  return {
    status: answer.data.complete && !missingGeometry ? "complete" : "incomplete",
    plans: answer.data.plans.map((p) => ({ id: p.id, name: p.name, date: p.date })),
    objects,
  };
}

/** National monuments (points) and protected views (polygons) around the plot. */
export async function fetchHeritage(
  plot: Polygon,
  neighbourParcels: Polygon[],
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<{ monuments: MonumentFact[]; views: string[]; complete: boolean }> {
  const xs = plot.map((p) => p[0]);
  const ys = plot.map((p) => p[1]);
  const bbox: Bbox = [
    Math.min(...xs) - 60,
    Math.min(...ys) - 60,
    Math.max(...xs) + 60,
    Math.max(...ys) + 60,
  ];
  const points = await ogcItems(RCE, "rce_inspire_points", bbox, ctx, fetchFn);
  const polygons = await ogcItems(RCE, "rce_inspire_polygons", bbox, ctx, fetchFn);
  const monuments: MonumentFact[] = [];
  const views: string[] = [];
  const relationOf = (at: Point): MonumentFact["relation"] =>
    contains(plot, at)
      ? "on-plot"
      : neighbourParcels.some((p) => contains(p, at) && distanceBetween(p, plot) < 0.5)
        ? "adjacent-parcel"
        : "nearby";
  for (const f of points.features) {
    const ns = String(f.properties.namespace ?? "");
    const g = f.geometry;
    if (!g || g.type !== "Point") continue;
    const at = g.coordinates as [number, number];
    if (/gezicht/i.test(ns)) continue;
    monuments.push({
      register: "national",
      id: String(f.properties.localid ?? f.id),
      name: String(f.properties.text ?? `rijksmonument ${String(f.properties.localid ?? "")}`),
      url: String(f.properties.ci_citation ?? ""),
      at: [at[0], at[1]],
      relation: relationOf([at[0], at[1]]),
    });
  }
  for (const f of polygons.features) {
    const ns = String(f.properties.namespace ?? "");
    const rings = outerRings(f.geometry);
    const touches = rings.some((r) => distanceBetween(r, plot) < 0.01);
    if (!touches) continue;
    if (/gezicht/i.test(ns)) views.push(String(f.properties.text ?? "protected view"));
    else
      monuments.push({
        register: "national",
        id: String(f.properties.localid ?? f.id),
        name: String(f.properties.text ?? "rijksmonument"),
        url: String(f.properties.ci_citation ?? ""),
        relation: "on-plot",
      });
  }
  return { monuments, views, complete: points.complete && polygons.complete };
}

/** Municipal monuments by address (the plot's own addresses). Null: no register for this municipality. */
export function municipalMonumentsAt(
  municipality: string,
  addresses: { street: string; number: number; town: string }[],
): { items: MonumentFact[]; checkedOn: string } | null {
  const register = MUNICIPAL_MONUMENTS[municipality];
  if (!register) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const items = register.items
    .filter((m) =>
      addresses.some(
        (a) =>
          norm(a.street) === norm(m.street) &&
          a.number === m.houseNumber &&
          norm(a.town) === norm(m.city),
      ),
    )
    .map((m) => ({
      register: "municipal" as const,
      id: `${m.street} ${m.houseNumber}`,
      name: m.name,
      url: m.source,
      relation: "on-plot" as const,
    }));
  return { items, checkedOn: register.checkedOn };
}
