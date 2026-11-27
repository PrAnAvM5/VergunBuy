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

describe("road-aware car world", () => {
  // Road 6.5 m wide, from 2 m to 8.5 m in front of the plot (a 2 m pavement in between), 60 m long.
  const road = { drivable: [box(-25, -8.5, 45, -2)], blockers: [] as Polygon[] };
  const roadSite = (extra: Partial<WorldInput> = {}) => site({ road, ...extra });

  it("starts on the road on both sides of the gate, driving along the street", () => {
    const L = buildLattice(buildWorld(roadSite()), carOf(DEFAULT_VEHICLE));
    expect(L.w.roadMode).toBe(true);
    const xs = [...L.starts].map((s) => {
      const k = s >> 3;
      return (L.w.i0 + (k % L.w.NI)) * 0.5;
    });
    const hs = new Set([...L.starts].map((s) => s & 7));
    expect(Math.min(...xs)).toBeLessThan(13);
    expect(Math.max(...xs)).toBeGreaterThan(18);
    // Along the street (headings 2 and 6), never straight at the plot.
    expect([...hs].every((h) => h === 2 || h === 6)).toBe(true);
  });

  it("drives in from the road and every pose is on the road, the crossing or the plot", () => {
    const L = buildLattice(buildWorld(roadSite()), carOf(DEFAULT_VEHICLE));
    const acc = accessCarport(L, backCarport, false);
    const r = acc[0]!.route!;
    expect(r).toBeTruthy();
    const first = r.poses[0]!;
    expect(first.y).toBeLessThan(-2);
    // The car arrives along the street, not head-on from across it.
    expect(Math.abs(Math.sin(first.a))).toBeGreaterThan(0.9);
    for (const p of r.poses) {
      const onRoad = p.y <= -2 && p.y >= -8.5;
      const onCrossing = p.y > -2 && p.y < 0 && p.x > 10 && p.x < 21;
      const onPlot = p.y >= 0;
      expect(onRoad || onCrossing || onPlot).toBe(true);
    }
  });

  it("drives out until the whole car stands on the road", () => {
    // A cycle path between the plot line and the road.
    const w = buildWorld(
      roadSite({
        road: {
          drivable: [box(-25, -8.5, 45, -3.5)],
          blockers: [],
          crossable: [box(-25, -3.5, 45, -2)],
        },
      }),
    );
    const L = buildLattice(w, carOf(DEFAULT_VEHICLE));
    const acc = accessCarport(L, backCarport, false);
    const out = leaveCarport(L, backCarport, acc, 0)!;
    expect(out).toBeTruthy();
    const last = out.poses[out.poses.length - 1]!;
    const car = carOf(DEFAULT_VEHICLE);
    const c = [-car.ro, car.nose].map((d) => last.y + Math.cos(last.a) * d);
    for (const y of c) {
      expect(y).toBeLessThanOrEqual(-3.5);
      expect(y).toBeGreaterThanOrEqual(-8.5);
    }
    expect(Math.abs(Math.sin(last.a))).toBeGreaterThan(0.9);
  });

  it("does not drive through a lamp post", () => {
    // Lamp posts all along the plot side of the road, except right at the gate.
    const lamps: Polygon[] = [];
    for (let x = -24; x < 44; x += 1) if (x < 9 || x > 22) lamps.push(box(x, -2.4, x + 0.4, -2));
    const L = buildLattice(
      buildWorld(roadSite({ road: { ...road, blockers: lamps } })),
      carOf(DEFAULT_VEHICLE),
    );
    const r = accessCarport(L, backCarport, false)[0]!.route!;
    expect(r).toBeTruthy();
    const car = carOf(DEFAULT_VEHICLE);
    const w = buildWorld(roadSite({ road: { ...road, blockers: lamps } }));
    for (const p of r.poses) {
      const ca = Math.cos(p.a);
      const sa = Math.sin(p.a);
      // Car centre stays clear of the lamp row except at the gate.
      const cx = p.x + sa * car.bodyC;
      const cy = p.y + ca * car.bodyC;
      if (cx < 9 || cx > 22) expect(cy).toBeLessThan(-2.4 + 0.1);
    }
    expect(w.roadMode).toBe(true);
  });

  it("shunts when a turn in one go does not fit", () => {
    // Road 7 m wide right against the plot, a 3.5 m gate between walls, carport straight
    // behind it: a car coming along the street cannot line up in one go.
    const narrow = { drivable: [box(-25, -7, 50, 0)], blockers: [] as Polygon[] };
    const w = buildWorld({
      plot: box(0, 0, 25, 30),
      solids: [box(0, 0, 13, 14), box(16.5, 0, 25, 14)],
      scan: [],
      scanCellM: 0.5,
      gates: [{ a: [13, 0], b: [16.5, 0], kind: "existing" }],
      road: narrow,
    });
    const L = buildLattice(w, carOf(DEFAULT_VEHICLE));
    const r = accessCarport(L, { x0: 13.25, y0: 18, x1: 16.25, y1: 23, o: "ns", bays: 1 }, true)[0]!
      .route;
    expect(r).toBeTruthy();
    expect(r!.shunts).toBeGreaterThan(0);
    expect(r!.poses.some((p) => p.rev)).toBe(true);
    expect(r!.how).toMatch(/shunt/);
  });
});

describe("carports at any angle, and backing in", () => {
  it("drives into a carport turned 30° and parks along its axis", () => {
    const L = buildLattice(buildWorld(site()), carOf(DEFAULT_VEHICLE));
    const ang = (30 * Math.PI) / 180;
    const r: CarportRect = { x0: 14.5, y0: 21, x1: 17.5, y1: 26, o: "ns", bays: 1, ang };
    // The turned footprint must stay on the plot: shift it left a little.
    r.x0 -= 1.5;
    r.x1 -= 1.5;
    const acc = accessCarport(L, r, false);
    expect(acc[0]!.route).toBeTruthy();
    const end = acc[0]!.parked;
    const d = Math.abs(Math.sin(end.a - ang));
    expect(d).toBeLessThan(1e-6);
    const out = leaveCarport(L, r, acc, 0);
    expect(out).toBeTruthy();
  });

  it("double carport at 60°: both bays reachable, cars side by side along the axis", () => {
    const L = buildLattice(buildWorld(site({}, 18)), carOf(DEFAULT_VEHICLE));
    const ang = Math.PI / 3;
    const r: CarportRect = { x0: 9, y0: 19, x1: 15, y1: 24, o: "ns", bays: 2, ang };
    const acc = accessCarport(L, r, false);
    expect(acc.every((b) => b.route)).toBe(true);
    for (const b of acc) expect(Math.abs(Math.sin(b.parked.a - ang))).toBeLessThan(1e-6);
  });
});
