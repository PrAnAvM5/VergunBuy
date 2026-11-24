import polygonClipping from "polygon-clipping";

/**
 * Small, dependency-free 2D geometry in metres (RD New, EPSG:28992).
 * Polygons are open rings: the last point is NOT repeated.
 */
export type Point = readonly [number, number];
export type Polygon = readonly Point[];

export function signedArea(poly: Polygon): number {
  // Relative to the first vertex: with RD coordinates (~10^5 m) the raw shoelace formula
  // multiplies large numbers and loses precision; differences keep it exact to sub-millimetre.
  const o = poly[0];
  if (!o) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = at(poly, i);
    const [x2, y2] = at(poly, i + 1);
    sum += (x1 - o[0]) * (y2 - o[1]) - (x2 - o[0]) * (y1 - o[1]);
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

/**
 * Smallest rectangle around a polygon, aligned with one of its edges (good for buildings and plots,
 * which are mostly rectangular). Returns length ≥ width, in metres.
 */
export function orientedBox(poly: Polygon): { lengthM: number; widthM: number; angleDeg: number } {
  let best = { area: Infinity, lengthM: 0, widthM: 0, angleDeg: 0 };
  for (const [a, b] of edges(poly)) {
    const len = length(a, b);
    if (len < 0.01) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of poly) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const w = maxU - minU;
    const h = maxV - minV;
    if (w * h < best.area) {
      best = {
        area: w * h,
        lengthM: Math.max(w, h),
        widthM: Math.min(w, h),
        angleDeg: (Math.atan2(uy, ux) * 180) / Math.PI,
      };
    }
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return { lengthM: r(best.lengthM), widthM: r(best.widthM), angleDeg: r(best.angleDeg) };
}

/** Orientation of the triple (p, q, r): >0 counter-clockwise, <0 clockwise, 0 collinear (within eps). */
function orient(p: Point, q: Point, r: Point, eps = 1e-9): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return Math.abs(v) < eps ? 0 : v;
}

const onSegment = (p: Point, q: Point, r: Point) =>
  Math.min(p[0], r[0]) - 1e-9 <= q[0] &&
  q[0] <= Math.max(p[0], r[0]) + 1e-9 &&
  Math.min(p[1], r[1]) - 1e-9 <= q[1] &&
  q[1] <= Math.max(p[1], r[1]) + 1e-9;

/** True if segments a–b and c–d share at least one point (crossing, touching or collinear overlap). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

/** Shortest distance between segments a–b and c–d (0 if they intersect). */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  );
}

/**
 * Shortest distance between two polygons (0 if they touch, cross or one lies inside the other).
 * Checks every edge pair, so two shapes that cross without any vertex inside the other
 * (e.g. a plus sign made of two bars) correctly return 0.
 */
export function distanceBetween(a: Polygon, b: Polygon): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const first = (p: Polygon) => p[0] as Point;
  if (contains(b, first(a)) || contains(a, first(b))) return 0;
  let min = Infinity;
  for (const [p, q] of edges(a)) {
    for (const [r, t] of edges(b)) {
      const d = segmentDistance(p, q, r, t);
      if (d === 0) return 0;
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Area-weighted centroid (centre of mass) of a simple polygon. Unlike the average of the
 * vertices, it does not shift towards the side that happens to have more corner points.
 */
export function centroid(poly: Polygon): Point {
  const o = poly[0];
  if (!o) return [NaN, NaN];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = at(poly, i);
    const [x2, y2] = at(poly, i + 1);
    const ax = x1 - o[0];
    const ay = y1 - o[1];
    const bx = x2 - o[0];
    const by = y2 - o[1];
    const cross = ax * by - bx * ay;
    a += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    // Degenerate (no area): fall back to the vertex average.
    return [
      poly.reduce((s, p) => s + p[0], 0) / poly.length,
      poly.reduce((s, p) => s + p[1], 0) / poly.length,
    ];
  }
  return [o[0] + cx / (3 * a), o[1] + cy / (3 * a)];
}

/** Area (m²) of the overlap of two simple polygons, using a robust clipping library. */
export function intersectionArea(a: Polygon, b: Polygon): number {
  if (a.length < 3 || b.length < 3) return 0;
  // Clip in local coordinates around a shared origin, for numerical robustness at RD scale.
  const o = a[0] as Point;
  const ring = (p: Polygon): [number, number][] => {
    const r = p.map((q) => [q[0] - o[0], q[1] - o[1]] as [number, number]);
    const f = r[0]!;
    r.push([f[0], f[1]]);
    return r;
  };
  const result = polygonClipping.intersection([ring(a)], [ring(b)]);
  let total = 0;
  for (const poly of result) {
    poly.forEach((r, i) => {
      const open = r.slice(0, -1) as unknown as Polygon;
      total += i === 0 ? area(open) : -area(open);
    });
  }
  return total;
}

export interface PolygonCheck {
  valid: boolean;
  issues: string[];
}

/**
 * Checks that a ring from a data source is a usable simple polygon: at least 3 distinct points,
 * non-zero area, no repeated consecutive points and no edges crossing each other.
 * Invalid geometry must never be measured silently: callers lower data quality instead.
 */
/**
 * Removes consecutive points closer than tolTo (default 1 mm), including a repeated closing point.
 * Public registers (BGT, BRK) often repeat a point where an arc was densified; that changes
 * nothing about the shape but makes a zero-length edge, which would look like a self-intersection.
 */
export function cleanPolygon(poly: Polygon, tol = 0.001): Polygon {
  const out: Point[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) <= tol && Math.abs(last[1] - p[1]) <= tol) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(last[0] - first[0]) <= tol && Math.abs(last[1] - first[1]) <= tol) out.pop();
    else break;
  }
  return out;
}

export function validatePolygon(poly: Polygon, minAreaM2 = 0.01): PolygonCheck {
  const issues: string[] = [];
  if (poly.length < 3) issues.push("fewer than 3 points");
  for (let i = 0; i < poly.length; i++) {
    const a = at(poly, i);
    const b = at(poly, i + 1);
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
      issues.push("repeated consecutive point");
      break;
    }
  }
  if (poly.length >= 3 && area(poly) < minAreaM2) issues.push("no area");
  const n = poly.length;
  outer: for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsIntersect(at(poly, i), at(poly, i + 1), at(poly, j), at(poly, j + 1))) {
        issues.push("edges cross each other (self-intersection)");
        break outer;
      }
    }
  }
  return { valid: issues.length === 0, issues };
}
