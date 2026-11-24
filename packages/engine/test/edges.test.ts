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

  it("detached on a corner (no shared wall, two public sides) is still detached", () => {
    const rural = { ...corner, neighbourBuildings: [] };
    expect(deriveHouseType(classifyEdges(rural))).toBe("detached");
  });

  it("does not depend on the winding direction of the plot polygon", () => {
    const clockwise = { ...terraced, plot: [...terraced.plot].reverse() };
    expect(metres(clockwise, "shared-wall")).toBeCloseTo(8, 0);
    expect(metres(clockwise, "public")).toBeCloseTo(7, 1);
  });

  it("marks edges unknown (never neighbour) when public-area data is missing", () => {
    const missing = { ...detached, publicAreas: null };
    expect(metres(missing, "public")).toBe(0);
    expect(metres(missing, "neighbour")).toBe(0);
    expect(metres(missing, "unknown")).toBeCloseTo(60, 0);
  });

  it("returns explainable facts with certainty and a note", () => {
    const facts = edgeFacts(terraced);
    expect(facts.edges.certainty).toBe("derived");
    expect(facts.edges.step).toBe("classify-edges");
    expect(facts.houseType.note).toContain("terraced");
  });
});

describe("orientedBox", () => {
  it("measures a rotated rectangle along its own axes", async () => {
    const { orientedBox } = await import("../src/geometry.ts");
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const rot = (x: number, y: number) => [x * c - y * s, x * s + y * c] as const;
    const box = orientedBox([rot(0, 0), rot(9, 0), rot(9, 6), rot(0, 6)]);
    expect(box.lengthM).toBeCloseTo(9, 1);
    expect(box.widthM).toBeCloseTo(6, 1);
  });
});

describe("change points along an edge", () => {
  it("are located to within 1 cm, not to the 25 cm sample spacing", () => {
    // Front edge y = 0 from x = 0 to 10; a road in front only from x = 3.37 onwards.
    const plot: Polygon = [
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ];
    const road = {
      id: "road",
      kind: "road" as const,
      outline: [
        [3.37, -5],
        [20, -5],
        [20, 0],
        [3.37, 0],
      ] as Polygon,
    };
    const runs = classifyEdges({
      plot,
      house: [
        [2, 5],
        [8, 5],
        [8, 15],
        [2, 15],
      ],
      neighbourBuildings: [],
      publicAreas: [road],
    }).filter((r) => r.edge === 0);
    expect(runs.map((r) => r.kind)).toEqual(["neighbour", "public"]);
    expect(Math.abs(runs[0]!.lengthM - 3.37)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(runs[1]!.lengthM - 6.63)).toBeLessThanOrEqual(0.01);
  });
});
