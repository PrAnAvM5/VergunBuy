import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { addressMatches, createPermits, parseRecords } from "../src/permits.ts";

const xml = readFileSync(join(import.meta.dirname, "sru-aalbersestraat.xml"), "utf8");
// Plot of Aalbersestraat 7 around the publication's point (81044.614, 381928.854).
const ring: [number, number][] = [
  [81035, 381920],
  [81055, 381920],
  [81055, 381940],
  [81035, 381940],
];

describe("permit history (official publications)", () => {
  it("reads id, date, activity, point and address label from the search answer", () => {
    const { total, records } = parseRecords(xml);
    expect(total).toBe(9);
    const r = records.find((x) => x.id === "gmb-2026-506726")!;
    expect(r.date).toBe("2026-10-30");
    expect(r.activities).toContain("bouwen");
    expect(r.point).toEqual([81044.614, 381928.854]);
    expect(r.label).toBe("Aalbersestraat 7 te Hoogerheide");
  });

  it("matches exact house numbers only", () => {
    expect(addressMatches("Aalbersestraat 7 te Hoogerheide", "Aalbersestraat", 7)).toBe(true);
    expect(addressMatches("Aalbersestraat 71 te Hoogerheide", "Aalbersestraat", 7)).toBe(false);
    expect(addressMatches("Hoogerheide - Aalbersestraat 36", "Aalbersestraat", 3)).toBe(false);
    expect(addressMatches("Markt 10a", "Markt", 10, "a")).toBe(true);
    expect(addressMatches("Markt 10b", "Markt", 10)).toBe(false);
  });

  it("returns the publications on the plot with their decision text", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/sru?")) return new Response(xml);
      return new Response("<p>Hoogerheide - Aalbersestraat 7: het plaatsen van een carport</p>");
    };
    const app = createApp({
      allowedOrigins: ["https://pranavm5.github.io"],
      version: "test",
      log: () => {},
      permits: createPermits({ fetchFn }),
    });
    const res = await app.request("/api/permits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        municipality: "Woensdrecht",
        street: "Aalbersestraat",
        number: 7,
        ring,
      }),
    });
    const { data } = await res.json();
    expect(data.complete).toBe(true);
    expect(data.publications.map((p: { id: string }) => p.id)).toContain("gmb-2026-506726");
    expect(data.publications[0].text).toContain("carport");
    expect(
      data.publications.some((p: { label: string }) => /Aalbersestraat 36/.test(p.label ?? "")),
    ).toBe(false);
  });
});
