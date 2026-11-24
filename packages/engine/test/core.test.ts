import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineOutcomes, RuleSet, SafeError, Tracer } from "../src/index.ts";

describe("combineOutcomes (zero false greens)", () => {
  it("is pass only when every check passes", () => {
    expect(combineOutcomes(["pass", "pass"])).toBe("pass");
  });
  it("is unknown when any check is unknown and none fail", () => {
    expect(combineOutcomes(["pass", "unknown"])).toBe("unknown");
  });
  it("is fail when any check fails", () => {
    expect(combineOutcomes(["unknown", "fail", "pass"])).toBe("fail");
  });
});

describe("Tracer", () => {
  it("records ok, degraded and failed steps with safe errors only", async () => {
    let t = 0;
    const tracer = new Tracer(() => (t += 5));
    await tracer.step("a", "Step A", (ctx) => ctx.summarize("found 1 plot"));
    await tracer.step("b", "Step B", (ctx) => ctx.degrade("tree data missing"));
    await expect(
      tracer.step("c", "Step C", () => {
        throw new SafeError("UPSTREAM_TIMEOUT", "The address service did not answer in time.");
      }),
    ).rejects.toThrow(SafeError);
    await expect(
      tracer.step("d", "Step D", () => {
        throw new Error("secret internal detail");
      }),
    ).rejects.toThrow();

    expect(tracer.steps.map((s) => s.status)).toEqual(["ok", "degraded", "failed", "failed"]);
    expect(tracer.steps[0]?.summary).toBe("found 1 plot");
    expect(tracer.steps[2]?.error).toBe("The address service did not answer in time.");
    expect(tracer.steps[3]?.error).not.toContain("secret");
    expect(tracer.steps[0]?.ms).toBe(5);
  });
});

describe("rule files", () => {
  const root = join(import.meta.dirname, "../../../rulesets");
  for (const municipality of readdirSync(root)) {
    for (const file of readdirSync(join(root, municipality))) {
      it(`${municipality}/${file} matches the RuleSet schema`, () => {
        const json: unknown = JSON.parse(readFileSync(join(root, municipality, file), "utf8"));
        const result = RuleSet.safeParse(json);
        expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
        expect(file).toBe(`${result.data?.version}.json`);
      });
    }
  }
});
