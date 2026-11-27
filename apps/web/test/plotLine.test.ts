import { describe, expect, it } from "vitest";
import { smoothedPieces } from "../src/plotLine.ts";

const P = (s: string) => ({ side: "street" as const, state: s as "open" | "hedge" | "exit" });

describe("smoothed plot line (display only)", () => {
  it("absorbs single flickers into the hedge and keeps exits", () => {
    const raw = "hhohhuhhohheeehhbhh"
      .split("")
      .map((c) => P({ h: "hedge", o: "open", u: "unknown", e: "exit", b: "barrier" }[c]!));
    const out = smoothedPieces(raw)
      .map((p) => p.state[0])
      .join("");
    expect(out).toBe("hhhhhhhhhhheeehhhhh");
  });
});
