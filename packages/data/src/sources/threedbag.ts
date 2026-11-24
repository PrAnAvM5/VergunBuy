/**
 * 3D BAG (TU Delft / 3DGI, CC BY 4.0): heights, roof type, storeys, change flags and 3D shape
 * per BAG building, derived from the national height scans (AHN).
 * Heights in the source are metres above NAP; we convert to metres above ground.
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

const Geometry = z
  .object({
    type: z.string(),
    lod: z.string(),
    boundaries: z.unknown(),
    semantics: z
      .object({
        surfaces: z.array(z.object({ type: z.string() }).passthrough()),
        values: z.unknown(),
      })
      .optional(),
  })
  .passthrough();

const CityObject = z
  .object({
    type: z.string(),
    attributes: Attributes.optional(),
    geometry: z.array(Geometry).optional(),
  })
  .passthrough();

const Page = z.object({
  features: z.array(
    z.object({
      CityObjects: z.record(CityObject),
      vertices: z.array(z.array(z.number())).optional(),
    }),
  ),
  metadata: z
    .object({
      transform: z
        .object({ scale: z.array(z.number()), translate: z.array(z.number()) })
        .optional(),
    })
    .passthrough()
    .optional(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

/** One planar face of a building: RD x, RD y, height above ground (metres). */
export interface Face {
  kind: "roof" | "wall" | "ground";
  ring: [number, number, number][];
  /** Roof slope in degrees, when known. */
  slopeDeg?: number;
}

export interface BuildingMesh {
  /** Level of detail used: 2.2 = real roof shapes, 1.3/1.2 = simpler blocks. */
  lod: string;
  faces: Face[];
}

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
  /** Each roof plane: slope and top height above ground (from LoD 2.2). */
  roofParts?: { slopeDeg: number; topM: number }[];
  mesh?: BuildingMesh;
}

const PREFERRED_LODS = ["2.2", "1.3", "1.2"];
const round1 = (n: number) => Math.round(n * 10) / 10;

type CityObjectT = z.infer<typeof CityObject>;

function buildMesh(
  part: CityObjectT | undefined,
  vtx: (i: number) => [number, number, number],
): { mesh: BuildingMesh; roofParts: { slopeDeg: number; topM: number }[] } | undefined {
  const geoms = part?.geometry ?? [];
  const geom = PREFERRED_LODS.map((l) => geoms.find((g) => g.lod === l)).find(Boolean);
  if (!geom || geom.type !== "Solid" || !geom.semantics) return undefined;
  const shells = geom.boundaries as number[][][][];
  const values = geom.semantics.values as number[][];
  const surfaces = geom.semantics.surfaces;
  const faces: Face[] = [];
  const roofParts: { slopeDeg: number; topM: number }[] = [];
  shells.forEach((shell, si) =>
    shell.forEach((surface, fi) => {
      const sem = surfaces[values[si]?.[fi] ?? -1] as
        { type: string; b3_hellingshoek?: number } | undefined;
      const kind: Face["kind"] =
        sem?.type === "RoofSurface" ? "roof" : sem?.type === "GroundSurface" ? "ground" : "wall";
      const outer = surface[0];
      if (!outer) return;
      const face: Face = { kind, ring: outer.map(vtx) };
      if (sem?.b3_hellingshoek !== undefined) face.slopeDeg = sem.b3_hellingshoek;
      faces.push(face);
      if (kind === "roof")
        roofParts.push({
          slopeDeg: round1(sem?.b3_hellingshoek ?? 0),
          topM: round1(Math.max(...face.ring.map((p) => p[2]))),
        });
    }),
  );
  return { mesh: { lod: geom.lod, faces }, roofParts };
}

export interface HeightsResult {
  heights: Map<string, BuildingHeights>;
  /** False when more pages existed than we read. */
  complete: boolean;
}

export async function fetchHeights(
  bbox: Bbox,
  ctx: StepContext,
  fetchFn?: FetchFn,
  maxPages = 10,
): Promise<HeightsResult> {
  const out = new Map<string, BuildingHeights>();
  let next: URL | undefined = new URL("https://api.3dbag.nl/collections/pand/items");
  next.searchParams.set("bbox", bbox.map((n) => n.toFixed(2)).join(","));
  next.searchParams.set("limit", "100");
  let pages = 0;
  while (next && pages < maxPages) {
    pages++;
    const body: z.infer<typeof Page> = await getJson({
      url: next,
      schema: Page,
      ctx,
      serviceName: "3D BAG",
      ...(fetchFn ? { fetchFn } : {}),
    });
    const t = body.metadata?.transform ?? { scale: [1, 1, 1], translate: [0, 0, 0] };
    for (const f of body.features) {
      const verts = f.vertices ?? [];
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

        // Geometry lives on the BuildingPart child; vertices are integers scaled per response.
        const part = Object.entries(f.CityObjects).find(
          ([k, o]) => o.type === "BuildingPart" && k.startsWith(key),
        )?.[1];
        const vtx = (i: number): [number, number, number] => {
          const v = verts[i] ?? [0, 0, 0];
          return [
            (v[0] ?? 0) * (t.scale[0] ?? 1) + (t.translate[0] ?? 0),
            (v[1] ?? 0) * (t.scale[1] ?? 1) + (t.translate[1] ?? 0),
            round1((v[2] ?? 0) * (t.scale[2] ?? 1) + (t.translate[2] ?? 0) - (ground ?? 0)),
          ];
        };
        const built = buildMesh(part, vtx);
        if (built) {
          h.mesh = built.mesh;
          if (built.roofParts.length) h.roofParts = built.roofParts;
        }
        out.set(key.replace("NL.IMBAG.Pand.", ""), h);
      }
    }
    const href = body.links?.find((l) => l.rel === "next")?.href;
    next = href ? new URL(href) : undefined;
  }
  const complete = next === undefined;
  if (!complete) ctx.degrade(`3D BAG: more than ${pages} pages, list cut off`);
  return { heights: out, complete };
}
