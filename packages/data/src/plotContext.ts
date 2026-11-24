/**
 * Builds everything the engine needs about one address, step by step, with a trace.
 *
 * Critical path (ADR-030): address object and plot outline. Without them nothing can be
 * checked, so a failure stops the run with a clear message. Every other step degrades:
 * the run continues, and the gap is recorded three ways:
 *   - in the trace (the step is "degraded" or "failed"),
 *   - as a flag (plain-language warning),
 *   - in `quality` (per data domain), which the zero-false-greens gate uses so that no check
 *     can pass on missing, assumed or cut-off data.
 *
 * Real-data rules learned from probing PDOK (24-11-2026):
 *  - BGT returns historical objects; only those with eind_registratie = null are current.
 *  - BAG returns demolished and wrongly-registered buildings; only in-use statuses count.
 *  - BRK parcels carry status_historie_code; "G" = valid.
 *  - Narrow footpaths include pavements, so they are treated as public (safe default), with a flag.
 *  - Driveway crossings ("inrit") are often not registered, especially rural and rear exits.
 *  - Vegetation is typed: points "boom" = tree, areas "haag" = hedge; other types exist.
 */
import {
  area,
  assessAccess,
  centroid,
  classifyEdges,
  contains,
  deriveHouseType,
  distanceBetween,
  downgrade,
  gate,
  intersectionArea,
  isCarSurface,
  newQuality,
  note,
  orientedBox,
  validatePolygon,
  plotFrame,
  plotLayout,
  SafeError,
  type AccessLevel,
  type DataQuality,
  type EdgeRun,
  type GatedOutcome,
  type HouseType,
  type PlotFrame,
  type PlotLayout,
  type Point,
  type Polygon,
  type PublicArea,
  type PublicAreaKind,
  type Tracer,
} from "@vergunbuy/engine";
import type { FetchFn } from "./http.ts";
import type { Address } from "./sources/locatieserver.ts";
import { num, OGC, ogcItems, outerRings, str, type Bbox, type Feature } from "./sources/ogc.ts";
import { fetchHeights, type BuildingHeights } from "./sources/threedbag.ts";

export interface Building {
  id: string;
  outline: Polygon;
  bouwjaar?: number;
  status: string;
  documentdatum?: string;
  documentnummer?: string;
  /** Number of addresses (verblijfsobjecten) in the building; 0 for most sheds and garages. */
  addresses?: number;
  /** BAG use, e.g. "woonfunctie". Absent for buildings without an address. */
  use?: string;
  heights?: BuildingHeights;
  /** Plain description. For outbuildings this is an assumption: BAG does not record the type. */
  label?: string;
  lengthM?: number;
  widthM?: number;
  /** Share of the building's footprint that lies on this plot (0..1). */
  onPlotShare?: number;
}

export interface Tree {
  id: string;
  at: Point;
  /** Assumed crown diameter: the register has a point only, no size. */
  crownM: number;
  registeredAt?: string;
}

/** Registered vegetation that is not a tree or hedge (BGT plus_type, e.g. "struikgewas"). */
export interface OtherVegetation {
  id: string;
  kind: string;
  at?: Point;
  outline?: Polygon;
}

export interface Exit {
  id: string;
  outline: Polygon;
  /** Length of plot boundary that touches the driveway crossing. */
  alongPlotM: number;
  registeredAt?: string;
}

/** A stretch of plot boundary lying directly on a road, parking area or shared yard. */
export interface CarReachableEdge {
  edge: number;
  from: number;
  to: number;
  lengthM: number;
  surface: string;
}

export interface Measurements {
  houseLengthM?: number;
  houseWidthM?: number;
  houseHeightM?: number;
  /** Shortest distance from the house to public area. */
  houseToPublicM?: number;
  /** Plot boundary length on public area. */
  frontageM: number;
}

export type FlagCode =
  | "MULTIPLE_HOUSE_BUILDINGS"
  | "HOUSE_NOT_ON_PLOT"
  | "BUILDING_ON_BOUNDARY"
  | "PUBLIC_AREA_UNKNOWN"
  | "POSSIBLE_ACHTERPAD"
  | "WATER_NEARBY"
  | "NEIGHBOURS_UNKNOWN"
  | "OUTBUILDINGS_ON_PLOT"
  | "HEIGHTS_MISSING"
  | "HEIGHTS_PARTIAL"
  | "CHANGED_BETWEEN_SCANS"
  | "NO_EXIT_FOUND"
  | "POSSIBLE_EXIT"
  | "TREES_UNKNOWN"
  | "DATA_TRUNCATED"
  | "FRONT_ESTIMATED"
  | "PLOT_AREA_MISMATCH"
  | "INVALID_GEOMETRY";

export interface Flag {
  code: FlagCode;
  detail: string;
}

export interface SourceInfo {
  name: string;
  licence: string;
  fetchedAt: string;
  objects: number;
  /** False when the source's list was cut off. */
  complete: boolean;
}

export interface PlotContext {
  address: Address;
  plot: { id: string; outline: Polygon; areaM2: number; registeredAreaM2?: number };
  house: Building[];
  outbuildings: Building[];
  neighbours: Building[];
  /** Other parcels nearby, for drawing context only. */
  nearbyParcels: { id: string; outline: Polygon }[];
  publicAreas: (PublicArea & { label: string; registeredAt?: string })[] | null;
  trees: Tree[] | null;
  hedges: { id: string; outline: Polygon }[];
  otherVegetation: OtherVegetation[];
  exits: Exit[];
  carReachableEdges: CarReachableEdge[];
  /** Carport precondition: can a car get onto the plot? Gated by data quality. */
  access: GatedOutcome & { level: AccessLevel; reason: string };
  measurements: Measurements;
  /** The plot's own frame (street at the bottom) and its main dimensions. */
  frame: PlotFrame;
  layout: PlotLayout;
  edges: EdgeRun[];
  houseType: HouseType;
  flags: Flag[];
  sources: SourceInfo[];
  /** Per-domain data status; checks that need a non-complete domain cannot pass. */
  quality: DataQuality;
}

const IN_USE = new Set([
  "Pand in gebruik",
  "Pand in gebruik (niet ingemeten)",
  "Verbouwing pand",
  "Sloopvergunning verleend",
]);

const INVALID_TEXT =
  "Some shapes from the registers are not clean (for example, edges crossing each other). Measurements on them may be off.";

/** Footprint share on the plot from which a building counts as standing on it. */
export const ON_PLOT_SHARE = 0.5;
/** Shares between these bounds mean the building crosses the boundary: uncertain ownership. */
const STRADDLE_MIN = 0.05;
const STRADDLE_MAX = 0.95;

const registered = (f: Feature): { registeredAt?: string } => {
  const t = str(f.properties.tijdstip_registratie);
  return t ? { registeredAt: t.slice(0, 10) } : {};
};

const isCurrentBgt = (f: Feature) =>
  f.properties.eind_registratie === null || f.properties.eind_registratie === undefined;

const bgtId = (f: Feature, i = 0) =>
  `${str(f.properties.lokaal_id) ?? String(f.id)}${i ? `-${i}` : ""}`;

/** Average width of a strip ≈ 2·area / perimeter. */
function widthM(poly: Polygon): number {
  let perimeter = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a && b) perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perimeter === 0 ? 0 : (2 * area(poly)) / perimeter;
}

function bboxOf(poly: Polygon, margin: number): Bbox {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [
    Math.min(...xs) - margin,
    Math.min(...ys) - margin,
    Math.max(...xs) + margin,
    Math.max(...ys) + margin,
  ];
}

const share = (plot: Polygon, b: Polygon) => {
  const a = area(b);
  return a > 0 ? Math.min(1, intersectionArea(plot, b) / a) : 0;
};

function toBuilding(f: Feature): Building[] {
  return outerRings(f.geometry).map((outline, i) => {
    const b: Building = {
      id: `${str(f.properties.identificatie) ?? String(f.id)}${i ? `-${i}` : ""}`,
      outline,
      status: str(f.properties.status) ?? "unknown",
    };
    const bouwjaar = num(f.properties.bouwjaar);
    const documentdatum = str(f.properties.documentdatum);
    const documentnummer = str(f.properties.documentnummer);
    if (bouwjaar !== undefined) b.bouwjaar = bouwjaar;
    if (documentdatum) b.documentdatum = documentdatum;
    if (documentnummer) b.documentnummer = documentnummer;
    const addresses = num(f.properties.aantal_verblijfsobjecten);
    if (addresses !== undefined) b.addresses = addresses;
    const use = str(f.properties.gebruiksdoel);
    if (use) b.use = use;
    const box = orientedBox(outline);
    b.lengthM = box.lengthM;
    b.widthM = box.widthM;
    return b;
  });
}

/**
 * BAG does not record what an outbuilding is. We describe it from size, height and whether
 * it has an address. This is an assumption and is labelled as such in the Inspector.
 */
export function describeOutbuilding(b: Building): string {
  const a = area(b.outline);
  const h = b.heights?.heightM;
  if ((b.addresses ?? 0) > 0)
    return b.use ? `Building with an address (${b.use})` : "Building with an address";
  if (a < 8) return "Small shed or storage";
  if (h !== undefined && h <= 3.5 && a <= 45) return "Single-storey shed, garage or garden room";
  if (h !== undefined && h > 3.5) return "Larger outbuilding (taller than one storey)";
  return "Outbuilding (type not registered)";
}

export async function buildPlotContext(
  address: Address,
  tracer: Tracer,
  fetchFn?: FetchFn,
): Promise<PlotContext> {
  const flags: Flag[] = [];
  const flag = (code: FlagCode, detail: string) => {
    if (!flags.some((f) => f.code === code)) flags.push({ code, detail });
  };
  const sources: SourceInfo[] = [];
  const quality = newQuality();
  const now = () => new Date().toISOString();
  const truncated = (domain: Parameters<typeof downgrade>[1], what: string) => {
    downgrade(
      quality,
      domain,
      "partial",
      `The ${what} list was cut off; some records were not read.`,
    );
    flag(
      "DATA_TRUNCATED",
      `Not all ${what} could be read (the list was cut off). Affected checks show as "needs a check".`,
    );
  };
  const [x, y] = address.pointRd;
  const near: Bbox = [x - 5, y - 5, x + 5, y + 5];

  // 1. Address object → the BAG building(s) it is in. Critical.
  const housePandUuids = await tracer.step(
    "bag-address",
    "Find the building for this address (BAG)",
    async (ctx) => {
      const { features } = await ogcItems(OGC.bag, "verblijfsobject", near, ctx, fetchFn);
      const vbo = features.find((f) => f.properties.identificatie === address.bagVerblijfsobjectId);
      if (!vbo)
        throw new SafeError(
          "ADDRESS_OBJECT_NOT_FOUND",
          "The building register has no object for this address.",
        );
      const hrefs = (vbo.properties["pand.href"] as string[] | undefined) ?? [];
      const uuids = hrefs.map((h) => h.split("/").pop() ?? "");
      ctx.summarize(`Address is in ${uuids.length} building(s)`);
      return new Set(uuids);
    },
  );

  // 2. Plot outline: the valid parcel containing the address point. Critical.
  const { plot, parcels } = await tracer.step(
    "brk-plot",
    "Find the plot (BRK cadastral map)",
    async (ctx) => {
      const res = await ogcItems(
        OGC.brk,
        "perceel",
        [x - 40, y - 40, x + 40, y + 40],
        ctx,
        fetchFn,
      );
      if (!res.complete) truncated("plot", "cadastral parcel");
      const valid = res.features.filter((f) => (f.properties.status_historie_code ?? "G") === "G");
      for (const f of valid) {
        const outline = outerRings(f.geometry).find((ring) => contains(ring, [x, y]));
        if (!outline) continue;
        const id =
          `${str(f.properties.kadastrale_gemeente_waarde) ?? ""} ${str(f.properties.sectie) ?? ""} ${num(f.properties.perceelnummer) ?? ""}`.trim();
        const reg = num(f.properties.kadastrale_grootte_waarde);
        const check = validatePolygon(outline);
        if (!check.valid) {
          downgrade(
            quality,
            "plot",
            "partial",
            `The plot outline from the cadastral map is not a clean shape (${check.issues.join(", ")}).`,
          );
          flag("INVALID_GEOMETRY", INVALID_TEXT);
        }
        const drawn = area(outline);
        ctx.summarize(`Plot ${id}, ${Math.round(drawn)} m² drawn`);
        sources.push({
          name: "BRK Kadastrale kaart",
          licence: "CC BY 4.0",
          fetchedAt: now(),
          objects: valid.length,
          complete: res.complete,
        });
        note(
          quality,
          "plot",
          "Cadastral map boundaries are indicative, not surveyed legal boundaries.",
        );
        if (reg && Math.abs(drawn - reg) / reg > 0.05) {
          downgrade(
            quality,
            "plot",
            "partial",
            `The drawn plot (${Math.round(drawn)} m²) differs from the registered area (${reg} m²) by more than 5%.`,
          );
          flag(
            "PLOT_AREA_MISMATCH",
            `The drawn plot differs from the registered area by more than 5% (${Math.round(drawn)} vs ${reg} m²).`,
          );
        }
        return {
          plot: {
            id,
            outline,
            areaM2: Math.round(drawn),
            ...(reg ? { registeredAreaM2: reg } : {}),
          },
          parcels: valid,
        };
      }
      throw new SafeError(
        "PLOT_NOT_FOUND",
        "We could not find a plot at this address on the cadastral map.",
      );
    },
  );

  const work = bboxOf(plot.outline, 25);

  // 3. Buildings: house, outbuildings, neighbours, by how much of each footprint lies on the plot.
  let house: Building[] = [];
  let outbuildings: Building[] = [];
  let neighbours: Building[] = [];
  try {
    await tracer.step("bag-buildings", "Buildings on and around the plot (BAG)", async (ctx) => {
      const res = await ogcItems(OGC.bag, "pand", work, ctx, fetchFn);
      if (!res.complete) truncated("buildings", "building");
      const current = res.features.filter((f) => IN_USE.has(str(f.properties.status) ?? ""));
      const dropped = res.features.length - current.length;
      let straddling = 0;
      let invalid = 0;
      for (const f of current) {
        for (const b of toBuilding(f)) {
          if (!validatePolygon(b.outline).valid) invalid++;
          b.onPlotShare = Math.round(share(plot.outline, b.outline) * 100) / 100;
          if (housePandUuids.has(String(f.id))) house.push(b);
          else if (b.onPlotShare >= ON_PLOT_SHARE) outbuildings.push(b);
          else neighbours.push(b);
          if (
            !housePandUuids.has(String(f.id)) &&
            b.onPlotShare > STRADDLE_MIN &&
            b.onPlotShare < STRADDLE_MAX
          )
            straddling++;
        }
      }
      if (invalid > 0) {
        downgrade(
          quality,
          "buildings",
          "partial",
          `${invalid} building outline(s) are not clean shapes, so their measurements may be off.`,
        );
        flag("INVALID_GEOMETRY", INVALID_TEXT);
      }
      if (straddling > 0) {
        downgrade(
          quality,
          "buildings",
          "partial",
          `${straddling} building(s) cross the plot boundary, so it is unclear which plot they belong to.`,
        );
        flag(
          "BUILDING_ON_BOUNDARY",
          `${straddling} building(s) cross the plot boundary. Which plot they belong to is uncertain; boundaries on the cadastral map are indicative.`,
        );
      }
      sources.push({
        name: "BAG",
        licence: "Public domain",
        fetchedAt: now(),
        objects: current.length,
        complete: res.complete,
      });
      ctx.summarize(
        `${house.length} house, ${outbuildings.length} other on plot, ${neighbours.length} nearby; ignored ${dropped} demolished or invalid`,
      );
      if (house.length === 0) ctx.degrade("house outline not found");
    });
  } catch {
    house = [];
    outbuildings = [];
    neighbours = [];
    downgrade(quality, "buildings", "missing", "Buildings could not be loaded.");
    flag("NEIGHBOURS_UNKNOWN", "Buildings could not be loaded; shared walls cannot be detected.");
  }
  if (house.length === 0)
    downgrade(quality, "buildings", "missing", "The house outline was not found.");
  if (house.length > 1)
    flag("MULTIPLE_HOUSE_BUILDINGS", `${house.length} building outlines belong to this address.`);
  const houseShare = house.length ? Math.max(...house.map((h) => h.onPlotShare ?? 0)) : 1;
  if (house.length && houseShare < ON_PLOT_SHARE) {
    downgrade(
      quality,
      "buildings",
      "partial",
      "Most of the house outline lies outside the plot found for this address.",
    );
    flag(
      "HOUSE_NOT_ON_PLOT",
      "The house outline is mostly outside the plot found for this address. The plot may be split or merged in the cadastre, or the register outline covers several houses.",
    );
  }
  if (outbuildings.length > 0)
    flag(
      "OUTBUILDINGS_ON_PLOT",
      `${outbuildings.length} other building(s) registered on this plot.`,
    );

  // 3b. Heights, roof shape and change flags from 3D BAG. Degrades.
  try {
    await tracer.step("3dbag-heights", "Heights and roofs (3D BAG)", async (ctx) => {
      const res = await fetchHeights(work, ctx, fetchFn);
      if (!res.complete) truncated("heights", "3D building");
      let matched = 0;
      for (const b of [...house, ...outbuildings, ...neighbours]) {
        const h = res.heights.get(b.id.replace(/-\d+$/, ""));
        if (h) {
          b.heights = h;
          matched++;
        }
      }
      sources.push({
        name: "3D BAG",
        licence: "CC BY 4.0",
        fetchedAt: now(),
        objects: matched,
        complete: res.complete,
      });
      const scan = house[0]?.heights?.scanYear;
      ctx.summarize(`Heights for ${matched} buildings${scan ? `, height scan of ${scan}` : ""}`);
      const onPlot = [...house, ...outbuildings];
      const missing = onPlot.filter((b) => b.heights?.heightM === undefined);
      if (missing.length) {
        ctx.degrade(`${missing.length} building(s) on the plot have no height`);
        downgrade(
          quality,
          "heights",
          "partial",
          `${missing.length} building(s) on the plot have no measured height (often small sheds or recent builds).`,
        );
        flag(
          "HEIGHTS_PARTIAL",
          `${missing.length} building(s) on this plot have no measured height; small sheds and recent builds are often missing from the height scan.`,
        );
      }
    });
  } catch {
    downgrade(quality, "heights", "missing", "Building heights could not be loaded.");
    flag("HEIGHTS_MISSING", "Building heights could not be loaded.");
  }
  for (const b of outbuildings) b.label = describeOutbuilding(b);
  for (const b of house) b.label = "House";
  const changed = house.find(
    (h) => h.heights?.changedBetweenScans.ahn3ToAhn4 || h.heights?.changedBetweenScans.ahn4ToAhn5,
  );
  if (changed) {
    const c = changed.heights?.changedBetweenScans;
    flag(
      "CHANGED_BETWEEN_SCANS",
      `The national height scans show a change to the house between ${c?.ahn3ToAhn4 ? "2014–2019 and 2020–2022" : "2020–2022 and 2023–2025"}. This can mean an extension or roof change.`,
    );
  }

  // 3c. Registered vegetation (BGT), by type. Garden trees are not registered anywhere. Degrades.
  let trees: Tree[] | null = null;
  let hedges: { id: string; outline: Polygon }[] = [];
  const otherVegetation: OtherVegetation[] = [];
  try {
    await tracer.step(
      "bgt-trees",
      "Registered trees, hedges and other vegetation (BGT)",
      async (ctx) => {
        const [points, areas] = await Promise.all([
          ogcItems(OGC.bgt, "vegetatieobject_punt", work, ctx, fetchFn),
          ogcItems(OGC.bgt, "vegetatieobject_vlak", work, ctx, fetchFn),
        ]);
        if (!points.complete || !areas.complete) truncated("vegetation", "vegetation");
        const t: Tree[] = [];
        for (const f of points.features) {
          if (!isCurrentBgt(f) || f.geometry?.type !== "Point") continue;
          const c = f.geometry.coordinates as number[];
          const at: Point = [Number(c[0]), Number(c[1])];
          const type = str(f.properties.plus_type) ?? "unknown";
          if (type === "boom") t.push({ id: bgtId(f), at, crownM: 4, ...registered(f) });
          else otherVegetation.push({ id: bgtId(f), kind: type, at });
        }
        trees = t;
        for (const f of areas.features) {
          if (!isCurrentBgt(f)) continue;
          const type = str(f.properties.plus_type) ?? "unknown";
          outerRings(f.geometry).forEach((outline, i) => {
            if (type === "haag") hedges.push({ id: bgtId(f, i), outline });
            else otherVegetation.push({ id: bgtId(f, i), kind: type, outline });
          });
        }
        ctx.summarize(
          `${t.length} registered trees, ${hedges.length} hedges, ${otherVegetation.length} other vegetation nearby`,
        );
      },
    );
    // True for every plot: only municipal trees are registered.
    downgrade(
      quality,
      "vegetation",
      "partial",
      "Trees and plants in gardens are not registered anywhere; only street trees and some hedges are known.",
    );
  } catch {
    trees = null;
    hedges = [];
    downgrade(quality, "vegetation", "missing", "Registered trees could not be loaded.");
    flag("TREES_UNKNOWN", "Registered trees could not be loaded.");
  }

  // 4. Public area from BGT (current objects only). Degrades to "unknown" edges, never to "neighbour".
  let streetLabels: { at: Point; name: string }[] = [];
  let labelsRead = false;
  let publicAreas: (PublicArea & { label: string; registeredAt?: string })[] | null = null;
  try {
    publicAreas = await tracer.step(
      "bgt-public",
      "Streets, paths, green and water (BGT)",
      async (ctx) => {
        const [roads, green, water] = await Promise.all([
          ogcItems(OGC.bgt, "wegdeel", work, ctx, fetchFn),
          ogcItems(OGC.bgt, "begroeidterreindeel", work, ctx, fetchFn),
          ogcItems(OGC.bgt, "waterdeel", work, ctx, fetchFn),
        ]);
        if (!roads.complete || !green.complete || !water.complete)
          truncated("publicArea", "street and public area");
        try {
          const labels = await ogcItems(OGC.bgt, "openbareruimtelabel", work, ctx, fetchFn);
          labelsRead = true;
          streetLabels = labels.features
            .filter((f) => isCurrentBgt(f) && f.geometry?.type === "Point")
            .map((f) => {
              const c = f.geometry?.coordinates as number[];
              return {
                at: [Number(c[0]), Number(c[1])] as Point,
                name: str(f.properties.openbareruimtenaam) ?? "",
              };
            })
            .filter((l) => l.name.toLowerCase() === address.street.toLowerCase());
        } catch {
          labelsRead = false;
        }
        const out: (PublicArea & { label: string; registeredAt?: string })[] = [];
        let history = 0;
        let narrowPaths = 0;
        const add = (
          fs: Feature[],
          kindOf: (f: Feature, ring: Polygon) => PublicAreaKind | null,
          labelOf: (f: Feature) => string,
        ) => {
          for (const f of fs) {
            if (!isCurrentBgt(f)) {
              history++;
              continue;
            }
            outerRings(f.geometry).forEach((ring, i) => {
              const kind = kindOf(f, ring);
              if (kind)
                out.push({
                  id: bgtId(f, i),
                  kind,
                  outline: ring,
                  label: labelOf(f),
                  ...registered(f),
                });
            });
          }
        };
        add(
          roads.features,
          (f, ring) => {
            const functie = str(f.properties.functie) ?? "";
            // Narrow footpaths may be rear paths, but pavements are narrow too: treat as public (safe).
            if (functie === "voetpad" && widthM(ring) < 2.5) narrowPaths++;
            return functie.includes("voetpad") || functie.includes("fietspad")
              ? "footpath"
              : "road";
          },
          (f) => str(f.properties.functie) ?? "road",
        );
        // Public green (plantsoen etc.). Private gardens are "erf" in onbegroeidterreindeel, which we do not load.
        add(
          green.features,
          (f) => (str(f.properties.fysiek_voorkomen) === "groenvoorziening" ? "green" : null),
          (f) => str(f.properties.plus_fysiek_voorkomen) ?? "green",
        );
        add(
          water.features,
          () => "water",
          (f) => str(f.properties.type) ?? "water",
        );
        const badAreas = out.filter((a) => !validatePolygon(a.outline).valid).length;
        if (badAreas > 0) {
          downgrade(
            quality,
            "publicArea",
            "partial",
            `${badAreas} street or public-area shape(s) are not clean shapes.`,
          );
          flag("INVALID_GEOMETRY", INVALID_TEXT);
        }
        sources.push({
          name: "BGT",
          licence: "CC0",
          fetchedAt: now(),
          objects: out.length,
          complete: roads.complete && green.complete && water.complete,
        });
        ctx.summarize(`${out.length} current public areas; ignored ${history} historical records`);
        if (narrowPaths > 0) {
          note(quality, "publicArea", "Narrow footpaths are treated as public (the safe choice).");
          flag(
            "POSSIBLE_ACHTERPAD",
            `${narrowPaths} narrow footpath(s) nearby are treated as public. If one is a rear path serving only the plots, more positions may be allowed.`,
          );
        }
        return out;
      },
    );
  } catch {
    downgrade(quality, "publicArea", "missing", "Streets and public areas could not be loaded.");
    flag(
      "PUBLIC_AREA_UNKNOWN",
      "Streets and public areas could not be loaded; plot edges toward them are unknown.",
    );
  }

  // 5. Classify plot edges (engine).
  const mainHouse = [...house].sort((a, b) => area(b.outline) - area(a.outline))[0];
  const edges = await tracer.step("classify-edges", "Classify every plot edge", (ctx) => {
    const runs = classifyEdges({
      plot: plot.outline,
      house: mainHouse?.outline ?? [],
      neighbourBuildings: neighbours.map((n) => ({ id: n.id, outline: n.outline })),
      publicAreas: publicAreas?.map(({ id, kind, outline }) => ({ id, kind, outline })) ?? null,
    });
    const kinds = new Set(runs.map((r) => r.kind));
    if (kinds.has("water")) {
      downgrade(
        quality,
        "publicArea",
        "assumed",
        "Water borders the plot; whether it counts as public area is not known.",
      );
      flag(
        "WATER_NEARBY",
        "Water borders the plot; whether it counts as public is not known from data.",
      );
    }
    ctx.summarize(`${runs.length} edge runs`);
    if (kinds.has("unknown")) ctx.degrade("some edges unknown");
    return runs;
  });

  // 6. Car access: registered crossings, then boundary stretches directly on car-usable surfaces.
  const byId = new Map((publicAreas ?? []).map((a) => [a.id, a]));
  const exits: Exit[] = [];
  for (const a of publicAreas ?? []) {
    if (a.label !== "inrit" || distanceBetween(a.outline, plot.outline) > 1.0) continue;
    const along = edges.filter((r) => r.otherSide === a.id).reduce((s, r) => s + r.lengthM, 0);
    exits.push({
      id: a.id,
      outline: a.outline,
      alongPlotM: Math.round(along * 10) / 10,
      ...(a.registeredAt ? { registeredAt: a.registeredAt } : {}),
    });
  }
  const carReachableEdges: CarReachableEdge[] = edges
    .filter((r) => r.kind === "public" && isCarSurface(byId.get(r.otherSide ?? "")?.label))
    .map((r) => ({
      edge: r.edge,
      from: r.from,
      to: r.to,
      lengthM: r.lengthM,
      surface: byId.get(r.otherSide ?? "")?.label ?? "road",
    }));
  const accessResult = assessAccess({
    publicDataAvailable: publicAreas !== null,
    registeredExits: exits.length,
    carReachableRunsM: carReachableEdges.map((e) => e.lengthM),
  });
  if (accessResult.level === "registered") {
    // complete
  } else if (accessResult.level === "possible") {
    downgrade(quality, "access", "assumed", accessResult.reason);
    flag("POSSIBLE_EXIT", accessResult.reason);
  } else if (accessResult.level === "none-found") {
    downgrade(quality, "access", "partial", accessResult.reason);
    flag("NO_EXIT_FOUND", accessResult.reason);
  } else {
    downgrade(quality, "access", "missing", accessResult.reason);
  }
  const access = {
    ...gate(accessResult.outcome, ["access"], quality),
    level: accessResult.level,
    reason: accessResult.reason,
  };

  // 7. The plot's own frame: street at the bottom.
  const kindById = new Map((publicAreas ?? []).map((a) => [a.id, a.kind]));
  const frame = plotFrame(plot.outline, edges, streetLabels, (id) =>
    id ? kindById.get(id) : undefined,
  );
  if (frame.method === "longest-public") {
    downgrade(
      quality,
      "front",
      "assumed",
      labelsRead
        ? "The street name was not found next to the plot, so the front side is estimated."
        : "Street names could not be loaded, so the front side is estimated.",
    );
    flag(
      "FRONT_ESTIMATED",
      "The front of the plot is estimated (longest public side). On corner and rural plots this can be the wrong side.",
    );
  } else if (frame.method === "none") {
    downgrade(
      quality,
      "front",
      "missing",
      "No public side found, so the front of the plot is unknown.",
    );
  }
  const layout = plotLayout(frame, plot.outline, mainHouse?.outline);

  // 8. Measurements.
  const publicOutlines = (publicAreas ?? [])
    .filter((a) => a.kind !== "water")
    .map((a) => a.outline);
  const houseToPublic =
    mainHouse && publicOutlines.length
      ? Math.min(...publicOutlines.map((o) => distanceBetween(mainHouse.outline, o)))
      : undefined;
  const measurements: Measurements = {
    frontageM:
      Math.round(edges.filter((e) => e.kind === "public").reduce((s, e) => s + e.lengthM, 0) * 10) /
      10,
    ...(mainHouse?.lengthM ? { houseLengthM: mainHouse.lengthM } : {}),
    ...(mainHouse?.widthM ? { houseWidthM: mainHouse.widthM } : {}),
    ...(mainHouse?.heights?.heightM !== undefined
      ? { houseHeightM: mainHouse.heights.heightM }
      : {}),
    ...(houseToPublic !== undefined && Number.isFinite(houseToPublic)
      ? { houseToPublicM: Math.round(houseToPublic * 10) / 10 }
      : {}),
  };

  return {
    address,
    plot,
    house,
    outbuildings,
    neighbours,
    nearbyParcels: parcels
      .flatMap((f) =>
        outerRings(f.geometry).map((outline) => ({
          id: str(f.properties.identificatie_lokaal_id) ?? "",
          outline,
        })),
      )
      .filter(
        (p) =>
          !(
            centroid(p.outline)[0] === centroid(plot.outline)[0] &&
            centroid(p.outline)[1] === centroid(plot.outline)[1]
          ),
      ),
    publicAreas,
    trees,
    hedges,
    otherVegetation,
    exits,
    carReachableEdges,
    access,
    measurements,
    frame,
    layout,
    edges,
    houseType: deriveHouseType(edges),
    flags,
    sources,
    quality,
  };
}
