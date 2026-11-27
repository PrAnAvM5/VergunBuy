/**
 * Kerb height from the laser scan: is the kerb in front of the plot lowered (a driveway
 * crossing that the map does not show) or a normal raised kerb?
 *
 * 1. Kerb line: where the carriageway (or a parking strip) meets pavement, cycle path, verge or a
 *    driveway crossing in the map register (BGT).
 * 2. Ground points only (laser class 2: parked cars, bins, people are not ground), in two strips
 *    0.25–1.0 m either side of the kerb line (the line itself is only accurate to ~0.2 m).
 * 3. Along the kerb, windows of 1 m every 0.5 m: median ground height on each side (at least
 *    MIN_POINTS each, spread not too wide); the step is pavement side minus road side.
 *    About 10–15 cm: raised. Under 4.5 cm: lowered. Else, too few points or a wide spread:
 *    unclear (for example where a car was parked when the scan was flown).
 * 4. A lowered stretch counts only when at least 2.4 m long (a car plus margins).
 */
import { contains, length, outwardNormal, type Point, type Polygon } from "../geometry.ts";

export const KERB_SETTINGS = {
  /** Strip on each side: from this distance off the kerb line … */
  innerM: 0.25,
  /** … to this one. */
  outerM: 1.0,
  windowM: 1.0,
  stepM: 0.5,
  minPoints: 4,
  /** Median absolute deviation above this (m): too uneven to read (cars, bins, slopes). */
  maxSpreadM: 0.05,
  loweredBelowM: 0.045,
  raisedFromM: 0.07,
  /** A lowered stretch shorter than this is not a way in. */
  minLoweredM: 2.4,
} as const;

export type KerbState = "raised" | "lowered" | "unclear";

/** One stretch of kerb line, with the road on its left (seen from a to b) or right. */
export interface KerbLine {
  a: Point;
  b: Point;
  /** Unit vector from the kerb line towards the road. */
  toRoad: Point;
}

export interface KerbWindow {
  a: Point;
  b: Point;
  state: KerbState;
  /** Pavement side minus road side (m), null when unclear for lack of points. */
  stepM: number | null;
  nRoad: number;
  nPave: number;
}

/** The two 0.25–1.0 m strips either side of a kerb line (road side first). */
export function kerbStrips(k: KerbLine, s = KERB_SETTINGS): [Point[], Point[]] {
  const strip = (sign: number): Point[] => {
    const off = (d: number): Point => [k.toRoad[0] * d * sign, k.toRoad[1] * d * sign];
    const i = off(s.innerM);
    const o = off(s.outerM);
    return [
      [k.a[0] + i[0], k.a[1] + i[1]],
      [k.b[0] + i[0], k.b[1] + i[1]],
      [k.b[0] + o[0], k.b[1] + o[1]],
      [k.a[0] + o[0], k.a[1] + o[1]],
    ];
  };
  return [strip(1), strip(-1)];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Windows along each kerb line, from ground points (x, y, z in metres). */
export function kerbProfile(
  lines: KerbLine[],
  pts: { x: number; y: number; z: number }[],
  s = KERB_SETTINGS,
): KerbWindow[] {
  const out: KerbWindow[] = [];
  for (const k of lines) {
    const len = Math.hypot(k.b[0] - k.a[0], k.b[1] - k.a[1]);
    if (len < s.windowM / 2) continue;
    const t: Point = [(k.b[0] - k.a[0]) / len, (k.b[1] - k.a[1]) / len];
    // Points near this line: along-position and side.
    const road: { u: number; z: number }[] = [];
    const pave: { u: number; z: number }[] = [];
    for (const p of pts) {
      const dx = p.x - k.a[0];
      const dy = p.y - k.a[1];
      const u = dx * t[0] + dy * t[1];
      if (u < -s.windowM || u > len + s.windowM) continue;
      const v = dx * k.toRoad[0] + dy * k.toRoad[1];
      const av = Math.abs(v);
      if (av < s.innerM - 1e-6 || av > s.outerM + 1e-6) continue;
      (v > 0 ? road : pave).push({ u, z: p.z });
    }
    const n = Math.max(1, Math.round(len / s.stepM));
    for (let w = 0; w < n; w++) {
      const u0 = (w * len) / n;
      const u1 = ((w + 1) * len) / n;
      const mid = (u0 + u1) / 2;
      const inWin = (q: { u: number }) => Math.abs(q.u - mid) <= s.windowM / 2;
      const zr = road.filter(inWin).map((q) => q.z);
      const zp = pave.filter(inWin).map((q) => q.z);
      const a: Point = [k.a[0] + t[0] * u0, k.a[1] + t[1] * u0];
      const b: Point = [k.a[0] + t[0] * u1, k.a[1] + t[1] * u1];
      if (zr.length < s.minPoints || zp.length < s.minPoints) {
        out.push({ a, b, state: "unclear", stepM: null, nRoad: zr.length, nPave: zp.length });
        continue;
      }
      const mr = median(zr);
      const mp = median(zp);
      const spread = Math.max(
        median(zr.map((z) => Math.abs(z - mr))),
        median(zp.map((z) => Math.abs(z - mp))),
      );
      const step = mp - mr;
      const state: KerbState =
        spread > s.maxSpreadM
          ? "unclear"
          : step < s.loweredBelowM && step > -s.loweredBelowM
            ? "lowered"
            : step >= s.raisedFromM
              ? "raised"
              : "unclear";
      out.push({
        a,
        b,
        state,
        stepM: Math.round(step * 1000) / 1000,
        nRoad: zr.length,
        nPave: zp.length,
      });
    }
  }
  return out;
}

/**
 * What the kerb is in front of each plot-line piece: straight out from the piece (up to
 * maxOutM), the nearest kerb window within 0.6 m of that line. Lowered runs shorter than
 * minLoweredM along the plot line become unclear.
 */
export function kerbForPieces(
  pieces: { a: Point; b: Point; out: Point }[],
  windows: KerbWindow[],
  maxOutM = 12,
  s = KERB_SETTINGS,
): (KerbWindow | null)[] {
  const hits = pieces.map((p) => {
    const m: Point = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
    let best: KerbWindow | null = null;
    let bestD = Infinity;
    for (const w of windows) {
      const c: Point = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      const dx = c[0] - m[0];
      const dy = c[1] - m[1];
      const along = dx * p.out[0] + dy * p.out[1];
      if (along <= 0 || along > maxOutM) continue;
      const side = Math.abs(dx * p.out[1] - dy * p.out[0]);
      if (side > 0.6) continue;
      if (along < bestD) {
        bestD = along;
        best = w;
      }
    }
    return best;
  });
  // Short lowered runs (along consecutive pieces) do not count.
  const len = (i: number) =>
    Math.hypot(pieces[i]!.b[0] - pieces[i]!.a[0], pieces[i]!.b[1] - pieces[i]!.a[1]);
  let i = 0;
  while (i < hits.length) {
    if (hits[i]?.state !== "lowered") {
      i++;
      continue;
    }
    let j = i;
    let run = 0;
    while (j < hits.length && hits[j]?.state === "lowered") {
      run += len(j);
      j++;
    }
    if (run < s.minLoweredM - 1e-6)
      for (let k = i; k < j; k++) hits[k] = { ...hits[k]!, state: "unclear" };
    i = j;
  }
  return hits;
}

/**
 * Kerb lines near the plot: edges of carriageway and parking polygons where the ground just
 * outside is pavement, cycle path, verge or a driveway crossing (not more road, not water).
 * Only stretches within nearM of one of the `near` points (the plot's street side) are kept;
 * consecutive 0.5 m pieces along one edge are joined into one line.
 */
export function kerbLines(
  roads: Polygon[],
  beside: Polygon[],
  near: Point[],
  nearM = 12,
  pieceM = 0.5,
): KerbLine[] {
  const out: KerbLine[] = [];
  const isNear = (p: Point) => near.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= nearM);
  for (const road of roads) {
    for (let i = 0; i < road.length; i++) {
      const a = road[i]!;
      const b = road[(i + 1) % road.length]!;
      const len = length(a, b);
      if (len < 0.2) continue;
      const n = outwardNormal(road, a, b);
      const toRoad: Point = [-n[0], -n[1]];
      const k = Math.max(1, Math.round(len / pieceM));
      let start: Point | null = null;
      let last: Point | null = null;
      const flush = () => {
        if (start && last && length(start, last) >= 0.5) out.push({ a: start, b: last, toRoad });
        start = last = null;
      };
      for (let j = 0; j < k; j++) {
        const pa: Point = [a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k];
        const pb: Point = [
          a[0] + ((b[0] - a[0]) * (j + 1)) / k,
          a[1] + ((b[1] - a[1]) * (j + 1)) / k,
        ];
        const m: Point = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
        const outside: Point = [m[0] + n[0] * 0.4, m[1] + n[1] * 0.4];
        const ok =
          isNear(m) &&
          beside.some((g) => contains(g, outside)) &&
          !roads.some((r) => r !== road && contains(r, outside));
        if (ok) {
          start ??= pa;
          last = pb;
        } else flush();
      }
      flush();
    }
  }
  return out;
}
