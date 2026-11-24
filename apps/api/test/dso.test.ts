import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createDso, fingerprint, toDocument } from "../src/dso.ts";

const KEY = "test-key-1234567890";
const answer = {
  _embedded: {
    regelingen: [
      {
        identificatie: "/akn/nl/act/gm0873/2024/omgevingsplan",
        technischId: "_akn_nl_act_gm0873_2024_omgevingsplan",
        type: { code: "x", waarde: "Omgevingsplan" },
        opschrift: "Omgevingsplan gemeente Woensdrecht",
        expressionId: "/akn/nl/act/gm0873/2024/omgevingsplan/nld@2026-06-01;7",
        aangeleverdDoorEen: { code: "gm0873", naam: "Woensdrecht", bestuurslaag: "gemeente" },
        geregistreerdMet: {
          versie: 7,
          beginInwerking: "2026-06-15",
          tijdstipRegistratie: "2026-10-01T10:00:00Z",
        },
        _links: { self: { href: "..." } },
      },
    ],
  },
  page: { size: 200, totalElements: 1, totalPages: 1, number: 1 },
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
    const doc = body.data.regelingen.documents[0];
    expect(doc.title).toBe("Omgevingsplan gemeente Woensdrecht");
    expect(doc.version).toBe(7);
    expect(doc.expressionId).toContain("nld@2026-06-01;7");
    expect(doc.authority.code).toBe("gm0873");
    expect(doc.inForceSince).toBe("2026-06-15");
    expect(body.data.complete).toBe(true);

    const call = seen[0]!;
    expect(call.url).toContain("/presenteren/v8/regelingen/_zoek");
    expect(call.url).toContain("geldigOp=2026-11-24");
    expect(call.url).toContain("size=200");
    expect(call.url).toContain("beschikbaarOp=");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["content-crs"]).toContain("28992");
    // RD coordinates rounded to 3 decimals, as the DSO requires.
    expect(JSON.parse(String(call.init.body))).toEqual({
      geometrie: { type: "Point", coordinates: [86549.8, 376598.204] },
    });
    expect(seen.some((s) => s.url.includes("/ontwerpregelingen/_zoek"))).toBe(true);
  });

  it("answers the same question from its cache instead of calling the DSO again", async () => {
    const { app, seen } = setup();
    await app.request("/api/dso/regelingen?x=86549.8&y=376598.2");
    const res = await app.request("/api/dso/regelingen?x=86549.8&y=376598.2");
    expect(seen).toHaveLength(2); // rules and drafts, each asked once
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

  it("fetches every page, pinned to one moment, and checks the count against the DSO's total", async () => {
    const seen: string[] = [];
    const docs = Array.from({ length: 450 }, (_, i) => ({
      identificatie: `/akn/nl/act/x/2024/doc${i}`,
      expressionId: `/akn/nl/act/x/2024/doc${i}/nld@2024-01-01;1`,
    }));
    const fetchFn: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("size"));
      const slice = url.pathname.includes("ontwerp")
        ? []
        : docs.slice((page - 1) * size, page * size);
      const total = url.pathname.includes("ontwerp") ? 0 : docs.length;
      return new Response(
        JSON.stringify({
          _embedded: { regelingen: slice },
          page: {
            size,
            number: page,
            totalElements: total,
            totalPages: Math.max(1, Math.ceil(total / size)),
          },
        }),
      );
    };
    const dso = createDso({ keys: { prod: KEY }, fetchFn });
    const r = await dso.regelingenAt({ x: 86549.8, y: 376598.2, env: "prod" });
    expect(r.regelingen.documents).toHaveLength(450);
    expect(r.regelingen.pages).toBe(3);
    expect(r.complete).toBe(true);
    const moments = new Set(
      seen
        .filter((u) => !u.includes("ontwerp"))
        .map((u) => new URL(u).searchParams.get("beschikbaarOp")),
    );
    expect(moments.size).toBe(1);
  });

  it("marks the answer incomplete when a page fails or the count does not match", async () => {
    let n = 0;
    const fetchFn: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      if (String(input).includes("ontwerp"))
        return new Response(
          JSON.stringify({ _embedded: {}, page: { totalElements: 0, totalPages: 1 } }),
        );
      n++;
      if (page === 2) return new Response("{}", { status: 503 });
      return new Response(
        JSON.stringify({
          _embedded: { regelingen: [{ identificatie: "a" }] },
          page: { totalElements: 300, totalPages: 2 },
        }),
      );
    };
    const dso = createDso({ keys: { prod: KEY }, fetchFn });
    const r = await dso.regelingenAt({ x: 86549.8, y: 376598.2, env: "prod" });
    expect(n).toBe(2);
    expect(r.complete).toBe(false);
    expect(r.regelingen.error).toBeDefined();
    // An incomplete answer is not cached: the next request asks again.
    await dso.regelingenAt({ x: 86549.8, y: 376598.2, env: "prod" });
    expect(n).toBe(4);
  });

  it("gives the same fingerprint for the same versions in any order, a new one after a change", () => {
    const a = toDocument({ identificatie: "a", expressionId: "a;1" });
    const b = toDocument({ identificatie: "b", expressionId: "b;1" });
    const b2 = toDocument({ identificatie: "b", expressionId: "b;2" });
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    expect(fingerprint([a, b2])).not.toBe(fingerprint([a, b]));
  });
});
