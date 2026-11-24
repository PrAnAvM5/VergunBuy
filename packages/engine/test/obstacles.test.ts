import { describe, expect, it } from "vitest";
import { detectObstacles, fillGaps, type HeightGrid, type Polygon } from "../src/index.ts";

/** 30 × 20 m grid at 0.5 m (the plot is 1–19 m, so there is room around it), ground at 10 m. */
function grid(
  surface: (x: number, y: number) => number,
  groundHole?: (x: number, y: number) => boolean,
): HeightGrid {
  const cols = 60;
  const rows = 40;
  const dsm = new Float32Array(cols * rows);
  const dtm = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * 0.5;
      const y = 20 - (r + 0.5) * 0.5;
      dsm[r * cols + c] = 10 + surface(x, y);
      dtm[r * cols + c] = groundHole?.(x, y) ? Number.NaN : 10;
    }
  return { x0: 0, y0: 20, res: 0.5, cols, rows, dsm, dtm };
}
const plot: Polygon = [
  [1, 1],
  [19, 1],
  [19, 19],
  [1, 19],
];
const house: Polygon = [
  [3, 3],
  [9, 3],
  [9, 9],
  [3, 9],
];

describe("detectObstacles", () => {
  it("finds a 3 m wide, 6 m high tree as one tall obstacle", () => {
    const g = grid((x, y) => (Math.hypot(x - 14, y - 14) < 1.5 ? 6 : 0));
    const r = detectObstacles(g, plot, [house]);
    expect(r.obstacles).toHaveLength(1);
    expect(r.obstacles[0]!.kind).toBe("tall");
    expect(r.obstacles[0]!.maxHeightM).toBeCloseTo(6, 1);
    expect(r.obstacles[0]!.areaM2).toBeGreaterThan(5);
    expect(r.obstacles[0]!.areaM2).toBeLessThan(9);
  });

  it("calls a 1.6 m hedge medium, and ignores lawn and the house itself", () => {
    const g = grid((x, y) => {
      if (x >= 3 && x <= 9 && y >= 3 && y <= 9) return 7; // the house roof
      if (y > 17 && y < 18) return 1.6; // hedge along the rear
      return 0.05; // lawn
    });
    const r = detectObstacles(g, plot, [house]);
    expect(r.obstacles.map((o) => o.kind)).toEqual(["medium"]);
    expect(r.tallM2).toBe(0);
  });

  it("fills ground gaps under a crown from the ground around it", () => {
    const g = grid(
      (x, y) => (Math.hypot(x - 14, y - 14) < 2 ? 8 : 0),
      (x, y) => Math.hypot(x - 14, y - 14) < 2,
    );
    const r = detectObstacles(g, plot, []);
    expect(r.obstacles[0]!.maxHeightM).toBeCloseTo(8, 1);
    expect(r.groundFilledShare).toBeGreaterThan(0);
  });

  it("reports the area above each compared height", () => {
    const g = grid((x) => (x > 15 && x < 17 ? 2 : 0));
    const r = detectObstacles(g, plot, []);
    expect(r.areaAboveM2["1.5"]).toBeGreaterThan(30);
    expect(r.areaAboveM2["2.5"]).toBe(0);
  });
});

describe("trees, hedges and overhang", () => {
  it("keeps a hedge that touches a tree as its own medium obstacle", () => {
    const g = grid((x, y) => {
      if (Math.hypot(x - 14, y - 14) < 1.5) return 8; // tree
      if (y > 14.5 && y < 15.1 && x > 3 && x < 13.5) return 1.6; // hedge running up to the crown
      return 0;
    });
    const r = detectObstacles(g, plot, []);
    const kinds = r.obstacles.map((o) => o.kind).sort();
    expect(kinds).toEqual(["medium", "tall"]);
    const hedge = r.obstacles.find((o) => o.kind === "medium")!;
    expect(hedge.maxHeightM).toBeLessThan(2.5);
  });

  it("calls a crown whose tree stands outside the plot 'overhang', not an obstacle on the plot", () => {
    // Tree centred just outside the right boundary (x = 19), crown radius 2.5 m.
    const g = grid((x, y) =>
      Math.hypot(x - 21.5, y - 10) < 3.5 ? 9 - Math.hypot(x - 21.5, y - 10) : 0,
    );
    const r = detectObstacles(g, plot, []);
    expect(r.obstacles).toHaveLength(1);
    expect(r.obstacles[0]!.kind).toBe("overhang");
    expect(r.obstacles[0]!.peakInside).toBe(false);
    expect(r.tallM2).toBe(0);
    expect(r.overhangM2).toBeGreaterThan(0);
    expect(r.obstacles[0]!.peakToLineM).toBeLessThan(-1);
    expect(r.obstacles[0]!.reachIntoPlotM).toBeLessThanOrEqual(1.5);
  });

  it("reports the spread of heights, not only the top", () => {
    const g = grid((x, y) => (x > 12 && x < 16 && y > 12 && y < 16 ? (x > 15.5 ? 9 : 2.6) : 0));
    const o = detectObstacles(g, plot, []).obstacles[0]!;
    expect(o.maxHeightM).toBeCloseTo(9, 1);
    expect(o.medianHeightM).toBeCloseTo(2.6, 1);
  });
});

describe("touching crowns", () => {
  it("splits two trees whose crowns touch, and judges each by where its own top is", () => {
    // Tree A inside the plot (top at x = 12), tree B outside (top at x = 22.5, plot ends at 19):
    // crowns touch around x = 17. Before, one merged group was judged by B's higher top.
    const g = grid((x, y) => {
      const a = Math.hypot(x - 12, y - 10);
      const b = Math.hypot(x - 22.5, y - 10);
      return Math.max(a < 5.5 ? 9 - a : 0, b < 6 ? 14 - b : 0);
    });
    const r = detectObstacles(g, plot, []);
    expect(r.treesFound).toBe(2);
    const kinds = r.obstacles
      .filter((o) => o.kind !== "medium")
      .map((o) => o.kind)
      .sort();
    expect(kinds).toEqual(["overhang", "tall"]);
    const tall = r.obstacles.find((o) => o.kind === "tall")!;
    expect(tall.maxHeightM).toBeCloseTo(9, 0);
  });

  it("calls a tree whose top is within a metre of the line 'boundary'", () => {
    const g = grid((x, y) => (Math.hypot(x - 19.4, y - 10) < 3 ? 8 : 0));
    const r = detectObstacles(g, plot, []);
    expect(r.obstacles[0]!.kind).toBe("boundary");
  });
});

describe("fillGaps", () => {
  it("leaves known values and fills holes", () => {
    const v = Float32Array.from([1, Number.NaN, 3, Number.NaN]);
    const f = fillGaps(v, 2, 2);
    expect(f[0]).toBe(1);
    expect(f[2]).toBe(3);
    expect(Number.isNaN(f[1]!)).toBe(false);
    expect(Number.isNaN(f[3]!)).toBe(false);
  });
});
