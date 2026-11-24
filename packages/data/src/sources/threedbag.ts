/**
 * 3D BAG (TU Delft / 3DGI, CC BY 4.0): heights, roof type, storeys and change flags per BAG building,
 * derived from the national height scans (AHN). Heights are metres above NAP; we store heights above ground.
 * Docs: https://api.3dbag.nl/api.html
 */
import type { StepContext } from "@vergunbuy/engine";
import { z } from "zod";
import { getJson, type FetchFn } from "../http.ts";
import type { Bbox } from "./ogc.ts";

const Attributes = z
  .object({
    b3_h_maaiveld: z.number().nullable().optional(),
    b3_h_dak_max: z.number().nullable().optional(),
    b3_h_dak_min: z.number().nullable().optional(),
    b3_h_nok: z.number().nullable().optional(),
    b3_dak_type: z.string().nullable().optional(),
    b3_bouwlagen: z.number().nullable().optional(),
    b3_pw_datum: z.number().nullable().optional(),
    b3_pw_bron: z.string().nullable().optional(),
    b3_mutatie_ahn3_ahn4: z.boolean().nullable().optional(),
    b3_mutatie_ahn4_ahn5: z.boolean().nullable().optional(),
    b3_kwaliteitsindicator: z.boolean().nullable().optional(),
    voorkomenidentificatie: z.number().nullable().optional(),
    documentdatum: z.string().nullable().optional(),
  })
  .passthrough();

const Page = z.object({
  features: z.array(
    z.object({
      CityObjects: z.record(
        z.object({ type: z.string(), attributes: Attributes.optional() }).passthrough(),
      ),
    }),
  ),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

export interface BuildingHeights {
  /** Highest roof point above ground, metres. */
  heightM?: number;
  /** Lowest roof point above ground, metres (eaves or a lower roof part). */
  lowestRoofM?: number;
  roofType?: string;
  storeys?: number;
  /** Year of the height scan used. */
  scanYear?: number;
  scanSource?: string;
  /** The height scans show a change to this building between scans. */
  changedBetweenScans: { ahn3ToAhn4?: boolean; ahn4ToAhn5?: boolean };
  /** BAG record version; above 1 means the register record was changed after creation. */
  registerVersion?: number;
  reliable?: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function fetchHeights(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
  maxPages = 5,
): Promise<Map<string, BuildingHeights>> {
  const out = new Map<string, BuildingHeights>();
  let next: URL | undefined = new URL("https://api.3dbag.nl/collections/pand/items");
  next.searchParams.set("bbox", bbox.map((n) => n.toFixed(2)).join(","));
  next.searchParams.set("limit", "100");
  for (let page = 0; next && page < maxPages; page++) {
    const body: z.infer<typeof Page> = await getJson({
      url: next,
      schema: Page,
      ctx,
      serviceName: "3D BAG",
      ...(fetchFn ? { fetchFn } : {}),
    });
    for (const f of body.features) {
      for (const [key, obj] of Object.entries(f.CityObjects)) {
        if (obj.type !== "Building" || !obj.attributes) continue;
        const a = obj.attributes;
        const ground = a.b3_h_maaiveld ?? undefined;
        const h: BuildingHeights = {
          changedBetweenScans: {
            ...(a.b3_mutatie_ahn3_ahn4 != null ? { ahn3ToAhn4: a.b3_mutatie_ahn3_ahn4 } : {}),
            ...(a.b3_mutatie_ahn4_ahn5 != null ? { ahn4ToAhn5: a.b3_mutatie_ahn4_ahn5 } : {}),
          },
        };
        if (ground != null && a.b3_h_dak_max != null) h.heightM = round1(a.b3_h_dak_max - ground);
        if (ground != null && a.b3_h_dak_min != null)
          h.lowestRoofM = round1(a.b3_h_dak_min - ground);
        if (a.b3_dak_type) h.roofType = a.b3_dak_type;
        if (a.b3_bouwlagen != null) h.storeys = a.b3_bouwlagen;
        if (a.b3_pw_datum != null) h.scanYear = a.b3_pw_datum;
        if (a.b3_pw_bron) h.scanSource = a.b3_pw_bron;
        if (a.voorkomenidentificatie != null) h.registerVersion = a.voorkomenidentificatie;
        if (a.b3_kwaliteitsindicator != null) h.reliable = a.b3_kwaliteitsindicator;
        out.set(key.replace("NL.IMBAG.Pand.", ""), h);
      }
    }
    const href = body.links?.find((l) => l.rel === "next")?.href;
    next = href ? new URL(href) : undefined;
  }
  return out;
}
