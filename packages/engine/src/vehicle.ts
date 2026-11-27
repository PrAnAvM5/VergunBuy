/**
 * Vehicle access: can a car drive into a carport bay, and how does it leave?
 *
 * Port of the MVP front end's swept-path engine (apps/web/legacy/engine.js) to real plots:
 *  - the car is a rectangle (default 1.8 × 4.5 m) that keeps a clearance (default 0.5 m) from
 *    every obstacle with its whole body; at full lock its outer corner sweeps a fixed radius
 *    (default 6.5 m), which sets the turning radius of the rear axle;
 *  - motion is planned on a 0.5 m lattice with 8 headings; a 45° turn is a circular arc at the
 *    minimum turning radius joined by short straights so that it ends on the lattice;
 *  - the car comes in from the road straight through a way in ("gate") and may only start turning
 *    once its rear axle is on the plot; it must be straight and lined up before its nose enters
 *    the bay; short S-bends allow a sideways shift of 0.5–2.5 m just before the line-up;
 *  - the carport's posts and a car parked in the other bay are obstacles too;
 *  - leaving: reverse out of the bay, and where there is room turn and drive forward to the road
 *    (with gear changes, like a three-point turn), staying on the driveway.
 *
 * Obstacles come from the registers and the laser scan, in the plot's own frame (street at the
 * bottom): everything outside the plot except the road side of the gates, buildings, registered
 * structures, and trees or tall objects (by default 2.5 m and higher, whole crown).
 *
 * Collision test: the car body grown by the clearance is a rotated rectangle; it is free when no
 * blocked grid cell has its centre inside it. With per-row prefix sums that is one lookup per grid
 * row, so the test is exact up to the grid cell (0.2 m).
 */
import { contains, distanceToSegment, type Point, type Polygon } from "./geometry.ts";

export interface VehicleParams {
  widthM: number;
  lengthM: number;
  /** Radius swept by the outer front corner at full lock. */
  outerRadiusM: number;
  /** Free space kept around the whole body. */
  clearanceM: number;
}

export const DEFAULT_VEHICLE: VehicleParams = {
  widthM: 1.8,
  lengthM: 4.5,
  // A typical hatchback at walking pace (about 10.5–11 m kerb to kerb), decision 2026-11-26.
  outerRadiusM: 6,
  clearanceM: 0.3,
};

export interface Car {
  w: number;
  l: number;
  /** Rear axle to front (wheelbase + front overhang) and rear overhang. */
  nose: number;
  ro: number;
  clr: number;
  /** Turning radius of the rear-axle centre. */
  rt: number;
  /** Rear axle to the centre of the body. */
  bodyC: number;
  params: VehicleParams;
}

export function carOf(p: VehicleParams): Car {
  const wb = 0.6 * p.lengthM;
  const fo = 0.2 * p.lengthM;
  const ro = 0.2 * p.lengthM;
  const nose = wb + fo;
  const rt = Math.max(2.5, Math.sqrt(Math.max(0, p.outerRadiusM ** 2 - nose ** 2)) - p.widthM / 2);
  return {
    w: p.widthM,
    l: p.lengthM,
    nose,
    ro,
    clr: p.clearanceM,
    rt,
    bodyC: (nose - ro) / 2,
    params: p,
  };
}

export interface Pose {
  /** Rear-axle centre (local metres). */
  x: number;
  y: number;
  /** Heading: 0 = +y (away from the street), clockwise, radians. */
  a: number;
  /** Driving backwards on this sample. */
  rev?: boolean;
}

const EPS = 1e-6;
const GS = 0.5;
const Q45 = Math.PI / 4;
const C45 = Math.SQRT1_2;
const TURNPEN = 1.5;
/** Most 45° turns on the way in: two full U-turns' worth, so loops in a big garden are found. */
const MAXTURN = 8;
const HEADA = (h: number) => h * Q45;

export function carCorners(car: Car, x: number, y: number, a: number, grow = 0): number[] {
  const s = Math.sin(a);
  const c = Math.cos(a);
  const u0 = -car.ro - grow;
  const u1 = car.nose + grow;
  const v = car.w / 2 + grow;
  return [
    x + u0 * s - v * c,
    y + u0 * c + v * s,
    x + u1 * s - v * c,
    y + u1 * c + v * s,
    x + u1 * s + v * c,
    y + u1 * c - v * s,
    x + u0 * s + v * c,
    y + u0 * c - v * s,
  ];
}

// ---------------------------------------------------------------------------------------------
// The world: blocked cells, gates, and the collision test
// ---------------------------------------------------------------------------------------------

export interface Gate {
  a: Point;
  b: Point;
  /** "existing": a registered driveway exit; "frontage": a stretch where a new exit could go. */
  kind: "existing" | "frontage";
}

export interface WorldInput {
  plot: Polygon;
  /** Solid obstacles (buildings, structures). */
  solids: Polygon[];
  /** Laser-scan cells (local centres) and their size; `blocks`: part of a tree's crown (2.5 m+). */
  scan: { at: Point; blocks: boolean }[];
  scanCellM: number;
  gates: Gate[];
  /**
   * The street as it really is: road surfaces a car may drive on, and objects in the street it
   * must miss (lamp posts, poles, cabinets, street-tree trunks). With it, the car comes along the
   * road from either side, crosses the pavement or verge only straight in front of a gate, and
   * may turn anywhere on the road. Without it, the old model: a straight strip out from each gate.
   */
  road?:
    | {
        drivable: Polygon[];
        blockers: Polygon[];
        /** Cycle paths and lanes: a car may swing over them only close to a gate, to turn in. */
        crossable?: Polygon[];
        /** All public ground (pavement, verges, green): the car's body may overhang its edge. */
        soft?: Polygon[];
        /** Street-tree trunks: the paved crossing of a new exit keeps EXIT_TREE_M from them. */
        trees?: Point[];
      }
    | undefined;
}

export interface World {
  plot: Polygon;
  /** True when the real road surface is known (see WorldInput.road). */
  roadMode: boolean;
  /** Per gate: how far out the road surface starts (m), in road mode. */
  apron: number[];
  drivable: Polygon[];
  /** Road mode: cells on a road surface (not cycle path, pavement or verge), free of objects. */
  roadCell: Uint8Array | null;
  cell: number;
  minX: number;
  minY: number;
  nx: number;
  ny: number;
  blocked: Uint8Array;
  /** Per row, prefix sums of blocked cells (length nx + 1 per row). */
  pre: Int32Array;
  gates: Gate[];
  /** Lattice: node (i, j) is at (i0 + i, j0 + j) × GS. */
  i0: number;
  j0: number;
  NI: number;
  NJ: number;
}

/** Depth of the road strip in front of a gate where the car approaches from. */
const CORRIDOR_M = 11;
const START_OUT_M = 9;
/** How far the road is opened along the street beyond each gate, for leaving. */
const ROAD_ALONG_M = 10;
/** Road mode: how much street around the plot is part of the world. */
const ROAD_MARGIN_M = 20;
/** Road mode: the farthest the road surface may lie beyond a gate (pavement plus verge). */
const APRON_MAX_M = 8;
/** Road mode: how much wider a crossing is at the road than at the gate, each side (m). */
const APRON_FLARE_M = 2.5;
/** Road mode: how far along the street from a gate a car may swing over a cycle path to turn in. */
const SWING_M = 6;
/** Road mode: how far a car's body may overhang the kerb onto pavement or verge (m). */
const OVERHANG_M = 0.5;
/** Least distance (m) from a new exit's paved crossing to the outside of a street-tree trunk. */
export const EXIT_TREE_M = 1.5;
/** Assumed trunk radius (m): the register gives a point, not a trunk width. */
export const TRUNK_R = 0.25;

function inwardNormal(plot: Polygon, a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let n: Point = [-dy / len, dx / len];
  const mid: Point = [(a[0] + b[0]) / 2 + n[0] * 0.3, (a[1] + b[1]) / 2 + n[1] * 0.3];
  if (!contains(plot, mid)) n = [-n[0], -n[1]];
  return n;
}

function fillPolygon(
  poly: Polygon,
  w: { minX: number; minY: number; nx: number; ny: number; cell: number },
  out: Uint8Array,
  value: 0 | 1,
): void {
  const ys = poly.map((p) => p[1]);
  const j0 = Math.max(0, Math.ceil((Math.min(...ys) - w.minY) / w.cell - 0.5));
  const j1 = Math.min(w.ny - 1, Math.floor((Math.max(...ys) - w.minY) / w.cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = w.minY + (j + 0.5) * w.cell;
    xs.length = 0;
    for (let e = 0; e < poly.length; e++) {
      const p = poly[e]!;
      const q = poly[(e + 1) % poly.length]!;
      if (p[1] > y !== q[1] > y) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - w.minX) / w.cell - 0.5));
      const i1 = Math.min(w.nx - 1, Math.floor((xs[k + 1]! - w.minX) / w.cell - 0.5));
      for (let i = i0; i <= i1; i++) out[j * w.nx + i] = value;
    }
  }
}

export function buildWorld(input: WorldInput): World {
  const xs = input.plot.map((p) => p[0]);
  const ys = input.plot.map((p) => p[1]);
  const roadMode = !!input.road && input.road.drivable.length > 0;
  const m = roadMode ? ROAD_MARGIN_M : CORRIDOR_M + 2;
  const span =
    (Math.max(...xs) - Math.min(...xs) + 2 * m) * (Math.max(...ys) - Math.min(...ys) + 2 * m);
  const cell = span > 40000 ? 0.25 : 0.2;
  const minX = Math.floor((Math.min(...xs) - m) / GS) * GS;
  const minY = Math.floor((Math.min(...ys) - m) / GS) * GS;
  const nx = Math.ceil((Math.max(...xs) + m - minX) / cell);
  const ny = Math.ceil((Math.max(...ys) + m - minY) / cell);
  const dims = { minX, minY, nx, ny, cell };
  // Start with everything blocked, open the plot, then the ways out to the street.
  const blocked = new Uint8Array(nx * ny).fill(1);
  fillPolygon(input.plot, dims, blocked, 0);
  const apron: number[] = [];
  const drivable = roadMode ? input.road!.drivable : [];
  if (roadMode) for (const d of drivable) fillPolygon(d, dims, blocked, 0);
  for (const g of input.gates) {
    const n = inwardNormal(input.plot, g.a, g.b);
    // Road mode: the strip straight out from the gate across the pavement or verge, to where the
    // road surface starts (found by looking out from both ends and the middle of the gate).
    let depth = CORRIDOR_M;
    if (roadMode) {
      depth = 0;
      for (const t of [0.15, 0.5, 0.85]) {
        const p: Point = [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t];
        let d = 0;
        while (
          d <= APRON_MAX_M &&
          !drivable.some((r) => contains(r, [p[0] - n[0] * d, p[1] - n[1] * d]))
        )
          d += 0.25;
        depth = Math.max(depth, d > APRON_MAX_M ? CORRIDOR_M : d + 0.75);
      }
    }
    apron.push(depth);
    // In road mode the crossing widens towards the road, like the sloped kerb of a real
    // driveway crossing, so a car can swing in from the road.
    const len0 = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
    const tt: Point = [(g.b[0] - g.a[0]) / len0, (g.b[1] - g.a[1]) / len0];
    // A new exit's crossing (flare included) keeps EXIT_TREE_M from a street-tree trunk.
    const trees = g.kind === "existing" ? [] : (input.road?.trees ?? []);
    const flareFor = (from: Point, sign: number) => {
      let f = roadMode ? Math.min(APRON_FLARE_M, depth * 2) : 0;
      for (; f > 0; f -= 0.5) {
        const far: Point = [
          from[0] - n[0] * depth + tt[0] * f * sign,
          from[1] - n[1] * depth + tt[1] * f * sign,
        ];
        if (trees.every((t) => distanceToSegment(t, from, far) >= EXIT_TREE_M + TRUNK_R)) break;
      }
      return Math.max(0, f);
    };
    const flA = flareFor(g.a, -1);
    const flB = flareFor(g.b, 1);
    const corridor: Polygon = [
      g.a,
      g.b,
      [g.b[0] - n[0] * depth + tt[0] * flB, g.b[1] - n[1] * depth + tt[1] * flB],
      [g.a[0] - n[0] * depth - tt[0] * flA, g.a[1] - n[1] * depth - tt[1] * flA],
    ];
    fillPolygon(corridor, dims, blocked, 0);
    if (roadMode) continue;
    // Old model: the road along the street on both sides of the gate (from 2 m out), where a car
    // leaving can turn to drive off along the street.
    const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
    const t: Point = [(g.b[0] - g.a[0]) / len, (g.b[1] - g.a[1]) / len];
    const A: Point = [g.a[0] - t[0] * ROAD_ALONG_M, g.a[1] - t[1] * ROAD_ALONG_M];
    const B: Point = [g.b[0] + t[0] * ROAD_ALONG_M, g.b[1] + t[1] * ROAD_ALONG_M];
    const road: Polygon = [
      [A[0] - n[0] * 2, A[1] - n[1] * 2],
      [B[0] - n[0] * 2, B[1] - n[1] * 2],
      [B[0] - n[0] * CORRIDOR_M, B[1] - n[1] * CORRIDOR_M],
      [A[0] - n[0] * CORRIDOR_M, A[1] - n[1] * CORRIDOR_M],
    ];
    fillPolygon(road, dims, blocked, 0);
  }
  if (roadMode && input.road!.crossable?.length) {
    // Turning space: cycle paths and lanes within a few metres along the street of each gate.
    const swing = new Uint8Array(nx * ny);
    const cyc = new Uint8Array(nx * ny);
    input.gates.forEach((g, gi) => {
      const n = inwardNormal(input.plot, g.a, g.b);
      const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
      const t: Point = [(g.b[0] - g.a[0]) / len, (g.b[1] - g.a[1]) / len];
      const A: Point = [g.a[0] - t[0] * SWING_M, g.a[1] - t[1] * SWING_M];
      const B: Point = [g.b[0] + t[0] * SWING_M, g.b[1] + t[1] * SWING_M];
      const d = (apron[gi] ?? 0) + SWING_M;
      fillPolygon(
        [A, B, [B[0] - n[0] * d, B[1] - n[1] * d], [A[0] - n[0] * d, A[1] - n[1] * d]],
        dims,
        swing,
        1,
      );
    });
    for (const c of input.road!.crossable!) fillPolygon(c, dims, cyc, 1);
    for (let k = 0; k < blocked.length; k++) if (swing[k] && cyc[k]) blocked[k] = 0;
  }
  if (roadMode && input.road!.soft?.length) {
    // A kerb is not a wall: bumpers and mirrors may overhang the pavement or verge next to the
    // road a little, never private ground.
    const soft = new Uint8Array(nx * ny);
    for (const p of input.road!.soft!) fillPolygon(p, dims, soft, 1);
    const onPlotCell = new Uint8Array(nx * ny);
    fillPolygon(input.plot, dims, onPlotCell, 1);
    const road = new Uint8Array(nx * ny);
    for (let k = 0; k < road.length; k++) road[k] = !blocked[k] && !onPlotCell[k] ? 1 : 0;
    const r = Math.ceil((OVERHANG_M - 1e-9) / cell);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        if (!blocked[k] || !soft[k] || onPlotCell[k]) continue;
        search: for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= nx || yy >= ny || dx * dx + dy * dy > r * r) continue;
            if (road[yy * nx + xx]) {
              blocked[k] = 0;
              break search;
            }
          }
      }
  }
  if (roadMode) for (const b of input.road!.blockers) fillPolygon(b, dims, blocked, 1);
  let roadCell: Uint8Array | null = null;
  if (roadMode) {
    roadCell = new Uint8Array(nx * ny);
    for (const d of drivable) fillPolygon(d, dims, roadCell, 1);
    for (let k = 0; k < roadCell.length; k++) if (blocked[k]) roadCell[k] = 0;
  }

  for (const s of input.solids) fillPolygon(s, dims, blocked, 1);
  // Tree crowns inside the plot (the whole crown of anything 2.5 m or higher).
  const half = input.scanCellM / 2;
  for (const c of input.scan) {
    if (!c.blocks) continue;
    fillPolygon(
      [
        [c.at[0] - half, c.at[1] - half],
        [c.at[0] + half, c.at[1] - half],
        [c.at[0] + half, c.at[1] + half],
        [c.at[0] - half, c.at[1] + half],
      ],
      dims,
      blocked,
      1,
    );
  }
  const pre = new Int32Array((nx + 1) * ny);
  for (let j = 0; j < ny; j++) {
    let acc = 0;
    for (let i = 0; i < nx; i++) {
      pre[j * (nx + 1) + i] = acc;
      acc += blocked[j * nx + i]!;
    }
    pre[j * (nx + 1) + nx] = acc;
  }
  const i0 = Math.round(minX / GS);
  const j0 = Math.round(minY / GS);
  return {
    plot: input.plot,
    roadMode,
    apron,
    drivable,
    roadCell,
    cell,
    minX,
    minY,
    nx,
    ny,
    blocked,
    pre,
    gates: input.gates,
    i0,
    j0,
    NI: Math.floor((nx * cell) / GS),
    NJ: Math.floor((ny * cell) / GS),
  };
}

/** True when no blocked cell centre lies inside the convex quad (corners as flat array). */
export function quadFree(w: World, cc: number[]): boolean {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 1; k < 8; k += 2) {
    y0 = Math.min(y0, cc[k]!);
    y1 = Math.max(y1, cc[k]!);
  }
  const j0 = Math.max(0, Math.ceil((y0 - w.minY) / w.cell - 0.5));
  const j1 = Math.min(w.ny - 1, Math.floor((y1 - w.minY) / w.cell - 0.5));
  if (j0 > j1) return true;
  for (let j = j0; j <= j1; j++) {
    const y = w.minY + (j + 0.5) * w.cell;
    let xl = Infinity;
    let xr = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      const ax = cc[k]!;
      const ay = cc[k + 1]!;
      const bx = cc[(k + 2) % 8]!;
      const by = cc[(k + 3) % 8]!;
      if (ay > y !== by > y) {
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    if (xl > xr) continue;
    const i0 = Math.max(0, Math.ceil((xl - w.minX) / w.cell - 0.5));
    const i1 = Math.min(w.nx - 1, Math.floor((xr - w.minX) / w.cell - 0.5));
    if (i0 > i1) continue;
    const row = j * (w.nx + 1);
    if (w.pre[row + i1 + 1]! - w.pre[row + i0]! > 0) return false;
  }
  return true;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: string;
}

/** Separating-axis test: car (uninflated) against an axis-aligned rectangle. */
function boxHit(car: Car, cc: number[], x: number, y: number, a: number, b: Rect): boolean {
  let mnx = Infinity;
  let mxx = -Infinity;
  let mny = Infinity;
  let mxy = -Infinity;
  for (let k = 0; k < 8; k += 2) {
    mnx = Math.min(mnx, cc[k]!);
    mxx = Math.max(mxx, cc[k]!);
    mny = Math.min(mny, cc[k + 1]!);
    mxy = Math.max(mxy, cc[k + 1]!);
  }
  if (mxx <= b.x0 + EPS || mnx >= b.x1 - EPS || mxy <= b.y0 + EPS || mny >= b.y1 - EPS)
    return false;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const bx = [b.x0, b.x1, b.x1, b.x0];
  const by = [b.y0, b.y0, b.y1, b.y1];
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 4; k++) {
    const p = bx[k]! * s + by[k]! * c;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const ad = x * s + y * c;
  if (hi <= ad - car.ro + EPS || lo >= ad + car.nose - EPS) return false;
  lo = Infinity;
  hi = -Infinity;
  for (let k = 0; k < 4; k++) {
    const p = bx[k]! * c - by[k]! * s;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const ar = x * c - y * s;
  if (hi <= ar - car.w / 2 + EPS || lo >= ar + car.w / 2 - EPS) return false;
  return true;
}

export interface Dyn {
  rects: Rect[];
  bb: { x0: number; y0: number; x1: number; y1: number };
}

function dynOf(rects: Rect[]): Dyn | null {
  if (!rects.length) return null;
  return {
    rects,
    bb: {
      x0: Math.min(...rects.map((q) => q.x0)),
      y0: Math.min(...rects.map((q) => q.y0)),
      x1: Math.max(...rects.map((q) => q.x1)),
      y1: Math.max(...rects.map((q) => q.y1)),
    },
  };
}

function dynHitWhich(car: Car, dyn: Dyn | null, x: number, y: number, a: number): Rect | null {
  if (!dyn) return null;
  const cx = x + car.bodyC * Math.sin(a);
  const cy = y + car.bodyC * Math.cos(a);
  const R = Math.hypot((car.nose + car.ro) / 2, car.w / 2) + 0.05;
  if (cx + R < dyn.bb.x0 || cx - R > dyn.bb.x1 || cy + R < dyn.bb.y0 || cy - R > dyn.bb.y1)
    return null;
  let cc: number[] | null = null;
  for (const b of dyn.rects) {
    if (cx + R < b.x0 || cx - R > b.x1 || cy + R < b.y0 || cy - R > b.y1) continue;
    cc ??= carCorners(car, x, y, a);
    if (boxHit(car, cc, x, y, a, b)) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Motion primitives
// ---------------------------------------------------------------------------------------------

type Seg = { S: number } | { A: number };

function walk(rt: number, p: Pose, segs: Seg[], step = 0.25): Pose[] {
  const out: Pose[] = [];
  let { x, y, a } = p;
  for (const sg of segs) {
    if ("S" in sg) {
      if (sg.S < 1e-9) continue;
      const n = Math.max(1, Math.ceil(sg.S / step));
      const dx = (Math.sin(a) * sg.S) / n;
      const dy = (Math.cos(a) * sg.S) / n;
      for (let i = 0; i < n; i++) {
        x += dx;
        y += dy;
        out.push({ x, y, a });
      }
    } else {
      const ang = sg.A;
      const sgn = Math.sign(ang);
      const n = Math.max(1, Math.ceil((Math.abs(ang) * rt) / step));
      const a0 = a;
      const cx = x + sgn * rt * Math.cos(a0);
      const cy = y - sgn * rt * Math.sin(a0);
      for (let i = 1; i <= n; i++) {
        const na = a0 + (ang * i) / n;
        x = cx - sgn * rt * Math.cos(na);
        y = cy + sgn * rt * Math.sin(na);
        a = na;
        out.push({ x, y, a });
      }
    }
  }
  return out;
}

interface Prim {
  di: number;
  dj: number;
  dh: number;
  samples: Pose[];
  cost: number;
  len: number;
  bb: { x0: number; y0: number; x1: number; y1: number };
}

/** Lattice primitives for one car: per heading, straight, 45° left and 45° right. */
function primitives(car: Car): Prim[][] {
  const rt = car.rt;
  // A 45° turn from N ends at (a, b): a ≥ rt(1 − cos45), b ≥ rt·sin45 + s2·cos45, on the lattice.
  const a = Math.ceil((rt * (1 - C45)) / GS - 1e-9) * GS;
  const s2 = (a - rt * (1 - C45)) / C45;
  const b = Math.ceil((rt * C45 + s2 * C45) / GS - 1e-9) * GS;
  const s1 = b - rt * C45 - s2 * C45;
  const base: { segs: Seg[]; dh: number }[][] = [
    [
      { segs: [{ S: GS }], dh: 0 },
      { segs: [{ S: s1 }, { A: Q45 }, { S: s2 }], dh: 1 },
      { segs: [{ S: s1 }, { A: -Q45 }, { S: s2 }], dh: -1 },
    ],
    [
      { segs: [{ S: GS * Math.SQRT2 }], dh: 0 },
      { segs: [{ S: s2 }, { A: Q45 }, { S: s1 }], dh: 1 },
      { segs: [{ S: s2 }, { A: -Q45 }, { S: s1 }], dh: -1 },
    ],
  ];
  const rot = (q: Pose, k: number): Pose => {
    let { x, y, a: ang } = q;
    for (let i = 0; i < k; i++) {
      const t = x;
      x = y;
      y = -t;
      ang += Math.PI / 2;
    }
    return { x, y, a: ang };
  };
  const R = Math.hypot(car.nose, car.w / 2);
  const out: Prim[][] = [];
  for (let h = 0; h < 8; h++) {
    const odd = h & 1;
    const k = (h - odd) / 2;
    out[h] = base[odd]!.map((p) => {
      const sm = walk(rt, { x: 0, y: 0, a: odd * Q45 }, p.segs).map((q) => rot(q, k));
      const e = sm[sm.length - 1]!;
      const len = p.segs.reduce((t, sg) => t + ("S" in sg ? sg.S : Math.abs(sg.A) * rt), 0);
      return {
        di: Math.round(e.x / GS),
        dj: Math.round(e.y / GS),
        dh: p.dh,
        samples: sm,
        cost: len + (p.dh ? TURNPEN : 0),
        len,
        bb: {
          x0: Math.min(0, ...sm.map((q) => q.x)) - R,
          x1: Math.max(0, ...sm.map((q) => q.x)) + R,
          y0: Math.min(0, ...sm.map((q) => q.y)) - R,
          y1: Math.max(0, ...sm.map((q) => q.y)) + R,
        },
      };
    });
  }
  return out;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.v.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    let i = v.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0]!;
    const lk = k.pop()!;
    const lv = v.pop()!;
    const n = v.length;
    if (n) {
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && k[r]! < k[l]!) l = r;
        if (k[l]! >= lk) break;
        k[i] = k[l]!;
        v[i] = v[l]!;
        i = l;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------------------------
// The lattice for one world and one car
// ---------------------------------------------------------------------------------------------

export interface Lattice {
  w: World;
  car: Car;
  prims: Prim[][];
  N: number;
  node: Uint8Array;
  edge: Uint8Array;
  /** Shortest distance from any gate's road side (static obstacles only). */
  res: SearchResult;
  starts: Set<number>;
  /** Road mode: road states reached without entering the plot, and which of them border it. */
  seed?: { states: Int32Array; frontier: Uint8Array };
  /** Reverse moves: for heading h, the (previous heading, primitive) pairs ending in h. */
  rev: [number, number][][];
}

/**
 * Search over states in two gears: index s < N driving forward, s + N reversing (same pose).
 * dist[s] for s < N is the cost to stand at s ready to drive forward.
 */
interface SearchResult {
  dist: Float32Array;
  par: Int32Array;
  /** Move into the state: primitive 0–2, or 3 for a change of gear. */
  pr: Int8Array;
  goal: number;
}

const stXY = (L: Lattice, s: number): [number, number] => {
  const k = s >> 3;
  return [(L.w.i0 + (k % L.w.NI)) * GS, (L.w.j0 + Math.floor(k / L.w.NI)) * GS];
};
const stOf = (L: Lattice, x: number, y: number, h: number) =>
  ((Math.round(y / GS) - L.w.j0) * L.w.NI + (Math.round(x / GS) - L.w.i0)) * 8 + h;
const onLattice = (L: Lattice, x: number, y: number) => {
  const i = Math.round(x / GS) - L.w.i0;
  const j = Math.round(y / GS) - L.w.j0;
  return i >= 0 && j >= 0 && i < L.w.NI && j < L.w.NJ;
};

function staticFree(L: Lattice, x: number, y: number, a: number): boolean {
  return quadFree(L.w, carCorners(L.car, x, y, a, L.car.clr));
}
const onPlot = (L: Lattice, x: number, y: number) => contains(L.w.plot, [x, y]);

function nodeOk(L: Lattice, s: number, dyn: Dyn | null): boolean {
  if (!L.node[s]) {
    const [x, y] = stXY(L, s);
    L.node[s] = staticFree(L, x, y, HEADA(s & 7)) ? 1 : 2;
  }
  if (L.node[s] === 2) return false;
  if (dyn) {
    const [x, y] = stXY(L, s);
    if (dynHitWhich(L.car, dyn, x, y, HEADA(s & 7))) return false;
  }
  return true;
}

function edgeOk(
  L: Lattice,
  s: number,
  p: number,
  x: number,
  y: number,
  P: Prim,
  dyn: Dyn | null,
): boolean {
  const e = s * 3 + p;
  if (!L.edge[e]) {
    let bad = false;
    for (const q of P.samples)
      if (!staticFree(L, x + q.x, y + q.y, q.a)) {
        bad = true;
        break;
      }
    L.edge[e] = bad ? 2 : 1;
  }
  if (L.edge[e] === 2) return false;
  if (
    dyn &&
    !(
      x + P.bb.x1 < dyn.bb.x0 ||
      x + P.bb.x0 > dyn.bb.x1 ||
      y + P.bb.y1 < dyn.bb.y0 ||
      y + P.bb.y0 > dyn.bb.y1
    )
  )
    for (const q of P.samples) if (dynHitWhich(L.car, dyn, x + q.x, y + q.y, q.a)) return false;
  return true;
}

/** True when the car's whole body (no clearance) stands on road cells. */
function onRoad(w: World, car: Car, x: number, y: number, a: number): boolean {
  const rc = w.roadCell!;
  const c = carCorners(car, x, y, a);
  // Corners, edge midpoints and the centre.
  const pts: [number, number][] = [];
  for (let k = 0; k < 8; k += 2) {
    const n2 = (k + 2) % 8;
    pts.push([c[k]!, c[k + 1]!], [(c[k]! + c[n2]!) / 2, (c[k + 1]! + c[n2 + 1]!) / 2]);
  }
  pts.push([(c[0]! + c[4]!) / 2, (c[1]! + c[5]!) / 2]);
  return pts.every(([px, py]) => {
    const i = Math.floor((px - w.minX) / w.cell);
    const j = Math.floor((py - w.minY) / w.cell);
    return i >= 0 && j >= 0 && i < w.nx && j < w.ny && rc[j * w.nx + i] === 1;
  });
}

/** Nearest of the 8 headings to a direction vector. */
const headingOf = (d: Point) => ((Math.round(Math.atan2(d[0], d[1]) / Q45) % 8) + 8) % 8;

/** Lattice states on the road side of the gates, heading into the plot. */
function startStates(L: Lattice): Set<number> {
  const out = new Set<number>();
  const add = (px: number, py: number, h: number) => {
    if (!onLattice(L, px, py)) return;
    const s = stOf(L, Math.round(px / GS) * GS, Math.round(py / GS) * GS, h);
    if (nodeOk(L, s, null)) out.add(s);
  };
  L.w.gates.forEach((g, gi) => {
    const n = inwardNormal(L.w.plot, g.a, g.b);
    const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) || 1;
    if (L.w.roadMode) {
      // On the road, some way along the street on either side, driving towards the gate.
      const t: Point = [(g.b[0] - g.a[0]) / len, (g.b[1] - g.a[1]) / len];
      const mid: Point = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
      // Look out across the street at several distances along it; every road point found
      // (at least 1.5 m apart) is a start, heading along the street towards the gate.
      for (const along of [8, 11, 14, 17])
        for (const side of [1, -1]) {
          let last = -Infinity;
          for (let o = 0.5; o <= ROAD_MARGIN_M - 2; o += 0.5) {
            const px = mid[0] + t[0] * along * side - n[0] * o;
            const py = mid[1] + t[1] * along * side - n[1] * o;
            if (o - last < 1.5 || !L.w.drivable.some((r) => contains(r, [px, py]))) continue;
            last = o;
            add(px, py, headingOf([-t[0] * side, -t[1] * side]));
          }
        }
      // No road within reach of this gate (apron fell back to the straight strip): start at
      // its far end, driving in.
      if ((L.w.apron[gi] ?? 0) < CORRIDOR_M) return;
    }
    const h = headingOf(n);
    const steps = Math.max(1, Math.ceil(len / (GS / 2)));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      add(
        g.a[0] + (g.b[0] - g.a[0]) * f - n[0] * START_OUT_M,
        g.a[1] + (g.b[1] - g.a[1]) * f - n[1] * START_OUT_M,
        h,
      );
    }
  });
  return out;
}

const MAXPOPS = 6000;
/** Reversing on the way in costs this many times the distance (people prefer driving forward). */
const REV_IN = 2;
/** Cost of stopping to change gear (m equivalent). */
const GEAR_IN = 3;
/** Most shunts (reverse, then forward again) on the way in. */
const MAXSHUNT = 3;

function search(L: Lattice, dyn: Dyn | null, goals: Map<number, unknown> | null): SearchResult {
  const { N } = L;
  const NI = L.w.NI;
  const dist = new Float32Array(2 * N).fill(Infinity);
  const par = new Int32Array(2 * N).fill(-1);
  const pr = new Int8Array(2 * N).fill(-1);
  const done = new Uint8Array(2 * N);
  let g0: [number, number] | null = null;
  let g1: [number, number] | null = null;
  if (goals) {
    const pts = [...goals.keys()].map((s) => stXY(L, s));
    g0 = pts[0]!;
    g1 = pts[pts.length - 1]!;
  }
  const gx = g0 && g1 ? g1[0] - g0[0] : 0;
  const gy = g0 && g1 ? g1[1] - g0[1] : 0;
  const gl2 = gx * gx + gy * gy;
  const hf = (S: number) => {
    if (!g0) return 0;
    const [sx, sy] = stXY(L, S % N);
    const x = sx - g0[0];
    const y = sy - g0[1];
    const t = gl2 ? Math.max(0, Math.min(1, (x * gx + y * gy) / gl2)) : 0;
    return Math.hypot(x - t * gx, y - t * gy);
  };
  const heap = new Heap();
  // Road mode: the drive along the road is the same for every carport (carport posts and parked
  // cars are on the plot), so a goal search starts from the road states already found, and only
  // those next to the plot are expanded again.
  const seed = goals && L.w.roadMode ? roadSeed(L) : null;
  if (seed) {
    for (const S of seed.states) {
      dist[S] = L.res.dist[S]!;
      par[S] = L.res.par[S]!;
      pr[S] = L.res.pr[S]!;
      if (seed.frontier[S]) heap.push(dist[S]! + hf(S), S);
      else done[S] = 1;
    }
  } else
    for (const s of L.starts) {
      if (!nodeOk(L, s, dyn)) continue;
      dist[s] = 0;
      heap.push(hf(s), s);
    }
  const relax = (T: number, nd: number, from: number, m: number) => {
    if (nd < dist[T]! - 1e-9) {
      dist[T] = nd;
      par[T] = from;
      pr[T] = m;
      heap.push(nd + hf(T), T);
    }
  };
  let pops = 0;
  while (heap.size) {
    const S = heap.pop();
    if (done[S]) continue;
    done[S] = 1;
    const rev = S >= N;
    const s = rev ? S - N : S;
    if (goals) {
      if (!rev && goals.has(s)) return { dist, par, pr, goal: s };
      if (!(seed && seed.frontier[S]) && ++pops > MAXPOPS) break;
    }
    const h = s & 7;
    const k = s >> 3;
    const i = k % NI;
    const j = Math.floor(k / NI);
    const [x, y] = stXY(L, s);
    const inside = onPlot(L, x, y);
    if (!rev) {
      for (let p = 0; p < 3; p++) {
        const P = L.prims[h]![p]!;
        // Old model: no turning off the plot. Road mode: the car may turn on the road.
        if (!inside && P.dh !== 0 && !L.w.roadMode) continue;
        const ni = i + P.di;
        const nj = j + P.dj;
        if (ni < 0 || ni >= NI || nj < 0 || nj >= L.w.NJ) continue;
        const ns = (nj * NI + ni) * 8 + ((h + P.dh + 8) & 7);
        if (done[ns]) continue;
        if (!edgeOk(L, s, p, x, y, P, dyn)) continue;
        relax(ns, dist[S]! + P.cost, S, p);
      }
    } else {
      // Reversing: back along a primitive that would have ended here.
      for (const [hp, p] of L.rev[h]!) {
        const P = L.prims[hp]![p]!;
        if (!inside && P.dh !== 0 && !L.w.roadMode) continue;
        const pi = i - P.di;
        const pj = j - P.dj;
        if (pi < 0 || pi >= NI || pj < 0 || pj >= L.w.NJ) continue;
        const sp = (pj * NI + pi) * 8 + hp;
        if (done[sp + N]) continue;
        const [px, py] = stXY(L, sp);
        if (!nodeOk(L, sp, dyn) || !edgeOk(L, sp, p, px, py, P, dyn)) continue;
        relax(sp + N, dist[S]! + P.len * REV_IN + (P.dh ? TURNPEN : 0), S, p);
      }
    }
    // Change gear where the car stands (a shunt is reverse, then forward again).
    relax(rev ? s : S + N, dist[S]! + GEAR_IN, S, 3);
  }
  return { dist, par, pr, goal: -1 };
}

/** Road states whose shortest drive never touches the plot, and those near it. */
function roadSeed(L: Lattice): NonNullable<Lattice["seed"]> {
  if (L.seed) return L.seed;
  const { N } = L;
  const off = new Int8Array(2 * N); // 0 unknown, 1 off the plot all the way, 2 not
  const offPlot = (S: number) => {
    const [x, y] = stXY(L, S % N);
    return !onPlot(L, x, y);
  };
  const chainOff = (S0: number): boolean => {
    const stack: number[] = [];
    let S = S0;
    let ok = true;
    for (;;) {
      if (off[S] !== 0) {
        ok = off[S] === 1;
        break;
      }
      stack.push(S);
      if (!offPlot(S)) {
        ok = false;
        break;
      }
      const p = L.res.par[S]!;
      if (p < 0) break;
      S = p;
    }
    for (const q of stack) off[q] = ok ? 1 : 2;
    return ok;
  };
  // Near: within reach of one move and the car's length of the plot.
  const xs = L.w.plot.map((p) => p[0]);
  const ys = L.w.plot.map((p) => p[1]);
  const near = L.car.l + 4;
  const [bx0, by0, bx1, by1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const states: number[] = [];
  const frontier = new Uint8Array(2 * N);
  for (let S = 0; S < 2 * N; S++) {
    if (L.res.dist[S] === Infinity || !chainOff(S)) continue;
    states.push(S);
    const [x, y] = stXY(L, S % N);
    const dx = Math.max(bx0 - x, 0, x - bx1);
    const dy = Math.max(by0 - y, 0, y - by1);
    if (dx * dx + dy * dy <= near * near && distToPolygon(L.w.plot, x, y) <= near) frontier[S] = 1;
  }
  L.seed = { states: Int32Array.from(states), frontier };
  return L.seed;
}

function distToPolygon(poly: Polygon, x: number, y: number): number {
  let min = Infinity;
  for (let e = 0; e < poly.length; e++) {
    const a = poly[e]!;
    const b = poly[(e + 1) % poly.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)),
    );
    min = Math.min(min, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return min;
}

function extract(
  L: Lattice,
  res: SearchResult,
  s: number,
): { poses: Pose[]; turns: number[]; shunts: number } {
  const { N } = L;
  const chain: number[] = [];
  let q = s;
  while (res.par[q]! >= 0) {
    chain.push(q);
    q = res.par[q]!;
  }
  chain.reverse();
  const [x0, y0] = stXY(L, q % N);
  const poses: Pose[] = [{ x: x0, y: y0, a: HEADA(q & 7) }];
  const turns: number[] = [];
  let gears = 0;
  let prev = q;
  for (const S of chain) {
    const m = res.pr[S]!;
    if (m === 3) gears++;
    else if (S < N) {
      const ps = prev % N;
      const [x, y] = stXY(L, ps);
      const P = L.prims[ps & 7]![m]!;
      for (const sm of P.samples) poses.push({ x: x + sm.x, y: y + sm.y, a: sm.a });
      if (P.dh) turns.push(P.dh);
    } else {
      // Reversing from prev back to S: the primitive of S's heading, walked backwards.
      const cs = S - N;
      const [x, y] = stXY(L, cs);
      const P = L.prims[cs & 7]![m]!;
      const seg = [
        { x, y, a: HEADA(cs & 7) },
        ...P.samples.map((q2) => ({ x: x + q2.x, y: y + q2.y, a: q2.a })),
      ].reverse();
      seg.shift();
      for (const p of seg) poses.push({ ...p, rev: true });
      if (P.dh) turns.push(-P.dh);
    }
    prev = S;
  }
  return { poses, turns, shunts: Math.floor(gears / 2) };
}

export function buildLattice(w: World, car: Car): Lattice {
  const N = w.NI * w.NJ * 8;
  const L: Lattice = {
    w,
    car,
    prims: primitives(car),
    N,
    node: new Uint8Array(N),
    edge: new Uint8Array(N * 3),
    res: { dist: new Float32Array(0), par: new Int32Array(0), pr: new Int8Array(0), goal: -1 },
    starts: new Set(),
    rev: [...Array(8)].map(() => []),
  };
  for (let h = 0; h < 8; h++)
    for (let p = 0; p < 3; p++) L.rev[(h + L.prims[h]![p]!.dh + 8) & 7]!.push([h, p]);
  L.starts = startStates(L);
  L.res = search(L, null, null);
  return L;
}

// ---------------------------------------------------------------------------------------------
// Carport bays, approach lines and routes
// ---------------------------------------------------------------------------------------------

export interface CarportRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** "ns": cars park along y (bays side by side in x); "ew": along x. */
  o: "ns" | "ew";
  bays: 1 | 2;
}

const snapG = (v: number) => Math.round(v / GS) * GS;
const ceilG = (v: number) => Math.ceil(v / GS - 1e-9) * GS;
const floorG = (v: number) => Math.floor(v / GS + 1e-9) * GS;

interface Entry {
  h: number;
  Af: { x: number; y: number };
}
interface Bay {
  b: number;
  c: number;
  entries: Entry[];
}

/** Bays and the poses a parked car takes, entering from either open side. */
function baysOf(car: Car, r: CarportRect, frontOnly: boolean): Bay[] {
  const ns = r.o === "ns";
  const A0 = ns ? r.x0 : r.y0;
  const A = ns ? r.x1 - r.x0 : r.y1 - r.y0;
  const bw = A / r.bays;
  const out: Bay[] = [];
  for (let b = 0; b < r.bays; b++) {
    // The exact centre of the bay: the car need not stand on the 0.5 m lattice when parked.
    const c = A0 + bw * (b + 0.5);
    const E: Entry[] = [];
    if (ns) {
      E.push({ h: 0, Af: { x: c, y: ceilG(r.y0 + car.ro) } });
      if (!frontOnly) E.push({ h: 4, Af: { x: c, y: floorG(r.y1 - car.ro) } });
    } else {
      E.push({ h: 2, Af: { x: ceilG(r.x0 + car.ro), y: c } });
      E.push({ h: 6, Af: { x: floorG(r.x1 - car.ro), y: c } });
    }
    out.push({ b, c, entries: E });
  }
  return out;
}

const insideRect = (cc: number[], r: CarportRect) => {
  for (let k = 0; k < 8; k += 2)
    if (
      cc[k]! < r.x0 - EPS ||
      cc[k]! > r.x1 + EPS ||
      cc[k + 1]! < r.y0 - EPS ||
      cc[k + 1]! > r.y1 + EPS
    )
      return false;
  return true;
};

function carRectAt(car: Car, x: number, y: number, a: number): Rect {
  const cc = carCorners(car, x, y, a);
  const xs = [cc[0]!, cc[2]!, cc[4]!, cc[6]!];
  const ys = [cc[1]!, cc[3]!, cc[5]!, cc[7]!];
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
    kind: "car",
  };
}

const inflate = (r: Rect, m: number): Rect => ({
  x0: r.x0 - m,
  y0: r.y0 - m,
  x1: r.x1 + m,
  y1: r.y1 + m,
  kind: r.kind,
});

export const POST_M = 0.1;
/** Inside the carport the car creeps: it passes posts and the other bay's car this close. */
export const INSIDE_CLEARANCE_M = 0.1;
function postRects(r: CarportRect): Rect[] {
  const P = POST_M;
  return [
    [r.x0, r.y0],
    [r.x1 - P, r.y0],
    [r.x0, r.y1 - P],
    [r.x1 - P, r.y1 - P],
  ].map(([x, y]) => ({ x0: x!, y0: y!, x1: x! + P, y1: y! + P, kind: "post" }));
}

interface Cand {
  k: number;
  s: number;
  ok: boolean;
  E: Entry;
  pre?: Pose[];
  extra?: number;
  turns?: number[];
}

/** States on the straight line-up behind an entry, where the car is clear of the bay. */
const onGrid = (v: number) => Math.abs(v / GS - Math.round(v / GS)) < 1e-6;

function approachCands(L: Lattice, r: CarportRect, E: Entry, dyn: Dyn | null): Cand[] {
  const a = HEADA(E.h);
  const dx = Math.round(Math.sin(a));
  const dy = Math.round(Math.cos(a));
  const entryAlong =
    E.h === 0
      ? r.y0 - E.Af.y
      : E.h === 4
        ? E.Af.y - r.y1
        : E.h === 2
          ? r.x0 - E.Af.x
          : E.Af.x - r.x1;
  const kmin = Math.ceil((L.car.nose - entryAlong) / GS - 1e-9);
  const out: Cand[] = [];
  let dynOk = true;
  for (let t = 0; t < 40; t += 0.25) {
    const px = E.Af.x - dx * t;
    const py = E.Af.y - dy * t;
    if (!onLattice(L, px, py)) break;
    const cc = carCorners(L.car, px, py, a);
    if (!insideRect(cc, r) && !staticFree(L, px, py, a)) break;
    if (dynHitWhich(L.car, dyn, px, py, a) && dynOk) dynOk = false;
    const k = Math.round(t / GS);
    if (Math.abs(t - k * GS) < 1e-9 && k >= kmin)
      out.push({ k, s: onGrid(px) && onGrid(py) ? stOf(L, px, py, E.h) : -1, ok: dynOk, E });
  }
  return out;
}

function lineFrom(E: Entry, k: number): Pose[] {
  const a = HEADA(E.h);
  const dx = Math.round(Math.sin(a));
  const dy = Math.round(Math.cos(a));
  const out: Pose[] = [];
  for (let t = k * GS - 0.25; t > -1e-9; t -= 0.25)
    out.push({ x: E.Af.x - dx * t, y: E.Af.y - dy * t, a });
  return out;
}

/** S-bend lead-ins: a sideways shift of 0.5–2.5 m with two gentle arcs before the line-up. */
function sCands(L: Lattice, r: CarportRect, E: Entry, dyn: Dyn | null, straight: Cand[]): Cand[] {
  const a = HEADA(E.h);
  const dx = Math.round(Math.sin(a));
  const dy = Math.round(Math.cos(a));
  const nx = dy;
  const ny = -dx;
  const rt = L.car.rt;
  const out: Cand[] = [];
  const okList = straight.filter((c) => c.ok);
  for (const c of okList.slice(0, 9)) {
    if ((c.k - okList[0]!.k) % 2) continue;
    const Px = E.Af.x - dx * c.k * GS;
    const Py = E.Af.y - dy * c.k * GS;
    // Sideways shifts that start on a lattice line: up to 2.5 m either way. Shifts under 0.5 m
    // (a bay that is not on the lattice) are a slight steer, not counted as curves.
    const lat = E.h % 4 === 0 ? Px : Py;
    const sgnN = E.h % 4 === 0 ? nx : ny;
    const shifts: number[] = [];
    for (let m = -6; m <= 6; m++) {
      const dd = (snapG(lat) + m * GS - lat) * sgnN;
      if (Math.abs(dd) > 1e-6 && Math.abs(dd) <= 2.5 + 1e-6) shifts.push(dd);
    }
    for (const dd of shifts) {
      const dl = Math.abs(dd);
      const sg = Math.sign(dd);
      const nudge = dl < 0.5 - 1e-6;
      const phi = Math.acos(1 - dl / (2 * rt));
      const Ls = 2 * rt * Math.sin(phi);
      const Lg = Math.ceil(Ls / GS - 1e-9) * GS;
      const Qx = Px - dx * Lg + nx * dd;
      const Qy = Py - dy * Lg + ny * dd;
      // A slight steer may start on the road; a real S-bend only once on the plot.
      if (!onLattice(L, Qx, Qy) || (!nudge && !onPlot(L, Qx, Qy))) continue;
      const pre = walk(rt, { x: Qx, y: Qy, a }, [
        { S: Lg - Ls },
        { A: -sg * phi },
        { A: sg * phi },
      ]);
      const end = pre[pre.length - 1]!;
      if (Math.hypot(end.x - Px, end.y - Py) > 0.02) continue;
      pre[pre.length - 1] = { x: Px, y: Py, a };
      if (
        pre.some(
          (p) => !insideRect(carCorners(L.car, p.x, p.y, p.a), r) && !staticFree(L, p.x, p.y, p.a),
        )
      )
        continue;
      if (dynFirstHit(L.car, pre, dyn)) continue;
      out.push({
        k: c.k,
        s: stOf(L, Qx, Qy, E.h),
        ok: true,
        E,
        pre,
        extra: Lg + 2 * rt * phi - Ls + (nudge ? 0 : TURNPEN),
        turns: nudge ? [] : [-sg, sg],
      });
    }
  }
  return out;
}

function dynFirstHit(car: Car, poses: Pose[], dyn: Dyn | null): { i: number; b: Rect } | null {
  for (let i = 0; i < poses.length; i++) {
    const b = dynHitWhich(car, dyn, poses[i]!.x, poses[i]!.y, poses[i]!.a);
    if (b) return { i, b };
  }
  return null;
}

export function describeRoute(turns: number[], shunts = 0): string {
  const g: { s: number; n: number }[] = [];
  for (const t of turns) {
    if (g.length && g[g.length - 1]!.s === t) g[g.length - 1]!.n++;
    else g.push({ s: t, n: 1 });
  }
  const base = !g.length
    ? "straight in"
    : g.length === 1
      ? `with one ${g[0]!.n * 45}° curve`
      : g.length === 2 && g[0]!.s !== g[1]!.s && g[0]!.n === g[1]!.n
        ? "with an S-bend"
        : `with ${g.length} curves`;
  return shunts
    ? `${base}, after ${shunts === 1 ? "one shunt" : `${shunts} shunts`} (back and forth)`
    : base;
}

export interface BayRoute {
  ok: true;
  poses: Pose[];
  entryHeading: number;
  cost: number;
  lengthM: number;
  how: string;
  /** Where the swept path crosses the plot boundary (points), for the exit width. */
  crossing: Point[];
  /** Times the car reverses and drives forward again on the way in. */
  shunts: number;
  /** The lattice state where the final approach starts, and the poses from there into the bay. */
  start: number;
  tail: Pose[];
}

/** Points where the car's outline crosses the plot boundary along a path. */
function crossings(car: Car, plot: Polygon, poses: Pose[]): Point[] {
  const out: Point[] = [];
  for (const p of poses) {
    const cc = carCorners(car, p.x, p.y, p.a);
    for (let k = 0; k < 8; k += 2) {
      const ax = cc[k]!;
      const ay = cc[k + 1]!;
      const bx = cc[(k + 2) % 8]!;
      const by = cc[(k + 3) % 8]!;
      for (let e = 0; e < plot.length; e++) {
        const c = plot[e]!;
        const d = plot[(e + 1) % plot.length]!;
        const den = (bx - ax) * (d[1] - c[1]) - (by - ay) * (d[0] - c[0]);
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c[0] - ax) * (d[1] - c[1]) - (c[1] - ay) * (d[0] - c[0])) / den;
        const u = ((c[0] - ax) * (by - ay) - (c[1] - ay) * (bx - ax)) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
          out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
      }
    }
  }
  return out;
}

function bayRoute(
  L: Lattice,
  r: CarportRect,
  E: Entry,
  dyn: Dyn | null,
  cands: Cand[] & { _s?: Cand[] },
): BayRoute | null {
  const res = L.res;
  const tryList = (list: Cand[]) => {
    const order = list
      .filter((c) => c.ok && c.s >= 0 && res.dist[c.s]! < Infinity)
      .map((c) => ({ c, tot: res.dist[c.s]! + c.k * GS + (c.extra ?? 0) }))
      .sort((a, b) => a.tot - b.tot);
    for (const { c, tot } of order) {
      const p = extract(L, res, c.s);
      if (dynFirstHit(L.car, p.poses, dyn)) continue;
      if (p.turns.length + (c.turns ?? []).length > MAXTURN || p.shunts > MAXSHUNT) continue;
      return { tot, c, p };
    }
    return null;
  };
  let best = tryList(cands);
  if (!best) {
    cands._s ??= sCands(L, r, E, dyn, cands);
    best = tryList(cands._s);
  }
  const all = cands.concat(cands._s ?? []);
  if (!best && all.some((c) => c.ok && c.s >= 0 && res.dist[c.s]! < Infinity)) {
    // The parked car or a post is in the way of the shortest route: search again around it.
    const goals = new Map<number, Cand>();
    for (const c of all) if (c.ok && c.s >= 0 && !goals.has(c.s)) goals.set(c.s, c);
    const r2 = search(L, dyn, goals);
    if (r2.goal >= 0) {
      const c = goals.get(r2.goal)!;
      best = { tot: r2.dist[r2.goal]! + c.k * GS + (c.extra ?? 0), c, p: extract(L, r2, r2.goal) };
    }
  }
  if (!best) return null;
  const turns = best.p.turns.concat(best.c.turns ?? []);
  if (turns.length > MAXTURN || best.p.shunts > MAXSHUNT) return null;
  const tail = (best.c.pre ?? []).concat(lineFrom(E, best.c.k));
  const poses = best.p.poses.concat(tail);
  return {
    start: best.c.s,
    tail,
    ok: true,
    poses,
    entryHeading: E.h,
    cost: best.tot,
    lengthM: best.tot - turns.length * TURNPEN,
    how: describeRoute(turns, best.p.shunts),
    shunts: best.p.shunts,
    crossing: crossings(L.car, L.w.plot, poses),
  };
}

export interface BayAccess {
  b: number;
  route: BayRoute | null;
  /** When no route: what is in the way of the best attempt ("car" or "post"), if that's why. */
  blocker?: string;
  /** Final parked pose (when reached) or the planned one. */
  parked: Pose;
}

/**
 * Routes into every bay of a carport through the lattice's gates. A bay counts as reachable when
 * the car gets in while the other bay is occupied (two-car carports).
 */
export function accessCarport(L: Lattice, r: CarportRect, frontOnly: boolean): BayAccess[] {
  const car = L.car;
  const bays = baysOf(car, r, frontOnly);
  const posts = postRects(r).map((p) => inflate(p, Math.min(car.clr, INSIDE_CLEARANCE_M)));
  const parked = bays.map((B) =>
    inflate(
      carRectAt(car, B.entries[0]!.Af.x, B.entries[0]!.Af.y, HEADA(B.entries[0]!.h)),
      car.clr,
    ),
  );
  return bays.map((B, bi) => {
    const dyn = dynOf([...posts, ...parked.filter((_, k) => k !== bi)]);
    let best: BayRoute | null = null;
    for (const E of B.entries) {
      const rt = bayRoute(L, r, E, dyn, approachCands(L, r, E, dyn));
      if (rt && (!best || rt.cost < best.cost)) best = rt;
    }
    if (best) return { b: bi, route: best, parked: best.poses[best.poses.length - 1]! };
    // Why not: try ignoring posts and the parked car, and find what the path would hit.
    let blocker: string | undefined;
    for (const E of B.entries) {
      const cands = approachCands(L, r, E, null);
      let bestC: { tot: number; c: Cand } | null = null;
      for (const c of cands) {
        if (c.s < 0) continue;
        const d = L.res.dist[c.s]!;
        if (d < Infinity && (!bestC || d + c.k * GS < bestC.tot)) bestC = { tot: d + c.k * GS, c };
      }
      if (!bestC) continue;
      const poses = extract(L, L.res, bestC.c.s).poses.concat(lineFrom(E, bestC.c.k));
      const h = dynFirstHit(car, poses, dyn);
      if (h) {
        blocker = h.b.kind;
        break;
      }
    }
    const E0 = B.entries[0]!;
    return {
      b: bi,
      route: null,
      ...(blocker ? { blocker } : {}),
      parked: { x: E0.Af.x, y: E0.Af.y, a: HEADA(E0.h) },
    };
  });
}

/** Whether a car of this size fits inside the carport with room to open its doors. */
export function parkingFit(
  car: Car,
  r: CarportRect,
  doorGapM = 0.5,
): { fits: boolean; gapM: number } {
  const ns = r.o === "ns";
  const across = ns ? r.x1 - r.x0 : r.y1 - r.y0;
  const depth = ns ? r.y1 - r.y0 : r.x1 - r.x0;
  const gapM = across / r.bays - car.w;
  return { fits: depth >= car.l - 1e-9 && gapM >= 2 * doorGapM - 1e-9, gapM: gapM / 2 };
}

// ---------------------------------------------------------------------------------------------
// Leaving: reverse out, then (where there is room) turn and drive forward to the road
// ---------------------------------------------------------------------------------------------

const RVC = 6;
const GEAR = 4;

export interface LeaveRoute {
  poses: Pose[];
  text: string;
  forward: boolean;
}

/**
 * The way out of one bay: reversing (more expensive per metre) with gear changes allowed, staying
 * on the driveway (the area swept on the way in plus a turning space around the carport). Display
 * only: leaving is always possible by reversing along the way in.
 */
export function leaveCarport(
  L: Lattice,
  r: CarportRect,
  access: BayAccess[],
  bi: number,
): LeaveRoute | null {
  const car = L.car;
  const B = access[bi];
  if (!B?.route) return null;
  const posts = postRects(r).map((p) => inflate(p, Math.min(car.clr, INSIDE_CLEARANCE_M)));
  const others = access
    .filter((_, k) => k !== bi)
    .map((q) => inflate(carRectAt(car, q.parked.x, q.parked.y, q.parked.a), car.clr));
  const dyn = dynOf([...posts, ...others]);
  // On the road the car ends up along the street the gate lies on (either direction).
  const streetHeadings = new Set<number>();
  for (const g of L.w.gates) {
    const hd = headingOf([g.b[0] - g.a[0], g.b[1] - g.a[1]]);
    streetHeadings.add(hd);
    streetHeadings.add((hd + 4) & 7);
  }
  // Leaving starts by reversing out along the final approach, back to its lattice state.
  const start = B.route.start;
  const tailRev = [...B.route.tail].reverse();
  const tailLen = tailRev.reduce(
    (t, p, i) => (i ? t + Math.hypot(p.x - tailRev[i - 1]!.x, p.y - tailRev[i - 1]!.y) : t),
    0,
  );
  // Driveway mask: swept on the way in (with margin), a turning space of 12 m around the carport,
  // and the road side of the gates.
  const MS = 0.25;
  const w = L.w;
  const MI = Math.ceil((w.nx * w.cell) / MS);
  const MJ = Math.ceil((w.ny * w.cell) / MS);
  const mask = new Uint8Array(MI * MJ);
  const TY = 12;
  for (let jj = 0; jj < MJ; jj++)
    for (let ii = 0; ii < MI; ii++) {
      const x = w.minX + ii * MS;
      const y = w.minY + jj * MS;
      if (
        (x > r.x0 - TY && x < r.x1 + TY && y > r.y0 - TY && y < r.y1 + TY) ||
        !contains(w.plot, [x, y])
      )
        mask[jj * MI + ii] = 1;
    }
  for (const q of access)
    if (q.route)
      for (const p of q.route.poses) {
        const c = carCorners(car, p.x, p.y, p.a, 0.3);
        const xs = [c[0]!, c[2]!, c[4]!, c[6]!];
        const ys = [c[1]!, c[3]!, c[5]!, c[7]!];
        for (
          let ii = Math.max(0, Math.floor((Math.min(...xs) - w.minX) / MS));
          ii <= Math.min(MI - 1, Math.ceil((Math.max(...xs) - w.minX) / MS));
          ii++
        )
          for (
            let jj = Math.max(0, Math.floor((Math.min(...ys) - w.minY) / MS));
            jj <= Math.min(MJ - 1, Math.ceil((Math.max(...ys) - w.minY) / MS));
            jj++
          )
            mask[jj * MI + ii] = 1;
      }
  const onDrive = (x: number, y: number, a: number) => {
    const c = carCorners(car, x, y, a);
    for (let k = 0; k < 8; k += 2) {
      const ii = Math.round((c[k]! - w.minX) / MS);
      const jj = Math.round((c[k + 1]! - w.minY) / MS);
      if (ii < 0 || ii >= MI || jj < 0 || jj >= MJ || !mask[jj * MI + ii]) return false;
    }
    return true;
  };
  const edgeDrive = (x: number, y: number, P: Prim) =>
    P.samples.every((q) => onDrive(x + q.x, y + q.y, q.a));
  // Reverse primitives: for heading h, the (previous heading, primitive) pairs ending in h.
  const REV: [number, number][][] = [...Array(8)].map(() => []);
  for (let h = 0; h < 8; h++)
    for (let p = 0; p < 3; p++) REV[(h + L.prims[h]![p]!.dh + 8) & 7]!.push([h, p]);
  const { N } = L;
  const NI = w.NI;
  const dist = new Float32Array(2 * N).fill(Infinity);
  const par = new Int32Array(2 * N).fill(-1);
  const pm = new Int8Array(2 * N).fill(-1);
  const done = new Uint8Array(2 * N);
  // Goal: off the plot, on the road side of a gate, in either direction along the road.
  const heap = new Heap();
  dist[start] = tailLen * RVC;
  // A* towards the road: the distance to the nearest gate never overestimates what is left.
  const toGate = (S: number) => {
    const [x, y] = stXY(L, S % N);
    let d = Infinity;
    for (const g of w.gates) {
      const dx = g.b[0] - g.a[0];
      const dy = g.b[1] - g.a[1];
      const t = Math.max(
        0,
        Math.min(1, ((x - g.a[0]) * dx + (y - g.a[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
      d = Math.min(d, Math.hypot(x - g.a[0] - t * dx, y - g.a[1] - t * dy));
    }
    return d;
  };
  heap.push(dist[start]! + toGate(start), start);
  let goal = -1;
  let fallback = -1;
  let pops = 0;
  const relax = (T: number, nd: number, from: number, m: number) => {
    if (nd < dist[T]! - 1e-9) {
      dist[T] = nd;
      par[T] = from;
      pm[T] = m;
      heap.push(nd + toGate(T), T);
    }
  };
  while (heap.size) {
    const S = heap.pop();
    if (done[S]) continue;
    done[S] = 1;
    if (++pops > 60000) break;
    const ph = S >= N ? 1 : 0;
    const s = S % N;
    const h = s & 7;
    const k = s >> 3;
    const i = k % NI;
    const j = Math.floor(k / NI);
    const [x, y] = stXY(L, s);
    const inside = onPlot(L, x, y);
    // Done when the whole car is off the plot (out on the road).
    // Done when the whole car is out on the road, lined up with the street (else, if that is
    // never possible, the first point where it is out at all).
    if (!inside && !quadHitsPlot(car, w.plot, x, y, HEADA(h))) {
      if (fallback < 0) fallback = S;
      // Road mode: the whole car stands on the road itself, not on a cycle path or pavement.
      if (streetHeadings.has(h) && (!w.roadCell || onRoad(w, car, x, y, HEADA(h)))) {
        goal = S;
        break;
      }
    }
    if (ph === 0) {
      for (const [hp, p] of REV[h]!) {
        const P = L.prims[hp]![p]!;
        const pi = i - P.di;
        const pj = j - P.dj;
        if (pi < 0 || pi >= NI || pj < 0 || pj >= w.NJ) continue;
        const sp = (pj * NI + pi) * 8 + hp;
        const [px, py] = stXY(L, sp);
        if (
          done[sp] ||
          !nodeOk(L, sp, dyn) ||
          !edgeOk(L, sp, p, px, py, P, dyn) ||
          !onDrive(px, py, HEADA(hp)) ||
          !edgeDrive(px, py, P)
        )
          continue;
        relax(sp, dist[S]! + P.len * RVC + (P.dh ? TURNPEN : 0), S, p);
      }
      relax(S + N, dist[S]! + GEAR, S, 3);
    } else {
      for (let p = 0; p < 3; p++) {
        const P = L.prims[h]![p]!;
        const ni = i + P.di;
        const nj = j + P.dj;
        if (ni < 0 || ni >= NI || nj < 0 || nj >= w.NJ) continue;
        const nh = (h + P.dh + 8) & 7;
        const ns = (nj * NI + ni) * 8 + nh;
        if (done[ns + N] || !edgeOk(L, s, p, x, y, P, dyn) || !edgeDrive(x, y, P)) continue;
        relax(ns + N, dist[S]! + P.cost, S, p);
      }
      relax(S - N, dist[S]! + GEAR, S, 3);
    }
  }
  if (goal < 0) goal = fallback;
  if (goal < 0) return null;
  const chain: number[] = [];
  for (let S = goal; S !== start; S = par[S]!) chain.push(S);
  chain.reverse();
  const pose = (s: number): Pose => {
    const [x, y] = stXY(L, s % N);
    return { x, y, a: HEADA((s % N) & 7) };
  };
  const poses: Pose[] = tailRev
    .slice(1)
    .map((p) => ({ ...p, rev: true }))
    .concat([{ ...pose(start), rev: true }]);
  let revTurns = 0;
  let fwd = false;
  let changes = 0;
  let prev = start;
  for (const S of chain) {
    const m = pm[S]!;
    if (m === 3) {
      fwd = S >= N;
      changes++;
    } else if (S < N) {
      const P = L.prims[S & 7]![m]!;
      const [x, y] = stXY(L, S);
      const seg = [
        { x, y, a: HEADA(S & 7) },
        ...P.samples.map((q) => ({ x: x + q.x, y: y + q.y, a: q.a })),
      ].reverse();
      seg.shift();
      poses.push(...seg.map((p) => ({ ...p, rev: true })));
      if (P.dh) revTurns++;
    } else {
      const s = prev % N;
      const P = L.prims[s & 7]![m]!;
      const [x, y] = stXY(L, s);
      poses.push(...P.samples.map((q) => ({ x: x + q.x, y: y + q.y, a: q.a })));
    }
    prev = S;
  }
  const text =
    changes >= 3
      ? `makes a ${changes === 3 ? "three" : "multi"}-point turn, then drives off along the street`
      : !fwd
        ? revTurns
          ? "reverses out with a turn onto the street"
          : "reverses straight back onto the street (no room to turn)"
        : revTurns
          ? "reverses out with a turn, then drives off along the street"
          : "reverses out onto the street, then turns and drives off along it";
  return { poses, text, forward: fwd };
}

function quadHitsPlot(car: Car, plot: Polygon, x: number, y: number, a: number): boolean {
  const cc = carCorners(car, x, y, a);
  for (let k = 0; k < 8; k += 2) if (contains(plot, [cc[k]!, cc[k + 1]!])) return true;
  return false;
}
