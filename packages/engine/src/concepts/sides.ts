/**
 * Concept: what lies on each side of the plot (front, rear, left, right), in plain words.
 * Built from the classified edge runs and the plot frame (street at the bottom).
 * This is how the platform "reads" the surroundings: every metre of boundary is accounted for.
 */
import type { EdgeKind, EdgeRun } from "./edges.ts";
import type { PlotFrame } from "./frame.ts";
import { at, outwardNormal, type Polygon } from "../geometry.ts";

export type Side = "front" | "rear" | "left" | "right";

export interface SidePart {
  kind: EdgeKind;
  /** Plain description, e.g. "carriageway (Aalbersestraat)", "shared wall", "neighbouring plot". */
  label: string;
  lengthM: number;
}

export interface SideSummary {
  side: Side;
  lengthM: number;
  parts: SidePart[];
  /** A road lies just beyond this side, across a pavement or verge (see pavementCrossings). */
  roadBeyond?: { acrossM: number; lengthM: number; via: string[] };
}

/** Which side a plot edge belongs to, from its outward normal in the plot's own frame. */
export function sideOfEdge(frame: PlotFrame, plot: Polygon, edge: number): Side {
  const a = at(plot, edge);
  const b = at(plot, edge + 1);
  const n = outwardNormal(plot, a, b);
  const c = Math.cos(frame.rotation);
  const s = Math.sin(frame.rotation);
  const nx = n[0] * c - n[1] * s;
  const ny = n[0] * s + n[1] * c;
  if (Math.abs(ny) >= Math.abs(nx)) return ny < 0 ? "front" : "rear";
  return nx < 0 ? "left" : "right";
}

const KIND_LABEL: Record<EdgeKind, string> = {
  public: "public area",
  water: "water",
  "rear-path": "rear path",
  "shared-wall": "shared wall with the neighbour",
  neighbour: "neighbouring plot",
  unknown: "unknown (data missing)",
};

/**
 * @param describePublic  label for a public area by id, e.g. "carriageway (Aalbersestraat)"
 */
export function describeSides(
  frame: PlotFrame,
  plot: Polygon,
  runs: EdgeRun[],
  describePublic: (otherSide: string | undefined) => string | undefined,
): SideSummary[] {
  const sides = new Map<Side, Map<string, SidePart>>();
  for (const r of runs) {
    const side = sideOfEdge(frame, plot, r.edge);
    const label =
      r.kind === "public" ? (describePublic(r.otherSide) ?? KIND_LABEL.public) : KIND_LABEL[r.kind];
    const parts = sides.get(side) ?? new Map<string, SidePart>();
    const key = `${r.kind}|${label}`;
    const part = parts.get(key) ?? { kind: r.kind, label, lengthM: 0 };
    part.lengthM += r.lengthM;
    parts.set(key, part);
    sides.set(side, parts);
  }
  const order: Side[] = ["front", "rear", "left", "right"];
  return order
    .filter((s) => sides.has(s))
    .map((side) => {
      const parts = [...(sides.get(side)?.values() ?? [])]
        .map((p) => ({ ...p, lengthM: Math.round(p.lengthM * 10) / 10 }))
        .sort((a, b) => b.lengthM - a.lengthM);
      return {
        side,
        lengthM: Math.round(parts.reduce((s, p) => s + p.lengthM, 0) * 10) / 10,
        parts,
      };
    });
}
