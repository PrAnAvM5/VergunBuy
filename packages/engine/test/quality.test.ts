import { describe, expect, it } from "vitest";
import {
  assessAccess,
  downgrade,
  gate,
  isCarSurface,
  newQuality,
  pavementCrossings,
  facingLengthM,
  ROAD_PARCEL_VERGE,
  type Polygon,
  type DataStatus,
  type Domain,
  type Outcome,
} from "../src/index.ts";

const DOMAINS: Domain[] = [
  "plot",
  "buildings",
  "heights",
  "publicArea",
  "vegetation",
  "access",
  "front",
];
const STATUSES: DataStatus[] = ["complete", "assumed", "partial", "missing"];
const OUTCOMES: Outcome[] = ["pass", "fail", "unknown"];

describe("gate (zero false greens)", () => {
  it("never lets a pass through when any needed domain is not complete — exhaustive over statuses", () => {
    for (const domain of DOMAINS)
      for (const status of STATUSES)
        for (const outcome of OUTCOMES) {
          const q = newQuality();
          if (status !== "complete") downgrade(q, domain, status, `${domain} ${status}`);
          const g = gate(outcome, DOMAINS, q);
          if (status !== "complete") expect(g.outcome).not.toBe("pass");
          if (status === "complete") expect(g.outcome).toBe(outcome);
        }
  });

  it("keeps fail as fail (cannot create a green) but explains the data gap", () => {
    const q = newQuality();
    downgrade(q, "heights", "missing", "Heights could not be loaded.");
    expect(gate("fail", ["heights"], q)).toEqual({
      outcome: "fail",
      reasons: ["Heights could not be loaded."],
    });
  });

  it("ignores domains the check does not need", () => {
    const q = newQuality();
    downgrade(q, "vegetation", "partial", "Garden trees are not registered.");
    expect(gate("pass", ["plot", "publicArea"], q).outcome).toBe("pass");
  });

  it("downgrade never raises a status", () => {
    const q = newQuality();
    downgrade(q, "plot", "missing", "a");
    downgrade(q, "plot", "assumed", "b");
    expect(q.plot.status).toBe("missing");
    expect(q.plot.reasons).toEqual(["a", "b"]);
  });
});

describe("assessAccess", () => {
  it("passes only on a registered driveway crossing", () => {
    expect(
      assessAccess({ publicDataAvailable: true, registeredExits: 1, carReachableRunsM: [] })
        .outcome,
    ).toBe("pass");
  });
  it("is unknown (never fail) when a car can reach the boundary but nothing is registered", () => {
    const r = assessAccess({
      publicDataAvailable: true,
      registeredExits: 0,
      carReachableRunsM: [1.2, 6.4],
    });
    expect(r).toMatchObject({ level: "possible", outcome: "unknown" });
  });
  it("is unknown, not fail, when nothing is found", () => {
    expect(
      assessAccess({ publicDataAvailable: true, registeredExits: 0, carReachableRunsM: [1.5] }),
    ).toMatchObject({ level: "none-found", outcome: "unknown" });
  });
  it("is unknown without street data", () => {
    expect(
      assessAccess({ publicDataAvailable: false, registeredExits: 0, carReachableRunsM: [] }).level,
    ).toBe("unknown");
  });
  it("recognises car surfaces and excludes foot and cycle paths", () => {
    expect(isCarSurface("rijbaan lokale weg")).toBe(true);
    expect(isCarSurface("parkeervlak")).toBe(true);
    expect(isCarSurface("voetpad")).toBe(false);
    expect(isCarSurface("fietspad")).toBe(false);
  });
});

describe("pavementCrossings", () => {
  // Plot 10 m wide, front edge on y = 0. Pavement 0..-2, road -2..-8.
  const plot: Polygon = [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
  ];
  const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const pavement = { outline: rect(-5, -2, 15, 0), label: "voetpad", kind: "footpath" };
  const road = { outline: rect(-5, -8, 15, -2), label: "rijbaan lokale weg", kind: "road" };

  it("finds the road across the pavement along the whole front", () => {
    const runs = pavementCrossings(plot, [pavement, road]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.lengthM).toBeCloseTo(10, 6);
    // Measured in 0.25 m steps, so within one step of the true 2 m.
    expect(runs[0]!.acrossM).toBeGreaterThanOrEqual(2);
    expect(runs[0]!.acrossM).toBeLessThanOrEqual(2.25);
    expect(runs[0]!.via).toEqual(["voetpad"]);
    expect(runs[0]!.reaches).toBe("rijbaan lokale weg");
  });

  it("records which crossing it reaches, so a registered crossing across the pavement is found", () => {
    const inrit = { id: "inrit-1", outline: rect(2, -3, 6, -2), label: "inrit", kind: "road" };
    const runs = pavementCrossings(plot, [inrit, pavement, road]);
    const toInrit = runs.filter((r) => r.reachesId === "inrit-1");
    expect(toInrit.reduce((s, r) => s + r.lengthM, 0)).toBeCloseTo(4, 6);
  });

  it("stops at unmapped ground unless it lies on the road's own parcel", () => {
    // Gap 0..-3 not mapped in BGT; road -3..-8.
    const road2 = { outline: rect(-5, -8, 15, -3), label: "rijbaan lokale weg", kind: "road" };
    expect(pavementCrossings(plot, [road2])).toHaveLength(0);
    const roadParcel = { id: "road", outline: rect(-5, -9, 15, 0) };
    const runs = pavementCrossings(plot, [road2], [roadParcel]);
    expect(runs[0]?.via).toContain(ROAD_PARCEL_VERGE);
    // A different (private) parcel in the gap blocks it.
    const garden = { id: "garden", outline: rect(-5, -3, 15, 0) };
    const roadOnly = { id: "road", outline: rect(-5, -9, 15, -3) };
    expect(pavementCrossings(plot, [road2], [garden, roadOnly])).toHaveLength(0);
  });

  it("never crosses water, and ignores roads further than the limit", () => {
    const ditch = { outline: rect(-5, -2, 15, 0), label: "sloot", kind: "water" };
    expect(pavementCrossings(plot, [ditch, road])).toHaveLength(0);
    const farRoad = { outline: rect(-5, -20, 15, -10), label: "rijbaan lokale weg", kind: "road" };
    const wide = { outline: rect(-5, -10, 15, 0), label: "voetpad", kind: "footpath" };
    expect(pavementCrossings(plot, [wide, farRoad])).toHaveLength(0);
  });

  it("access ladder: a pavement crossing is 'possible', never a pass", () => {
    const r = assessAccess({
      publicDataAvailable: true,
      registeredExits: 0,
      carReachableRunsM: [],
      pavementRuns: [{ lengthM: 10, acrossM: 2 }],
    });
    expect(r.level).toBe("possible");
    expect(r.route).toBe("across-pavement");
    expect(r.outcome).toBe("unknown");
    expect(
      assessAccess({
        publicDataAvailable: true,
        registeredExits: 0,
        carReachableRunsM: [],
        pavementRuns: [{ lengthM: 2, acrossM: 2 }],
      }).level,
    ).toBe("none-found");
  });
});

describe("facingLengthM", () => {
  const plot: Polygon = [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
  ];
  it("counts the boundary that looks straight at the shape", () => {
    // Crossing 4 m wide, right in front of the plot.
    const inFront: Polygon = [
      [3, -2],
      [7, -2],
      [7, 0],
      [3, 0],
    ];
    expect(facingLengthM(plot, inFront)).toBeCloseTo(4, 1);
  });
  it("gives (almost) nothing for a shape that only touches a corner", () => {
    const atCorner: Polygon = [
      [-4, -2],
      [0, -2],
      [0, 0],
      [-4, 0],
    ];
    expect(facingLengthM(plot, atCorner)).toBeLessThan(0.5);
  });
});
