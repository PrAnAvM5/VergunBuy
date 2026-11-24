import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Tracer } from "@vergunbuy/engine";
import { describe, expect, it } from "vitest";
import {
  AddressQuery,
  buildPlotContext,
  findAddress,
  fixtureFetch,
  type RecordedResponses,
} from "../src/index.ts";

// Real responses recorded from PDOK on 24-11-2026 for Aalbersestraat 1, Hoogerheide.
const recorded: RecordedResponses = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../fixtures/hoogerheide-aalbersestraat-1/responses.json"),
    "utf8",
  ),
);

async function run(responses: RecordedResponses = recorded) {
  const tracer = new Tracer();
  const fetchFn = fixtureFetch(responses);
  const address = await tracer.step("find-address", "Find address", (ctx) =>
    findAddress(AddressQuery.parse({ postcode: "4631CC", number: "1" }), ctx, fetchFn),
  );
  const context = await buildPlotContext(address, tracer, fetchFn);
  return { context, tracer };
}

describe("buildPlotContext on real recorded data", () => {
  it("finds the plot, the house and classified edges", async () => {
    const { context, tracer } = await run();
    expect(context.plot.areaM2).toBeGreaterThan(50);
    expect(context.house.length).toBeGreaterThan(0);
    expect(context.edges.length).toBeGreaterThan(0);
    expect(context.edges.some((e) => e.kind === "public")).toBe(true);
    expect(tracer.steps.every((s) => s.status !== "failed")).toBe(true);
  });

  it("finds the front from the street-name label and measures the plot in its own frame", async () => {
    const { context } = await run();
    expect(context.frame.method).toBe("street-label");
    expect(context.frame.streetName).toBe("Aalbersestraat");
    expect(context.layout.plotWidthM).toBeCloseTo(5.3, 0);
    expect(context.layout.plotDepthM).toBeCloseTo(21, 0);
    expect(context.house[0]?.heights?.mesh?.lod).toBe("2.2");
  });

  it("ignores demolished buildings and historical BGT records", async () => {
    const { context } = await run();
    const all = [...context.house, ...context.outbuildings, ...context.neighbours];
    expect(
      all.every((b) => b.status !== "Pand gesloopt" && b.status !== "Pand ten onrechte opgevoerd"),
    ).toBe(true);
    // A BGT object keeps its lokaal_id across versions, so count versions, not ids.
    const roads = (
      recorded["bgt/wegdeel"] as { features: { properties: Record<string, unknown> }[] }
    ).features;
    const current = roads.filter((f) => f.properties.eind_registratie == null).length;
    expect(roads.length).toBeGreaterThan(current); // the recording does contain history
    const roadAreas =
      context.publicAreas?.filter((a) => ["road", "footpath", "rear-path"].includes(a.kind)) ?? [];
    expect(roadAreas.length).toBe(current);
  });

  it("degrades without BGT: edges become unknown, never neighbour, and the run completes", async () => {
    const { "bgt/wegdeel": _w, ...withoutRoads } = recorded;
    void _w;
    const { context, tracer } = await run(withoutRoads);
    expect(context.publicAreas).toBeNull();
    expect(context.flags.map((f) => f.code)).toContain("PUBLIC_AREA_UNKNOWN");
    expect(context.edges.some((e) => e.kind === "public")).toBe(false);
    expect(context.edges.some((e) => e.kind === "unknown")).toBe(true);
    expect(tracer.steps.find((s) => s.id === "bgt-public")?.status).toBe("failed");
  });

  it("degrades without BAG buildings and still completes", async () => {
    const { "bag/pand": _p, ...withoutBuildings } = recorded;
    void _p;
    const { context } = await run(withoutBuildings);
    expect(context.flags.map((f) => f.code)).toContain("NEIGHBOURS_UNKNOWN");
    expect(context.edges.length).toBeGreaterThan(0);
  });

  it("stops with a clear error when the plot cannot be found (critical path)", async () => {
    const { "brk/perceel": _b, ...withoutPlot } = recorded;
    void _b;
    await expect(run(withoutPlot)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});
