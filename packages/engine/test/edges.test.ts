import { describe, expect, it } from "vitest";
import {
  classifyEdges,
  deriveHouseType,
  edgeFacts,
  type EdgeInput,
  type EdgeKind,
} from "../src/index.ts";
import type { Polygon } from "../src/geometry.ts";

/** Axis-aligned rectangle as an open, counter-clockwise ring. */
const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const street = { id: "street-front", kind: "road" as const, outline: rect(-30, -8, 40, 0) };

/** Metres along the boundary with this kind of neighbour. */
const metres = (input: EdgeInput, kind: EdgeKind) =>
  classifyEdges(input)
    .filter((r) => r.kind === kind)
    .reduce((sum, r) => sum + r.lengthM, 0);

// Street at y < 0, so the front of every plot is the edge at y = 0.
const terraced: EdgeInput = {
  plot: rect(0, 0, 7, 15),
  house: rect(0, 2, 7, 6),
  neighbourBuildings: [
    { id: "left", outline: rect(-7, 2, 0, 6) },
    { id: "right", outline: rect(7, 2, 14, 6) },
  ],
  publicAreas: [street, { id: "rear", kind: "rear-path", outline: rect(-30, 15, 40, 16.2) }],
};

const corner: EdgeInput = {
  plot: rect(0, 0, 13, 15),
  house: rect(0, 2, 7, 6),
  neighbourBuildings: [{ id: "left", outline: rect(-7, 2, 0, 6) }],
  publicAreas: [street, { id: "street-side", kind: "road", outline: rect(13, -8, 18, 30) }],
};

const detached: EdgeInput = {
  plot: rect(0, 0, 15, 15),
  house: rect(4.5, 3, 10.5, 7.5),
  neighbourBuildings: [
    { id: "far-left", outline: rect(-12, 3, -4, 8) },
    { id: "far-right", outline: rect(19, 3, 26, 8) },
  ],
  publicAreas: [street],
};

describe("classifyEdges", () => {
  it("terraced: front is public, both sides share a 4 m wall, rear path is not public", () => {
    expect(metres(terraced, "public")).toBeCloseTo(7, 1);
    expect(metres(terraced, "shared-wall")).toBeCloseTo(8, 0);
    expect(metres(terraced, "rear-path")).toBeCloseTo(7, 1);
    expect(deriveHouseType(classifyEdges(terraced))).toBe("terraced");
  });

  it("corner: two public sides make it a corner plot", () => {
    expect(metres(corner, "public")).toBeCloseTo(13 + 15, 1);
    expect(metres(corner, "shared-wall")).toBeCloseTo(4, 0);
    expect(deriveHouseType(classifyEdges(corner))).toBe("corner");
  });

  it("detached: one public edge, no shared walls", () => {
    expect(metres(detached, "public")).toBeCloseTo(15, 1);
    expect(metres(detached, "shared-wall")).toBe(0);
    expect(deriveHouseType(classifyEdges(detached))).toBe("detached");
  });

  it("does not depend on the winding direction of the plot polygon", () => {
    const clockwise = { ...terraced, plot: [...terraced.plot].reverse() };
    expect(metres(clockwise, "shared-wall")).toBeCloseTo(8, 0);
    expect(metres(clockwise, "public")).toBeCloseTo(7, 1);
  });

  it("returns explainable facts with certainty and a note", () => {
    const facts = edgeFacts(terraced);
    expect(facts.edges.certainty).toBe("derived");
    expect(facts.edges.step).toBe("classify-edges");
    expect(facts.houseType.note).toContain("terraced");
  });
});
