import { describe, expect, it } from "vitest";
import {
  assessAccess,
  downgrade,
  gate,
  isCarSurface,
  newQuality,
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
