/**
 * Foundation guarantees on real recorded data: truncation, overlap classification,
 * vegetation types, car access, and that missing data never yields a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, Tracer, type Domain } from "@vergunbuy/engine";
import { describe, expect, it } from "vitest";
import {
  AddressQuery,
  buildPlotContext,
  findAddress,
  fixtureFetch,
  type RecordedResponses,
} from "../src/index.ts";

const load = (dir: string): RecordedResponses =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../../fixtures/${dir}/responses.json`), "utf8"),
  );
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function run(responses: RecordedResponses, postcode: string, number: string) {
  const tracer = new Tracer();
  const fetchFn = fixtureFetch(responses);
  const address = await findAddress(
    AddressQuery.parse({ postcode, number }),
    { summarize() {}, degrade() {}, recordCall() {} },
    fetchFn,
  );
  return { context: await buildPlotContext(address, tracer, fetchFn), tracer };
}

const aalbers = () => load("hoogerheide-aalbersestraat-1");
const huijbergen = () => load("huijbergen-buurtweg-1");
type FC = {
  features: { id?: string; geometry: unknown; properties: Record<string, unknown> }[];
  links: { rel: string; href: string }[];
};

describe("pagination is never silently truncated", () => {
  it("marks buildings partial, flags DATA_TRUNCATED and degrades the step when a next page remains", async () => {
    const rec = clone(aalbers());
    // Every response keeps pointing to a next page: the reader must stop and say so.
    (rec["bag/pand"] as FC).links = [
      {
        rel: "next",
        href: "https://api.pdok.nl/kadaster/bag/ogc/v2/collections/pand/items?cursor=x",
      },
    ];
    const { context, tracer } = await run(rec, "4631CC", "1");
    expect(context.quality.buildings.status).toBe("partial");
    expect(context.flags.map((f) => f.code)).toContain("DATA_TRUNCATED");
    expect(tracer.steps.find((s) => s.id === "bag-buildings")?.status).toBe("degraded");
    expect(context.sources.find((s) => s.name === "BAG")?.complete).toBe(false);
  });
});

describe("buildings are classified by overlap area, not a centre point", () => {
  it("flags a building that crosses the plot boundary", async () => {
    const rec = clone(aalbers());
    const { context: base } = await run(rec, "4631CC", "1");
    // Add a shed straddling the plot's first boundary edge: half in, half out.
    const [a, b] = [base.plot.outline[0]!, base.plot.outline[1]!];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const shed = [
      [mx - 1, my - 1],
      [mx + 1, my - 1],
      [mx + 1, my + 1],
      [mx - 1, my + 1],
      [mx - 1, my - 1],
    ];
    (rec["bag/pand"] as FC).features.push({
      id: "test-shed",
      geometry: { type: "Polygon", coordinates: [shed] },
      properties: { identificatie: "TEST", status: "Pand in gebruik", aantal_verblijfsobjecten: 0 },
    });
    const { context } = await run(rec, "4631CC", "1");
    expect(context.flags.map((f) => f.code)).toContain("BUILDING_ON_BOUNDARY");
    expect(context.quality.buildings.status).toBe("partial");
    const shedB = [...context.outbuildings, ...context.neighbours].find((x) => x.id === "TEST");
    expect(shedB?.onPlotShare).toBeGreaterThan(0.05);
    expect(shedB?.onPlotShare).toBeLessThan(0.95);
  });
});

describe("vegetation is classified by BGT type", () => {
  it("keeps hedges and trees separate from other vegetation", async () => {
    const rec = clone(aalbers());
    const areas = rec["bgt/vegetatieobject_vlak"] as FC;
    const points = rec["bgt/vegetatieobject_punt"] as FC;
    const hedge = areas.features.find(
      (f) => f.properties.plus_type === "haag" && f.properties.eind_registratie == null,
    )!;
    areas.features.push({
      ...clone(hedge),
      properties: { ...hedge.properties, plus_type: "struikgewas", lokaal_id: "BUSH" },
    });
    const tree = points.features.find(
      (f) => f.properties.plus_type === "boom" && f.properties.eind_registratie == null,
    )!;
    points.features.push({
      ...clone(tree),
      properties: { ...tree.properties, plus_type: "paal", lokaal_id: "POLE" },
    });
    const { context } = await run(rec, "4631CC", "1");
    expect(context.hedges.some((h) => h.id === "BUSH")).toBe(false);
    expect(context.otherVegetation.map((v) => v.kind)).toEqual(
      expect.arrayContaining(["struikgewas", "paal"]),
    );
    expect(context.trees?.some((t) => t.id === "POLE")).toBe(false);
  });
});

describe("car access evidence", () => {
  it("passes only with a registered crossing (Huijbergen)", async () => {
    const { context } = await run(huijbergen(), "4635RN", "1");
    expect(context.access).toMatchObject({ level: "registered", outcome: "pass" });
  });
  it("is 'possible' and unknown when a road runs along the plot without a crossing (Aalbersestraat)", async () => {
    const { context } = await run(aalbers(), "4631CC", "1");
    expect(context.access).toMatchObject({ level: "possible", outcome: "unknown" });
    expect(context.carReachableEdges.length).toBeGreaterThan(0);
  });
});

describe("zero false greens, end to end", () => {
  const ALL: Domain[] = [
    "plot",
    "buildings",
    "heights",
    "publicArea",
    "vegetation",
    "access",
    "front",
  ];
  for (const key of [
    "bgt/wegdeel",
    "bag/pand",
    "3dbag/pand",
    "bgt/vegetatieobject_punt",
    "bgt/openbareruimtelabel",
  ]) {
    it(`a pass on every domain becomes unknown when ${key} is missing`, async () => {
      const rec = clone(huijbergen());
      delete rec[key];
      const { context } = await run(rec, "4635RN", "1");
      const affected = ALL.filter((d) => context.quality[d].status !== "complete");
      expect(affected.length).toBeGreaterThan(0);
      expect(gate("pass", ALL, context.quality).outcome).toBe("unknown");
    });
  }
  it("access without street data is unknown, never pass", async () => {
    const rec = clone(huijbergen());
    delete rec["bgt/wegdeel"];
    const { context } = await run(rec, "4635RN", "1");
    expect(context.access.outcome).toBe("unknown");
    expect(context.quality.publicArea.status).toBe("missing");
  });
});

describe("invalid geometry is never measured silently", () => {
  it("flags a self-intersecting building outline and lowers building quality", async () => {
    const rec = clone(aalbers());
    const { context: base } = await run(rec, "4631CC", "1");
    const [x, y] = base.plot.outline[0]!;
    const bowtie = [
      [x + 50, y + 50],
      [x + 54, y + 54],
      [x + 54, y + 50],
      [x + 50, y + 54],
      [x + 50, y + 50],
    ];
    (rec["bag/pand"] as FC).features.push({
      id: "bowtie",
      geometry: { type: "Polygon", coordinates: [bowtie] },
      properties: { identificatie: "BOWTIE", status: "Pand in gebruik" },
    });
    const { context } = await run(rec, "4631CC", "1");
    expect(context.flags.map((f) => f.code)).toContain("INVALID_GEOMETRY");
    expect(context.quality.buildings.status).toBe("partial");
  });
});

describe("surroundings per side (real data)", () => {
  it("Aalbersestraat 1: front on the Aalbersestraat pavement, the road itself along the left side", async () => {
    const { context } = await run(aalbers(), "4631CC", "1");
    const by = Object.fromEntries(context.sides.map((s) => [s.side, s]));
    expect(by.front?.parts[0]?.label).toContain("Aalbersestraat");
    expect(by.left?.parts.some((p) => p.label === "road (Aalbersestraat)" && p.lengthM > 15)).toBe(
      true,
    );
    expect(by.right?.parts.some((p) => p.kind === "shared-wall")).toBe(true);
  });
});

describe("validation run findings (2026-11-24)", () => {
  it("repeated points in register shapes are cleaned, not reported as invalid geometry", async () => {
    const { context } = await run(load("huijbergen-siardus-bogaertslaan-7"), "4635CL", "7");
    expect(context.flags.map((f) => f.code)).not.toContain("INVALID_GEOMETRY");
  });

  it("Siardus Bogaertslaan 7: pavement then road in front is 'possible across pavement', never pass", async () => {
    const { context } = await run(load("huijbergen-siardus-bogaertslaan-7"), "4635CL", "7");
    expect(context.access.level).toBe("possible");
    expect(context.access.route).toBe("across-pavement");
    expect(context.access.outcome).toBe("unknown");
    expect(context.flags.map((f) => f.code)).toContain("PAVEMENT_CROSSING");
    expect(context.sides.find((s) => s.side === "front")?.roadBeyond).toBeDefined();
  });

  it("Zonnedauw 13: a verge on the road's own parcel is crossed; the front is found through it", async () => {
    const { context } = await run(load("huijbergen-zonnedauw-13"), "4635BL", "13");
    expect(context.access.route).toBe("across-pavement");
    expect(context.pavementRuns.some((r) => r.via.includes("verge on the road's parcel"))).toBe(
      true,
    );
    expect(context.frame.method).not.toBe("none");
  });

  it("Geyssendorfferlaan 23: other homes on the same parcel are neighbours, not outbuildings", async () => {
    const { context } = await run(load("hoogerheide-geyssendorfferlaan-23"), "4631HW", "23");
    expect(context.otherHomesOnPlot).toBeGreaterThan(5);
    expect(context.flags.map((f) => f.code)).toContain("SHARED_PLOT");
    expect(context.quality.plot.status).toBe("partial");
    expect(context.outbuildings.every((b) => !b.addresses)).toBe(true);
  });

  it("a narrow path is flagged as a possible rear path only when it borders the plot", async () => {
    const { context } = await run(load("huijbergen-siardus-bogaertslaan-7"), "4635CL", "7");
    expect(context.flags.map((f) => f.code)).not.toContain("POSSIBLE_ACHTERPAD");
  });

  it("Handekenskruid 44: a registered crossing straight across the pavement is this plot's exit", async () => {
    const { context } = await run(load("huijbergen-handekenskruid-44"), "4635BJ", "44");
    expect(context.access.level).toBe("registered");
    expect(context.exits[0]?.acrossM).toBeLessThanOrEqual(3);
    expect(context.exits[0]?.alongPlotM).toBeGreaterThanOrEqual(2.5);
  });
});
