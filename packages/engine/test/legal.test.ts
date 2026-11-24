import { describe, expect, it } from "vitest";
import {
  assessExclusions,
  type LegalFacts,
  type Polygon,
  type ZoningObjectFact,
} from "../src/index.ts";

const sq = (x: number, y: number, w: number, h = w): Polygon => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const plot = sq(0, 0, 20, 30);

const zone = (
  name: string,
  outline: Polygon,
  extra: Partial<ZoningObjectFact> = {},
): ZoningObjectFact => ({
  planId: "BP",
  planName: "Bebouwde kom",
  kind: "bestemmingsvlakken",
  type: "enkelbestemming",
  name,
  mainGroup: null,
  outlines: [outline],
  ...extra,
});

const facts = (over: Partial<LegalFacts> = {}): LegalFacts => ({
  zoning: { status: "complete", plans: [], objects: [zone("Wonen - 1", sq(-5, -5, 40, 50))] },
  monuments: { status: "complete", items: [], municipalRegisterCheckedOn: "2026-11-25" },
  protectedViews: { status: "complete", names: [] },
  ...over,
});
const state = (f: LegalFacts, id: string) =>
  assessExclusions(plot, f).find((r) => r.ruleId === id)!;

describe("rule exclusions from legal facts", () => {
  it("clears every exclusion for an ordinary home", () => {
    const r = assessExclusions(plot, facts());
    expect(r.map((x) => x.state)).toEqual(["clear", "clear", "clear", "clear", "clear"]);
  });

  it("a monument on the plot switches off both 22.27 and 22.36", () => {
    const f = facts({
      monuments: {
        status: "complete",
        municipalRegisterCheckedOn: "x",
        items: [{ register: "national", id: "1", name: "Boerderij", relation: "on-plot" }],
      },
    });
    expect(state(f, "ex-monument-2227").state).toBe("applies");
    expect(state(f, "ex-monument-village-2236").state).toBe("applies");
  });

  it("archaeology depends on where (and how big) the carport is", () => {
    const f = facts({
      zoning: {
        status: "complete",
        plans: [],
        objects: [zone("Waarde - Archeologie", sq(10, 0, 30, 30), { type: "dubbelbestemming" })],
      },
    });
    const r = state(f, "ex-archaeology-2227");
    expect(r.state).toBe("depends-on-placement");
    expect(r.zones).toHaveLength(1);
  });

  it("a fuel station within 120 m is unknown, one further away is clear", () => {
    const near = facts({
      zoning: {
        status: "complete",
        plans: [],
        objects: [zone("Bedrijf - Verkooppunt motorbrandstoffen", sq(100, 0, 10))],
      },
    });
    expect(state(near, "ex-safety-2236").state).toBe("unknown");
    const far = facts({
      zoning: {
        status: "complete",
        plans: [],
        objects: [zone("Bedrijf - Verkooppunt motorbrandstoffen", sq(200, 0, 10))],
      },
    });
    expect(state(far, "ex-safety-2236").state).toBe("clear");
  });

  it("a pipeline strip on the plot depends on placement; a high-voltage strip is not a pipeline", () => {
    const pipe = facts({
      zoning: {
        status: "complete",
        plans: [],
        objects: [zone("Leiding - Gas", sq(0, 0, 5, 30), { type: "dubbelbestemming" })],
      },
    });
    expect(state(pipe, "ex-safety-2236").state).toBe("depends-on-placement");
    const hv = facts({
      zoning: {
        status: "complete",
        plans: [],
        objects: [zone("Leiding - Hoogspanningsverbinding", sq(0, 0, 5, 30))],
      },
    });
    expect(state(hv, "ex-safety-2236").state).toBe("clear");
  });

  it("missing data is unknown, never clear", () => {
    const r = assessExclusions(
      plot,
      facts({
        zoning: { status: "incomplete", plans: [], objects: [] },
        monuments: { status: "missing", items: [], municipalRegisterCheckedOn: "" },
      }),
    );
    expect(r.every((x) => x.state === "unknown")).toBe(true);
  });
});
