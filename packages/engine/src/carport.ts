/**
 * Carport engine: can a carport of a given size stand at a given spot, and does it need a permit?
 *
 * Works in the plot's own frame (metres; street at the bottom, y pointing into the plot), so a
 * carport is an axis-aligned rectangle and the legal "front line" is horizontal. The site
 * builder (data layer) converts every register geometry into this frame.
 *
 * Two questions, kept apart and both shown:
 *  1. Feasible: on the plot, not on a building, and reachable by car from the plot's exit.
 *     A spot a car cannot reach is not feasible (decision of 2026-11-25).
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
  distanceBetween,
  distanceToSegment,
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

/** Fixed standard height of the presets (decision of 2026-11-25: no height dragging). */
export const CARPORT_HEIGHT_M = 2.5;

export const CARPORT_PRESETS = {
  single: { widthM: 3, lengthM: 5 },
  double: { widthM: 6, lengthM: 5 },
} as const;

export const CARPORT_LIMITS = { minWidthM: 2.5, maxWidthM: 9, minLengthM: 4, maxLengthM: 9 };

/** Car routing: the narrowest passage a car needs (gate or side path), in metres. */
export const ROUTE = { passageM: 2.3, comfortableM: 3, cellM: 0.25 };

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
    note: string;
  };
  /** Height-scan obstacle cells (local centres) with heights; null when unavailable. */
  obstacles: {
    cells: { at: Point; heightM: number; kind: string }[];
    cellM: number;
    scanYear?: number;
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
// Car routing on a grid
// ---------------------------------------------------------------------------------------------

export interface RouteGrid {
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  cell: number;
  /** Cell can hold the centre line of a car (enough room on both sides). */
  passable: Uint8Array;
  /** Steps from the nearest entry (Infinity: unreachable). */
  dist: Float32Array;
  /** Same, using only cells with room for a comfortable 3 m passage. */
  distWide: Float32Array;
  hasEntry: boolean;
}

/**
 * Where a car can drive: free ground on the plot (no building, no roofed structure), plus a band
 * just outside the entry stretches so the car can come in from the road. A cell is passable when
 * the nearest obstacle is at least half the passage width away; reachable cells are those
 * connected to an entry through passable cells.
 */
export function routeGrid(site: CarportSite, ignore: Polygon[] = []): RouteGrid {
  const cell = ROUTE.cellM;
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  const m = 4;
  const minX = Math.min(...xs) - m;
  const minY = Math.min(...ys) - m;
  const nx = Math.ceil((Math.max(...xs) + m - minX) / cell);
  const ny = Math.ceil((Math.max(...ys) + m - minY) / cell);
  const blocked = new Uint8Array(nx * ny);
  const solid = [
    ...site.house.map((h) => h.outline),
    ...site.buildings.map((b) => b.outline),
    ...site.structures.filter((s) => s.roofed).map((s) => s.outline),
  ].filter((p) => !ignore.includes(p));
  const gridDims = { minX, minY, nx, ny, cell };
  const plotMask = new Uint8Array(nx * ny);
  rasterize(site.plot, gridDims, plotMask);
  const solidMask = new Uint8Array(nx * ny);
  for (const x of solid) rasterize(x, gridDims, solidMask);
  const isEntry = new Uint8Array(nx * ny);
  // The band just outside each entry stretch (up to 3 m out), where a car comes from the road.
  for (const [a, b] of site.access.entries) {
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - 3 - minX) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + 3 - minX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - 3 - minY) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + 3 - minY) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (plotMask[k]) continue;
        const p: Point = [minX + (i + 0.5) * cell, minY + (j + 0.5) * cell];
        if (distanceToSegment(p, a, b) <= 3) isEntry[k] = 1;
      }
  }
  for (let k = 0; k < nx * ny; k++)
    blocked[k] = (plotMask[k] ? !solidMask[k] : isEntry[k] === 1) ? 0 : 1;
  // Distance to the nearest blocked cell (two-pass chamfer, in metres).
  const d = new Float32Array(nx * ny).fill(BIG);
  for (let k = 0; k < nx * ny; k++) if (blocked[k]) d[k] = 0;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0) d[k] = Math.min(d[k]!, d[k - 1]! + a);
      if (j > 0) d[k] = Math.min(d[k]!, d[k - nx]! + a);
      if (i > 0 && j > 0) d[k] = Math.min(d[k]!, d[k - nx - 1]! + b);
      if (i < nx - 1 && j > 0) d[k] = Math.min(d[k]!, d[k - nx + 1]! + b);
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i < nx - 1) d[k] = Math.min(d[k]!, d[k + 1]! + a);
      if (j < ny - 1) d[k] = Math.min(d[k]!, d[k + nx]! + a);
      if (i < nx - 1 && j < ny - 1) d[k] = Math.min(d[k]!, d[k + nx + 1]! + b);
      if (i > 0 && j < ny - 1) d[k] = Math.min(d[k]!, d[k + nx - 1]! + b);
    }
  const passable = new Uint8Array(nx * ny);
  const wide = new Uint8Array(nx * ny);
  // A cell next to an obstacle has distance one cell, so subtract half a cell for its centre.
  for (let k = 0; k < nx * ny; k++) {
    passable[k] = d[k]! - cell / 2 >= ROUTE.passageM / 2 ? 1 : 0;
    wide[k] = d[k]! - cell / 2 >= ROUTE.comfortableM / 2 ? 1 : 0;
  }
  const flood = (ok: Uint8Array) => {
    const dist = new Float32Array(nx * ny).fill(Infinity);
    const queue: number[] = [];
    for (let k = 0; k < nx * ny; k++)
      if (isEntry[k] && ok[k]) {
        dist[k] = 0;
        queue.push(k);
      }
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q]!;
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const kk = jj * nx + ii;
        if (!ok[kk] || dist[kk] !== Infinity) continue;
        dist[kk] = dist[k]! + 1;
        queue.push(kk);
      }
    }
    return { dist, any: queue.length > 0 };
  };
  const narrow = flood(passable);
  const comfy = flood(wide);
  return {
    minX,
    minY,
    nx,
    ny,
    cell,
    passable,
    dist: narrow.dist,
    distWide: comfy.dist,
    hasEntry: narrow.any,
  };
}

/** Shortest route (m) from an entry to a point inside the outline, or null if none. */
export function routeTo(grid: RouteGrid, outline: Polygon, wide = false): number | null {
  const field = wide ? grid.distWide : grid.dist;
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - grid.minX) / grid.cell));
  const i1 = Math.min(grid.nx - 1, Math.floor((Math.max(...xs) - grid.minX) / grid.cell));
  const j0 = Math.max(0, Math.floor((Math.min(...ys) - grid.minY) / grid.cell));
  const j1 = Math.min(grid.ny - 1, Math.floor((Math.max(...ys) - grid.minY) / grid.cell));
  let best = Infinity;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const k = j * grid.nx + i;
      const dd = field[k]!;
      if (dd >= best) continue;
      const p: Point = [grid.minX + (i + 0.5) * grid.cell, grid.minY + (j + 0.5) * grid.cell];
      if (contains(outline, p)) best = dd;
    }
  return Number.isFinite(best) ? best * grid.cell : null;
}

// ---------------------------------------------------------------------------------------------
// Evaluating one placement
// ---------------------------------------------------------------------------------------------

export interface Prepared {
  site: CarportSite;
  yard: BackYard;
  grid: RouteGrid;
  /** Per route-grid cell, for fast screening of many positions (confirmed by evaluate()). */
  screen: {
    onPlot: Uint8Array;
    solid: Uint8Array;
    yard: Uint8Array;
    obstacle: Uint8Array;
    /** Distance (m) to the nearest public-area cell. */
    publicM: Float32Array;
  };
  /** Annex area already standing in the back yard (sheds, garages, roofed canopies). */
  existingAnnexM2: number;
  yardM2: number;
  houseM2: number;
}

/** Heavy, placement-independent work, done once per plot. */
export function prepare(site: CarportSite): Prepared {
  const yard = backYard(site);
  const grid = routeGrid(site);
  const inYard = (p: Polygon) =>
    yard.region.reduce((s, part) => s + intersectionArea(part.outer, p), 0);
  const existingAnnexM2 =
    site.buildings.filter((b) => b.onPlot).reduce((s, b) => s + inYard(b.outline), 0) +
    site.structures.filter((s) => s.roofed).reduce((s, x) => s + inYard(x.outline), 0);
  return {
    site,
    yard,
    grid,
    screen: screening(site, yard, grid),
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

function screening(site: CarportSite, yard: BackYard, g: RouteGrid): Prepared["screen"] {
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
  for (const c of site.obstacles?.cells ?? []) {
    if (c.heightM < 1) continue;
    const i = Math.floor((c.at[0] - g.minX) / g.cell);
    const j = Math.floor((c.at[1] - g.minY) / g.cell);
    const r = Math.max(0, Math.round((site.obstacles!.cellM / g.cell - 1) / 2));
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < g.nx && jj < g.ny) obstacle[jj * g.nx + ii] = 1;
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
  return { onPlot, solid, yard: inYard, obstacle, publicM };
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

export function evaluate(prep: Prepared, pl: Placement): CarportVerdict {
  const { site, yard, grid } = prep;
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
  const route = routeTo(grid, r);
  const accessOutcome: CheckOutcome =
    site.access.level === "none" || !grid.hasEntry
      ? "unknown"
      : route === null
        ? "fail"
        : site.access.level === "registered"
          ? "pass"
          : "unknown";
  add({
    id: "car-route",
    group: "feasible",
    label: "A car can drive in",
    outcome: accessOutcome,
    detail:
      site.access.level === "none" || !grid.hasEntry
        ? `No way onto the plot was found for a car. ${site.access.note}`
        : route === null
          ? `No route of at least ${ROUTE.passageM} m wide leads from the plot's way in to this spot (the house or other buildings are in the way).`
          : site.access.level === "registered"
            ? route < 1
              ? "Right at the registered exit."
              : `About ${Math.round(route)} m from the registered exit, with at least ${ROUTE.passageM} m of room all the way.`
            : `A ${ROUTE.passageM} m wide route exists (about ${Math.round(route)} m), but the way onto the plot is not a registered exit: ${site.access.note}`,
  });
  if (route !== null && routeTo(grid, r, true) === null)
    warnings.push({
      id: "narrow-route",
      text: `The only way for a car is a passage under ${ROUTE.comfortableM} m wide (at least ${ROUTE.passageM} m). Fences, gates and hedges are not in the public registers: check on site that nothing blocks it.`,
    });
  const struct = site.structures.filter((s) => overlapM2(s.outline, r) > 0.05);
  if (struct.length)
    warnings.push({
      id: "structure",
      text: `Stands on ${struct.map((s) => s.label).join(", ")}: it would have to be removed or replaced.`,
    });
  if (site.obstacles) {
    const inside = site.obstacles.cells.filter((c) => c.heightM >= 1 && contains(r, c.at));
    if (inside.length) {
      const top = Math.max(...inside.map((c) => c.heightM));
      const overhang = inside.some((c) => c.kind === "overhang");
      const m2 = inside.length * site.obstacles.cellM ** 2;
      warnings.push({
        id: "obstacle",
        text: `${fmt(m2)} m² of vegetation or objects up to ${fmt(top)} m high stands here (laser scan ${site.obstacles.scanYear ?? ""}). ${overhang ? "Part is a neighbour's tree hanging over: trimming needs care and may need their agreement. " : ""}A tree would have to go; check whether felling needs a permit (Woensdrecht protects valuable trees).`,
      });
    }
  }

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

  return verdictFrom(checks, warnings, r, site);
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
    headline = "Not possible here";
  } else if (permitFree === "fail") {
    colour = "red";
    headline = "Permit needed";
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
    headline =
      permitFree === "pass" && allowedByLaw === "fail"
        ? "No permit needed, but the old zoning plan decides whether it is allowed"
        : feasible === "unknown"
          ? "Possibly permit-free; car access needs a check"
          : "Possibly permit-free; something needs a check";
  }
  return { colour, headline, feasible, permitFree, allowedByLaw, checks, warnings, outline };
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

export interface Suggestion {
  placement: Placement;
  verdict: CarportVerdict;
  routeM: number | null;
}

/**
 * Searches positions for one size (both orientations) over the plot, every 0.5 m (coarser on
 * very large plots). Best = green before amber before red; then no obstacle warnings; then the shortest
 * drive from the exit. Also returns every centre where the carport would be green ("heat").
 */
export function suggest(
  prep: Prepared,
  size: { widthM: number; lengthM: number },
  stepM = 0.5,
): { best: Suggestion | null; green: { x: number; y: number; rotation: 0 | 90 }[] } {
  const { site, grid: g, screen } = prep;
  const xs = site.plot.map((p) => p[0]);
  const ys = site.plot.map((p) => p[1]);
  type Cand = { pl: Placement; score: number; likelyGreen: boolean };
  const cands: Cand[] = [];
  for (const rotation of [0, 90] as const) {
    const w = rotation === 0 ? size.widthM : size.lengthM;
    const h = rotation === 0 ? size.lengthM : size.widthM;
    for (let y = Math.min(...ys) + h / 2; y <= Math.max(...ys) - h / 2 + 1e-9; y += stepM)
      for (let x = Math.min(...xs) + w / 2; x <= Math.max(...xs) - w / 2 + 1e-9; x += stepM) {
        // Cells whose centre lies inside the rectangle.
        const i0 = Math.ceil((x - w / 2 - g.minX) / g.cell - 0.5);
        const i1 = Math.floor((x + w / 2 - g.minX) / g.cell - 0.5);
        const j0 = Math.ceil((y - h / 2 - g.minY) / g.cell - 0.5);
        const j1 = Math.floor((y + h / 2 - g.minY) / g.cell - 0.5);
        let ok = true;
        let reach = Infinity;
        let allYard = true;
        let minPub = BIG;
        let obstacles = 0;
        for (let j = j0; j <= j1 && ok; j++)
          for (let i = i0; i <= i1; i++) {
            const k = j * g.nx + i;
            if (!screen.onPlot[k] || screen.solid[k]) {
              ok = false;
              break;
            }
            if (g.dist[k]! < reach) reach = g.dist[k]!;
            if (!screen.yard[k]) allYard = false;
            if (screen.publicM[k]! < minPub) minPub = screen.publicM[k]!;
            obstacles += screen.obstacle[k]!;
          }
        if (!ok) continue;
        if (g.hasEntry && !Number.isFinite(reach)) continue; // a car cannot get there
        const pubOk = minPub - g.cell > 1;
        const likelyGreen = allYard && pubOk && Number.isFinite(reach);
        const score =
          (allYard ? 4e6 : 0) +
          (pubOk ? 2e6 : 0) -
          obstacles * 1e3 -
          (Number.isFinite(reach) ? reach * g.cell : 500);
        cands.push({ pl: { x, y, rotation, ...size }, score, likelyGreen });
      }
  }
  if (!cands.length) return { best: null, green: [] };
  // Confirm the most promising positions with the full evaluation.
  cands.sort((a, b) => b.score - a.score);
  const rank = { green: 2, amber: 1, red: 0 } as const;
  let best: Suggestion | null = null;
  let bestScore = -Infinity;
  for (const c of cands.slice(0, 25)) {
    const v = evaluate(prep, c.pl);
    if (v.feasible === "fail") continue;
    const routeM = routeTo(g, v.outline);
    const score =
      rank[v.colour] * 1e9 - v.checks.filter((x) => x.outcome !== "pass").length * 1e7 + c.score;
    if (score > bestScore) {
      bestScore = score;
      best = { placement: c.pl, verdict: v, routeM };
    }
  }
  // Heat: positions the screening finds in the back yard, clear of public area and reachable, and
  // clear of placement-dependent exclusion zones — shown when nothing independent of position
  // (area limit, monuments, ...) already rules permit-free out. A guide only: a placed carport is
  // always fully evaluated.
  const zones = site.exclusions
    .filter((e) => e.state === "depends-on-placement")
    .filter((e) => e.ruleId !== "ex-archaeology-2227" || size.widthM * size.lengthM >= 50)
    .flatMap((e) => e.zones ?? []);
  const green =
    best && best.verdict.permitFree !== "fail" && best.verdict.allowedByLaw !== "fail"
      ? cands
          .filter((c) => c.likelyGreen)
          .filter((c) => !zones.some((z) => overlapM2(z, rectangle(c.pl)) > 0.05))
          .map((c) => ({ x: c.pl.x, y: c.pl.y, rotation: c.pl.rotation }))
      : [];
  return { best, green };
}

/** The segment gate: homes where a carport check is not offered on its own. */
export function carportGate(houseType: string, otherHomesOnPlot: number): string | null {
  if (houseType === "unit")
    return "This home is a flat or unit in a shared building: building on the shared ground needs the other owners' agreement.";
  if (otherHomesOnPlot > 0)
    return "This plot is shared with other homes: building on it needs the other owners' agreement.";
  return null;
}
