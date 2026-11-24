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
  describeSides,
  sideOfEdge,
  type SideSummary,
  distanceBetween,
  downgrade,
  gate,
  intersectionArea,
  isCarSurface,
  pavementCrossings,
  ROAD_PARCEL_VERGE,
  facingLengthM,
  MIN_ACCESS_WIDTH_M,
  type PavementRun,
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
  detectObstacles,
  type ObstacleResult,
} from "@vergunbuy/engine";
import type { FetchFn } from "./http.ts";
import type { Address } from "./sources/locatieserver.ts";
import { num, OGC, ogcItems, outerRings, str, type Bbox, type Feature } from "./sources/ogc.ts";
import { fetchHeights, type BuildingHeights } from "./sources/threedbag.ts";
import { fetchHeightGrid } from "./sources/ahn.ts";

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
  /** House numbers registered in this building, e.g. ["10", "10a", "10b"]. */
  addressLabels?: string[];
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
  /** Length of plot boundary that touches (or faces) the driveway crossing. */
  alongPlotM: number;
  /** Set when the crossing lies across the pavement rather than against the boundary. */
  acrossM?: number;
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
  | "INVALID_GEOMETRY"
  | "SHARED_PLOT"
  | "MULTI_UNIT_BUILDING"
  | "PAVEMENT_CROSSING";

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
  publicAreas:
    (PublicArea & { label: string; registeredAt?: string; streetName?: string })[] | null;
  /** Street-name label positions from the map register, for drawing and for naming roads. */
  streetNames: { at: Point; name: string }[];
  /** What lies along each side of the plot, in plain words. */
  sides: SideSummary[];
  trees: Tree[] | null;
  hedges: { id: string; outline: Polygon }[];
  otherVegetation: OtherVegetation[];
  exits: Exit[];
  carReachableEdges: CarReachableEdge[];
  /** Carport precondition: can a car get onto the plot? Gated by data quality. */
  access: GatedOutcome & {
    level: AccessLevel;
    route?: "direct" | "across-pavement";
    reason: string;
  };
  /** Boundary stretches with a road just beyond a pavement or verge (only when no exit is registered). */
  pavementRuns: PavementRun[];
  /** Other home buildings on the same cadastral parcel (terraces or flats owned by one party). */
  otherHomesOnPlot: number;
  /** Addresses in the house's building; more than 1 means this home is a unit (flat). */
  unitsInHouse: number;
  /** Registered structures on or at the plot (BGT "overig bouwwerk"): canopies, pools, ... */
  structures: Structure[];
  /** Trees and other obstacles in the garden from the laser height scan; absent if unavailable. */
  obstacles?: ObstacleResult;
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

/** Plain names for BGT road functions. */
export const SURFACE_TEXT: Record<string, string> = {
  "rijbaan lokale weg": "road",
  "rijbaan regionale weg": "main road",
  "rijbaan autosnelweg": "motorway",
  "rijbaan autoweg": "main road",
  parkeervlak: "parking spaces",
  voetpad: "footpath / pavement",
  "voetpad op trap": "steps",
  fietspad: "cycle path",
  voetgangersgebied: "pedestrian area",
  inrit: "driveway crossing",
  woonerf: "shared residential street",
  ruiterpad: "bridle path",
  "OV-baan": "bus or tram lane",
};

function distanceToPolygon(poly: Polygon, p: Point): number {
  if (contains(poly, p)) return 0;
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    min = Math.min(min, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return min;
}

/** One label position per street name, so names are not drawn many times. */
function dedupeLabels(labels: { at: Point; name: string }[]) {
  const seen = new Set<string>();
  return labels.filter((l) => (seen.has(l.name) ? false : (seen.add(l.name), true)));
}

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

/**
 * On a parcel shared with other homes, walls between them lie inside the parcel, so the boundary
 * cannot show them. Count them directly: a house touching other homes is not detached.
 */
function houseTypeWithin(fromEdges: HouseType, house: Building[], others: Building[]): HouseType {
  if (house.some((h) => (h.addresses ?? 0) > 1)) return "unit";
  if (!house.length || !others.length) return fromEdges;
  const touching = others.filter((o) =>
    house.some((h) => distanceBetween(h.outline, o.outline) <= 0.3),
  ).length;
  if (touching === 0) return fromEdges;
  if (fromEdges === "corner") return "corner";
  return touching >= 2 ? "terraced" : "semi-or-end";
}

export interface Structure {
  id: string;
  /** BGT type, e.g. "overkapping" (canopy, often a carport), "bassin" (pool). */
  type: string;
  outline: Polygon;
  onPlotShare: number;
}

export const STRUCTURE_TEXT: Record<string, string> = {
  overkapping: "canopy (roof without walls, e.g. a carport)",
  bassin: "pool or basin",
  "open loods": "open shed",
  opslagtank: "storage tank",
  windturbine: "wind turbine",
  "lage trafo": "transformer box",
  bezinkbak: "settling tank",
};

/** A registered crossing further across the pavement than this is not counted as this plot's. */
const CROSSING_ACROSS_MAX_M = 3;

/** A building with at least one address used for living. */
const isHome = (b: Building) => (b.addresses ?? 0) > 0 && /woon/i.test(b.use ?? "");

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
  let otherHomesOnPlot = 0;
  const otherHomes: Building[] = [];
  const rearPathCandidates = new Set<string>();
  const openGround: { id: string; outline: Polygon; label: string; kind: string }[] = [];
  try {
    await tracer.step("bag-buildings", "Buildings on and around the plot (BAG)", async (ctx) => {
      const res = await ogcItems(OGC.bag, "pand", work, ctx, fetchFn);
      if (!res.complete) truncated("buildings", "building");
      const current = res.features.filter((f) => IN_USE.has(str(f.properties.status) ?? ""));
      // House numbers per building, so every building on the map can be named.
      const labelsByPand = new Map<string, string[]>();
      try {
        const vos = await ogcItems(OGC.bag, "verblijfsobject", work, ctx, fetchFn);
        for (const v of vos.features) {
          const nr = num(v.properties.huisnummer);
          if (nr === undefined) continue;
          const label = `${nr}${str(v.properties.huisletter) ?? ""}${str(v.properties.toevoeging) ? `-${str(v.properties.toevoeging)}` : ""}`;
          for (const href of (v.properties["pand.href"] as string[] | undefined) ?? []) {
            const uuid = href.split("/").pop() ?? "";
            const list = labelsByPand.get(uuid) ?? [];
            if (!list.includes(label)) list.push(label);
            labelsByPand.set(uuid, list);
          }
        }
      } catch {
        note(quality, "buildings", "House numbers of nearby buildings could not be loaded.");
      }
      const dropped = res.features.length - current.length;
      let straddling = 0;
      let invalid = 0;
      for (const f of current) {
        for (const b of toBuilding(f)) {
          const labels = labelsByPand.get(String(f.id));
          if (labels?.length)
            b.addressLabels = labels.sort((p, q) => p.localeCompare(q, "nl", { numeric: true }));
          if (!validatePolygon(b.outline).valid) invalid++;
          b.onPlotShare = Math.round(share(plot.outline, b.outline) * 100) / 100;
          if (housePandUuids.has(String(f.id))) house.push(b);
          else if (b.onPlotShare >= ON_PLOT_SHARE && isHome(b)) {
            // Another home on the same parcel (terrace or flats owned by one party). It is a
            // neighbour for every purpose, never an outbuilding of this house.
            otherHomesOnPlot++;
            otherHomes.push(b);
            neighbours.push(b);
          } else if (b.onPlotShare >= ON_PLOT_SHARE) outbuildings.push(b);
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
        `${house.length} house, ${otherHomesOnPlot ? `${otherHomesOnPlot} other homes and ` : ""}${outbuildings.length} other buildings on plot, ${neighbours.length} nearby; ignored ${dropped} demolished or invalid`,
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
  if (otherHomesOnPlot > 0) {
    downgrade(
      quality,
      "plot",
      "partial",
      `This parcel also holds ${otherHomesOnPlot} other home building(s), so the part that belongs to this home is not on the cadastral map.`,
    );
    flag(
      "SHARED_PLOT",
      `This parcel also holds ${otherHomesOnPlot} other home building(s), as with housing-association terraces or flats. Plot size, garden and setbacks below are for the whole parcel, not this home.`,
    );
  }
  const unitsInHouse = Math.max(0, ...house.map((h) => h.addresses ?? 0));
  if (unitsInHouse > 1) {
    const uses = [...new Set(house.flatMap((h) => (h.use ?? "").split(",")).filter(Boolean))];
    const detail = `This address is one of ${unitsInHouse} units in the same building${uses.some((u) => u !== "woonfunctie") ? " (homes together with a shop or other use)" : " (flats)"}. The building and its plot are shared, so a carport needs the other owners to agree, usually through the owners' association (VvE).`;
    downgrade(quality, "plot", "partial", detail);
    flag("MULTI_UNIT_BUILDING", detail);
  }
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
  let allLabels: { at: Point; name: string }[] = [];
  let labelsRead = false;
  let publicAreas:
    (PublicArea & { label: string; registeredAt?: string; streetName?: string })[] | null = null;
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
          // Unvegetated terrain that is not a private yard (paved verges, open paving, sand).
          // Used only as ground a car may cross to reach the road (see pavementCrossings).
          const open = await ogcItems(OGC.bgt, "onbegroeidterreindeel", work, ctx, fetchFn);
          for (const f of open.features) {
            const look = str(f.properties.fysiek_voorkomen) ?? "";
            if (!isCurrentBgt(f) || look === "erf" || look === "") continue;
            outerRings(f.geometry).forEach((ring, i) =>
              openGround.push({ id: bgtId(f, i), outline: ring, label: look, kind: "terrain" }),
            );
          }
        } catch {
          note(
            quality,
            "access",
            "Unpaved and paved terrain could not be loaded; verges may be missed.",
          );
        }
        try {
          const labels = await ogcItems(OGC.bgt, "openbareruimtelabel", work, ctx, fetchFn);
          labelsRead = true;
          allLabels = labels.features
            .filter((f) => isCurrentBgt(f) && f.geometry?.type === "Point")
            .map((f) => {
              const c = f.geometry?.coordinates as number[];
              return {
                at: [Number(c[0]), Number(c[1])] as Point,
                name: str(f.properties.openbareruimtenaam) ?? "",
              };
            })
            .filter((l) => l.name !== "");
          streetLabels = allLabels.filter(
            (l) => l.name.toLowerCase() === address.street.toLowerCase(),
          );
        } catch {
          labelsRead = false;
        }
        const out: (PublicArea & { label: string; registeredAt?: string })[] = [];
        let history = 0;
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
          (f) => {
            const functie = str(f.properties.functie) ?? "";
            // Narrow footpaths may be rear paths, but pavements are narrow too: treat as public (safe).
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
        const badAreas = out.filter(
          (a) => !validatePolygon(a.outline).valid && distanceBetween(a.outline, plot.outline) <= 1,
        ).length;
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
        // A narrow footpath that touches no road is a candidate rear path (achterpad); a pavement
        // along a road is not. Either way it stays public (the safe choice); we only flag it
        // when it borders this plot (see the edge step).
        const cars = out.filter((a) => isCarSurface(a.label));
        for (const a of out) {
          if (a.label !== "voetpad" || widthM(a.outline) >= 2.5) continue;
          if (!cars.some((c) => distanceBetween(c.outline, a.outline) <= 0.3))
            rearPathCandidates.add(a.id);
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
    const rearPathM = runs
      .filter((r) => r.otherSide && rearPathCandidates.has(r.otherSide))
      .reduce((m, r) => m + r.lengthM, 0);
    if (rearPathM >= 1) {
      note(
        quality,
        "publicArea",
        "A narrow footpath along the plot is treated as public (the safe choice).",
      );
      flag(
        "POSSIBLE_ACHTERPAD",
        `A narrow footpath that does not lead along a road borders the plot over ${rearPathM.toFixed(1)} m. It is treated as public; if it is a rear path serving only the plots, more positions may be allowed.`,
      );
    }
    ctx.summarize(`${runs.length} edge runs`);
    if (kinds.has("unknown")) ctx.degrade("some edges unknown");
    return runs;
  });

  // 6. Car access: registered crossings, then boundary stretches directly on car-usable surfaces.
  const byId = new Map((publicAreas ?? []).map((a) => [a.id, a]));
  // A registered crossing is this plot's exit only when it lies against the boundary over at least
  // a car's width. Within 1 m but facing less (e.g. touching a corner) it may be the neighbour's.
  const exits: Exit[] = [];
  const partlyFacingCrossings: { facingM: number; acrossM: number }[] = [];
  for (const a of publicAreas ?? []) {
    if (a.label !== "inrit" || distanceBetween(a.outline, plot.outline) > 1.0) continue;
    const facingM = facingLengthM(plot.outline, a.outline, 1.0);
    if (facingM >= MIN_ACCESS_WIDTH_M)
      exits.push({
        id: a.id,
        outline: a.outline,
        alongPlotM: Math.round(facingM * 10) / 10,
        ...(a.registeredAt ? { registeredAt: a.registeredAt } : {}),
      });
    else if (facingM >= 0.5)
      partlyFacingCrossings.push({ facingM: Math.round(facingM * 10) / 10, acrossM: 0 });
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
  const pavementRuns: PavementRun[] =
    publicAreas && exits.length === 0
      ? pavementCrossings(
          plot.outline,
          [...publicAreas, ...openGround],
          parcels.flatMap((f) =>
            outerRings(f.geometry).map((outline) => ({
              id: str(f.properties.identificatie_lokaal_id) ?? String(f.id),
              outline,
            })),
          ),
        )
      : [];
  // A registered crossing reached straight across the pavement: it is this plot's when it faces
  // at least a car's width of the boundary; less than that and it may be the neighbour's.
  const facing = new Map<string, { facingM: number; acrossM: number }>();
  for (const r of pavementRuns) {
    if (r.reaches !== "inrit" || !r.reachesId || r.acrossM > CROSSING_ACROSS_MAX_M) continue;
    const f = facing.get(r.reachesId) ?? { facingM: 0, acrossM: 0 };
    f.facingM += r.lengthM;
    f.acrossM = Math.max(f.acrossM, r.acrossM);
    facing.set(r.reachesId, f);
  }
  for (const [id, f] of facing) {
    const area = byId.get(id);
    if (!area) continue;
    if (f.facingM >= MIN_ACCESS_WIDTH_M)
      exits.push({
        id,
        outline: area.outline,
        alongPlotM: Math.round(f.facingM * 10) / 10,
        acrossM: f.acrossM,
        ...(area.registeredAt ? { registeredAt: area.registeredAt } : {}),
      });
    else if (f.facingM >= 0.5)
      partlyFacingCrossings.push({
        facingM: Math.round(f.facingM * 10) / 10,
        acrossM: f.acrossM,
      });
  }
  const accessResult = assessAccess({
    publicDataAvailable: publicAreas !== null,
    registeredExits: exits.length,
    ...(exits.length && exits.every((e) => e.acrossM !== undefined)
      ? { registeredAcrossM: Math.max(...exits.map((e) => e.acrossM ?? 0)) }
      : {}),
    carReachableRunsM: carReachableEdges.map((e) => e.lengthM),
    pavementRuns,
    partlyFacingCrossings,
  });
  if (accessResult.level === "registered") {
    // complete
  } else if (accessResult.level === "possible") {
    downgrade(quality, "access", "assumed", accessResult.reason);
    flag(
      accessResult.route === "across-pavement" ? "PAVEMENT_CROSSING" : "POSSIBLE_EXIT",
      accessResult.reason,
    );
  } else if (accessResult.level === "none-found") {
    downgrade(quality, "access", "partial", accessResult.reason);
    flag("NO_EXIT_FOUND", accessResult.reason);
  } else {
    downgrade(quality, "access", "missing", accessResult.reason);
  }
  const access = {
    ...gate(accessResult.outcome, ["access"], quality),
    level: accessResult.level,
    ...(accessResult.route ? { route: accessResult.route } : {}),
    reason: accessResult.reason,
  };

  // Name each road surface after the street label inside it, or the nearest one within 12 m.
  for (const a of publicAreas ?? []) {
    if (a.kind === "water" || a.kind === "green") continue;
    const inside = allLabels.find((l) => contains(a.outline, l.at));
    const nearest =
      inside ??
      allLabels
        .map((l) => ({ l, d: distanceToPolygon(a.outline, l.at) }))
        .filter((x) => x.d <= 12)
        .sort((p, q) => p.d - q.d)[0]?.l;
    if (nearest) a.streetName = nearest.name;
  }

  // 7. The plot's own frame: street at the bottom.
  const kindById = new Map((publicAreas ?? []).map((a) => [a.id, a.kind]));
  // When no edge touches public ground directly (a verge on the road's parcel lies in between),
  // the stretches with a road just beyond stand in for the street side.
  const frameRuns: EdgeRun[] = edges.some((r) => r.kind === "public")
    ? edges
    : [
        ...edges,
        ...pavementRuns.map((r) => ({
          edge: r.edge,
          from: r.from,
          to: r.to,
          kind: "public" as const,
          lengthM: r.lengthM,
        })),
      ];
  const frame = plotFrame(plot.outline, frameRuns, streetLabels, (id) =>
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

  // What lies along each side, in plain words.
  // A boundary stretch that only borders unmapped ground on the road's own parcel is the road's
  // verge, not a neighbour's garden. For the plain-words summary only: the edge kinds used for
  // setbacks and house type stay as they are.
  const ROAD_VERGE_ID = "__road-verge";
  const sideRuns: EdgeRun[] = edges.map((r) => {
    if (r.kind !== "neighbour") return r;
    const covered = pavementRuns
      .filter((p) => p.edge === r.edge && p.via.includes(ROAD_PARCEL_VERGE))
      .reduce((m, p) => m + Math.max(0, Math.min(p.to, r.to) - Math.max(p.from, r.from)), 0);
    return covered >= 0.8 * (r.to - r.from)
      ? { ...r, kind: "public", otherSide: ROAD_VERGE_ID }
      : r;
  });
  const sides = describeSides(frame, plot.outline, sideRuns, (id) => {
    if (id === ROAD_VERGE_ID) return "verge belonging to the road";
    const a = id ? byId.get(id) : undefined;
    if (!a) return undefined;
    const what =
      SURFACE_TEXT[a.label] ??
      (a.kind === "green" ? "public green" : a.kind === "water" ? "water" : a.label);
    return a.streetName ? `${what} (${a.streetName})` : what;
  });

  for (const r of pavementRuns) {
    const side = sides.find((x) => x.side === sideOfEdge(frame, plot.outline, r.edge));
    if (!side) continue;
    const prev = side.roadBeyond;
    side.roadBeyond = {
      acrossM: Math.max(prev?.acrossM ?? 0, r.acrossM),
      lengthM: Math.round(((prev?.lengthM ?? 0) + r.lengthM) * 10) / 10,
      via: [...new Set([...(prev?.via ?? []), ...r.via])],
    };
  }

  // 7b. Registered structures (canopies, pools) and obstacles from the laser height scan.
  // Neither is critical: missing data downgrades "obstacles", never stops the check.
  const structures: Structure[] = [];
  try {
    await tracer.step(
      "bgt-structures",
      "Canopies, pools and other structures (BGT)",
      async (ctx) => {
        const res = await ogcItems(OGC.bgt, "overigbouwwerk", work, ctx, fetchFn);
        if (!res.complete) truncated("obstacles", "structure");
        for (const f of res.features) {
          if (!isCurrentBgt(f)) continue;
          const type = str(f.properties.type) ?? str(f.properties.bgt_type) ?? "other";
          // "niet-bgt": drawn by the municipality outside the national standard; type unknown.
          if (type === "niet-bgt") continue;
          outerRings(f.geometry).forEach((ring, i) => {
            if (distanceBetween(ring, plot.outline) > 0.5) return;
            structures.push({
              id: bgtId(f, i),
              type,
              outline: ring,
              onPlotShare:
                Math.round(
                  (intersectionArea(ring, plot.outline) / Math.max(area(ring), 0.01)) * 100,
                ) / 100,
            });
          });
        }
        ctx.summarize(
          structures.length
            ? structures.map((s) => STRUCTURE_TEXT[s.type] ?? s.type).join(", ")
            : "none registered on or at the plot",
        );
      },
    );
  } catch {
    note(quality, "obstacles", "Registered structures (canopies, pools) could not be loaded.");
  }

  let obstacles: ObstacleResult | undefined;
  try {
    obstacles = await tracer.step(
      "ahn-obstacles",
      "Trees and other obstacles in the garden (laser height scan)",
      async (ctx) => {
        const xs = plot.outline.map((p) => p[0]);
        const ys = plot.outline.map((p) => p[1]);
        const grid = await fetchHeightGrid(
          // 8 m around the plot, so a tree standing next door is seen whole (overhang vs own).
          [Math.min(...xs) - 8, Math.min(...ys) - 8, Math.max(...xs) + 8, Math.max(...ys) + 8],
          ctx,
          fetchFn,
        );
        const result = detectObstacles(
          grid,
          plot.outline,
          [...house, ...outbuildings, ...neighbours].map((b) => b.outline),
        );
        const n = (k: string) => result.obstacles.filter((o) => o.kind === k).length;
        ctx.summarize(
          `${n("tall")} tall (${result.tallM2} m²), ${n("medium")} medium (${result.mediumM2} m²), ${n("overhang")} overhanging from next door (${result.overhangM2} m²) in ${result.yardM2} m² of garden`,
        );
        return result;
      },
    );
    note(
      quality,
      "obstacles",
      "From the national laser height scan: a snapshot of one date. Trees may have grown or gone since, and a parked car shows up as a medium obstacle.",
    );
    if (obstacles.groundFilledShare > 0.5)
      downgrade(
        quality,
        "obstacles",
        "assumed",
        "Under most of the garden the scan saw no bare ground (dense trees), so ground height was filled in from around it.",
      );
  } catch {
    downgrade(
      quality,
      "obstacles",
      "missing",
      "The national laser height scan could not be loaded, so trees and other obstacles in the garden are unknown.",
    );
  }

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
    streetNames: dedupeLabels(allLabels),
    sides,
    trees,
    hedges,
    otherVegetation,
    exits,
    carReachableEdges,
    access,
    pavementRuns,
    otherHomesOnPlot,
    unitsInHouse,
    structures,
    ...(obstacles ? { obstacles } : {}),
    measurements,
    frame,
    layout,
    edges,
    houseType: houseTypeWithin(deriveHouseType(edges), house, otherHomes),
    flags,
    sources,
    quality,
  };
}
