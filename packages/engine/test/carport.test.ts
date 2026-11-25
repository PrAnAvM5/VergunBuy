import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backYard,
  CARPORT_PRESETS,
  evaluate,
  prepare,
  regionArea,
  RuleSet,
  suggest,
  type AreaTableParams,
  type CarportSite,
  type ExclusionResult,
  type Polygon,
} from "../src/index.ts";

const rules = RuleSet.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../rulesets/woensdrecht/carport/2026-11-24.json"),
      "utf8",
    ),
  ),
);
const ev = rules.rules.find((r) => r.id === "ia-area-limit")!.evaluation;
const areaTable = (ev.kind === "check" ? ev.params : {}) as unknown as AreaTableParams;

const box = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const clear = (id: string): ExclusionResult => ({ ruleId: id, state: "clear", reason: "clear" });
const EXCL = [
  "ex-monument-2227",
  "ex-village-view-2227",
  "ex-archaeology-2227",
  "ex-monument-village-2236",
  "ex-safety-2236",
];

/** Detached house on a 20 × 40 m plot, street at the bottom, driveway on the left. */
function site(over: Partial<CarportSite> = {}): CarportSite {
  return {
    plot: box(-10, 0, 10, 40),
    house: [{ outline: box(-6, 5, 6, 15), heightM: 8, storeys: 2, isDwelling: true }],
    buildings: [],
    structures: [],
    publicAreas: [box(-30, -10, 30, 0)],
    publicSides: [],
    front: "street-label",
    access: {
      level: "registered",
      entries: [
        [
          [-10, 0],
          [-6.5, 0],
        ],
      ],
      note: "registered exit",
    },
    obstacles: { cells: [], cellM: 0.5 },
    exclusions: EXCL.map(clear),
    extensionEvidence: [],
    areaTable,
    freshness: { known: true, staleRules: [], note: "verified versions" },
    quality: { plot: "complete", buildings: "complete", publicArea: "complete" },
    ...over,
  };
}
const single = { ...CARPORT_PRESETS.single, rotation: 0 as const };
const outcome = (v: ReturnType<typeof evaluate>, id: string) =>
  v.checks.find((c) => c.id === id)!.outcome;

describe("back-yard area (achtererfgebied)", () => {
  it("starts 1 m behind the front façade and leaves out the house", () => {
    const y = backYard(site());
    expect(y.frontLineY).toBe(6);
    expect(regionArea(y.region)).toBeCloseTo(20 * 34 - 12 * 9, 1);
  });

  it("uses the deepest visible part of a stepped front", () => {
    const y = backYard(
      site({
        house: [
          {
            outline: [
              [-6, 5],
              [0, 5],
              [0, 7],
              [6, 7],
              [6, 15],
              [-6, 15],
            ],
            heightM: 8,
            isDwelling: true,
          },
        ],
      }),
    );
    expect(y.frontLineY).toBe(8);
  });

  it("on a corner plot leaves out the strip along the side street", () => {
    const y = backYard(site({ publicSides: ["left"] }));
    expect(regionArea(y.region)).toBeCloseTo(16 * 34 - 12 * 9, 1);
  });
});

describe("carport verdict", () => {
  it("is green in the back garden of an ordinary detached house", () => {
    const v = evaluate(prepare(site()), { x: 0, y: 25, ...single });
    expect(v.checks.filter((c) => c.outcome !== "pass").map((c) => c.id)).toEqual([]);
    expect(v.colour).toBe("green");
  });

  it("needs a permit in the front yard", () => {
    const v = evaluate(prepare(site()), { x: -8, y: 2.6, ...single });
    expect(outcome(v, "back-yard")).toBe("fail");
    expect(v.colour).toBe("red");
    expect(v.headline).toBe("Permit needed");
  });

  it("is not possible where a car cannot get to (house fills the width)", () => {
    const s = site({ house: [{ outline: box(-9, 5, 9, 15), heightM: 8, isDwelling: true }] });
    const v = evaluate(prepare(s), { x: 0, y: 25, ...single });
    expect(outcome(v, "car-route")).toBe("fail");
    expect(v.headline).toBe("Not possible here");
  });

  it("is never green within 1 m of public area", () => {
    const s = site({ publicAreas: [box(-30, -10, 30, 0), box(10, 0, 14, 40)] });
    const v = evaluate(prepare(s), { x: 8.4, y: 25, ...single });
    expect(outcome(v, "public-distance")).toBe("fail");
    expect(v.colour).toBe("red");
  });

  it("a monument on the plot means a permit", () => {
    const s = site({
      exclusions: [
        ...EXCL.slice(1).map(clear),
        { ruleId: "ex-monument-2227", state: "applies", reason: "monument" },
      ],
    });
    expect(evaluate(prepare(s), { x: 0, y: 25, ...single }).colour).toBe("red");
  });

  it("archaeology only matters for 50 m² or more inside the zone", () => {
    const zone: ExclusionResult = {
      ruleId: "ex-archaeology-2227",
      state: "depends-on-placement",
      reason: "zone",
      zones: [box(-10, 20, 10, 40)],
    };
    const s = site({
      exclusions: [...EXCL.filter((e) => e !== "ex-archaeology-2227").map(clear), zone],
    });
    const p = prepare(s);
    expect(evaluate(p, { x: 0, y: 25, ...single }).colour).toBe("green");
    expect(
      outcome(
        evaluate(p, { x: 0, y: 30, widthM: 6, lengthM: 9, rotation: 0 }),
        "ex-archaeology-2227",
      ),
    ).toBe("fail");
  });

  it("is amber when a rule's document changed since it was verified", () => {
    const s = site({ freshness: { known: true, staleRules: ["pf-back-yard"], note: "changed" } });
    const v = evaluate(prepare(s), { x: 0, y: 25, ...single });
    expect(outcome(v, "back-yard")).toBe("unknown");
    expect(v.colour).toBe("amber");
  });

  it("is amber when an unregistered way in has not been confirmed", () => {
    const s = site({
      access: {
        level: "possible",
        entries: [
          [
            [-10, 0],
            [-6.5, 0],
          ],
        ],
        note: "across the pavement",
      },
    });
    expect(evaluate(prepare(s), { x: 0, y: 25, ...single }).colour).toBe("amber");
  });

  it("lets a possible house extension decide when the room is tight", () => {
    const shed = { id: "shed", outline: box(-10, 34, 0, 40), label: "shed", onPlot: true };
    const s = site({ buildings: [shed], extensionEvidence: ["permit 2019: extension"] });
    const v = evaluate(prepare(s), { x: 0, y: 25, widthM: 6, lengthM: 5, rotation: 0 });
    expect(outcome(v, "area")).toBe("unknown");
    expect(v.colour).toBe("amber");
  });

  it("warns about a tree where the carport would stand", () => {
    const s = site({
      obstacles: { cells: [{ at: [0, 25], heightM: 7, kind: "tall" }], cellM: 0.5, scanYear: 2024 },
    });
    const v = evaluate(prepare(s), { x: 0, y: 25, ...single });
    expect(v.warnings.map((w) => w.id)).toContain("obstacle");
  });
});

describe("suggestions", () => {
  it("finds a green spot in the back garden, away from trees", () => {
    const tree = { at: [0, 30] as const, heightM: 8, kind: "tall" };
    const p = prepare(site({ obstacles: { cells: [tree], cellM: 0.5 } }));
    const { best, green } = suggest(p, CARPORT_PRESETS.single);
    expect(best?.verdict.colour).toBe("green");
    expect(best?.verdict.warnings).toEqual([]);
    expect(green.length).toBeGreaterThan(20);
  });

  it("finds nothing green when the only way in is blocked", () => {
    const p = prepare(
      site({ house: [{ outline: box(-9, 5, 9, 15), heightM: 8, isDwelling: true }] }),
    );
    const { best } = suggest(p, CARPORT_PRESETS.single);
    expect(best?.verdict.colour).not.toBe("green");
  });
});
