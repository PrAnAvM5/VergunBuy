/**
 * Data for what things are made of and what stands on the plot line:
 *  - laser echoes per 0.5 m cell, from the AHN point cloud via our server (the AHN storage does
 *    not allow browsers to read it directly);
 *  - the infrared aerial photo (PDOK, CC BY 4.0) at 0.25 m, turned into the plant index NDVI;
 *  - registered fences and walls (BGT scheiding) and hedge lines (BGT vegetatieobject, haag).
 */
import type { EchoGrid, NdviGrid, Point, StepContext } from "@vergunbuy/engine";
import jpeg from "jpeg-js";
import { z } from "zod";
import { getBytes, getJson, VERGUNBUY_API, type FetchFn } from "../http.ts";
import { OGC, ogcItems, str, type Bbox, type Feature } from "./ogc.ts";

export const CIR_WMS = "https://service.pdok.nl/hwh/luchtfotocir/wms/v1_0";
/** Newest high-resolution infrared photo; PDOK renames the underlying year once a year. */
export const CIR_LAYER = "Actueel_orthoHRIR";
export const CIR_RES = 0.25;

const EchoAnswer = z.object({
  data: z.object({
    version: z.string(),
    sheets: z.array(z.string()),
    res: z.number(),
    x0: z.number(),
    y0: z.number(),
    cols: z.number().int(),
    rows: z.number().int(),
    n: z.array(z.number()),
    multi: z.array(z.number()),
    points: z.number(),
  }),
});

export async function fetchEchoes(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<EchoGrid & { points: number; sheets: string[] }> {
  const body = await getJson({
    url: new URL(`${VERGUNBUY_API}/api/ahn/echoes`),
    schema: EchoAnswer,
    ctx,
    ...(fetchFn ? { fetchFn } : {}),
    postBody: { bbox: bbox.map((v) => Math.round(v * 10) / 10) },
    timeoutMs: 55_000,
    serviceName: "the laser point cloud (AHN, via our server)",
  });
  return body.data;
}

export async function fetchNdvi(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<NdviGrid> {
  const x0 = Math.floor(bbox[0] / CIR_RES) * CIR_RES;
  const y0 = Math.floor(bbox[1] / CIR_RES) * CIR_RES;
  const x1 = Math.ceil(bbox[2] / CIR_RES) * CIR_RES;
  const y1 = Math.ceil(bbox[3] / CIR_RES) * CIR_RES;
  const cols = Math.round((x1 - x0) / CIR_RES);
  const rows = Math.round((y1 - y0) / CIR_RES);
  const url = new URL(CIR_WMS);
  for (const [k, v] of Object.entries({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: CIR_LAYER,
    styles: "",
    crs: "EPSG:28992",
    bbox: [x0, y0, x1, y1].map((v) => v.toFixed(2)).join(","),
    width: String(cols),
    height: String(rows),
    format: "image/jpeg",
  }))
    url.searchParams.set(k, v);
  const buf = await getBytes({
    url,
    ctx,
    ...(fetchFn ? { fetchFn } : {}),
    timeoutMs: 15_000,
    serviceName: "the infrared aerial photo (PDOK)",
  });
  const img = jpeg.decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true });
  const ndvi = new Float32Array(cols * rows).fill(Number.NaN);
  for (let r = 0; r < Math.min(rows, img.height); r++)
    for (let c = 0; c < Math.min(cols, img.width); c++) {
      const o = (r * img.width + c) * 4;
      // False-colour infrared: red channel = near infrared, green channel = red light.
      const nir = img.data[o]!;
      const red = img.data[o + 1]!;
      // White (no photo) and black (outside the photo) say nothing.
      if (nir + red === 0 || (nir > 250 && red > 250)) continue;
      ndvi[r * cols + c] = (nir - red) / (nir + red);
    }
  return { layer: CIR_LAYER, res: CIR_RES, x0, y0: y1, cols, rows, ndvi };
}

export function lines(f: Feature): Point[][] {
  const g = f.geometry;
  if (!g) return [];
  const c = g.coordinates as never;
  const pts = (ring: number[][]): Point[] => ring.map((p) => [Number(p[0]), Number(p[1])] as Point);
  switch (g.type) {
    case "LineString":
      return [pts(c)];
    case "MultiLineString":
      return (c as number[][][]).map(pts);
    case "Polygon":
      return [pts((c as number[][][])[0]!)];
    case "MultiPolygon":
      return (c as number[][][][]).map((p) => pts(p[0]!));
    case "Point":
      return [[[Number((c as number[])[0]), Number((c as number[])[1])]]];
  }
  return [];
}

/** Registered fences and walls, and hedges, near the plot (current objects only). */
export async function fetchMapBarriers(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<{ barriers: Point[][]; hedges: Point[][]; types: Record<string, number> }> {
  const [sl, sv, vl, vv] = await Promise.all(
    ["scheiding_lijn", "scheiding_vlak", "vegetatieobject_lijn", "vegetatieobject_vlak"].map((c) =>
      ogcItems(OGC.bgt, c, bbox, ctx, fetchFn),
    ),
  );
  const current = (f: Feature) => !f.properties.eind_registratie;
  const typeOf = (f: Feature) => str(f.properties.plus_type) ?? str(f.properties.type) ?? "?";
  const types: Record<string, number> = {};
  const barriers = [...sl!.features, ...sv!.features]
    .filter(current)
    .filter((f) => typeOf(f) !== "niet-bgt" && typeOf(f) !== "transitie")
    .flatMap((f) => {
      types[typeOf(f)] = (types[typeOf(f)] ?? 0) + 1;
      return lines(f);
    });
  const hedges = [...vl!.features, ...vv!.features]
    .filter(current)
    .filter((f) => typeOf(f) === "haag")
    .flatMap((f) => {
      types.haag = (types.haag ?? 0) + 1;
      return lines(f);
    });
  return { barriers, hedges, types };
}

/** A fixed object in the street a car must miss: lamp post, pole, bollard, cabinet. */
export interface StreetObject {
  at: Point;
  /** BGT kind in plain words ("lamp post", "pole", "bollard", "cabinet", …). */
  kind: string;
  /** The BGT type as registered (e.g. "lichtmast"). */
  type: string;
}

const STREET_OBJECT_TEXT: Record<string, string> = {
  lichtmast: "lamp post",
  verkeersbordpaal: "sign post",
  poller: "bollard",
  drukknoppaal: "push-button post",
  portaal: "gantry",
  haltepaal: "bus stop post",
  hekwerk: "railing",
  verkeersregelinstallatiepaal: "traffic light",
  straatnaambord: "street sign",
  "telecom kast": "telecom cabinet",
  elektrakast: "power cabinet",
  gaskast: "gas cabinet",
  "CAI-kast": "cable cabinet",
};

/** Lamp posts, poles, bollards and cabinets in the street (BGT paal and kast, current only). */
export async function fetchStreetObjects(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<StreetObject[]> {
  const sets = await Promise.all(
    ["paal", "kast"].map((c) => ogcItems(OGC.bgt, c, bbox, ctx, fetchFn)),
  );
  const out: StreetObject[] = [];
  sets.forEach((set, i) => {
    for (const f of set.features) {
      if (f.properties.eind_registratie) continue;
      const type = str(f.properties.plus_type) ?? str(f.properties.type) ?? "";
      if (type === "niet-bgt" || type === "transitie") continue;
      const g = f.geometry as { type: string; coordinates: unknown } | null;
      let at: Point | null = null;
      if (g?.type === "Point") {
        const c = g.coordinates as number[];
        at = [Number(c[0]), Number(c[1])];
      } else if (g?.type === "MultiPoint") {
        const c = (g.coordinates as number[][])[0];
        if (c) at = [Number(c[0]), Number(c[1])];
      } else if (g?.type === "Polygon") {
        const ring = (g.coordinates as number[][][])[0] ?? [];
        if (ring.length)
          at = [
            ring.reduce((s, c) => s + Number(c[0]), 0) / ring.length,
            ring.reduce((s, c) => s + Number(c[1]), 0) / ring.length,
          ];
      }
      if (!at) continue;
      out.push({
        at,
        type: type || (i ? "kast" : "paal"),
        kind: STREET_OBJECT_TEXT[type] ?? (i ? "cabinet" : "pole"),
      });
    }
  });
  return out;
}
