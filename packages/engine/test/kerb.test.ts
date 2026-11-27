import { describe, expect, it } from "vitest";
import { kerbForPieces, kerbLines, kerbProfile, type KerbLine } from "../src/concepts/kerb.ts";

// Kerb line along y = 0 from x = 0 to 20; road at y < 0. Pavement 12 cm higher, except a
// lowered crossing from x = 8 to 12 (2 cm step), and a parked car's spot at 16–18 (no ground).
const line: KerbLine = { a: [0, 0], b: [20, 0], toRoad: [0, -1] };
function points(noise = 0.01) {
  const pts: { x: number; y: number; z: number }[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  for (let x = 0; x <= 20; x += 0.3)
    for (const y of [-0.9, -0.6, -0.35, 0.35, 0.6, 0.9]) {
      if (x > 16 && x < 18) continue;
      const pave = y > 0;
      const step = x > 8 && x < 12 ? 0.02 : 0.12;
      pts.push({ x, y, z: 2 + (pave ? step : 0) + rnd() });
    }
  return pts;
}

describe("kerb height from ground points", () => {
  it("reads raised, lowered and missing stretches", () => {
    const w = kerbProfile([line], points());
    const at = (x: number) => w.find((q) => q.a[0] <= x && q.b[0] >= x)!;
    expect(at(3).state).toBe("raised");
    expect(at(3).stepM!).toBeCloseTo(0.12, 1);
    expect(at(10).state).toBe("lowered");
    expect(at(17).state).toBe("unclear");
  });

  it("noisy points stay unclear rather than lowered", () => {
    const w = kerbProfile([line], points(0.25));
    expect(w.filter((q) => q.state === "lowered").length).toBe(0);
  });

  it("maps windows onto plot-line pieces; short lowered runs do not count", () => {
    const w = kerbProfile([line], points());
    // Plot line 3 m back from the kerb (y = 3), pieces of 0.5 m, facing the road (-y).
    const pieces = [];
    for (let x = 0; x < 20; x += 0.5)
      pieces.push({
        a: [x, 3] as [number, number],
        b: [x + 0.5, 3] as [number, number],
        out: [0, -1] as [number, number],
      });
    const k = kerbForPieces(pieces, w);
    expect(k[20]!.state).toBe("lowered"); // x 10–10.5
    expect(k[4]!.state).toBe("raised");
    // A 1 m dip is not a way in.
    const w2 = w.map((q) => (q.a[0] >= 2 && q.b[0] <= 3 ? { ...q, state: "lowered" as const } : q));
    const k2 = kerbForPieces(pieces, w2);
    expect(k2[5]!.state).not.toBe("lowered");
  });
});

describe("kerb lines", () => {
  it("keeps only road edges next to pavement, near the plot", () => {
    const road: [number, number][] = [
      [0, -6],
      [40, -6],
      [40, 0],
      [0, 0],
    ];
    const pave: [number, number][] = [
      [0, 0],
      [40, 0],
      [40, 2],
      [0, 2],
    ];
    const ls = kerbLines(
      [road],
      [pave],
      [
        [10, 3],
        [14, 3],
      ],
    );
    expect(ls.length).toBe(1);
    const l = ls[0]!;
    expect(l.a[1]).toBeCloseTo(0);
    expect(l.toRoad[1]).toBeCloseTo(-1);
    const xs = [l.a[0], l.b[0]].sort((p, q) => p - q);
    expect(xs[0]).toBeGreaterThanOrEqual(0);
    expect(xs[1]).toBeLessThanOrEqual(27);
  });
});
