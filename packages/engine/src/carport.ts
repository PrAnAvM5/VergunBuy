/**
 * Carport engine: can a carport of a given size stand at a given spot, and does it need a permit?
 *
 * Works in the plot's own frame (metres; street at the bottom, y pointing into the plot), so a
 * carport is an axis-aligned rectangle and the legal "front line" is horizontal. The site
 * builder (data layer) converts every register geometry into this frame.
 *
 * Two questions, kept apart and both shown:
 *  1. Feasible: on the plot, not on a building or a tree, and a car (adjustable size, turning
 *     radius and clearance) can actually drive in and park with room to open its doors. The
 *     swept-path planner (vehicle.ts) decides that. A spot a car cannot reach is not feasible.
 *  2. Permit: the carport rule set (Bbl 2.25, omgevingsplan 22.27 and 22.36 with exclusions
 *     22.28, 22.38, 22.39). Every check names the rule id it implements, so the verdict can show
 *     the article and the exact words it rests on.
 *
 * Zero false greens: a check passes only on data; missing or uncertain data gives "unknown",
 * and green needs every check to pass AND every rule's document to be the verified version.
 */
import { checkAreaLimit, type AreaTableParams } from "./rules/areaLimit.ts";
import type { ExclusionResult } from "./concepts/legal.ts";
import {
  area,
  clipRegions,
  contains,
  distanceToSegment,
  distanceBetween,
  edges,
  intersectionArea,
  outwardNormal,
  regionArea,
  regionContains,
  regionOf,
  type Point,
  type Polygon,
  type Region,
} from "./geometry.ts";
import {
  DEFAULT_VEHICLE,
  accessCarport,
  buildLattice,
  buildWorld,
  carOf,
  leaveCarport,
  parkingFit,
  type BayAccess,
  type Car,
  type CarportRect,
  type Gate,
  type Lattice,
  type LeaveRoute,
  type VehicleParams,
  EXIT_TREE_M,
  TRUNK_R,
} from "./vehicle.ts";
import type { BoundaryState, Material } from "./concepts/boundary.ts";

/** Fixed standard height of the presets (decision of 2026-11-25: no height dragging). */
export const CARPORT_HEIGHT_M = 2.5;
/** From this height a scanned object counts as a tree (blocks the car and the carport). */
const TREE_M = 2.5;

export const CARPORT_PRESETS = {
  single: { widthM: 3, lengthM: 5 },
  double: { widthM: 6, lengthM: 5 },
} as const;

export const CARPORT_LIMITS = { minWidthM: 2.4, maxWidthM: 9, minLengthM: 4, maxLengthM: 9 };

/** Room beside a parked car to open its doors (each side): a carport is at least car + 0.6 m
 *  wide (decision 2026-11-26). */
export const DOOR_GAP_M = 0.3;

/**
 * The first floor of a house with more than one storey is assumed to be at least 2.4 m above
 * ground (minimum room height plus floor). With the fixed 2.5 m height this keeps a carport within
 * "0.3 m above the floor of the second storey" (22.36 a 1° II) for every ordinary house.
 */
export const ASSUMED_MIN_FIRST_FLOOR_M = 2.4;

export interface CarportSite {
  /** All geometry in the plot frame (local metres, street at the bottom). */
  plot: Polygon;
  /** The main house (hoofdgebouw); several parts when the register splits it. */
  house: { outline: Polygon; heightM?: number; storeys?: number; isDwelling: boolean }[];
  /** Other buildings on or overlapping the plot (sheds, garages, neighbours' walls). */
  buildings: { id: string; outline: Polygon; label: string; onPlot: boolean }[];
  /** Registered structures (BGT overig bouwwerk): canopies (existing carports), pools, ... */
  structures: { id: string; outline: Polygon; label: string; roofed: boolean }[];
  /** Publicly accessible area near the plot (rear paths included: conservative). */
  publicAreas: Polygon[] | null;
  /** Plot sides other than the front that border public area (not rear paths): corner plots. */
  publicSides: ("left" | "right" | "rear")[];
  /** How the front was found; an estimated front on a corner plot makes the back yard uncertain. */
  front: "street-label" | "estimated" | "none";
  access: {
    level: "registered" | "possible" | "none";
    /** Boundary stretches where a car can come in (local segments on the plot boundary). */
    entries: [Point, Point][];
    /** Road-side stretches where a new exit could be made (needs an exit permit). */
    frontage: [Point, Point][];
    note: string;
  };
  /** Registered street trees (local), kept clear of by a new exit. */
  streetTrees: Point[];
  /**
   * The street as it is: road surfaces a car may drive on (carriageway, parking, driveway
   * crossings, shared residential street) and fixed objects in it (lamp posts, poles, cabinets).
   * Null or absent: unknown, and the car is modelled on a straight strip out from each gate.
   */
  road?: {
    drivable: Polygon[];
    /** Cycle paths and lanes: crossed near a gate when turning in or out, never driven along. */
    crossable?: Polygon[];
    objects: { at: Point; kind: string }[];
  } | null;
  /** What stands on the plot line, in 0.5 m pieces (local); null without the height scan. */
  boundary: { a: Point; b: Point; side: "street" | "other"; state: BoundaryState }[] | null;
  /** Height-scan obstacle cells (local centres) with heights; null when unavailable. */
  obstacles: {
    /** tree: part of the crown of something 2.5 m or higher (blocks cars, cannot be built on). */
    cells: {
      /** The scanned object this cell belongs to (for "I'll clear this shrub"). */
      id?: string;
      at: Point;
      heightM: number;
      kind: string;
      tree: boolean;
      /** plant / solid / unknown from laser echoes and the infrared photo; null without data. */
      material: Material | null;
    }[];
    cellM: number;
    scanYear?: number;
    /**
     * Cells 1 m or higher on public ground just outside the plot (verges, public green,
     * pavement), where a car would cross to reach the road: trees block, the rest is the
     * municipality's planting or a solid object.
     */
    outside?: { at: Point; heightM: number; material: Material | null }[];
  } | null;
  /** Rule exclusions with zones already in the local frame. */
  exclusions: ExclusionResult[];
  /** Signs that part of the house is a later extension (permit, register change, scan change). */
  extensionEvidence: string[];
  areaTable: AreaTableParams;
  /** Rule ids whose document is not the verified version, and whether freshness is known. */
  freshness: { known: boolean; staleRules: string[]; note: string };
  /** Data quality per domain, as the plot context reports it. */
  quality: Record<string, string>;
}

export interface Placement {
  /** Centre of the carport (local). */
  x: number;
  y: number;
  widthM: number;
  lengthM: number;
  /** 0: width along the street; 90: width into the plot. */
  rotation: 0 | 90;
}

export type CheckOutcome = "pass" | "fail" | "unknown";

export interface CarportCheck {
  id: string;
  /** Rule id in the rule set, when the check implements a rule. */
  ruleId?: string;
  group: "feasible" | "technical" | "permit-free" | "allowed-by-law" | "exclusion" | "freshness";
  label: string;
  outcome: CheckOutcome;
  detail: string;
}

export interface CarportWarning {
  id: string;
  text: string;
}

export interface CarportVerdict {
  /** green: feasible, permit-free and allowed by law on verified rules; red: not feasible or a
   *  permit is certainly needed; amber: anything uncertain. */
  colour: "green" | "amber" | "red";
  headline: string;
  feasible: CheckOutcome;
  /** 22.27: no permit needed for the omgevingsplan activity. */
  permitFree: CheckOutcome;
  /** 22.36: in accordance with the omgevingsplan by law (old zoning plan does not matter). */
  allowedByLaw: CheckOutcome;
  checks: CarportCheck[];
  warnings: CarportWarning[];
  outline: Polygon;
  /** How the car gets in (routes per bay), for drawing and animating. */
  access: CarAccess;
}

export function rectangle(p: Placement): Polygon {
  const w = p.rotation === 0 ? p.widthM : p.lengthM;
  const h = p.rotation === 0 ? p.lengthM : p.widthM;
  return [
    [p.x - w / 2, p.y - h / 2],
    [p.x + w / 2, p.y - h / 2],
    [p.x + w / 2, p.y + h / 2],
    [p.x - w / 2, p.y + h / 2],
  ];
}

// ---------------------------------------------------------------------------------------------
// The back-yard area (achtererfgebied)
// ---------------------------------------------------------------------------------------------

export interface BackYard {
  /** The achtererfgebied: plot ground behind the front line, without the house. */
  region: Region;
  /** y of the front line: 1 m behind the deepest street-facing façade of the house. */
  frontLineY: number | null;
  method: string;
}

const BIG = 1e4;
/** Shortest street-facing wall that counts as (part of) the front façade. */
export const FACADE_MIN_M = 1.5;
const box = (minX: number, minY: number, maxX: number, maxY: number): Polygon => [
  [minX, minY],
  [maxX, minY],
  [maxX, maxY],
  [minX, maxY],
];

/**
 * Bbl Bijlage I, achtererfgebied: "gebouwerf achter de lijn die het hoofdgebouw doorkruist op
 * 1 m achter de voorkant en van daaruit evenwijdig loopt met het aangrenzend openbaar
 * toegankelijk gebied, zonder het hoofdgebouw opnieuw te doorkruisen of in het gebouwerf achter
 * het hoofdgebouw te komen".
 *
 * Construction (conservative where the definition leaves room):
 *  - the voorkant is the street-facing façade visible from the street (walls of at least 1.5 m;
 *    smaller jogs are not a façade); when it is stepped, the deepest visible part is used, so the
 *    line never lies further forward than the law allows;
 *  - the line runs parallel to the street, across the whole plot;
 *  - on a corner plot, the strip between the house and a public side is left out entirely.
 */
export function backYard(site: CarportSite): BackYard {
  const houses = site.house.map((h) => h.outline);
  if (!houses.length) return { region: [], frontLineY: null, method: "no house" };
  let front = -Infinity;
  for (const h of houses)
    for (const [a, b] of edges(h)) {
      const n = outwardNormal(h, a, b);
      if (n[1] > -0.5) continue; // not facing the street
      // Small jogs in a wall (under 1.5 m) are not a façade.
      if (Math.abs(b[0] - a[0]) < FACADE_MIN_M) continue;
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // Visible from the street: nothing of the house lies straight in front of it.
      const probe: Point = [mid[0], mid[1] - 0.05];
      const blocked = houses.some((o) =>
        edges(o).some(([c, d]) => {
          if ((c === a && d === b) || Math.max(c[1], d[1]) >= probe[1]) return false;
          const lo = Math.min(c[0], d[0]);
          const hi = Math.max(c[0], d[0]);
          return mid[0] > lo && mid[0] < hi;
        }),
      );
      if (!blocked) front = Math.max(front, a[1], b[1]);
    }
  if (!Number.isFinite(front))
    return { region: [], frontLineY: null, method: "no street-facing façade" };
  const lineY = front + 1;
  let region = clipRegions(
    regionOf(site.plot),
    regionOf(box(-BIG, lineY, BIG, BIG)),
    "intersection",
  );
  const xs = houses.flatMap((h) => h.map((p) => p[0]));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  if (site.publicSides.includes("left"))
    region = clipRegions(region, regionOf(box(-BIG, -BIG, minX, BIG)), "difference");
  if (site.publicSides.includes("right"))
    region = clipRegions(region, regionOf(box(maxX, -BIG, BIG, BIG)), "difference");
  region = clipRegions(region, regionOf(...houses), "difference");
  return {
    region,
    frontLineY: lineY,
    method: `1 m behind the street-facing façade${site.publicSides.some((s) => s === "left" || s === "right") ? "; side strip along the side street left out (corner plot)" : ""}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Evaluating one placement
// ---------------------------------------------------------------------------------------------

/**
 * The car's worlds, from strict to loose: through the existing exit(s) only; also across open
 * stretches of the street side (a new exit, "uitwegvergunning"); also through hedges, fences and
 * walls on the street side (they would have to be opened, and a new exit is needed).
 */
export interface VehicleWorlds {
  car: Car;
  params: VehicleParams;
  existing: Lattice | null;
  /** Existing exits plus open street-side stretches; null when there are none beyond the exits. */
  any: Lattice | null;
  /** Everything on the street side, including hedges, fences and walls. */
  opened: Lattice | null;
}

export interface ScreenGrid {
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  cell: number;
}

export interface Prepared {
  site: CarportSite;
  yard: BackYard;
  vehicle: VehicleWorlds;
  /** Per screening cell, for fast screening of many positions (confirmed by evaluate()). */
  grid: ScreenGrid;
  screen: {
    onPlot: Uint8Array;
    solid: Uint8Array;
    yard: Uint8Array;
    /** 2: tree crown (2.5 m+), 1: shrub or low object (1–2.5 m). */
    obstacle: Uint8Array;
    /** Distance (m) to the nearest public-area cell. */
    publicM: Float32Array;
    /** Distance driven from the road to this point, per world and per orientation of the car
     *  (ns: heading along y, as parked in a rotation-0 carport; ew: along x); Infinity: none. */
    reachExisting: { ns: Float32Array; ew: Float32Array };
    reachAny: { ns: Float32Array; ew: Float32Array };
  };
  /** Annex area already standing in the back yard (sheds, garages, roofed canopies). */
  existingAnnexM2: number;
  yardM2: number;
  houseM2: number;
}

/** Size of a lamp post, pole or cabinet as an obstacle (m, square). */
const STREET_OBJECT_M = 0.4;

const segBox = (p: Point, r: number): Polygon => box(p[0] - r, p[1] - r, p[0] + r, p[1] + r);

/** True when p lies in the strip straight out from a gate (8 m deep, 2.5 m wider each side). */
function nearGateStrip(plot: Polygon, g: Gate, p: Point): boolean {
  const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
  const tx = (g.b[0] - g.a[0]) / len;
  const ty = (g.b[1] - g.a[1]) / len;
  const mid: Point = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
  let nx = ty;
  let ny = -tx;
  if (contains(plot, [mid[0] + nx * 0.1, mid[1] + ny * 0.1])) {
    nx = -nx;
    ny = -ny;
  }
  const dx = p[0] - g.a[0];
  const dy = p[1] - g.a[1];
  const along = dx * tx + dy * ty;
  const out = dx * nx + dy * ny;
  return out >= -0.5 && out <= 8 && along >= -2.5 && along <= len + 2.5;
}

/** Splits new-exit gates into 0.5 m pieces and keeps those whose crossing to the road stays
 *  EXIT_TREE_M clear of every street-tree trunk. */
function treeSafe(site: CarportSite, gates: Gate[]): Gate[] {
  const out: Gate[] = [];
  const drivable = site.road?.drivable ?? [];
  for (const g of gates) {
    const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
    const n = Math.max(1, Math.round(len / 0.5));
    const tx = (g.b[0] - g.a[0]) / (len || 1);
    const ty = (g.b[1] - g.a[1]) / (len || 1);
    // Outward: the side of the piece away from the plot.
    const mid: Point = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
    let nx = ty;
    let ny = -tx;
    if (contains(site.plot, [mid[0] + nx * 0.1, mid[1] + ny * 0.1])) {
      nx = -nx;
      ny = -ny;
    }
    let cur: Gate | null = null;
    for (let i = 0; i < n; i++) {
      const pa: Point = [
        g.a[0] + ((g.b[0] - g.a[0]) * i) / n,
        g.a[1] + ((g.b[1] - g.a[1]) * i) / n,
      ];
      const pb: Point = [
        g.a[0] + ((g.b[0] - g.a[0]) * (i + 1)) / n,
        g.a[1] + ((g.b[1] - g.a[1]) * (i + 1)) / n,
      ];
      const pm: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      // How far out the crossing goes: to the road surface (at most 8 m), else 3 m.
      let d = 0;
      while (d <= 8 && !drivable.some((r) => contains(r, [pm[0] + nx * d, pm[1] + ny * d])))
        d += 0.25;
      if (d > 8) d = 3;
      const ok = site.streetTrees.every(
        (t) =>
          Math.min(
            distanceToSegment(t, pa, [pa[0] + nx * d, pa[1] + ny * d]),
            distanceToSegment(t, pb, [pb[0] + nx * d, pb[1] + ny * d]),
            distanceToSegment(t, pa, pb),
          ) >=
          EXIT_TREE_M + TRUNK_R,
      );
      if (ok) {
        if (cur && Math.hypot(cur.b[0] - pa[0], cur.b[1] - pa[1]) < 1e-6) cur.b = pb;
        else out.push((cur = { a: pa, b: pb, kind: g.kind }));
      } else cur = null;
    }
  }
  return out;
}

/** Joins consecutive street-side pieces whose state is in `states` into gate segments. */
function gatesFrom(
  pieces: NonNullable<CarportSite["boundary"]>,
  states: BoundaryState[],
  kind: Gate["kind"],
): Gate[] {
  const out: Gate[] = [];
  for (const p of pieces) {
    if (p.side !== "street" || !states.includes(p.state)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.b[0] - p.a[0], last.b[1] - p.a[1]) < 1e-6) last.b = p.b;
    else out.push({ a: p.a, b: p.b, kind });
  }
  return out;
}

/** The car's worlds for a site: obstacles, gates, lattices. */
export function vehicleWorlds(
  site: CarportSite,
  params: VehicleParams = DEFAULT_VEHICLE,
): VehicleWorlds {
  const car = carOf(params);
  const solids = [
    ...site.house.map((h) => h.outline),
    ...site.buildings.map((b) => b.outline),
    // A street tree's trunk (assumed TRUNK_R; the car keeps its normal clearance).
    ...site.streetTrees.map((t) => segBox(t, TRUNK_R)),
  ];
  // Only trees block inside the garden (decision 2026-11-25); shrubs and solid things lower
  // than 2.5 m are driven through with a condition (see evaluate).
  const scan = [...(site.obstacles?.cells ?? []).map((c) => ({ at: c.at, blocks: c.tree }))];
  // Trees on the verge or public green outside the plot block a NEW way in there, as inside.
  // Not in front of a way in that already exists (cars drive under street-tree crowns daily).
  const outsideScan = (existing: Gate[]) =>
    (site.obstacles?.outside ?? [])
      .filter(
        (c) => c.heightM >= TREE_M && !existing.some((g) => nearGateStrip(site.plot, g, c.at)),
      )
      .map((c) => ({ at: c.at, blocks: true }));
  const scanCellM = site.obstacles?.cellM ?? 0.5;
  let existingGates: Gate[];
  let openGates: Gate[];
  let closedGates: Gate[];
  if (site.boundary) {
    // Registered exits, and on plots without one the probable way in (road contact or a
    // pavement crossing where a car can reach the plot line), are tried first.
    existingGates = [
      ...gatesFrom(site.boundary, ["exit"], "existing"),
      ...(site.access.level === "registered"
        ? []
        : site.access.entries.map(([a, b]) => ({ a, b, kind: "existing" as const }))),
    ];
    openGates = gatesFrom(site.boundary, ["open"], "frontage");
    closedGates = gatesFrom(site.boundary, ["hedge", "barrier", "unknown"], "frontage");
  } else {
    existingGates =
      site.access.level === "registered"
        ? site.access.entries.map(([a, b]) => ({ a, b, kind: "existing" }))
        : [];
    openGates = [
      ...(site.access.level === "registered" ? [] : site.access.entries),
      ...site.access.frontage,
    ].map(([a, b]) => ({ a, b, kind: "frontage" }));
    closedGates = [];
  }
  // A new exit keeps EXIT_TREE_M from a street-tree trunk: plot-line pieces whose crossing to
  // the road would come closer are no way in (municipal exit rules: no damage to street trees).
  const awayFromTrees = (gs: Gate[]) => (site.streetTrees.length ? treeSafe(site, gs) : gs);
  openGates = awayFromTrees(openGates);
  closedGates = awayFromTrees(closedGates);
  // Street objects and street-tree trunks as small blocks the car must miss on the road.
  const road = site.road?.drivable.length
    ? {
        drivable: site.road.drivable,
        crossable: site.road.crossable ?? [],
        soft: site.publicAreas ?? [],
        blockers: [...site.road.objects.map((o) => segBox(o.at, STREET_OBJECT_M / 2))],
        trees: site.streetTrees,
      }
    : undefined;
  const world = (gates: Gate[]) =>
    gates.length
      ? buildLattice(
          buildWorld({
            plot: site.plot,
            solids,
            scan: [...scan, ...outsideScan(existingGates)],
            scanCellM,
            gates,
            road,
          }),
          car,
        )
      : null;
  return {
    car,
    params,
    existing: world(existingGates),
    any: openGates.length ? world([...existingGates, ...openGates]) : null,
    opened: closedGates.length ? world([...existingGates, ...openGates, ...closedGates]) : null,
  };
}

/** Heavy, placement-independent work, done once per plot (and again when the car changes). */
export function prepare(site: CarportSite, params: VehicleParams = DEFAULT_VEHICLE): Prepared {
  const yard = backYard(site);
  const vehicle = vehicleWorlds(site, params);
  const inYard = (p: Polygon) =>
    yard.region.reduce((s, part) => s + intersectionArea(part.outer, p), 0);
  const existingAnnexM2 =
    site.buildings.filter((b) => b.onPlot).reduce((s, b) => s + inYard(b.outline), 0) +
    site.structures.filter((s) => s.roofed).reduce((s, x) => s + inYard(x.outline), 0);
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  const cell = 0.25;
  const grid: ScreenGrid = {
    minX: Math.min(...xs) - 2,
    minY: Math.min(...ys) - 2,
    nx: Math.ceil((Math.max(...xs) - Math.min(...xs) + 4) / cell),
    ny: Math.ceil((Math.max(...ys) - Math.min(...ys) + 4) / cell),
    cell,
  };
  return {
    site,
    yard,
    vehicle,
    grid,
    screen: screening(site, yard, grid, vehicle),
    existingAnnexM2,
    yardM2: regionArea(yard.region),
    houseM2: site.house.reduce((s, h) => s + area(h.outline), 0),
  };
}

/**
 * Marks (value 1) or clears (value 0) the grid cells whose centre lies inside a polygon, by
 * scanline: per row, the crossings with the polygon's edges are sorted and filled in pairs.
 */
function rasterize(
  poly: Polygon,
  g: { minX: number; minY: number; nx: number; ny: number; cell: number },
  out: Uint8Array,
  value: 0 | 1 = 1,
): void {
  const ys = poly.map((p) => p[1]);
  const j0 = Math.max(0, Math.ceil((Math.min(...ys) - g.minY) / g.cell - 0.5));
  const j1 = Math.min(g.ny - 1, Math.floor((Math.max(...ys) - g.minY) / g.cell - 0.5));
  const xsAt: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.minY + (j + 0.5) * g.cell;
    xsAt.length = 0;
    for (let e = 0; e < poly.length; e++) {
      const a = poly[e]!;
      const b = poly[(e + 1) % poly.length]!;
      if (a[1] > y !== b[1] > y) xsAt.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xsAt.sort((u, v) => u - v);
    for (let q = 0; q + 1 < xsAt.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xsAt[q]! - g.minX) / g.cell - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor((xsAt[q + 1]! - g.minX) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) out[j * g.nx + i] = value;
    }
  }
}

function bboxOf(poly: Polygon) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Per screening cell: the shortest drive from the road to a lattice point there, with the car
 *  along y (headings 0 and 4) or along x (2 and 6). */
function reachField(L: Lattice | null, g: ScreenGrid): { ns: Float32Array; ew: Float32Array } {
  return { ns: reachFor(L, g, [0, 4]), ew: reachFor(L, g, [2, 6]) };
}

function reachFor(L: Lattice | null, g: ScreenGrid, headings: number[]): Float32Array {
  const out = new Float32Array(g.nx * g.ny).fill(Infinity);
  if (!L) return out;
  const { w, res } = L;
  for (let j = 0; j < w.NJ; j++)
    for (let i = 0; i < w.NI; i++) {
      let d = Infinity;
      const base = (j * w.NI + i) * 8;
      for (const h of headings) d = Math.min(d, res.dist[base + h]!);
      if (d === Infinity) continue;
      const x = (w.i0 + i) * 0.5;
      const y = (w.j0 + j) * 0.5;
      // Spread over the 0.5 m around the lattice point.
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = Math.floor((x + di * 0.25 - g.minX) / g.cell);
          const jj = Math.floor((y + dj * 0.25 - g.minY) / g.cell);
          if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
          const k = jj * g.nx + ii;
          if (d < out[k]!) out[k] = d;
        }
    }
  return out;
}

function screening(
  site: CarportSite,
  yard: BackYard,
  g: ScreenGrid,
  v: VehicleWorlds,
): Prepared["screen"] {
  const n = g.nx * g.ny;
  const onPlot = new Uint8Array(n);
  const solid = new Uint8Array(n);
  const inYard = new Uint8Array(n);
  const obstacle = new Uint8Array(n);
  const pub = new Uint8Array(n);
  rasterize(site.plot, g, onPlot);
  for (const x of [...site.house.map((h) => h.outline), ...site.buildings.map((b) => b.outline)])
    rasterize(x, g, solid);
  for (const part of yard.region) {
    rasterize(part.outer, g, inYard);
    for (const hole of part.holes) rasterize(hole, g, inYard, 0);
  }
  for (const a of site.publicAreas ?? []) rasterize(a, g, pub);
  const half = (site.obstacles?.cellM ?? 0.5) / 2;
  for (const c of site.obstacles?.cells ?? []) {
    const level = c.tree ? 2 : c.heightM >= 1 ? 1 : 0;
    if (!level) continue;
    const i0 = Math.max(0, Math.floor((c.at[0] - half - g.minX) / g.cell));
    const i1 = Math.min(g.nx - 1, Math.ceil((c.at[0] + half - g.minX) / g.cell) - 1);
    const j0 = Math.max(0, Math.floor((c.at[1] - half - g.minY) / g.cell));
    const j1 = Math.min(g.ny - 1, Math.ceil((c.at[1] + half - g.minY) / g.cell) - 1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        if (level > obstacle[k]!) obstacle[k] = level;
      }
  }
  // Distance to public area, by breadth-first growth (city-block, an under-estimate: safe).
  const publicM = new Float32Array(n).fill(BIG);
  const queue: number[] = [];
  for (let k = 0; k < n; k++)
    if (pub[k]) {
      publicM[k] = 0;
      queue.push(k);
    }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi]!;
    const i = k % g.nx;
    const j = (k - i) / g.nx;
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
      const kk = jj * g.nx + ii;
      if (publicM[kk]! <= publicM[k]! + g.cell) continue;
      publicM[kk] = publicM[k]! + g.cell;
      queue.push(kk);
    }
  }
  return {
    onPlot,
    solid,
    yard: inYard,
    obstacle,
    publicM,
    reachExisting: reachField(v.existing, g),
    reachAny: reachField(v.opened ?? v.any, g),
  };
}

const overlapM2 = (a: Polygon, b: Polygon) => {
  const ax = a.map((p) => p[0]);
  const bx = b.map((p) => p[0]);
  const ay = a.map((p) => p[1]);
  const by = b.map((p) => p[1]);
  if (Math.max(...ax) < Math.min(...bx) || Math.max(...bx) < Math.min(...ax)) return 0;
  if (Math.max(...ay) < Math.min(...by) || Math.max(...by) < Math.min(...ay)) return 0;
  return intersectionArea(a, b);
};

/** Sample points on and inside a rectangle, for containment tests against regions. */
function samples(r: Polygon, step = 0.5): Point[] {
  const xs = r.map((p) => p[0]);
  const ys = r.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pts: Point[] = [];
  const nx = Math.max(1, Math.ceil((x1 - x0) / step));
  const ny = Math.max(1, Math.ceil((y1 - y0) / step));
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      // Points a hair inside the outline, so a carport touching a line is judged by its inside.
      const x = Math.min(x1 - 0.01, Math.max(x0 + 0.01, x0 + ((x1 - x0) * i) / nx));
      const y = Math.min(y1 - 0.01, Math.max(y0 + 0.01, y0 + ((y1 - y0) * j) / ny));
      pts.push([x, y]);
    }
  return pts;
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

export function evaluate(
  prep: Prepared,
  pl: Placement,
  opts: EvaluateOptions = {},
): CarportVerdict {
  const cleared = opts.cleared ?? new Set<string>();
  const { site, yard } = prep;
  const r = rectangle(pl);
  const carportM2 = pl.widthM * pl.lengthM;
  const checks: CarportCheck[] = [];
  const warnings: CarportWarning[] = [];
  const add = (c: CarportCheck) => checks.push(c);
  const q = (domain: string) => site.quality[domain] ?? "missing";

  // --- Feasible ------------------------------------------------------------------------------
  const onPlotM2 = intersectionArea(site.plot, r);
  const onPlot = onPlotM2 >= carportM2 - 0.05;
  add({
    id: "on-plot",
    group: "feasible",
    label: "Stands on the plot",
    outcome: q("plot") === "complete" ? (onPlot ? "pass" : "fail") : "unknown",
    detail: onPlot
      ? "The whole carport lies within the registered plot boundary."
      : `${fmt(carportM2 - onPlotM2)} m² lies outside the plot.`,
  });
  const hits = [
    ...site.house.map((h) => ({ label: "the house", outline: h.outline })),
    ...site.buildings.map((b) => ({ label: b.label, outline: b.outline })),
  ].filter((b) => overlapM2(b.outline, r) > 0.05);
  add({
    id: "no-building",
    group: "feasible",
    label: "Clear of buildings",
    outcome: q("buildings") === "complete" ? (hits.length ? "fail" : "pass") : "unknown",
    detail: hits.length
      ? `Overlaps ${[...new Set(hits.map((h) => h.label))].join(", ")}.`
      : "No registered building stands where the carport would go.",
  });
  // Trees and shrubs where the carport would stand (laser scan). A tree would have to be felled:
  // not offered (red). Shrubs and low objects can be cleared: amber with a warning.
  const cellsAll = (site.obstacles?.cells ?? []).filter((c) => contains(r, c.at));
  const isCleared = (c: { id?: string; tree: boolean }) => !c.tree && !!c.id && cleared.has(c.id);
  const clearedHere = cellsAll.filter(isCleared).length;
  const cellsIn = cellsAll.filter((c) => !isCleared(c));
  const treeCells = cellsIn.filter((c) => c.tree);
  const lowCells = cellsIn.filter((c) => !c.tree && c.heightM >= 1);
  const solidCells = lowCells.filter((c) => c.material === "solid");
  const shrubCells = lowCells.filter((c) => c.material !== "solid");
  const cellM2 = (site.obstacles?.cellM ?? 0.5) ** 2;
  const scanNote = site.obstacles?.scanYear ? ` (laser scan ${site.obstacles.scanYear})` : "";
  add({
    id: "no-tree",
    group: "feasible",
    label: "No tree in the way",
    outcome: !site.obstacles
      ? "unknown"
      : treeCells.length
        ? "fail"
        : lowCells.length
          ? "unknown"
          : "pass",
    detail: !site.obstacles
      ? "The height scan could not be loaded, so trees on the spot are not known."
      : treeCells.length
        ? `${fmt(treeCells.length * cellM2)} m² of tree crown (2.5 m or higher, up to ${fmt(Math.max(...treeCells.map((c) => c.heightM)))} m)${scanNote} is where the carport would stand. It would have to be felled${treeCells.some((c) => c.kind === "overhang") ? " or cut back (a neighbour's tree)" : ""}; such spots are not offered.`
        : lowCells.length
          ? [
              shrubCells.length
                ? `${fmt(shrubCells.length * cellM2)} m² of shrubs or hedge (1–2.5 m)${scanNote} would have to be cleared first.`
                : "",
              solidCells.length
                ? `${fmt(solidCells.length * cellM2)} m² of something solid (1–2.5 m, not a plant)${scanNote} stands here: a parked car, a low wall or a shed. Check on site.`
                : "",
            ]
              .filter(Boolean)
              .join(" ")
          : `Nothing 1 m or higher stands here${scanNote}${clearedHere ? `, once the ${fmt(clearedHere * cellM2)} m² of shrubs you marked are cleared` : ""}.`,
  });

  const access = carAccess(prep, pl, cleared);
  const car = prep.vehicle.car;
  add({
    id: "car-fit",
    group: "feasible",
    label: "The car fits, doors open",
    outcome: access.fit.fits ? "pass" : "fail",
    detail: access.fit.fits
      ? `A ${fmt(car.l)} × ${fmt(car.w)} m car fits ${access.rect.bays === 2 ? "in each of the two bays" : ""} with ${fmt(access.fit.gapM)} m beside it on each side (at least ${DOOR_GAP_M} m for the doors).`
      : `A ${fmt(car.l)} × ${fmt(car.w)} m car needs ${fmt(car.l)} m of depth and ${fmt(car.w + 2 * DOOR_GAP_M)} m of width per bay (doors open ${DOOR_GAP_M} m).`,
  });
  const noGates = !prep.vehicle.existing && !prep.vehicle.any && !prep.vehicle.opened;
  // Conditions on the way in (each makes the route amber, never red).
  const conditions: string[] = [];
  if (access.via === "through-barrier")
    conditions.push(
      access.crossed.includes("hedge") && !access.crossed.includes("barrier")
        ? "The only way in crosses a hedge on the street side: a piece of it would have to go, and a new exit needs an exit permit (uitwegvergunning)."
        : "The only way in crosses a fence or wall on the street side: it would have to be opened, and a new exit needs an exit permit (uitwegvergunning).",
    );
  if (access.via && access.sweptShrubM2 >= 0.5)
    conditions.push(
      `The car drives over about ${fmt(access.sweptShrubM2)} m² of shrubs or hedge (1–2.5 m) on the way in: they would have to go.`,
    );
  if (access.via && access.sweptPublicM2 >= 0.5)
    conditions.push(
      `Just outside the plot the car would cross about ${fmt(access.sweptPublicM2)} m² of planting or objects 1–2.5 m high on public ground (verge or public green): the municipality decides whether that may go.`,
    );
  if (access.via && access.sweptSolidM2 >= 0.5)
    conditions.push(
      `Something solid (1–2.5 m, about ${fmt(access.sweptSolidM2)} m²) stood in the way during the laser scan: a parked car, a low wall or a shed. Check on site.`,
    );
  if (clearedHere || access.clearedM2)
    warnings.push({
      id: "cleared",
      text: `This assumes you clear the shrubs you marked (about ${fmt(clearedHere * cellM2 + access.clearedM2)} m² in the way). Shrubs on your own plot need no permit; trees of 2.5 m and up cannot be marked.`,
    });
  const blockers = access.bays.filter((b) => !b.route);
  add({
    id: "car-route",
    group: "feasible",
    label: "A car can drive in",
    outcome: !access.fit.fits
      ? "unknown"
      : noGates
        ? "unknown"
        : access.via === "existing" && !conditions.length
          ? "pass"
          : access.via
            ? "unknown"
            : "fail",
    detail: [
      !access.fit.fits
        ? "Not checked: the car does not fit."
        : noGates
          ? `No way onto the plot was found for a car. ${site.access.note}`
          : access.via === "existing"
            ? `Drives in through the existing exit ${access.bays.map((b) => b.route!.how).join(" / ")} (turning radius ${fmt(car.rt)} m, ${fmt(car.clr)} m clear of walls and trees all the way).`
            : access.via === "new-exit"
              ? "Not through the existing exit, but through a new exit from the street. A new exit needs an exit permit (uitwegvergunning) from the municipality."
              : access.via === "probable"
                ? "Drives in where a car can already reach the plot line (no exit is registered here, so check whether the kerb is lowered or an exit permit is needed)."
                : access.via === "unregistered"
                  ? `A car can drive in from the street, but no exit is registered here, so a new exit needs an exit permit (uitwegvergunning) unless an older one already exists: ${site.access.note}`
                  : access.via === "through-barrier"
                    ? "A car can only get in through a hedge, fence or wall on the street side."
                    : `A car cannot get there: ${blockers.some((b) => b.blocker === "car") ? "the other bay's car is in the way" : blockers.some((b) => b.blocker === "post") ? "a carport post is in the way" : `the house, buildings or trees leave no path with ${fmt(car.clr)} m clearance and a ${fmt(car.rt)} m turning radius`}.`,
      ...conditions,
    ].join(" "),
  });
  const struct = site.structures.filter((s) => overlapM2(s.outline, r) > 0.05);
  if (struct.length)
    warnings.push({
      id: "structure",
      text: `Stands on ${struct.map((s) => s.label).join(", ")}: it would have to be removed or replaced.`,
    });
  if (access.via)
    warnings.push({
      id: "fences",
      text: site.boundary
        ? "Fences and hedges are read from the laser scan; gates, wire fences and anything newer than the scan do not show. Check on site."
        : "Fences, gates and garden walls are not in the public registers: check on site that nothing blocks the drive.",
    });

  // --- Technical (Bbl 2.25) ------------------------------------------------------------------
  add({
    id: "tech-height",
    ruleId: "tech-max-5m",
    group: "technical",
    label: "No technical building permit",
    outcome: CARPORT_HEIGHT_M <= 5 ? "pass" : "fail",
    detail: `On the ground, ${CARPORT_HEIGHT_M} m high (at most 5 m), no roof terrace, not a main building.`,
  });

  // --- Permit-free (omgevingsplan 22.27 a) ---------------------------------------------------
  const pts = samples(r);
  const inYard = yard.region.length > 0 && pts.every((p) => regionContains(yard.region, p));
  const frontUncertain =
    site.front !== "street-label" && site.publicSides.length > 0 && site.front !== "none";
  add({
    id: "back-yard",
    ruleId: "pf-back-yard",
    group: "permit-free",
    label: "In the back-yard area",
    outcome:
      site.front === "none" || !yard.region.length || q("buildings") !== "complete"
        ? "unknown"
        : !inYard
          ? "fail"
          : frontUncertain
            ? "unknown"
            : "pass",
    detail: !yard.region.length
      ? "The back-yard area could not be constructed (no street-facing façade found)."
      : inYard
        ? frontUncertain
          ? "Inside the back-yard area, but the front of this corner plot is estimated, so the area may lie differently."
          : `Entirely behind the line ${yard.method}.`
        : "Part of the carport is in front of the line 1 m behind the house front, or beside the house on a corner: there a permit is always needed.",
  });
  let publicD: number | null = null;
  if (site.publicAreas) {
    const rb = bboxOf(r);
    const nearby = site.publicAreas.filter((a) => {
      const b = bboxOf(a);
      return b.x0 <= rb.x1 + 20 && b.x1 >= rb.x0 - 20 && b.y0 <= rb.y1 + 20 && b.y1 >= rb.y0 - 20;
    });
    publicD = nearby.length ? Math.min(...nearby.map((a) => distanceBetween(a, r))) : Infinity;
  }
  add({
    id: "public-distance",
    ruleId: "pf-public-distance",
    group: "permit-free",
    label: "More than 1 m from public area",
    outcome:
      publicD === null || q("publicArea") !== "complete"
        ? "unknown"
        : publicD > 1
          ? "pass"
          : "fail",
    detail:
      publicD === null
        ? "Public areas could not be loaded."
        : publicD === Infinity
          ? "No public area near the plot."
          : `Closest public area (street, pavement, green or path) is ${fmt(publicD)} m away.`,
  });
  add({
    id: "height-5",
    ruleId: "pf-max-5m",
    group: "permit-free",
    label: "Not higher than 5 m",
    outcome: "pass",
    detail: `Standard height ${CARPORT_HEIGHT_M} m.`,
  });

  // --- Allowed by law (22.36 a) --------------------------------------------------------------
  const houseD = Math.min(...site.house.map((h) => distanceBetween(h.outline, r)));
  const near = houseD <= 4;
  const houseH = Math.max(...site.house.map((h) => h.heightM ?? -1));
  const multiStorey = site.house.some((h) => (h.storeys ?? 0) > 1);
  add({
    id: "height-house",
    ruleId: near ? "ia-height-near-house" : "ia-height-far-from-house",
    group: "allowed-by-law",
    label: near ? "Height near the house" : "Height away from the house",
    outcome: near
      ? houseH < 0
        ? "unknown"
        : CARPORT_HEIGHT_M <= Math.min(5, houseH)
          ? "pass"
          : "fail"
      : "pass",
    detail: near
      ? houseH < 0
        ? "Within 4 m of the house, where the carport may not be higher than the house; the house height is not known."
        : `Within 4 m of the house: ${CARPORT_HEIGHT_M} m is below the house (${fmt(houseH)} m)${multiStorey ? ` and below the first floor + 0.3 m (first floor assumed at least ${ASSUMED_MIN_FIRST_FLOOR_M} m up)` : ""}.`
      : `More than 4 m from the house: ${CARPORT_HEIGHT_M} m is under the 3 m above which a pitched roof is required.`,
  });
  const area = checkAreaLimit(
    {
      backYardM2: prep.yardM2,
      outbuildingsM2: prep.existingAnnexM2,
      houseParts: [
        {
          id: "house",
          areaM2: prep.houseM2,
          status: site.extensionEvidence.length ? "unknown" : "original",
        },
      ],
      plannedM2: carportM2,
    },
    site.areaTable,
  );
  add({
    id: "area",
    ruleId: "ia-area-limit",
    group: "allowed-by-law",
    label: "Total annex area within the limit",
    outcome: q("buildings") !== "complete" || !yard.region.length ? "unknown" : area.outcome,
    detail:
      area.outcome === "unknown"
        ? `Room left: between ${fmt(Math.max(0, area.freeM2.worst))} and ${fmt(area.freeM2.best)} m², carport ${fmt(carportM2)} m². Whether part of the house is a later extension decides it: ${site.extensionEvidence.join("; ")}.`
        : `Back-yard area ${fmt(prep.yardM2)} m² allows annexes up to the area table; ${fmt(prep.existingAnnexM2)} m² already stands there (sheds, garages, canopies). Room left ${fmt(area.freeM2.best)} m², carport ${fmt(carportM2)} m².${site.extensionEvidence.length ? "" : " The house is taken as originally built: no permit (since 2010), register change or height-scan change shows an extension."}`,
  });
  const dwelling = site.house.some((h) => h.isDwelling);
  add({
    id: "at-house",
    ruleId: "ia-at-main-building",
    group: "allowed-by-law",
    label: "Belongs to a home",
    outcome: dwelling ? "pass" : "unknown",
    detail: dwelling
      ? "The main building is a registered home (BAG: woonfunctie)."
      : "The main building is not registered as a home.",
  });

  // --- Exclusions ----------------------------------------------------------------------------
  const ex = (id: string) => site.exclusions.find((e) => e.ruleId === id);
  const exOutcome = (id: string, appliesHere: (e: ExclusionResult) => boolean): CheckOutcome => {
    const e = ex(id);
    if (!e || e.state === "unknown") return "unknown";
    if (e.state === "clear") return "pass";
    if (e.state === "applies") return "fail";
    return appliesHere(e) ? "fail" : "pass";
  };
  const inZones = (e: ExclusionResult) =>
    (e.zones ?? []).some((z) => overlapM2(z, r) > 0.05 || contains(z, [pl.x, pl.y]));
  const exChecks: [string, string, (e: ExclusionResult) => boolean, "22.27" | "22.36" | "both"][] =
    [
      ["ex-monument-2227", "No monument", () => true, "22.27"],
      ["ex-village-view-2227", "No protected village view", () => true, "22.27"],
      ["ex-archaeology-2227", "Archaeology", (e) => carportM2 >= 50 && inZones(e), "22.27"],
      ["ex-monument-village-2236", "No monument or protected view", () => true, "22.36"],
      ["ex-safety-2236", "External safety", inZones, "22.36"],
    ];
  for (const [id, label, here] of exChecks) {
    const e = ex(id);
    add({
      id,
      ruleId: id,
      group: "exclusion",
      label,
      outcome: exOutcome(id, here),
      detail:
        e?.state === "depends-on-placement"
          ? id === "ex-archaeology-2227"
            ? carportM2 >= 50 && inZones(e)
              ? `${e.reason} This carport is ${fmt(carportM2)} m² and stands in the zone.`
              : `${e.reason} This carport is ${carportM2 < 50 ? `${fmt(carportM2)} m², under 50 m²` : "outside the zone"}.`
            : inZones(e)
              ? `${e.reason} This carport stands in it.`
              : `${e.reason} This carport stands outside it.`
          : (e?.reason ?? "Not evaluated."),
    });
  }

  // --- Freshness -----------------------------------------------------------------------------
  add({
    id: "freshness",
    group: "freshness",
    label: "Rules are the verified versions",
    outcome: !site.freshness.known
      ? "unknown"
      : site.freshness.staleRules.length
        ? "unknown"
        : "pass",
    detail: site.freshness.note,
  });

  return verdictFrom(checks, warnings, r, site, access);
}

function combine(outcomes: CheckOutcome[]): CheckOutcome {
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("unknown")) return "unknown";
  return "pass";
}

function verdictFrom(
  checks: CarportCheck[],
  warnings: CarportWarning[],
  outline: Polygon,
  site: CarportSite,
  access: CarAccess,
): CarportVerdict {
  const stale = new Set(site.freshness.staleRules);
  // A check whose rule is not the verified version can at best be unknown.
  for (const c of checks)
    if (c.ruleId && (stale.has(c.ruleId) || !site.freshness.known) && c.outcome === "pass")
      c.outcome = "unknown";
  const of = (g: CarportCheck["group"]) =>
    checks.filter((c) => c.group === g).map((c) => c.outcome);
  const exOf = (scope: string) =>
    checks.filter((c) => c.group === "exclusion" && c.id.endsWith(scope)).map((c) => c.outcome);
  const feasible = combine(of("feasible"));
  const technical = combine(of("technical"));
  const permitFree = combine([...of("permit-free"), ...exOf("2227"), technical]);
  const allowedByLaw = combine([...of("allowed-by-law"), ...exOf("2236")]);
  const fresh = combine(of("freshness"));

  let colour: CarportVerdict["colour"];
  let headline: string;
  if (feasible === "fail") {
    colour = "red";
    const failed = (id: string) => checks.some((c) => c.id === id && c.outcome === "fail");
    headline = failed("no-building")
      ? "Not possible here: a building is in the way"
      : failed("no-tree")
        ? "Not possible here: a tree would have to be felled"
        : failed("car-fit")
          ? "Not possible here: the car does not fit"
          : failed("car-route")
            ? "Not possible here: a car cannot drive in"
            : "Not possible here";
  } else if (
    feasible === "pass" &&
    permitFree === "pass" &&
    allowedByLaw === "pass" &&
    fresh === "pass"
  ) {
    colour = "green";
    headline = "Permit-free and allowed";
  } else {
    colour = "amber";
    const shrubs = checks.some((c) => c.id === "no-tree" && c.outcome === "unknown");
    headline =
      access.via === "new-exit" || access.via === "through-barrier"
        ? `Needs a new exit (exit permit)${access.via === "through-barrier" ? ", through the fence or hedge" : ""}${permitFree === "fail" ? " and a building permit" : ""}`
        : permitFree === "fail"
          ? "Possible with a building permit"
          : permitFree === "pass" && allowedByLaw === "fail"
            ? "No permit needed, but the old zoning plan decides whether it is allowed"
            : shrubs
              ? "Possibly permit-free; shrubs must be cleared"
              : feasible === "unknown"
                ? "Possibly permit-free; car access needs a check"
                : "Possibly permit-free; something needs a check";
  }
  return {
    colour,
    headline,
    feasible,
    permitFree,
    allowedByLaw,
    checks,
    warnings,
    outline,
    access,
  };
}

// ---------------------------------------------------------------------------------------------
// Car access for one placement
// ---------------------------------------------------------------------------------------------

export interface CarAccess {
  rect: CarportRect;
  fit: { fits: boolean; gapM: number };
  /** existing: through the existing exit; new-exit: across an open stretch of the street side
   *  (exit permit); probable: through the probable way in on a plot without a registered exit;
   *  unregistered: elsewhere from the street where no exit is registered; through-barrier:
   *  only through a hedge, fence or wall on the street side (open it, and a new exit);
   *  null: no way in. */
  via: "existing" | "probable" | "new-exit" | "unregistered" | "through-barrier" | null;
  bays: BayAccess[];
  /** The world the routes were found in (for driving out). */
  lattice: Lattice | null;
  /** What the car crosses on the street side (states of the plot-line pieces it drives over). */
  crossed: BoundaryState[];
  /** Low things in the way of the car body (cells of the height scan): shrubs and hedges that
   *  would have to go, and solid things (a parked car, a low wall, a shed) to check on site. */
  sweptShrubM2: number;
  sweptSolidM2: number;
  /** Low things (1–2.5 m) on public ground outside the plot the car would cross. */
  sweptPublicM2: number;
  /** Shrubs the person chose to clear that the car or carport would otherwise hit. */
  clearedM2: number;
}

/** Choices the person made on the plan. */
export interface EvaluateOptions {
  /** Ids of scanned shrubs on the plot they will clear. */
  cleared?: ReadonlySet<string>;
}

/** The carport as the vehicle planner sees it: cars park along its length, one or two bays. */
export function carportRect(pl: Placement, car: Car): CarportRect {
  const r = rectangle(pl);
  const across = pl.widthM;
  return {
    x0: r[0]![0],
    y0: r[0]![1],
    x1: r[2]![0],
    y1: r[2]![1],
    o: pl.rotation === 0 ? "ns" : "ew",
    bays: across >= 2 * (car.w + 2 * DOOR_GAP_M) ? 2 : 1,
  };
}

export function carAccess(
  prep: Prepared,
  pl: Placement,
  cleared: ReadonlySet<string> = new Set(),
): CarAccess {
  const { car, existing, any, opened } = prep.vehicle;
  const rect = carportRect(pl, car);
  const fit = parkingFit(car, rect, DOOR_GAP_M);
  const none = { crossed: [], sweptShrubM2: 0, sweptSolidM2: 0, sweptPublicM2: 0, clearedM2: 0 };
  if (!fit.fits) return { rect, fit, via: null, bays: [], lattice: null, ...none };
  const registered = prep.site.access.level === "registered";
  const tiers: [Lattice | null, CarAccess["via"]][] = [
    [existing, registered ? "existing" : "probable"],
    [any, registered ? "new-exit" : "unregistered"],
    [opened, "through-barrier"],
  ];
  let last: { bays: BayAccess[]; lattice: Lattice | null } = { bays: [], lattice: null };
  for (const [lattice, via] of tiers) {
    if (!lattice) continue;
    const bays = accessCarport(lattice, rect, false);
    if (bays.every((b) => b.route)) {
      const poses = bays.flatMap((b) => b.route!.poses);
      return {
        rect,
        fit,
        via,
        bays,
        lattice,
        crossed: crossedStates(prep.site, bays),
        ...sweptCells(prep.site, car, poses, cleared, via === "existing" || via === "probable"),
      };
    }
    last = { bays, lattice };
  }
  return { rect, fit, via: null, ...last, ...none };
}

/** States of the street-side plot-line pieces the routes cross. */
function crossedStates(site: CarportSite, bays: BayAccess[]): BoundaryState[] {
  if (!site.boundary) return [];
  const out = new Set<BoundaryState>();
  for (const b of bays)
    for (const p of b.route?.crossing ?? []) {
      let best: { d: number; s: BoundaryState } | null = null;
      for (const q of site.boundary) {
        if (q.side !== "street") continue;
        const d = distanceToSegment(p, q.a, q.b);
        if (d < 0.35 && (!best || d < best.d)) best = { d, s: q.state };
      }
      if (best) out.add(best.s);
    }
  return [...out];
}

/** Area of low scan cells (not trees) the car body passes over on the way in. */
function sweptCells(
  site: CarportSite,
  car: Car,
  poses: { x: number; y: number; a: number }[],
  cleared: ReadonlySet<string>,
  /** Through a way in that already exists: what stands outside it is not the person's concern. */
  existingWay = false,
): { sweptShrubM2: number; sweptSolidM2: number; sweptPublicM2: number; clearedM2: number } {
  type C = { at: Point; material: Material | null; id?: string; outside?: boolean };
  const cells: C[] = [
    ...(site.obstacles?.cells ?? []).filter((c) => !c.tree && c.heightM >= 1),
    ...(existingWay ? [] : (site.obstacles?.outside ?? []))
      .filter((c) => c.heightM >= 1 && c.heightM < TREE_M)
      .map((c) => ({ ...c, outside: true })),
  ];
  const zero = { sweptShrubM2: 0, sweptSolidM2: 0, sweptPublicM2: 0, clearedM2: 0 };
  if (!cells.length) return zero;
  const hit = new Set<number>();
  const R = Math.hypot((car.nose + car.ro) / 2, car.w / 2) + 0.3;
  for (let k = 0; k < poses.length; k += 2) {
    const p = poses[k]!;
    const cx = p.x + car.bodyC * Math.sin(p.a);
    const cy = p.y + car.bodyC * Math.cos(p.a);
    const sa = Math.sin(p.a);
    const ca = Math.cos(p.a);
    cells.forEach((c, i) => {
      if (hit.has(i)) return;
      const dx = c.at[0] - cx;
      const dy = c.at[1] - cy;
      if (dx * dx + dy * dy > R * R) return;
      // Along and across the car body.
      const u = dx * sa + dy * ca;
      const v = dx * ca - dy * sa;
      if (Math.abs(u) <= (car.nose + car.ro) / 2 && Math.abs(v) <= car.w / 2) hit.add(i);
    });
  }
  const m2 = (site.obstacles?.cellM ?? 0.5) ** 2;
  const out = { ...zero };
  for (const i of hit) {
    const c = cells[i]!;
    if (c.outside) out.sweptPublicM2 += m2;
    else if (c.material === "solid") out.sweptSolidM2 += m2;
    else if (c.id && cleared.has(c.id)) out.clearedM2 += m2;
    else out.sweptShrubM2 += m2;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    sweptShrubM2: r1(out.sweptShrubM2),
    sweptSolidM2: r1(out.sweptSolidM2),
    sweptPublicM2: r1(out.sweptPublicM2),
    clearedM2: r1(out.clearedM2),
  };
}

/** How the car in one bay leaves (reversing, turning where there is room). Null: not found. */
export function driveOut(access: CarAccess, bay: number): LeaveRoute | null {
  if (!access.lattice || !access.via) return null;
  return leaveCarport(access.lattice, access.rect, access.bays, bay);
}

// ---------------------------------------------------------------------------------------------
// Numbered options
// ---------------------------------------------------------------------------------------------

/** Checks whose outcome does not depend on where the carport stands (for the same size). */
export const POSITION_FREE = [
  "area",
  "at-house",
  "tech-height",
  "ex-monument-2227",
  "ex-village-view-2227",
  "ex-monument-village-2236",
];

export type CarportZone = "back" | "side" | "front";

export interface CarportOption {
  /** 1, 2, 3 ... in the order shown. */
  n: number;
  placement: Placement;
  verdict: CarportVerdict;
  zone: CarportZone;
}

const ZONE_ORDER: CarportZone[] = ["back", "side", "front"];

/**
 * Hand-picked placements for one size, like the MVP: positions every 0.5 m (1 m on large plots) in
 * both orientations are screened cheaply (on the plot, clear of buildings and trees, reachable),
 * then confirmed with the full evaluation, taking turns between the back yard, the side and the
 * front so the options differ. Never red: no spot that needs a tree felled or that a car cannot
 * reach. Green ones first, then those that need a permit, a new exit or a check.
 */
export function options(
  prep: Prepared,
  size: { widthM: number; lengthM: number },
  max = 6,
): CarportOption[] {
  const { site, grid: g, screen, yard } = prep;
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  const plotM2 = area(site.plot);
  const step = plotM2 > 3000 ? 1 : 0.5;
  const hasWorld = !!(prep.vehicle.existing || prep.vehicle.any || prep.vehicle.opened);
  const houseMinY = Math.min(...site.house.flatMap((h) => h.outline.map((p) => p[1])));
  // Zones where a rule exception depends on the position (archaeology from 50 m², safety zones):
  // spots outside them come first.
  const zones = site.exclusions
    .filter((e) => e.state === "depends-on-placement")
    .filter((e) => e.ruleId !== "ex-archaeology-2227" || size.widthM * size.lengthM >= 50)
    .flatMap((e) => e.zones ?? []);
  const zoneMask = new Uint8Array(g.nx * g.ny);
  for (const zz of zones) rasterize(zz, g, zoneMask);
  type Cand = { pl: Placement; score: number; zone: CarportZone };
  const queues: Record<CarportZone, Cand[]> = { back: [], side: [], front: [] };
  for (const rotation of [0, 90] as const) {
    const w = rotation === 0 ? size.widthM : size.lengthM;
    const h = rotation === 0 ? size.lengthM : size.widthM;
    const rE = rotation === 0 ? screen.reachExisting.ns : screen.reachExisting.ew;
    const rA = rotation === 0 ? screen.reachAny.ns : screen.reachAny.ew;
    for (let y = Math.min(...ys) + h / 2; y <= Math.max(...ys) - h / 2 + 1e-9; y += step)
      for (let x = Math.min(...xs) + w / 2; x <= Math.max(...xs) - w / 2 + 1e-9; x += step) {
        const i0 = Math.ceil((x - w / 2 - g.minX) / g.cell - 0.5);
        const i1 = Math.floor((x + w / 2 - g.minX) / g.cell - 0.5);
        const j0 = Math.ceil((y - h / 2 - g.minY) / g.cell - 0.5);
        const j1 = Math.floor((y + h / 2 - g.minY) / g.cell - 0.5);
        let ok = true;
        let reachE = Infinity;
        let reachA = Infinity;
        let allYard = true;
        let minPub = BIG;
        let shrubs = 0;
        let inZone = false;
        for (let j = j0; j <= j1 && ok; j++)
          for (let i = i0; i <= i1; i++) {
            const k = j * g.nx + i;
            if (!screen.onPlot[k] || screen.solid[k] || screen.obstacle[k] === 2) {
              ok = false;
              break;
            }
            reachE = Math.min(reachE, rE[k]!);
            reachA = Math.min(reachA, rA[k]!);
            if (!screen.yard[k]) allYard = false;
            minPub = Math.min(minPub, screen.publicM[k]!);
            shrubs += screen.obstacle[k]!;
            if (zoneMask[k]) inZone = true;
          }
        if (!ok) continue;
        const reach = Math.min(reachE, reachA);
        if (hasWorld && reach === Infinity) continue;
        const zone: CarportZone = allYard
          ? "back"
          : yard.frontLineY !== null
            ? y + h / 2 <= yard.frontLineY || y + h / 2 <= houseMinY
              ? "front"
              : "side"
            : "side";
        const pubOk = minPub - g.cell > 1;
        const score =
          (inZone ? 0 : 1.5e6) +
          (allYard ? 4e6 : 0) +
          (pubOk ? 2e6 : 0) +
          (reachE < Infinity ? 1e6 : 0) -
          shrubs * 1e3 -
          (reach < Infinity ? reach : 500);
        queues[zone].push({ pl: { x, y, rotation, ...size }, score, zone });
      }
  }
  for (const z of ZONE_ORDER) queues[z].sort((a, b) => b.score - a.score);
  const chosen: { c: Cand; v: CarportVerdict }[] = [];
  // Options are spread out: no overlap, and centres apart by at least the carport's diagonal or
  // an eighth of the plot's size, whichever is more.
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const apart = Math.max(Math.hypot(size.widthM, size.lengthM), diag / 8);
  const clash = (pl: Placement) => {
    const r = bboxOf(rectangle(pl));
    return chosen.some(({ c }) => {
      const o = bboxOf(rectangle(c.pl));
      const overlap =
        r.x0 < o.x1 + 0.5 && o.x0 < r.x1 + 0.5 && r.y0 < o.y1 + 0.5 && o.y0 < r.y1 + 0.5;
      return overlap || Math.hypot(pl.x - c.pl.x, pl.y - c.pl.y) < apart;
    });
  };
  // Full evaluations: at most 240 in all and 40 per zone per turn, so one zone full of spots the
  // car cannot reach does not use up the search for the others.
  let budget = 240;
  // One pick for a zone: among the next spots a car can reach (up to 8 that are not red), a green
  // one if there is any, else the best-scoring. Spots looked at but not picked go back in line.
  const next = (z: CarportZone): void => {
    const q = queues[z];
    let turn = 40;
    const seen: { c: Cand; v: CarportVerdict }[] = [];
    while (q.length && budget > 0 && turn-- > 0 && seen.length < 8) {
      // Stop early once a spot through an existing way in is found.
      const c = q.shift()!;
      if (clash(c.pl)) continue;
      budget--;
      const v = evaluate(prep, c.pl);
      if (v.colour === "red") continue;
      seen.push({ c, v });
      if (v.colour === "green" || v.access.via === "existing" || v.access.via === "probable") break;
    }
    if (!seen.length) return;
    const order = (v: CarportVerdict) =>
      (v.colour === "green" ? 0 : 10) +
      ({ existing: 0, probable: 1, "new-exit": 2, unregistered: 2, "through-barrier": 3 }[
        v.access.via ?? "through-barrier"
      ] ?? 4);
    const pick = seen.reduce((b, x) => (order(x.v) < order(b.v) ? x : b));
    chosen.push(pick);
    q.unshift(...seen.filter((x) => x !== pick).map((x) => x.c));
  };
  // Take turns between zones until enough options or nothing left.
  while (chosen.length < max && budget > 0 && ZONE_ORDER.some((z) => queues[z].length)) {
    for (const z of ZONE_ORDER) {
      if (chosen.length >= max) break;
      next(z);
    }
  }
  const rank = { green: 0, amber: 1, red: 2 } as const;
  // Among equals, a way in that already exists beats a new exit (people would rather not apply
  // for an exit permit), and a new exit beats breaking through a hedge or fence.
  const viaRank = (v: CarportVerdict) =>
    ({ existing: 0, probable: 1, "new-exit": 2, unregistered: 2, "through-barrier": 3 })[
      v.access.via ?? "through-barrier"
    ] ?? 4;
  return chosen
    .sort(
      (a, b) =>
        rank[a.v.colour] - rank[b.v.colour] ||
        viaRank(a.v) - viaRank(b.v) ||
        ZONE_ORDER.indexOf(a.c.zone) - ZONE_ORDER.indexOf(b.c.zone) ||
        b.c.score - a.c.score,
    )
    .map(({ c, v }, i) => ({ n: i + 1, placement: c.pl, verdict: v, zone: c.zone }));
}

/** The segment gate: homes where a carport check is not offered on its own. */
export function carportGate(houseType: string, otherHomesOnPlot: number): string | null {
  if (houseType === "unit")
    return "This home is a flat or unit in a shared building: building on the shared ground needs the other owners' agreement.";
  if (otherHomesOnPlot > 0)
    return "This plot is shared with other homes: building on it needs the other owners' agreement.";
  return null;
}
