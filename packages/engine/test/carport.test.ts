import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backYard,
  CARPORT_PRESETS,
  type CarportSite,
  contains,
  driveOut,
  evaluate,
  prepare,
  regionArea,
  RuleSet,
  options,
  type AreaTableParams,
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

/**
 * Detached house on a 20 × 40 m plot, street at the bottom, driveway on the left. A car (turning
 * radius about 4.5 m) reaches the back garden right of x ≈ 2 m forwards with a loop; spots right
 * behind the house (x ≈ 0) need more room to swing round.
 */
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
      frontage: [],
      note: "registered exit",
    },
    streetTrees: [],
    boundary: null,
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
    const v = evaluate(prepare(site()), { x: 4, y: 25, ...single });
    expect(v.checks.filter((c) => c.outcome !== "pass").map((c) => c.id)).toEqual([]);
    expect(v.colour).toBe("green");
  });

  it("needs a permit in the front yard", () => {
    const v = evaluate(prepare(site()), { x: -8, y: 2.6, ...single });
    expect(outcome(v, "back-yard")).toBe("fail");
    expect(outcome(v, "car-route")).toBe("pass");
    expect(v.colour).toBe("amber");
    expect(v.headline).toBe("Possible with a building permit");
  });

  it("is not possible where a car cannot get to (house fills the width)", () => {
    const s = site({ house: [{ outline: box(-9, 5, 9, 15), heightM: 8, isDwelling: true }] });
    const v = evaluate(prepare(s), { x: 4, y: 25, ...single });
    expect(outcome(v, "car-route")).toBe("fail");
    expect(v.colour).toBe("red");
    expect(v.headline).toBe("Not possible here: a car cannot drive in");
  });

  it("is never green within 1 m of public area", () => {
    const s = site({ publicAreas: [box(-30, -10, 30, 0), box(-30, 40, 30, 44)] });
    const v = evaluate(prepare(s), { x: 4, y: 37.4, ...single });
    expect(outcome(v, "public-distance")).toBe("fail");
    expect(v.colour).toBe("amber");
  });

  it("a monument on the plot means a permit", () => {
    const s = site({
      exclusions: [
        ...EXCL.slice(1).map(clear),
        { ruleId: "ex-monument-2227", state: "applies", reason: "monument" },
      ],
    });
    const v = evaluate(prepare(s), { x: 4, y: 25, ...single });
    expect(outcome(v, "ex-monument-2227")).toBe("fail");
    expect(v.colour).toBe("amber");
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
    expect(evaluate(p, { x: 4, y: 25, ...single }).colour).toBe("green");
    expect(
      outcome(
        evaluate(p, { x: 0, y: 30, widthM: 6, lengthM: 9, rotation: 0 }),
        "ex-archaeology-2227",
      ),
    ).toBe("fail");
  });

  it("is amber when a rule's document changed since it was verified", () => {
    const s = site({ freshness: { known: true, staleRules: ["pf-back-yard"], note: "changed" } });
    const v = evaluate(prepare(s), { x: 4, y: 25, ...single });
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
        frontage: [],
        note: "across the pavement",
      },
    });
    expect(evaluate(prepare(s), { x: 4, y: 25, ...single }).colour).toBe("amber");
  });

  it("lets a possible house extension decide when the room is tight", () => {
    const shed = { id: "shed", outline: box(6.5, 0, 10, 22), label: "shed", onPlot: true };
    const s = site({ buildings: [shed], extensionEvidence: ["permit 2019: extension"] });
    const v = evaluate(prepare(s), { x: 4, y: 25, widthM: 6, lengthM: 5, rotation: 0 });
    expect(outcome(v, "area")).toBe("unknown");
    expect(v.colour).toBe("amber");
  });

  it("is red over a tree and amber over shrubs", () => {
    const cells = (h: number, tree: boolean, material: "plant" | "solid" = "plant") => ({
      cells: [{ at: [4, 25] as const, heightM: h, kind: tree ? "tall" : "medium", tree, material }],
      cellM: 0.5,
      scanYear: 2024,
    });
    const t = evaluate(prepare(site({ obstacles: cells(7, true) })), { x: 4, y: 25, ...single });
    expect(outcome(t, "no-tree")).toBe("fail");
    expect(t.colour).toBe("red");
    const s = evaluate(prepare(site({ obstacles: cells(1.6, false) })), { x: 4, y: 25, ...single });
    expect(outcome(s, "no-tree")).toBe("unknown");
    expect(s.colour).toBe("amber");
    const w = evaluate(prepare(site({ obstacles: cells(1.2, false, "solid") })), {
      x: 4,
      y: 25,
      ...single,
    });
    expect(outcome(w, "no-tree")).toBe("unknown");
    expect(w.checks.find((c) => c.id === "no-tree")!.detail).toContain("solid");
  });

  it("a car of adjustable size: too big for the bay is not feasible", () => {
    const big = prepare(site(), { widthM: 2.2, lengthM: 5.2, outerRadiusM: 7, clearanceM: 0.5 });
    const v = evaluate(big, { x: 4, y: 25, ...single });
    expect(outcome(v, "car-fit")).toBe("fail");
    expect(v.colour).toBe("red");
  });

  it("a double carport is reached in both bays and the car can drive out", () => {
    const p = prepare(site());
    const v = evaluate(p, { x: 4, y: 25, widthM: 6, lengthM: 5, rotation: 0 });
    expect(v.access.rect.bays).toBe(2);
    expect(v.access.bays.every((b) => b.route)).toBe(true);
    expect(driveOut(v.access, 0)).not.toBeNull();
  });
});

describe("numbered options", () => {
  const overlaps = (a: Polygon, b: Polygon) => {
    const bb = (p: Polygon) => [
      Math.min(...p.map((q) => q[0])),
      Math.min(...p.map((q) => q[1])),
      Math.max(...p.map((q) => q[0])),
      Math.max(...p.map((q) => q[1])),
    ];
    const [a0, a1, a2, a3] = bb(a);
    const [b0, b1, b2, b3] = bb(b);
    return a0! < b2! && b0! < a2! && a1! < b3! && b1! < a3!;
  };

  it("offers non-overlapping spots, green first, never over a tree", () => {
    const tree = {
      at: [0, 30] as const,
      heightM: 8,
      kind: "tall",
      tree: true,
      material: "plant" as const,
    };
    const p = prepare(site({ obstacles: { cells: [tree], cellM: 0.5 } }));
    const opts = options(p, CARPORT_PRESETS.single);
    expect(opts.length).toBeGreaterThanOrEqual(3);
    expect(opts[0]!.verdict.colour).toBe("green");
    expect(opts.map((o) => o.n)).toEqual(opts.map((_, i) => i + 1));
    expect(opts.every((o) => o.verdict.colour !== "red")).toBe(true);
    expect(opts.some((o) => contains(o.verdict.outline, tree.at))).toBe(false);
    for (const a of opts)
      for (const b of opts)
        if (a !== b) expect(overlaps(a.verdict.outline, b.verdict.outline)).toBe(false);
    expect(new Set(opts.map((o) => o.zone)).size).toBeGreaterThan(1);
  });

  it("offers nothing green when the only way in is blocked", () => {
    const p = prepare(
      site({ house: [{ outline: box(-9, 5, 9, 15), heightM: 8, isDwelling: true }] }),
    );
    const opts = options(p, CARPORT_PRESETS.single);
    expect(opts.every((o) => o.verdict.colour === "amber")).toBe(true);
  });
});

describe("the street side of the plot (fences, hedges, exits)", () => {
  /** Bottom edge in 0.5 m pieces: `stateAt(x)` decides each; the other edges are "other". */
  const boundary = (stateAt: (x: number) => "exit" | "open" | "hedge" | "barrier") => {
    const out: NonNullable<CarportSite["boundary"]> = [];
    for (let x = -10; x < 10; x += 0.5)
      out.push({ a: [x, 0], b: [x + 0.5, 0], side: "street", state: stateAt(x + 0.25) });
    return out;
  };
  const spot = { x: 4, y: 25, ...single };

  it("through the registered exit when the rest is fenced: permit-free route", () => {
    const v = evaluate(
      prepare(site({ boundary: boundary((x) => (x < -6.5 ? "exit" : "barrier")) })),
      spot,
    );
    expect(v.access.via).toBe("existing");
    expect(outcome(v, "car-route")).toBe("pass");
  });

  it("only through a fence: amber, open it and a new exit", () => {
    const v = evaluate(prepare(site({ boundary: boundary(() => "barrier") })), spot);
    expect(v.access.via).toBe("through-barrier");
    expect(v.access.crossed).toContain("barrier");
    expect(outcome(v, "car-route")).toBe("unknown");
    expect(v.colour).toBe("amber");
    expect(v.checks.find((c) => c.id === "car-route")!.detail).toContain("fence or wall");
  });

  it("only through a hedge: amber, a piece of hedge has to go", () => {
    const v = evaluate(prepare(site({ boundary: boundary(() => "hedge") })), spot);
    expect(v.access.via).toBe("through-barrier");
    expect(v.checks.find((c) => c.id === "car-route")!.detail).toContain("hedge");
  });

  it("driving over shrubs on the way in is a condition, not a block", () => {
    const shrubs = [];
    for (let y = 2; y < 12; y += 0.5)
      for (let x = -9.5; x < -6.5; x += 0.5)
        shrubs.push({
          at: [x, y] as const,
          heightM: 1.5,
          kind: "medium",
          tree: false,
          material: "plant" as const,
        });
    const v = evaluate(
      prepare(
        site({
          boundary: boundary((x) => (x < -6.5 ? "exit" : "barrier")),
          obstacles: { cells: shrubs, cellM: 0.5 },
        }),
      ),
      spot,
    );
    expect(v.access.via).toBe("existing");
    expect(v.access.sweptShrubM2).toBeGreaterThan(1);
    expect(outcome(v, "car-route")).toBe("unknown");
  });
});
