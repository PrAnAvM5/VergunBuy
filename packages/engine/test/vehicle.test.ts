import { describe, expect, it } from "vitest";
import type { Polygon } from "../src/geometry.ts";
import {
  DEFAULT_VEHICLE,
  accessCarport,
  buildLattice,
  buildWorld,
  carOf,
  leaveCarport,
  parkingFit,
  quadFree,
  type CarportRect,
  type WorldInput,
} from "../src/vehicle.ts";

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Plot 18 × 30 m, house across the front, 5 m side path on the right, way in at the front. */
function site(extra: Partial<WorldInput> = {}, sideGapTo = 18): WorldInput {
  return {
    plot: box(0, 0, sideGapTo, 30),
    solids: [box(2, 5, 13, 14)],
    scan: [],
    scanCellM: 0.5,
    gates: [{ a: [13, 0], b: [sideGapTo, 0], kind: "existing" }],
    ...extra,
  };
}

/** In line with the side path. */
const backCarport: CarportRect = { x0: 14.5, y0: 20, x1: 17.5, y1: 25, o: "ns", bays: 1 };

function treeCells(cx: number, cy: number, r: number, h: number) {
  const out: { at: [number, number]; blocks: boolean }[] = [];
  for (let x = cx - r; x <= cx + r; x += 0.5)
    for (let y = cy - r; y <= cy + r; y += 0.5)
      if (Math.hypot(x - cx, y - cy) <= r) out.push({ at: [x, y], blocks: h >= 2.5 });
  return out;
}

describe("vehicle model", () => {
  it("derives a rear-axle turning radius of about 4.5 m from a 6.5 m outer sweep", () => {
    const car = carOf({ ...DEFAULT_VEHICLE, outerRadiusM: 6.5 });
    expect(car.rt).toBeGreaterThan(4.3);
    expect(car.rt).toBeLessThan(4.7);
  });

  it("collision test sees obstacles inside the inflated body only", () => {
    const w = buildWorld(site());
    const car = carOf(DEFAULT_VEHICLE);
    const free = (x: number, y: number) =>
      quadFree(w, [
        x - car.w / 2 - 0.5,
        y - 1.4,
        x + car.w / 2 + 0.5,
        y - 1.4,
        x + car.w / 2 + 0.5,
        y + 4.1,
        x - car.w / 2 - 0.5,
        y + 4.1,
      ]);
    expect(free(15.5, 8)).toBe(true); // in the side path
    expect(free(12.5, 8)).toBe(false); // overlapping the house
  });

  it("parking fit needs the car length and a door gap on both sides", () => {
    const car = carOf(DEFAULT_VEHICLE);
    expect(parkingFit(car, backCarport).fits).toBe(true);
    expect(parkingFit(car, { ...backCarport, x1: 14.5 }).fits).toBe(false);
  });
});

describe("driving into a carport in the back yard", () => {
  const car = carOf(DEFAULT_VEHICLE);

  it("finds a route along the side path and a way out", () => {
    const L = buildLattice(buildWorld(site()), car);
    const acc = accessCarport(L, backCarport, false);
    expect(acc[0]!.route).not.toBeNull();
    const out = leaveCarport(L, backCarport, acc, 0);
    expect(out).not.toBeNull();
    expect(out!.poses.length).toBeGreaterThan(5);
  });

  it("a tall tree in the side path blocks it, a shrub does not", () => {
    const tree = buildLattice(buildWorld(site({ scan: treeCells(15.5, 10, 1.5, 7) })), car);
    expect(accessCarport(tree, backCarport, false)[0]!.route).toBeNull();
    const shrub = buildLattice(buildWorld(site({ scan: treeCells(15.5, 10, 1.5, 1.8) })), car);
    expect(accessCarport(shrub, backCarport, false)[0]!.route).not.toBeNull();
  });

  it("a passage narrower than car width plus clearance on both sides blocks it", () => {
    // Side path 13 → 16 m = 3 m. Clearance 0.7 m needs 1.8 + 1.4 = 3.2 m; 0.2 m needs 2.2 m.
    const narrow = buildWorld(site({}, 16));
    const cp: CarportRect = { ...backCarport, x0: 13, x1: 16 };
    const wide = carOf({ ...DEFAULT_VEHICLE, clearanceM: 0.7 });
    expect(accessCarport(buildLattice(narrow, wide), cp, false)[0]!.route).toBeNull();
    const small = carOf({ ...DEFAULT_VEHICLE, clearanceM: 0.2 });
    expect(accessCarport(buildLattice(narrow, small), cp, false)[0]!.route).not.toBeNull();
  });

  it("an offset carport is reached with curves", () => {
    // Deep behind the house, 6 m left of the side path: needs an S-bend past the house corner.
    const L = buildLattice(buildWorld(site({ plot: box(0, 0, 18, 38) })), car);
    const acc = accessCarport(L, { x0: 8, y0: 29, x1: 11, y1: 34, o: "ns", bays: 1 }, false);
    expect(acc[0]!.route).not.toBeNull();
    expect(acc[0]!.route!.how).not.toBe("straight in");
  });

  it("a double carport is reachable for both bays with the other car parked", () => {
    const L = buildLattice(
      buildWorld(
        site({ plot: box(0, 0, 24, 30), gates: [{ a: [13, 0], b: [24, 0], kind: "existing" }] }),
      ),
      car,
    );
    const acc = accessCarport(L, { x0: 15, y0: 20, x1: 21, y1: 25, o: "ns", bays: 2 }, false);
    expect(acc.every((b) => b.route)).toBe(true);
  });
});

describe("default car", () => {
  it("a typical hatchback: about 4 m rear-axle radius, 0.3 m clearance", () => {
    const car = carOf(DEFAULT_VEHICLE);
    expect(car.rt).toBeGreaterThan(3.7);
    expect(car.rt).toBeLessThan(4.2);
    expect(car.clr).toBe(0.3);
  });
});
