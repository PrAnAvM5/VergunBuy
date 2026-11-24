import { describe, expect, it } from "vitest";
import {
  area,
  centroid,
  distanceBetween,
  intersectionArea,
  segmentsIntersect,
  type Polygon,
} from "../src/index.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe("segmentsIntersect", () => {
  it("detects crossing, touching and collinear overlap; rejects parallel and separate", () => {
    expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [2, 0], [2, 0], [3, 1])).toBe(true);
    expect(segmentsIntersect([0, 0], [3, 0], [1, 0], [2, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [2, 0], [0, 1], [2, 1])).toBe(false);
    expect(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0])).toBe(false);
  });
});

describe("distanceBetween", () => {
  it("is 0 for two bars that cross like a plus sign (no vertex inside the other)", () => {
    // The old vertex-based check returned 4 here.
    expect(distanceBetween(rect(-5, -1, 5, 1), rect(-1, -5, 1, 5))).toBe(0);
  });
  it("is 0 when one polygon lies inside the other", () => {
    expect(distanceBetween(rect(0, 0, 10, 10), rect(4, 4, 6, 6))).toBe(0);
  });
  it("is 0 when edges touch", () => {
    expect(distanceBetween(rect(0, 0, 2, 2), rect(2, 0, 4, 2))).toBe(0);
  });
  it("measures the real gap, including edge-to-edge gaps between non-vertex points", () => {
    expect(distanceBetween(rect(0, 0, 2, 2), rect(3, -5, 4, 5))).toBeCloseTo(1, 9);
  });
});

describe("centroid", () => {
  it("is the centre of mass, not pulled toward a side with extra vertices", () => {
    // Square 0..10 with many extra points on the left edge: vertex average drifts left, centroid does not.
    const poly: Polygon = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 8],
      [0, 6],
      [0, 4],
      [0, 2],
    ];
    const [x, y] = centroid(poly);
    expect(x).toBeCloseTo(5, 9);
    expect(y).toBeCloseTo(5, 9);
  });
  it("lies inside an L-shaped plot where the vertex average would also work, and matches area weighting", () => {
    const L: Polygon = [
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 10],
      [0, 10],
    ];
    const [x, y] = centroid(L);
    expect(x).toBeCloseTo(y, 9);
    expect(x).toBeLessThan(5);
  });
});

describe("intersectionArea", () => {
  it("computes overlap area for partial, full and no overlap", () => {
    expect(intersectionArea(rect(0, 0, 10, 10), rect(5, 5, 15, 15))).toBeCloseTo(25, 6);
    expect(intersectionArea(rect(0, 0, 10, 10), rect(2, 2, 4, 4))).toBeCloseTo(4, 6);
    expect(intersectionArea(rect(0, 0, 1, 1), rect(5, 5, 6, 6))).toBe(0);
  });
  it("works for a non-convex plot", () => {
    const L: Polygon = [
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 10],
      [0, 10],
    ];
    // A building over the inner corner: half of it lies in the notch outside the L.
    const b = rect(1, 1, 5, 5);
    expect(intersectionArea(L, b)).toBeCloseTo(area(rect(1, 1, 5, 2)) + area(rect(1, 2, 2, 5)), 6);
  });
});
