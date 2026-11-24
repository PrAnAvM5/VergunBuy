import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createDso } from "../src/dso.ts";

const KEY = "test-key-1234567890";
const answer = {
  _embedded: {
    regelingen: [
      {
        identificatie: "/akn/nl/act/gm0873/2024/omgevingsplan",
        technischId: "_akn_nl_act_gm0873_2024_omgevingsplan",
        type: { code: "x", waarde: "Omgevingsplan" },
        opschrift: "Omgevingsplan gemeente Woensdrecht",
        geregistreerdMet: { versie: 7, tijdstipRegistratie: "2026-10-01T10:00:00Z" },
        _links: { self: { href: "..." } },
      },
    ],
  },
};

function setup(keys: { prod?: string } = { prod: KEY }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const app = createApp({
    allowedOrigins: ["https://pranavm5.github.io"],
    version: "test",
    log: () => {},
    dso: createDso({ keys, fetchFn }),
  });
  return { app, seen };
}

describe("DSO routes", () => {
  it("reports whether keys are configured, never the keys", async () => {
    const { app } = setup();
    const res = await app.request("/api/dso/status");
    const text = await res.text();
    const data = JSON.parse(text).data;
    expect(data.prod).toBe(true);
    expect(data.pre).toBe(false);
    expect(Array.isArray(data.variablesSeen)).toBe(true);
    expect(text).not.toContain(KEY);
  });

  it("asks the DSO for rule documents at a point, with the key only in the request header", async () => {
    const { app, seen } = setup();
    const res = await app.request(
      "/api/dso/regelingen?x=86549.8&y=376598.2041&geldigOp=2026-11-24",
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.data.regelingen.regelingen[0].opschrift).toBe("Omgevingsplan gemeente Woensdrecht");
    expect(body.data.regelingen.regelingen[0].geregistreerdMet.versie).toBe(7);

    const call = seen[0]!;
    expect(call.url).toContain("/presenteren/v8/regelingen/_zoek");
    expect(call.url).toContain("geldigOp=2026-11-24");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["content-crs"]).toContain("28992");
    // RD coordinates rounded to 3 decimals, as the DSO requires.
    expect(JSON.parse(String(call.init.body))).toEqual({
      geo: {
        geometrie: { type: "Point", coordinates: [86549.8, 376598.204] },
        spatialOperator: "intersects",
      },
    });
  });

  it("answers the same question from its cache instead of calling the DSO again", async () => {
    const { app, seen } = setup();
    await app.request("/api/dso/regelingen?x=86549.8&y=376598.2");
    const res = await app.request("/api/dso/regelingen?x=86549.8&y=376598.2");
    expect(seen).toHaveLength(1);
    expect((await res.json()).data.calls[0].cached).toBe(true);
  });

  it("refuses points outside the Netherlands and says clearly when no key is set", async () => {
    const { app } = setup();
    expect((await app.request("/api/dso/regelingen?x=1&y=1")).status).toBe(400);
    const none = setup({});
    const res = await none.app.request("/api/dso/regelingen?x=86549.8&y=376598.2");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("DSO_NOT_CONFIGURED");
  });
});
