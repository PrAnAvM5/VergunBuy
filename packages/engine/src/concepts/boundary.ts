/**
 * Concept: what things in the garden are made of, and what stands on the plot line.
 *
 * Two measurements tell a plant from a solid object, without machine learning:
 *  - laser echoes (AHN point cloud): leaves and branches let part of each laser pulse through,
 *    so the pulse comes back as several echoes; walls, fences, roofs and cars stop it (one echo).
 *    On the 60 example homes: 69% of tree points, 12% of roof points had several echoes.
 *  - infrared aerial photo: living leaves reflect near-infrared light strongly, stone and paving
 *    do not. The plant index NDVI = (NIR − red) / (NIR + red). The national photos are taken in
 *    early spring, before leaves come out, so bare deciduous plants look weak here: the echoes
 *    cover them. Roofs measured about −0.10 on the example homes, evergreen hedges well above 0.
 *
 *   plant   : echo share ≥ plantEcho, or NDVI ≥ plantNdvi
 *   solid   : echo share < solidEcho (with enough points), and NDVI below plantNdvi
 *   unknown : neither (too few points and no photo, or the two disagree)
 *
 * The plot line is cut into pieces of pieceM. Each piece facing a public area ("street") gets one
 * of: exit (a registered driveway crossing), open (nothing of barrierM or higher on the line),
 * hedge (a plant barrier), barrier (a solid barrier: fence or wall), unknown (a barrier of
 * unknown make-up, or no height data). The national map (BGT) wins where it has a fence, wall or
 * hedge drawn; in Woensdrecht it rarely does.
 */
import type { HeightGrid } from "./obstacles.ts";
import {
  contains,
  distanceToSegment,
  edges as polyEdges,
  lerp,
  length,
  outwardNormal,
  type Point,
  type Polygon,
} from "../geometry.ts";

export interface EchoGrid {
  version: string;
  res: number;
  /** Top-left corner (RD New); rows run southwards. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  n: number[];
  multi: number[];
}

export interface NdviGrid {
  /** Name of the photo, e.g. "Actueel_orthoHRIR". */
  layer: string;
  res: number;
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  ndvi: Float32Array;
}

export type Material = "plant" | "solid" | "unknown";

export const MATERIAL_SETTINGS = {
  /** A cell needs this many non-ground points before its echo share counts. */
  minPoints: 4,
  plantEcho: 0.3,
  solidEcho: 0.15,
  plantNdvi: 0.05,
};

export const BOUNDARY_SETTINGS = {
  pieceM: 0.5,
  /** Something this high on the plot line is a barrier for a car (a low garden wall counts). */
  barrierM: 0.6,
  /** How far inside and outside the line we look for it. */
  bandInM: 0.75,
  bandOutM: 0.25,
  /** A registered fence, wall or hedge this close to a piece applies to it. */
  bgtNearM: 1,
  /** A registered exit straight outside a piece, within this distance, makes it an exit (the
   *  driveway crossing often starts at the kerb, across a pavement of 1–3 m). */
  exitNearM: 3,
  /** Cells this close to a building are left out (walls and eaves are not a fence). */
  buildingBufferM: 0.5,
};

export interface MaterialEvidence {
  material: Material;
  /** Share of points with several echoes, when enough points. */
  echoShare: number | null;
  points: number;
  ndvi: number | null;
}

/** Echo share and plant index around a point (the 0.5 m cell it falls in, and its neighbours
 *  when that cell alone has too few points). */
export function materialAt(
  p: Point,
  echo: EchoGrid | null | undefined,
  ndvi: NdviGrid | null | undefined,
  s = MATERIAL_SETTINGS,
): MaterialEvidence {
  let echoShare: number | null = null;
  let points = 0;
  if (echo) {
    const c = Math.floor((p[0] - echo.x0) / echo.res);
    const r = Math.floor((echo.y0 - p[1]) / echo.res);
    let n = 0;
    let m = 0;
    for (const radius of [0, 1]) {
      n = 0;
      m = 0;
      for (let dr = -radius; dr <= radius; dr++)
        for (let dc = -radius; dc <= radius; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= echo.rows || cc >= echo.cols) continue;
          n += echo.n[rr * echo.cols + cc] ?? 0;
          m += echo.multi[rr * echo.cols + cc] ?? 0;
        }
      if (n >= s.minPoints) break;
    }
    points = n;
    if (n >= s.minPoints) echoShare = m / n;
  }
  let v: number | null = null;
  if (ndvi) {
    // Mean over the photo pixels within 0.25 m of the point.
    let sum = 0;
    let k = 0;
    const span = Math.max(1, Math.round(0.25 / ndvi.res));
    const c = Math.floor((p[0] - ndvi.x0) / ndvi.res);
    const r = Math.floor((ndvi.y0 - p[1]) / ndvi.res);
    for (let dr = -span; dr < span; dr++)
      for (let dc = -span; dc < span; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= ndvi.rows || cc >= ndvi.cols) continue;
        const x = ndvi.ndvi[rr * ndvi.cols + cc]!;
        if (Number.isFinite(x)) {
          sum += x;
          k++;
        }
      }
    if (k) v = sum / k;
  }
  const plant =
    (echoShare !== null && echoShare >= s.plantEcho) || (v !== null && v >= s.plantNdvi);
  const solid =
    !plant && echoShare !== null && echoShare < s.solidEcho && (v === null || v < s.plantNdvi);
  return {
    material: plant ? "plant" : solid ? "solid" : "unknown",
    echoShare: echoShare === null ? null : Math.round(echoShare * 100) / 100,
    points,
    ndvi: v === null ? null : Math.round(v * 1000) / 1000,
  };
}

/** The material most cells of a group have (plant wins ties: the safer, removable reading). */
export function majority(ms: Material[]): Material {
  const n = { plant: 0, solid: 0, unknown: 0 };
  for (const m of ms) n[m]++;
  if (n.plant === 0 && n.solid === 0) return "unknown";
  return n.solid > n.plant ? "solid" : "plant";
}

export type BoundarySide = "street" | "other";
export type BoundaryState = "exit" | "open" | "hedge" | "barrier" | "unknown";

export interface BoundaryPiece {
  a: Point;
  b: Point;
  side: BoundarySide;
  state: BoundaryState;
  /** Highest point found on the line here, above ground (m); null without height data. */
  heightM: number | null;
  material: Material | null;
  source: "map" | "scan" | "exit" | "none";
}

export interface BoundaryInput {
  plot: Polygon;
  /** Plot-line stretches that face a public area (street, footpath, square, green). */
  streetRuns: { a: Point; b: Point }[];
  exits: Polygon[];
  grid: HeightGrid | null;
  buildings: Polygon[];
  echo: EchoGrid | null;
  ndvi: NdviGrid | null;
  /** Registered fences and walls (lines), and hedges (lines or outlines), from the BGT. */
  mapBarriers: Point[][];
  mapHedges: Point[][];
}

function heightAt(g: HeightGrid, p: Point): number {
  const c = Math.floor((p[0] - g.x0) / g.res);
  const r = Math.floor((g.y0 - p[1]) / g.res);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return Number.NaN;
  const k = r * g.cols + c;
  return g.dsm[k]! - g.dtm[k]!;
}

const nearLine = (p: Point, lines: Point[][], d: number) =>
  lines.some((l) => {
    for (let i = 0; i + 1 < l.length; i++)
      if (distanceToSegment(p, l[i]!, l[i + 1]!) <= d) return true;
    return l.length === 1 && Math.hypot(p[0] - l[0]![0], p[1] - l[0]![1]) <= d;
  });

function nearPolygon(p: Point, poly: Polygon, d: number): boolean {
  if (contains(poly, p)) return true;
  for (let i = 0; i < poly.length; i++)
    if (distanceToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!) <= d) return true;
  return false;
}

/** Cuts the plot line into pieces and says what stands on each. */
export function boundaryPieces(input: BoundaryInput, s = BOUNDARY_SETTINGS): BoundaryPiece[] {
  const out: BoundaryPiece[] = [];
  for (const [a, b] of polyEdges(input.plot)) {
    const len = length(a, b);
    const n = Math.max(1, Math.round(len / s.pieceM));
    const out_ = outwardNormal(input.plot, a, b);
    for (let i = 0; i < n; i++) {
      const pa = lerp(a, b, i / n);
      const pb = lerp(a, b, (i + 1) / n);
      const m = lerp(a, b, (i + 0.5) / n);
      const street = input.streetRuns.some((r) => distanceToSegment(m, r.a, r.b) < 0.05);
      // A registered exit directly outside this piece (looking straight out up to exitNearM).
      const exit =
        street &&
        [0.1, 0.75, 1.5, 2.25, s.exitNearM].some((d) => {
          const q: Point = [m[0] + out_[0] * d, m[1] + out_[1] * d];
          return input.exits.some((e) => contains(e, q));
        });
      // Highest thing on the line here (inside a narrow band), away from buildings.
      let heightM: number | null = null;
      let top: Point | null = null;
      if (input.grid) {
        let h = -Infinity;
        for (const t of [-s.bandInM, -s.bandInM / 2, -0.1, s.bandOutM]) {
          // t < 0 is inside the plot (against the outward normal).
          const qq: Point = [m[0] + out_[0] * t, m[1] + out_[1] * t];
          if (input.buildings.some((bd) => nearPolygon(qq, bd, s.buildingBufferM))) continue;
          const v = heightAt(input.grid, qq);
          if (Number.isFinite(v) && v > h) {
            h = v;
            top = qq;
          }
        }
        heightM = Number.isFinite(h) ? Math.round(Math.max(0, h) * 10) / 10 : null;
      }
      const mapBarrier = nearLine(m, input.mapBarriers, s.bgtNearM);
      const mapHedge = nearLine(m, input.mapHedges, s.bgtNearM);
      let state: BoundaryState;
      let material: Material | null = null;
      let source: BoundaryPiece["source"];
      if (exit) {
        state = "exit";
        source = "exit";
      } else if (mapBarrier || mapHedge) {
        state = mapBarrier ? "barrier" : "hedge";
        material = mapBarrier ? "solid" : "plant";
        source = "map";
      } else if (heightM === null) {
        state = "unknown";
        source = "none";
      } else if (heightM < s.barrierM) {
        state = "open";
        source = "scan";
      } else {
        material = materialAt(top ?? m, input.echo, input.ndvi).material;
        state = material === "plant" ? "hedge" : material === "solid" ? "barrier" : "unknown";
        source = "scan";
      }
      out.push({
        a: pa,
        b: pb,
        side: street ? "street" : "other",
        state,
        heightM,
        material,
        source,
      });
    }
  }
  return out;
}

/** Joins consecutive pieces with the same side and state (for drawing and describing). */
export function boundaryRuns(pieces: BoundaryPiece[]): (BoundaryPiece & { lengthM: number })[] {
  const out: (BoundaryPiece & { lengthM: number })[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (
      last &&
      last.side === p.side &&
      last.state === p.state &&
      Math.hypot(last.b[0] - p.a[0], last.b[1] - p.a[1]) < 1e-6
    ) {
      last.b = p.b;
      last.lengthM += length(p.a, p.b);
      if (p.heightM !== null) last.heightM = Math.max(last.heightM ?? 0, p.heightM);
    } else out.push({ ...p, lengthM: length(p.a, p.b) });
  }
  for (const r of out) r.lengthM = Math.round(r.lengthM * 10) / 10;
  return out;
}
