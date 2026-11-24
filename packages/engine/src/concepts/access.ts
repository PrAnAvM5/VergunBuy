/**
 * Concept: can a car get onto the plot? (carport precondition)
 *
 * Evidence ladder:
 *  1. registered  a registered driveway crossing (BGT wegdeel "inrit") touches the plot → pass
 *  2. possible    a plot edge lies directly on a carriageway, parking area or shared yard,
 *                 so a car can physically reach the boundary, but no crossing is registered → unknown
 *     possible    (across pavement) the plot edge lies on a pavement or verge with a road just
 *                 beyond it. The usual Dutch front: cars cross the kerb on a lowered crossing that
 *                 is often not mapped as "inrit". Found by looking straight out from the boundary
 *                 (see pavementCrossings) → unknown
 *  3. none-found  no registered crossing and no car-usable surface along the plot → unknown
 *                 (registers are incomplete: rural and rear exits are often not recorded)
 *  4. unknown     public-area data is missing → unknown
 *
 * Access is never "fail" from data alone: a missing record is not proof that there is no exit.
 */
import type { Outcome } from "../facts.ts";
import {
  contains,
  edges,
  length,
  lerp,
  outwardNormal,
  type Point,
  type Polygon,
} from "../geometry.ts";

export type AccessLevel = "registered" | "possible" | "none-found" | "unknown";

/** BGT road functions a car can drive on up to the plot boundary. */
export const CAR_SURFACES = ["rijbaan", "parkeervlak", "inrit", "erf", "woonerf", "parkeerplaats"];

export const isCarSurface = (functie: string | undefined) =>
  !!functie &&
  CAR_SURFACES.some((s) => functie.toLowerCase().includes(s)) &&
  !/voet|fiets|ruiter/i.test(functie);

export interface AccessInput {
  publicDataAvailable: boolean;
  registeredExits: number;
  /** Length of each stretch of plot boundary lying directly on a car-usable surface. */
  carReachableRunsM: number[];
  /** Stretches where a road lies just beyond a pavement or verge (see pavementCrossings). */
  pavementRuns?: { lengthM: number; acrossM: number }[];
}

export interface AccessResult {
  level: AccessLevel;
  /** How a car would reach the plot, when level is "possible". */
  route?: "direct" | "across-pavement";
  outcome: Outcome;
  reason: string;
}

/** Minimum stretch of boundary a car needs (about a car's width plus margin). */
export const MIN_ACCESS_WIDTH_M = 2.5;

export function assessAccess(input: AccessInput): AccessResult {
  if (!input.publicDataAvailable)
    return {
      level: "unknown",
      outcome: "unknown",
      reason: "Street data could not be loaded, so car access is unknown.",
    };
  if (input.registeredExits > 0)
    return {
      level: "registered",
      outcome: "pass",
      reason: `${input.registeredExits} registered driveway crossing${input.registeredExits > 1 ? "s" : ""} touch${input.registeredExits > 1 ? "" : "es"} the plot.`,
    };
  const wide = input.carReachableRunsM.filter((m) => m >= MIN_ACCESS_WIDTH_M);
  if (wide.length > 0)
    return {
      level: "possible",
      route: "direct",
      outcome: "unknown",
      reason: `A car can reach the plot boundary over ${Math.max(...wide).toFixed(1)} m, but no driveway crossing is registered there. Check the aerial photo; a new exit needs its own permit.`,
    };
  const kerb = (input.pavementRuns ?? []).filter((r) => r.lengthM >= MIN_ACCESS_WIDTH_M);
  if (kerb.length > 0) {
    const best = kerb.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
    return {
      level: "possible",
      route: "across-pavement",
      outcome: "unknown",
      reason: `The road lies ${best.acrossM.toFixed(1)} m beyond the plot, across a pavement or verge, over a ${best.lengthM.toFixed(1)} m stretch. Most homes are reached this way, but no driveway crossing is registered there. Check the aerial photo; a new crossing needs its own permit.`,
    };
  }
  return {
    level: "none-found",
    outcome: "unknown",
    reason:
      "No registered driveway crossing and no road or parking area directly along the plot. Registers often miss exits (especially rural and rear ones), so check the aerial photo.",
  };
}

export interface PavementRun {
  edge: number;
  /** Start and end along the edge, as a fraction 0..1. */
  from: number;
  to: number;
  lengthM: number;
  /** Largest distance from the boundary to the road along this stretch. */
  acrossM: number;
  /** What the car would cross, e.g. ["voetpad", "groenvoorziening"]. */
  via: string[];
}

export const PAVEMENT_SETTINGS = {
  stepM: 0.5,
  marchM: 0.25,
  /** Pavement plus a normal verge or parking strip; further than this is not "just beyond". */
  maxAcrossM: 8,
} as const;

/** Label used for ground that BGT does not map as public but that lies on the road's own parcel. */
export const ROAD_PARCEL_VERGE = "verge on the road's parcel";

/**
 * Looks straight out from every stretch of boundary that lies on public, non-car ground (pavement,
 * verge, square). Walking outward, it may cross only public ground; it stops at private land,
 * buildings or water. If it reaches a car surface within maxAcrossM, that stretch counts.
 *
 * Ground that BGT does not map as public (e.g. a verge registered as unpaved terrain) is crossed
 * only when it lies on the same cadastral parcel as the road it leads to: then it is part of the
 * road's land, not someone's garden. Without parcels such ground always stops the walk.
 */
export function pavementCrossings(
  plot: Polygon,
  areas: { outline: Polygon; label: string; kind: string }[],
  parcels: { id: string; outline: Polygon }[] = [],
  isCar: (label: string) => boolean = (l) => isCarSurface(l),
): PavementRun[] {
  const S = PAVEMENT_SETTINGS;
  const areaAt = (p: Point) => areas.find((a) => contains(a.outline, p));
  const parcelAt = (p: Point) =>
    parcels.find((x) => !samePolygon(x.outline, plot) && contains(x.outline, p))?.id;
  const runs: PavementRun[] = [];
  edges(plot).forEach(([a, b], edge) => {
    const len = length(a, b);
    const n = outwardNormal(plot, a, b);
    const steps = Math.max(1, Math.round(len / S.stepM));
    for (let s = 0; s < steps; s++) {
      const mid = lerp(a, b, (s + 0.5) / steps);
      const at = (d: number): Point => [mid[0] + n[0] * d, mid[1] + n[1] * d];
      const first = areaAt(at(0.5));
      if (first && (first.kind === "water" || isCar(first.label))) continue;
      const via = new Set<string>();
      /** Parcels of unmapped ground crossed so far; they must all be the road's parcel. */
      const unmapped = new Set<string>();
      let hit: number | null = null;
      for (let d = 0.5; d <= S.maxAcrossM; d += S.marchM) {
        const p = at(d);
        const here = areaAt(p);
        if (here?.kind === "water") break;
        if (here && isCar(here.label)) {
          const roadParcel = parcelAt(p);
          if (
            unmapped.size === 0 ||
            (unmapped.size === 1 && roadParcel && unmapped.has(roadParcel))
          )
            hit = d;
          break;
        }
        if (here) {
          via.add(here.label);
          continue;
        }
        const parcel = parcelAt(p);
        if (!parcel) break;
        unmapped.add(parcel);
        if (unmapped.size > 1) break;
      }
      if (hit === null) continue;
      if (unmapped.size) via.add(ROAD_PARCEL_VERGE);
      const from = s / steps;
      const to = (s + 1) / steps;
      const last = runs[runs.length - 1];
      if (last && last.edge === edge && Math.abs(last.to - from) < 1e-9) {
        last.to = to;
        last.lengthM = len * (last.to - last.from);
        last.acrossM = Math.max(last.acrossM, hit);
        for (const v of via) if (!last.via.includes(v)) last.via.push(v);
      } else {
        runs.push({ edge, from, to, lengthM: len * (to - from), acrossM: hit, via: [...via] });
      }
    }
  });
  return runs.map((r) => ({
    ...r,
    lengthM: Math.round(r.lengthM * 100) / 100,
    acrossM: Math.round(r.acrossM * 100) / 100,
  }));
}

/** True when two outlines have the same points (the plot itself appears among the parcels). */
function samePolygon(a: Polygon, b: Polygon): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 1e-6 && Math.abs(p[1] - b[i]![1]) < 1e-6)
  );
}
