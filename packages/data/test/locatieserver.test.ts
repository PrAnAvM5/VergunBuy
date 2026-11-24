import { Tracer } from "@vergunbuy/engine";
import { describe, expect, it } from "vitest";
import { AddressQuery, findAddress, getJson } from "../src/index.ts";
import { z } from "zod";

// Synthetic response in the Locatieserver shape. Real recorded fixtures for the
// hand-checked test plots go in /fixtures once they are chosen.
const doc = (over: Record<string, unknown> = {}) => ({
  weergavenaam: "Teststraat 12, 4631AA Hoogerheide",
  straatnaam: "Teststraat",
  huisnummer: 12,
  postcode: "4631AA",
  woonplaatsnaam: "Hoogerheide",
  gemeentenaam: "Woensdrecht",
  centroide_rd: "POINT(84000.5 377000.25)",
  nummeraanduiding_id: "0873200000000001",
  adresseerbaarobject_id: "0873010000000001",
  ...over,
});

const respond =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const solr = (docs: unknown[]) => ({ response: { numFound: docs.length, docs } });

async function run(
  fetchFn: typeof fetch,
  query: Record<string, string> = { postcode: "4631 aa", number: "12" },
) {
  const tracer = new Tracer();
  const result = tracer.step("find-address", "Find address", (ctx) =>
    findAddress(AddressQuery.parse(query), ctx, fetchFn),
  );
  return { tracer, result };
}

describe("AddressQuery", () => {
  it("normalises postcodes", () => {
    expect(AddressQuery.parse({ postcode: " 4631 aa ", number: "12" }).postcode).toBe("4631AA");
  });
  it("rejects nonsense", () => {
    expect(AddressQuery.safeParse({ postcode: "ABCD12", number: "12" }).success).toBe(false);
    expect(AddressQuery.safeParse({ postcode: "4631AA", number: "-1" }).success).toBe(false);
  });
});

describe("findAddress", () => {
  it("returns a Woensdrecht address with RD coordinates and records the call", async () => {
    const { tracer, result } = await run(respond(solr([doc()])));
    const address = await result;
    expect(address.pointRd).toEqual([84000.5, 377000.25]);
    expect(address.bagVerblijfsobjectId).toBe("0873010000000001");
    const step = tracer.steps[0];
    expect(step?.status).toBe("ok");
    expect(step?.calls[0]).toMatchObject({ host: "api.pdok.nl", httpStatus: 200 });
  });

  it("accepts registered addresses without a postcode (real Woensdrecht case)", async () => {
    const noPostcode: Record<string, unknown> = doc();
    delete noPostcode.postcode;
    const { result } = await run(respond(solr([noPostcode])));
    expect((await result).postcode).toBe("4631AA");
  });

  it("refuses addresses outside the pilot municipality", async () => {
    const { result, tracer } = await run(respond(solr([doc({ gemeentenaam: "Bergen op Zoom" })])));
    await expect(result).rejects.toMatchObject({ code: "OUTSIDE_PILOT" });
    expect(tracer.steps[0]?.status).toBe("failed");
  });

  it("reports not found", async () => {
    const { result } = await run(respond(solr([])));
    await expect(result).rejects.toMatchObject({ code: "ADDRESS_NOT_FOUND" });
  });

  it("asks for the addition when a number has several addresses", async () => {
    const { result } = await run(respond(solr([doc(), doc({ huisletter: "A" })])));
    await expect(result).rejects.toMatchObject({ code: "ADDRESS_AMBIGUOUS" });
  });

  it("picks the right addition when given", async () => {
    const { result } = await run(
      respond(solr([doc(), doc({ huisletter: "A", adresseerbaarobject_id: "x" })])),
      {
        postcode: "4631AA",
        number: "12",
        addition: "a",
      },
    );
    expect((await result).bagVerblijfsobjectId).toBe("x");
  });

  it("turns malformed upstream data into UPSTREAM_INVALID", async () => {
    const { result } = await run(respond({ unexpected: true }));
    await expect(result).rejects.toMatchObject({ code: "UPSTREAM_INVALID" });
  });

  it("turns upstream errors into a safe message", async () => {
    const { result, tracer } = await run(respond("boom: stack trace", 500));
    await expect(result).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(tracer.steps[0]?.error).not.toContain("stack trace");
  });
});

describe("getJson", () => {
  it("never calls hosts outside the allowlist", async () => {
    const tracer = new Tracer();
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return new Response("{}");
    };
    await expect(
      tracer.step("x", "x", (ctx) =>
        getJson({
          url: new URL("https://evil.example/"),
          schema: z.unknown(),
          ctx,
          fetchFn: spy,
          serviceName: "x",
        }),
      ),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    expect(called).toBe(false);
  });
});
