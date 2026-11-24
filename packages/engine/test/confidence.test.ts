import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedArea,
  atLeast,
  checkAreaLimit,
  confidenceFrom,
  RuleSet,
  weakest,
  type AreaTableParams,
} from "../src/index.ts";

const rules = RuleSet.parse(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../rulesets/woensdrecht/carport/2026-11-24.json"),
      "utf8",
    ),
  ),
);
const areaRule = rules.rules.find((r) => r.id === "ia-area-limit")?.evaluation;
const params = (areaRule?.kind === "check" ? areaRule.params : {}) as unknown as AreaTableParams;

describe("weakest link", () => {
  it("takes the lowest level", () => {
    expect(weakest(["high", "medium", "high"])).toBe("medium");
    expect(weakest(["high", "low"])).toBe("low");
    expect(weakest([])).toBe("unknown");
  });
});

describe("confidenceFrom", () => {
  const e = (
    signal: "supports" | "contradicts" | "not-available",
    strength: "proof" | "hint" = "proof",
  ) => ({
    source: "x",
    signal,
    strength,
    note: "",
  });
  it("high with supporting proof", () =>
    expect(confidenceFrom([e("supports"), e("not-available")])).toBe("high"));
  it("low when sources disagree", () =>
    expect(confidenceFrom([e("supports"), e("contradicts", "hint")])).toBe("low"));
  it("medium with agreeing hints only", () =>
    expect(confidenceFrom([e("supports", "hint")])).toBe("medium"));
  it("unknown with nothing", () => expect(confidenceFrom([e("not-available")])).toBe("unknown"));
});

describe("atLeast over a range", () => {
  it("pass / unknown / fail", () => {
    expect(atLeast({ worst: 30, best: 40 }, 30)).toBe("pass");
    expect(atLeast({ worst: 25, best: 32 }, 30)).toBe("unknown");
    expect(atLeast({ worst: 10, best: 20 }, 30)).toBe("fail");
  });
});

describe("area limit (bruidsschat 22.36)", () => {
  it("follows the tiered table with a 150 m² cap", () => {
    expect(allowedArea(80, params)).toBe(40);
    expect(allowedArea(200, params)).toBe(70);
    expect(allowedArea(500, params)).toBe(110);
    expect(allowedArea(2000, params)).toBe(150);
  });

  const base = { backYardM2: 80, outbuildingsM2: 8, plannedM2: 30 };

  it("an unknown rear part gives a range and names the deciding part (no false green)", () => {
    const r = checkAreaLimit(
      { ...base, houseParts: [{ id: "part-2", areaM2: 14, status: "unknown" }] },
      params,
    );
    expect(r.freeM2).toEqual({ worst: 25, best: 32 });
    expect(r.outcome).toBe("unknown");
    expect(r.deciding).toEqual(["part-2"]);
  });

  it("a known extension counts as built and adds to the bebouwingsgebied", () => {
    const r = checkAreaLimit(
      { ...base, houseParts: [{ id: "part-2", areaM2: 14, status: "extension" }] },
      params,
    );
    expect(r.freeM2).toEqual({ worst: 25, best: 25 });
    expect(r.outcome).toBe("fail");
  });

  it("a known original part does not count", () => {
    const r = checkAreaLimit(
      { ...base, houseParts: [{ id: "part-2", areaM2: 14, status: "original" }] },
      params,
    );
    expect(r.outcome).toBe("pass");
  });

  it("worst case is never more generous than best case, for any sizes", () => {
    for (let yard = 20; yard <= 600; yard += 37) {
      for (let part = 0; part <= 60; part += 7) {
        const r = checkAreaLimit(
          {
            backYardM2: yard,
            outbuildingsM2: 5,
            plannedM2: 15,
            houseParts: [{ id: "p", areaM2: part, status: "unknown" }],
          },
          params,
        );
        expect(r.freeM2.worst).toBeLessThanOrEqual(r.freeM2.best);
      }
    }
  });
});
