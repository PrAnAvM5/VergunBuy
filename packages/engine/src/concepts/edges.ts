/**
 * Concept: plot edge classification (ADR-016).
 *
 * For every edge of the plot we ask: "what is on the other side?"
 * We walk along the edge in small steps, look a short distance outward,
 * and record what we find. Consecutive steps with the same answer become one run.
 *
 *   public     publicly accessible area (road, footpath, square, green) — Bbl definition
 *   water      water next to the plot; navigable or not is not known from data, so it is flagged
 *   rear-path  a narrow path that only serves plots; NOT public area (ADR-017)
 *   shared-wall our house is built against a neighbouring building here
 *   neighbour  a neighbouring private plot
 *   unknown    public-area data was not available, so we cannot tell public from private.
 *              Never treated as "neighbour": that could hide a road and create a false green.
 */
import { derived, type Fact } from "../facts.ts";
import {
  contains,
  distanceToBoundary,
  edges,
  length,
  lerp,
  outwardNormal,
  type Point,
  type Polygon,
} from "../geometry.ts";

export type PublicAreaKind = "road" | "footpath" | "square" | "green" | "water" | "rear-path";

export interface PublicArea {
  id: string;
  kind: PublicAreaKind;
  outline: Polygon;
}

export type EdgeKind = "public" | "water" | "rear-path" | "shared-wall" | "neighbour" | "unknown";

export interface EdgeRun {
  /** Index of the plot edge (edge i runs from point i to point i+1). */
  edge: number;
  /** Start and end along the edge, as a fraction 0..1. */
  from: number;
  to: number;
  kind: EdgeKind;
  lengthM: number;
  /** Id of the public area or neighbouring building found on the other side, if any. */
  otherSide?: string;
}

export interface EdgeInput {
  plot: Polygon;
  house: Polygon;
  neighbourBuildings: { id: string; outline: Polygon }[];
  /** null when public-area data could not be fetched (fallback: edges become "unknown"). */
  publicAreas: PublicArea[] | null;
}

export const EDGE_SETTINGS = {
  /** Distance between samples along an edge. */
  stepM: 0.25,
  /** How far outside the plot we look. BRK boundaries are indicative, so not too close. */
  probeM: 0.5,
  /** A plot edge counts as "at the house" when the house wall is this close to it. */
  wallToleranceM: 0.3,
} as const;

function sideAt(
  input: EdgeInput,
  onEdge: Point,
  outside: Point,
): Omit<EdgeRun, "edge" | "from" | "to" | "lengthM"> {
  const area = input.publicAreas?.find((a) => contains(a.outline, outside));
  if (area) {
    const kind: EdgeKind =
      area.kind === "water" ? "water" : area.kind === "rear-path" ? "rear-path" : "public";
    return { kind, otherSide: area.id };
  }
  const nearHouse = distanceToBoundary(input.house, onEdge) <= EDGE_SETTINGS.wallToleranceM;
  const building = input.neighbourBuildings.find((b) => contains(b.outline, outside));
  if (nearHouse && building) return { kind: "shared-wall", otherSide: building.id };
  if (input.publicAreas === null) return { kind: "unknown" };
  return { kind: "neighbour" };
}

export function classifyEdges(input: EdgeInput): EdgeRun[] {
  const runs: EdgeRun[] = [];
  edges(input.plot).forEach(([a, b], edge) => {
    const len = length(a, b);
    const n = outwardNormal(input.plot, a, b);
    const steps = Math.max(1, Math.round(len / EDGE_SETTINGS.stepM));
    for (let s = 0; s < steps; s++) {
      const from = s / steps;
      const to = (s + 1) / steps;
      const mid = lerp(a, b, (from + to) / 2);
      const outside: Point = [
        mid[0] + n[0] * EDGE_SETTINGS.probeM,
        mid[1] + n[1] * EDGE_SETTINGS.probeM,
      ];
      const side = sideAt(input, mid, outside);
      const last = runs[runs.length - 1];
      if (
        last &&
        last.edge === edge &&
        last.kind === side.kind &&
        last.otherSide === side.otherSide
      ) {
        last.to = to;
        last.lengthM = len * (last.to - last.from);
      } else {
        runs.push({ edge, from, to, lengthM: len * (to - from), ...side });
      }
    }
  });
  return runs.map((r) => ({ ...r, lengthM: Math.round(r.lengthM * 100) / 100 }));
}

export type HouseType = "detached" | "semi-or-end" | "terraced" | "corner";

/**
 * House type is DERIVED from edge classes and used only for explanations and tests.
 * Zones never depend on it (ADR-015).
 */
export function deriveHouseType(runs: EdgeRun[]): HouseType {
  const edgesWith = (kind: EdgeKind) =>
    new Set(runs.filter((r) => r.kind === kind).map((r) => r.edge)).size;
  const walls = edgesWith("shared-wall");
  // A house with no shared wall is detached, even when two sides face public land
  // (seen on real rural plots in Ossendrecht and Putte). "Corner" only applies to attached houses.
  if (walls === 0) return "detached";
  if (edgesWith("public") >= 2) return "corner";
  return walls >= 2 ? "terraced" : "semi-or-end";
}

export function edgeFacts(input: EdgeInput): {
  edges: Fact<EdgeRun[]>;
  houseType: Fact<HouseType>;
} {
  const runs = classifyEdges(input);
  const houseType = deriveHouseType(runs);
  const count = (k: EdgeKind) => runs.filter((r) => r.kind === k).length;
  return {
    edges: derived(runs, {
      step: "classify-edges",
      inputs: ["plot.outline", "house.outline", "neighbours", "publicAreas"],
      sources: [{ name: "BRK perceel" }, { name: "BAG pand" }, { name: "BGT" }],
      note: `${count("public")} public, ${count("shared-wall")} shared-wall, ${count("neighbour")} neighbour, ${count("rear-path")} rear-path, ${count("water")} water and ${count("unknown")} unknown run(s) along the plot boundary.`,
    }),
    houseType: derived(houseType, {
      step: "classify-edges",
      inputs: ["edges"],
      sources: [],
      note: `Derived from the boundary: ${houseType}. Used for explanation only.`,
    }),
  };
}
