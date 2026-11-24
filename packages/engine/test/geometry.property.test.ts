/**
 * Property-based tests: thousands of random shapes, placed at real RD coordinates
 * (around x = 80 000, y = 380 000), must obey the mathematical laws of the geometry.
 * If any law breaks, fast-check prints the smallest failing shape.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  area,
  centroid,
  classifyEdges,
  contains,
  distanceBetween,
  intersectionArea,
  orientedBox,
  signedArea,
  validatePolygon,
  type Point,
  type Polygon,
} from "../src/index.ts";

const RD: Point = [81000, 381900];
const RUNS = { numRuns: 400 };

/** A random simple (star-shaped) polygon: points at sorted angles around a centre. */
const starPolygon = fc
  .record({
    cx: fc.double({ min: -50, max: 50, noNaN: true }),
    cy: fc.double({ min: -50, max: 50, noNaN: true }),
    radii: fc.array(fc.double({ min: 2, max: 30, noNaN: true }), { minLength: 3, maxLength: 12 }),
    jitter: fc.array(fc.double({ min: 0.05, max: 0.95, noNaN: true }), {
      minLength: 12,
      maxLength: 12,
    }),
  })
  .map(({ cx, cy, radii, jitter }) => {
    const n = radii.length;
    return radii.map((r, i) => {
      const t = ((i + (jitter[i] ?? 0.5)) / n) * 2 * Math.PI;
      return [RD[0] + cx + r * Math.cos(t), RD[1] + cy + r * Math.sin(t)] as Point;
    }) as Polygon;
  });

/** A random rotated rectangle (like most plots and buildings). */
const rotatedRect = fc
  .record({
    cx: fc.double({ min: -50, max: 50, noNaN: true }),
    cy: fc.double({ min: -50, max: 50, noNaN: true }),
    w: fc.double({ min: 1, max: 40, noNaN: true }),
    h: fc.double({ min: 1, max: 40, noNaN: true }),
    angle: fc.double({ min: 0, max: Math.PI, noNaN: true }),
  })
  .map(({ cx, cy, w, h, angle }) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const corner = (x: number, y: number): Point => [
      RD[0] + cx + x * c - y * s,
      RD[1] + cy + x * s + y * c,
    ];
    return {
      poly: [
        corner(-w / 2, -h / 2),
        corner(w / 2, -h / 2),
        corner(w / 2, h / 2),
        corner(-w / 2, h / 2),
      ] as Polygon,
      w,
      h,
    };
  });

const shift = (p: Polygon, dx: number, dy: number): Polygon =>
  p.map((q) => [q[0] + dx, q[1] + dy] as Point);
const rotate = (p: Polygon, a: number, o: Point): Polygon =>
  p.map((q) => {
    const x = q[0] - o[0];
    const y = q[1] - o[1];
    return [
      o[0] + x * Math.cos(a) - y * Math.sin(a),
      o[1] + x * Math.sin(a) + y * Math.cos(a),
    ] as Point;
  });
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

describe("area and centroid", () => {
  it("area does not depend on winding, translation or rotation", () => {
    fc.assert(
      fc.property(starPolygon, fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }), (p, a) => {
        const A = area(p);
        expect(close(area([...p].reverse()), A, 1e-6)).toBe(true);
        expect(close(area(shift(p, 1234.5, -987.25)), A, 1e-6)).toBe(true);
        expect(close(area(rotate(p, a, RD)), A, 1e-6 * Math.max(1, A))).toBe(true);
        expect(Math.sign(signedArea(p))).toBe(-Math.sign(signedArea([...p].reverse())));
      }),
      RUNS,
    );
  });

  it("centroid moves exactly with the shape (no precision loss at RD scale)", () => {
    fc.assert(
      fc.property(starPolygon, (p) => {
        const [x, y] = centroid(p);
        const [x2, y2] = centroid(shift(p, 500.25, -300.5));
        expect(close(x2 - x, 500.25, 1e-6) && close(y2 - y, -300.5, 1e-6)).toBe(true);
        const [xr, yr] = centroid([...p].reverse());
        expect(close(xr, x, 1e-6) && close(yr, y, 1e-6)).toBe(true);
      }),
      RUNS,
    );
  });

  it("centroid of a rectangle is its centre and lies inside it", () => {
    fc.assert(
      fc.property(rotatedRect, ({ poly }) => {
        const c = centroid(poly);
        const mid: Point = [(poly[0]![0] + poly[2]![0]) / 2, (poly[0]![1] + poly[2]![1]) / 2];
        expect(close(c[0], mid[0], 1e-6) && close(c[1], mid[1], 1e-6)).toBe(true);
        expect(contains(poly, c)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("intersectionArea", () => {
  it("is symmetric, bounded by both areas, and equals the area for identical shapes", () => {
    fc.assert(
      fc.property(starPolygon, starPolygon, (a, b) => {
        const ab = intersectionArea(a, b);
        const ba = intersectionArea(b, a);
        expect(close(ab, ba, 1e-6 * Math.max(1, ab))).toBe(true);
        expect(ab).toBeGreaterThanOrEqual(-1e-9);
        expect(ab).toBeLessThanOrEqual(Math.min(area(a), area(b)) + 1e-6);
        expect(close(intersectionArea(a, a), area(a), 1e-6 * Math.max(1, area(a)))).toBe(true);
      }),
      RUNS,
    );
  });

  it("is zero for shapes far apart and unchanged when both move together", () => {
    fc.assert(
      fc.property(starPolygon, starPolygon, (a, b) => {
        expect(intersectionArea(a, shift(b, 500, 0))).toBe(0);
        const I = intersectionArea(a, b);
        expect(
          close(
            intersectionArea(shift(a, 77.7, -33.3), shift(b, 77.7, -33.3)),
            I,
            1e-6 * Math.max(1, I),
          ),
        ).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("distanceBetween", () => {
  it("is symmetric, never negative, and zero whenever the shapes overlap", () => {
    fc.assert(
      fc.property(starPolygon, starPolygon, (a, b) => {
        const d = distanceBetween(a, b);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(close(d, distanceBetween(b, a), 1e-9)).toBe(true);
        if (intersectionArea(a, b) > 1e-6) expect(d).toBe(0);
        if (d > 1e-9) expect(intersectionArea(a, b)).toBeLessThan(1e-6);
      }),
      RUNS,
    );
  });

  it("equals the exact gap between two axis-aligned boxes", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 20, noNaN: true }),
        fc.double({ min: 0.01, max: 30, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        (w, gap, dy) => {
          const a: Polygon = [RD, [RD[0] + w, RD[1]], [RD[0] + w, RD[1] + 10], [RD[0], RD[1] + 10]];
          const b = shift(a, w + gap, dy);
          expect(close(distanceBetween(a, b), gap, 1e-6)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe("orientedBox", () => {
  it("recovers the size of any rotated rectangle", () => {
    fc.assert(
      fc.property(rotatedRect, ({ poly, w, h }) => {
        const box = orientedBox(poly);
        expect(close(box.lengthM, Math.max(w, h), 0.06)).toBe(true);
        expect(close(box.widthM, Math.min(w, h), 0.06)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("classifyEdges", () => {
  it("covers the whole boundary: run lengths add up to the perimeter", () => {
    fc.assert(
      fc.property(rotatedRect, ({ poly }) => {
        const runs = classifyEdges({
          plot: poly,
          house: [],
          neighbourBuildings: [],
          publicAreas: [],
        });
        let perimeter = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const total = runs.reduce((s, r) => s + r.lengthM, 0);
        expect(close(total, perimeter, 0.01 * runs.length + 1e-6)).toBe(true);
        runs.forEach((r) => expect(r.to).toBeGreaterThan(r.from));
      }),
      RUNS,
    );
  });
});

describe("validatePolygon", () => {
  it("accepts every generated simple polygon", () => {
    fc.assert(
      fc.property(starPolygon, (p) => {
        expect(validatePolygon(p).valid).toBe(true);
      }),
      RUNS,
    );
  });
  it("rejects a bow-tie, a sliver and repeated points", () => {
    expect(
      validatePolygon([
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ]).issues,
    ).toContain("edges cross each other (self-intersection)");
    expect(
      validatePolygon([
        [0, 0],
        [1, 0],
        [2, 0],
      ]).valid,
    ).toBe(false);
    expect(
      validatePolygon([
        [0, 0],
        [1, 0],
        [1, 0],
        [1, 1],
      ]).issues,
    ).toContain("repeated consecutive point");
  });
});
