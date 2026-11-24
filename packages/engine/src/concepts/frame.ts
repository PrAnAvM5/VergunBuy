/**
 * Concept: the plot's own frame, "street at the bottom" (like the MVP plans).
 *
 * The front of the plot is the public boundary that faces the address's own street.
 * Best evidence: the street-name label of that street in the BGT (method "street-label").
 * Fallback: the longest public boundary, roads counting more than paths or green
 * (method "longest-public"), which can be wrong on corner plots and is labelled as such.
 *
 * Local coordinates: metres, origin at the plot centre, x to the right along the street,
 * y pointing away from the street (into the plot), so the street is at the bottom.
 */
import type { EdgeRun } from "./edges.ts";
import { at, edges, length, outwardNormal, type Point, type Polygon } from "../geometry.ts";

export interface PlotFrame {
  origin: Point;
  /** Rotation applied to RD coordinates (radians). */
  rotation: number;
  frontEdge: number;
  method: "street-label" | "longest-public" | "none";
  streetName?: string;
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

function centroid(poly: Polygon): Point {
  return [
    poly.reduce((s, p) => s + p[0], 0) / poly.length,
    poly.reduce((s, p) => s + p[1], 0) / poly.length,
  ];
}

const KIND_WEIGHT: Record<string, number> = { public: 1 };

export function plotFrame(
  plot: Polygon,
  runs: EdgeRun[],
  streetLabels: { at: Point; name: string }[],
  publicKindOf: (otherSide: string | undefined) => string | undefined = () => undefined,
): PlotFrame {
  const origin = centroid(plot);
  const publicLen = new Map<number, number>();
  for (const r of runs)
    if (r.kind === "public") publicLen.set(r.edge, (publicLen.get(r.edge) ?? 0) + r.lengthM);
  const candidates = [...publicLen.entries()].filter(([, len]) => len >= 1).map(([i]) => i);

  let front: number | undefined;
  let method: PlotFrame["method"] = "none";
  let streetName: string | undefined;

  // 1. The edge that faces the street-name label: label on the outside, closest to the edge.
  let best = Infinity;
  for (const label of streetLabels) {
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
        front = i;
        streetName = label.name;
        method = "street-label";
      }
    }
  }

  // 2. Fallback: longest public boundary, roads weighted above paths and green.
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
  return { origin, rotation, frontEdge: front, method, ...(streetName ? { streetName } : {}) };
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
