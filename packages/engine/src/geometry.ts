/**
 * Small, dependency-free 2D geometry in metres (RD New, EPSG:28992).
 * Polygons are open rings: the last point is NOT repeated.
 */
export type Point = readonly [number, number];
export type Polygon = readonly Point[];

export function signedArea(poly: Polygon): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = at(poly, i);
    const [x2, y2] = at(poly, i + 1);
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export const area = (poly: Polygon): number => Math.abs(signedArea(poly));

/** Point i of a ring, wrapping around. */
export function at(poly: Polygon, i: number): Point {
  const p = poly[((i % poly.length) + poly.length) % poly.length];
  if (!p) throw new Error("Empty polygon");
  return p;
}

export function edges(poly: Polygon): [Point, Point][] {
  return poly.map((p, i) => [p, at(poly, i + 1)]);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function length(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Unit normal pointing out of the polygon for edge a→b. */
export function outwardNormal(poly: Polygon, a: Point, b: Point): Point {
  const len = length(a, b) || 1;
  const dx = (b[0] - a[0]) / len;
  const dy = (b[1] - a[1]) / len;
  // Counter-clockwise ring: outside is to the right of the direction of travel.
  return signedArea(poly) > 0 ? [dy, -dx] : [-dy, dx];
}

/** Ray-casting point-in-polygon test. Points exactly on the boundary may go either way. */
export function contains(poly: Polygon, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = at(poly, i);
    const [xj, yj] = at(poly, j);
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t =
    lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  return length(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function distanceToBoundary(poly: Polygon, p: Point): number {
  return Math.min(...edges(poly).map(([a, b]) => distanceToSegment(p, a, b)));
}
