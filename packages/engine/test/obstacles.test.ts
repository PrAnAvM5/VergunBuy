import { describe, expect, it } from "vitest";
import { detectObstacles, fillGaps, type HeightGrid, type Polygon } from "../src/index.ts";

/** 20 × 20 m grid at 0.5 m, flat ground at 10 m. */
function grid(
  surface: (x: number, y: number) => number,
  groundHole?: (x: number, y: number) => boolean,
): HeightGrid {
  const cols = 40;
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
