import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const doc = {
  weergavenaam: "Teststraat 12, 4631AA Hoogerheide",
  straatnaam: "Teststraat",
  huisnummer: 12,
  postcode: "4631AA",
  woonplaatsnaam: "Hoogerheide",
  gemeentenaam: "Woensdrecht",
  centroide_rd: "POINT(84000.5 377000.25)",
  nummeraanduiding_id: "0873200000000001",
  adresseerbaarobject_id: "0873010000000001",
};

const fakeFetch =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

const make = (fetchFn: typeof fetch = fakeFetch({ response: { numFound: 1, docs: [doc] } })) =>
  createApp({
    fetchFn,
    allowedOrigins: ["https://vergunbuy.example"],
    version: "test",
    rateLimit: { limit: 3, windowMs: 60_000 },
    log: () => {},
  });

describe("API", () => {
  it("GET /api/health", async () => {
    const res = await make().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", version: "test" });
  });

  it("GET /api/search returns the address with a trace and request id", async () => {
    const res = await make().request("/api/search?postcode=4631aa&number=12");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { address: { town: string } };
      trace: { status: string }[];
      requestId: string;
    };
    expect(body.data.address.town).toBe("Hoogerheide");
    expect(body.trace[0]?.status).toBe("ok");
    expect(body.requestId).toBeTruthy();
  });

  it("rejects invalid input with 400 and still returns a trace", async () => {
    const res = await make().request("/api/search?postcode=hello&number=12");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; trace: { status: string }[] };
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.trace[0]?.status).toBe("skipped");
  });

  it("maps upstream failure to 502 with a safe message and a failed step", async () => {
    const res = await make(fakeFetch("internal details", 500)).request(
      "/api/search?postcode=4631AA&number=12",
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; message: string };
      trace: { status: string }[];
    };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).not.toContain("internal details");
    expect(body.trace[0]?.status).toBe("failed");
  });

  it("only allows CORS for configured origins", async () => {
    const app = make();
    const ok = await app.request("/api/health", {
      headers: { origin: "https://vergunbuy.example" },
    });
    const bad = await app.request("/api/health", { headers: { origin: "https://evil.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://vergunbuy.example");
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate-limits search per IP", async () => {
    const app = make();
    const hit = () =>
      app.request("/api/search?postcode=4631AA&number=12", {
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});
