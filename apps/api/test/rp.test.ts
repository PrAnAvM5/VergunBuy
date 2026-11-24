import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createRp, isBindingPlan } from "../src/rp.ts";

const KEY = "rp-test-key-123456";
const ring = [
  [84900, 383320],
  [84920, 383320],
  [84920, 383340],
  [84900, 383340],
];

const plan = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  naam: id,
  type: "bestemmingsplan",
  regelBinding: "burgerbindend",
  regelStatus: "geldend",
  isHistorisch: false,
  planstatusInfo: { planstatus: "vastgesteld", datum: "2012-11-07" },
  dossier: { status: "geheel onherroepelijk in werking" },
  ...extra,
});

function setup() {
  const seen: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({
      url,
      body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string>,
    });
    if (url.includes("/plannen/_zoek"))
      return new Response(
        JSON.stringify({
          _embedded: {
            plannen: [
              plan("BP-1"),
              plan("BP-ON", { planstatusInfo: { planstatus: "ontwerp" } }),
              plan("STRUCTUURVISIE", { regelBinding: "beleid" }),
            ],
          },
        }),
      );
    if (url.includes("/bestemmingsvlakken/_zoek")) {
      const page = new URL(url).searchParams.get("page");
      return new Response(
        JSON.stringify({
          _embedded: {
            bestemmingsvlakken: [
              {
                id: `bv-${page}`,
                type: page === "1" ? "enkelbestemming" : "dubbelbestemming",
                naam: page === "1" ? "Wonen - 1" : "Waarde - Archeologie",
                bestemmingshoofdgroep: page === "1" ? "wonen" : "waarde",
                artikelnummer: "16",
                geometrie: { type: "Polygon", coordinates: [] },
                _links: { teksten: [{ tekstId: "NL.IMRO.PT.regels.s219" }] },
              },
            ],
          },
          _links: page === "1" ? { next: { href: "..." } } : {},
        }),
      );
    }
    return new Response(JSON.stringify({ _embedded: {} }));
  };
  const app = createApp({
    allowedOrigins: ["https://pranavm5.github.io"],
    version: "test",
    log: () => {},
    rp: createRp({ key: KEY, fetchFn }),
  });
  return { app, seen };
}

describe("old zoning plans (Ruimtelijke Plannen)", () => {
  it("keeps only binding plans in force", () => {
    expect(isBindingPlan(plan("a"))).toBe(true);
    expect(isBindingPlan(plan("a", { planstatusInfo: { planstatus: "geconsolideerd" } }))).toBe(
      false,
    );
    expect(isBindingPlan(plan("a", { regelBinding: "instructieregels" }))).toBe(false);
    expect(isBindingPlan(plan("a", { isHistorisch: true }))).toBe(false);
  });

  it("returns plan objects overlapping the plot, all pages, key only in the header", async () => {
    const { app, seen } = setup();
    const res = await app.request("/api/rp/zoning", {
      method: "POST",
      body: JSON.stringify({ ring }),
      headers: { "content-type": "application/json" },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(KEY);
    const { data } = JSON.parse(text);
    expect(data.complete).toBe(true);
    expect(data.plans.map((p: { id: string }) => p.id)).toEqual(["BP-1"]);
    expect(data.objects.map((o: { name: string }) => o.name)).toEqual([
      "Wonen - 1",
      "Waarde - Archeologie",
    ]);
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]!.body).toEqual({
      _geo: {
        intersectAndNotTouches: {
          type: "Polygon",
          coordinates: [[...ring, ring[0]]],
        },
      },
    });
  });

  it("rejects a malformed outline", async () => {
    const { app } = setup();
    const res = await app.request("/api/rp/zoning", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });
});
