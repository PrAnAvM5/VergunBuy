/**
 * Generic reader for PDOK OGC API Features collections (BAG, BRK, BGT), in RD New.
 */
import { cleanPolygon, type Polygon, type StepContext } from "@vergunbuy/engine";
import { z } from "zod";
import { getJson, type FetchFn } from "../http.ts";

export const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";

export const OGC = {
  bag: "https://api.pdok.nl/kadaster/bag/ogc/v2",
  brk: "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1",
  bgt: "https://api.pdok.nl/kadaster/bgt/ogc/v1",
} as const;

const Geometry = z.object({
  type: z.enum(["Point", "Polygon", "MultiPolygon", "LineString", "MultiLineString"]),
  coordinates: z.unknown(),
});

export const Feature = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  geometry: Geometry.nullable(),
  properties: z.record(z.unknown()),
});
export type Feature = z.infer<typeof Feature>;

const FeatureCollection = z.object({
  features: z.array(Feature),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

export type Bbox = [number, number, number, number];

/** Result of a paged read. `complete` is false when more pages existed than we read. */
export interface OgcResult {
  features: Feature[];
  complete: boolean;
  pages: number;
}

export const OGC_MAX_PAGES = 10;

export async function ogcItems(
  base: string,
  collection: string,
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
  maxPages = OGC_MAX_PAGES,
): Promise<OgcResult> {
  const url = new URL(`${base}/collections/${collection}/items`);
  url.searchParams.set("f", "json");
  url.searchParams.set("limit", "1000");
  url.searchParams.set("bbox", bbox.map((n) => n.toFixed(3)).join(","));
  url.searchParams.set("bbox-crs", RD_CRS);
  url.searchParams.set("crs", RD_CRS);

  const features: Feature[] = [];
  let next: URL | undefined = url;
  let pages = 0;
  while (next && pages < maxPages) {
    const body: z.infer<typeof FeatureCollection> = await getJson({
      url: next,
      schema: FeatureCollection,
      ctx,
      serviceName: `PDOK (${collection})`,
      ...(fetchFn ? { fetchFn } : {}),
    });
    pages++;
    features.push(...body.features);
    const href = body.links?.find((l) => l.rel === "next")?.href;
    next = href ? new URL(href) : undefined;
  }
  // If a next page still exists, the list was cut off: say so, never pretend it is complete.
  const complete = next === undefined;
  if (!complete) ctx.degrade(`${collection}: more than ${pages} pages, list cut off`);
  return { features, complete, pages };
}

/** Outer rings of a (Multi)Polygon as open rings. Holes are ignored (rare for plots and houses). */
export function outerRings(geometry: Feature["geometry"]): Polygon[] {
  if (!geometry) return [];
  const close = (ring: number[][]): Polygon => {
    // Drops the closing point and any repeated points (see cleanPolygon).
    return cleanPolygon(ring.map((p) => [Number(p[0]), Number(p[1])] as const));
  };
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates as number[][][];
    return rings[0] ? [close(rings[0])] : [];
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as number[][][][]).flatMap((poly) =>
      poly[0] ? [close(poly[0])] : [],
    );
  }
  return [];
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
