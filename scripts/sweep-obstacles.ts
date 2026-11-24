/**
 * Obstacle sweep: re-runs the live pipeline (now with the laser height scan) for every home of
 * the earlier validation runs, and reports what each height threshold would mark as an obstacle.
 * Writes reports/obstacles-<date>/results.json and a recording per home (with height rasters).
 * Usage: tsx scripts/sweep-obstacles.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  AddressQuery,
  buildPlotContext,
  findAddress,
  recordingFetch,
  type RecordedResponses,
} from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Every home of the earlier runs, by the address recorded for it.
const homes = new Map<string, { postcode: string; number: string; addition?: string }>();
for (const dir of readdirSync("reports").filter((d) => d.startsWith("validation-"))) {
  const results = JSON.parse(readFileSync(`reports/${dir}/results.json`, "utf8")) as {
    rows: { address: string; error?: string }[];
  };
  for (const row of results.rows) {
    if (row.error || homes.has(row.address)) continue;
    let rec: { locatieserver?: { response?: { docs?: Record<string, string | number>[] } } };
    try {
      rec = JSON.parse(
        gunzipSync(
          readFileSync(`reports/${dir}/recordings/${slug(row.address)}.json.gz`),
        ).toString(),
      );
    } catch {
      continue;
    }
    const doc = rec.locatieserver?.response?.docs?.find(
      (d) => slug(String(d.weergavenaam)) === slug(row.address),
    );
    if (!doc) continue;
    const addition = `${doc.huisletter ?? ""}${doc.huisnummertoevoeging ?? ""}`;
    homes.set(row.address, {
      postcode: String(doc.postcode),
      number: String(doc.huisnummer),
      ...(addition ? { addition } : {}),
    });
  }
}

const out = `reports/obstacles-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(`${out}/recordings`, { recursive: true });
const rows: unknown[] = [];
for (const [label, q] of homes) {
  const recorded: RecordedResponses = {};
  const fetchFn = recordingFetch(recorded);
  const tracer = new Tracer();
  try {
    const address = await tracer.step("find-address", "Find address", (c) =>
      findAddress(AddressQuery.parse(q), c, fetchFn),
    );
    const ctx = await buildPlotContext(address, tracer, fetchFn);
    const o = ctx.obstacles;
    rows.push({
      address: ctx.address.label,
      access: ctx.access.level,
      quality: ctx.quality.obstacles.status,
      yardM2: o?.yardM2,
      areaAboveM2: o?.areaAboveM2,
      tallM2: o?.tallM2,
      mediumM2: o?.mediumM2,
      groundFilledShare: o?.groundFilledShare,
      structures: ctx.structures.map((s) => s.type),
      scanYear: ctx.house[0]?.heights?.scanYear,
      draw: {
        plot: ctx.plot.outline,
        house: ctx.house.map((b) => b.outline),
        outbuildings: ctx.outbuildings.map((b) => b.outline),
        structures: ctx.structures.map((s) => s.outline),
        res: o?.res ?? 0.5,
        cells: (o?.obstacles ?? []).flatMap((ob) =>
          ob.cells.map((p, i) => [
            Math.round(p[0] * 100) / 100,
            Math.round(p[1] * 100) / 100,
            ob.cellHeights[i],
          ]),
        ),
      },
    });
    writeFileSync(
      `${out}/recordings/${slug(ctx.address.label)}.json.gz`,
      gzipSync(JSON.stringify(recorded)),
    );
    console.log(
      `ok    ${label}: tall ${o?.tallM2} m², medium ${o?.mediumM2} m² (${ctx.quality.obstacles.status})`,
    );
  } catch (e) {
    rows.push({ address: label, error: (e as Error).message });
    console.log(`error ${label}: ${(e as Error).message}`);
  }
}
writeFileSync(`${out}/results.json`, JSON.stringify({ rows }));
console.log(`${rows.length} homes → ${out}`);
