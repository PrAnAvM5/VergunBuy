/**
 * Concept: the plot's own frame, "street at the bottom" (like the MVP plans).
 *
 * The front of the plot is the public boundary that faces the address's own street.
 * 0. The own street's centre line in the national road register, NWB (method "road-register").
 * 1. The street-name label of that street in the BGT next to the plot (method "street-label").
 * 2. Otherwise two of these agreeing on one side (method "agreed"): the own street's label
 *    further away (up to about 150 m), the registered driveway crossing, and the side nearest
 *    the address point (the national address register puts it in the building, as a rule near
 *    the entrance; the legal front is the façade with the main entrance).
 * 3. Fallback: the side with the driveway crossing, else the longest public boundary, roads
 *    counting more than paths or green (method "longest-public"): labelled as estimated.
 *
 * Local coordinates: metres, origin at the plot centre, x to the right along the street,
 * y pointing away from the street (into the plot), so the street is at the bottom.
 */
import type { EdgeRun } from "./edges.ts";
import {
  at,
  centroid,
  edges,
  length,
  outwardNormal,
  type Point,
  type Polygon,
} from "../geometry.ts";

export interface PlotFrame {
  origin: Point;
  /** Rotation applied to RD coordinates (radians). */
  rotation: number;
  frontEdge: number;
  method: "road-register" | "street-label" | "agreed" | "longest-public" | "none";
  streetName?: string;
  /** What decided the front, in plain words (for "agreed" and the fallback). */
  evidence?: string[];
}

/** Extra clues for the front when no street-name label lies next to the plot. */
export interface FrontHints {
  /**
   * Points along the own street's centre line from the national road register (NWB), near the
   * plot: the strongest evidence (the register names every road segment).
   */
  roadPoints?: { at: Point; name: string }[];
  /** The own street's labels further away. */
  farLabels?: { at: Point; name: string }[];
  /** Registered driveway crossings that touch or face the plot. */
  exits?: Polygon[];
  /** The address point (national address register). */
  addressPoint?: Point;
}

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface PlotLayout {
  plot: Box;
  house?: Box;
  /** Plot width along the street and depth away from it (bounding box in the local frame). */
  plotWidthM: number;
  plotDepthM: number;
  houseWidthM?: number;
  houseDepthM?: number;
  /** House to plot boundary, measured in the local frame (bounding boxes). */
  setbacks?: { frontM: number; rearM: number; leftM: number; rightM: number };
}

export function toLocal(frame: PlotFrame, p: Point): Point {
  const dx = p[0] - frame.origin[0];
  const dy = p[1] - frame.origin[1];
  const c = Math.cos(frame.rotation);
  const s = Math.sin(frame.rotation);
  return [dx * c - dy * s, dx * s + dy * c];
}

export const polyToLocal = (frame: PlotFrame, poly: Polygon): Polygon =>
  poly.map((p) => toLocal(frame, p));

const KIND_WEIGHT: Record<string, number> = { public: 1 };

export function plotFrame(
  plot: Polygon,
  runs: EdgeRun[],
  streetLabels: { at: Point; name: string }[],
  publicKindOf: (otherSide: string | undefined) => string | undefined = () => undefined,
  hints: FrontHints = {},
): PlotFrame {
  const origin = centroid(plot);
  const publicLen = new Map<number, number>();
  for (const r of runs)
    if (r.kind === "public") publicLen.set(r.edge, (publicLen.get(r.edge) ?? 0) + r.lengthM);
  const candidates = [...publicLen.entries()].filter(([, len]) => len >= 1).map(([i]) => i);

  let front: number | undefined;
  let method: PlotFrame["method"] = "none";
  let streetName: string | undefined;

  // The edge that faces a label: label on the outside, closest to the edge.
  const facing = (labels: { at: Point; name: string }[]) => {
    let best = Infinity;
    let edge: number | undefined;
    let name: string | undefined;
    for (const label of labels)
      for (const i of candidates) {
        const a = at(plot, i);
        const b = at(plot, i + 1);
        const n = outwardNormal(plot, a, b);
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const toLabel: Point = [label.at[0] - mid[0], label.at[1] - mid[1]];
        if (toLabel[0] * n[0] + toLabel[1] * n[1] <= 0) continue; // label is behind this edge
        const d = length(mid, label.at);
        if (d < best) {
          best = d;
          edge = i;
          name = label.name;
        }
      }
    return edge === undefined ? undefined : { edge, name: name! };
  };

  // 0. The own street's centre line (road register): the side that looks straight at it — a
  // line out from the side, square to it, reaches the centre line soonest. (Nearest by plain
  // distance would also pick a side edge near where the street runs on past the corner.)
  const facingRoad = (pts: { at: Point; name: string }[]) => {
    let best = Infinity;
    let edge: number | undefined;
    let name: string | undefined;
    for (const i of candidates) {
      const a = at(plot, i);
      const b = at(plot, i + 1);
      const len = length(a, b);
      if (len < 0.5) continue;
      const n = outwardNormal(plot, a, b);
      const t: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (const p of pts) {
        const dx = p.at[0] - mid[0];
        const dy = p.at[1] - mid[1];
        const out = dx * n[0] + dy * n[1];
        const side = Math.abs(dx * t[0] + dy * t[1]);
        if (out <= 0 || side > len / 2 + 1.5) continue;
        if (out < best) {
          best = out;
          edge = i;
          name = p.name;
        }
      }
    }
    return edge === undefined ? undefined : { edge, name: name! };
  };
  // On a corner where the own street bends round the plot, the front is the side facing the bit
  // of the street nearest the address point (the register places it by the entrance).
  let road: { edge: number; name: string } | undefined;
  const rp = hints.roadPoints ?? [];
  if (rp.length && hints.addressPoint) {
    const ap = hints.addressPoint;
    const near = rp.reduce((b, p) => (length(p.at, ap) < length(b.at, ap) ? p : b));
    road = facingRoad(rp.filter((p) => length(p.at, near.at) <= 10));
  }
  if (!road) road = facingRoad(rp);
  if (road) {
    front = road.edge;
    streetName = road.name;
    method = "road-register";
  }
  // 1. The own street's label next to the plot.
  const near = front === undefined ? facing(streetLabels) : undefined;
  if (near) {
    front = near.edge;
    streetName = near.name;
    method = "street-label";
  }

  // 2. Two clues agreeing on one side. A side may be several plot edges in a row (a kink or a
  // split point): edges facing within 25° of each other, one after another, are one side.
  const nE = edges(plot).length;
  const side = new Array<number>(nE).fill(-1);
  const ang = (i: number) => {
    const o = outwardNormal(plot, at(plot, i), at(plot, i + 1));
    return Math.atan2(o[1], o[0]);
  };
  const close = (x: number, y: number) =>
    Math.abs(((x - y + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < (25 * Math.PI) / 180;
  let sid = 0;
  for (let i = 0; i < nE; i++) {
    if (i > 0 && close(ang(i), ang(i - 1))) side[i] = side[i - 1]!;
    else side[i] = sid++;
  }
  if (nE > 1 && close(ang(0), ang(nE - 1))) {
    const last = side[nE - 1]!;
    for (let i = 0; i < nE; i++) if (side[i] === last) side[i] = side[0]!;
  }
  // The best edge of a side: the one with the most public boundary.
  const bestOf = (g: number) =>
    candidates
      .filter((i) => side[i] === g)
      .sort((p, q) => (publicLen.get(q) ?? 0) - (publicLen.get(p) ?? 0))[0];
  let evidence: string[] | undefined;
  let exitEdge: number | undefined;
  if (front === undefined && candidates.length) {
    const votes = new Map<number, string[]>();
    const vote = (edge: number | undefined, why: string) => {
      if (edge === undefined) return;
      const g = side[edge]!;
      votes.set(g, [...(votes.get(g) ?? []), why]);
    };
    const far = facing(hints.farLabels ?? []);
    vote(far?.edge, `faces ${far?.name ?? "the street"} (street-name label further along)`);
    // The candidate side the driveway crossings touch most.
    const exitLen = new Map<number, number>();
    for (const ex of hints.exits ?? []) {
      let bestD = Infinity;
      let bestI: number | undefined;
      for (const i of candidates) {
        const d = Math.min(...ex.map((p) => distToSegment(p, at(plot, i), at(plot, i + 1))));
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI !== undefined && bestD <= 3) exitLen.set(bestI, (exitLen.get(bestI) ?? 0) + 1);
    }
    const exitSides = new Set([...exitLen.keys()].map((i) => side[i]));
    if (exitSides.size === 1) exitEdge = bestOf(side[[...exitLen.keys()][0]!]!);
    vote(exitEdge, "has the registered driveway crossing");
    // The candidate side clearly nearest the address point (at least 1.5 times nearer).
    if (hints.addressPoint) {
      const ds = candidates
        .map((i) => ({ i, d: distToSegment(hints.addressPoint!, at(plot, i), at(plot, i + 1)) }))
        .sort((p, q) => p.d - q.d);
      // Nearest per side, then the nearest side must be clearly nearer than the next.
      const perSide = new Map<number, number>();
      for (const x of ds) if (!perSide.has(side[x.i]!)) perSide.set(side[x.i]!, x.d);
      const sd = [...perSide.entries()].sort((p, q) => p[1] - q[1]);
      if (sd.length === 1 || (sd[0] && sd[1] && sd[1][1] >= 1.5 * sd[0][1]))
        vote(bestOf(sd[0]![0]), "is nearest the address point (front door)");
    }
    for (const [g, why] of votes)
      if (why.length >= 2) {
        front = bestOf(g);
        method = "agreed";
        evidence = why;
        if (far && side[far.edge] === g) streetName = far.name;
        break;
      }
  }

  // 3. Fallback: the side with the driveway crossing, else the longest public boundary, roads
  // weighted above paths and green.
  if (front === undefined && exitEdge !== undefined) {
    front = exitEdge;
    method = "longest-public";
    evidence = ["has the registered driveway crossing (no other clue agrees)"];
  }
  if (front === undefined && candidates.length) {
    let score = -Infinity;
    for (const r of runs) {
      if (r.kind !== "public") continue;
      const kind = publicKindOf(r.otherSide);
      const w = kind === "road" ? 3 : kind === "footpath" ? 1.5 : (KIND_WEIGHT[kind ?? ""] ?? 1);
      if (r.lengthM * w > score) {
        score = r.lengthM * w;
        front = r.edge;
      }
    }
    method = "longest-public";
  }

  if (front === undefined) {
    // No public edge at all: keep north up.
    return { origin, rotation: 0, frontEdge: -1, method: "none" };
  }
  const a = at(plot, front);
  const b = at(plot, front + 1);
  const n = outwardNormal(plot, a, b);
  // Rotate so the outward normal of the front edge points down (0, -1).
  const rotation = Math.atan2(-1, 0) - Math.atan2(n[1], n[0]);
  return {
    origin,
    rotation,
    frontEdge: front,
    method,
    ...(streetName ? { streetName } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function boxOf(poly: Polygon): Box {
  return {
    minX: Math.min(...poly.map((p) => p[0])),
    maxX: Math.max(...poly.map((p) => p[0])),
    minY: Math.min(...poly.map((p) => p[1])),
    maxY: Math.max(...poly.map((p) => p[1])),
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function plotLayout(frame: PlotFrame, plot: Polygon, house?: Polygon): PlotLayout {
  const p = boxOf(polyToLocal(frame, plot));
  const layout: PlotLayout = {
    plot: p,
    plotWidthM: r1(p.maxX - p.minX),
    plotDepthM: r1(p.maxY - p.minY),
  };
  if (house && house.length) {
    const h = boxOf(polyToLocal(frame, house));
    layout.house = h;
    layout.houseWidthM = r1(h.maxX - h.minX);
    layout.houseDepthM = r1(h.maxY - h.minY);
    layout.setbacks = {
      frontM: r1(Math.max(0, h.minY - p.minY)),
      rearM: r1(Math.max(0, p.maxY - h.maxY)),
      leftM: r1(Math.max(0, h.minX - p.minX)),
      rightM: r1(Math.max(0, p.maxX - h.maxX)),
    };
  }
  return layout;
}

/** The number of plot edges, re-exported so callers can iterate without geometry imports. */
export const edgeCount = (plot: Polygon) => edges(plot).length;
