/**
 * Replays a validation run offline from its recordings, so pipeline changes can be compared on the
 * same 20 homes without calling PDOK. Usage: tsx scripts/replay-validation.ts reports/validation-YYYY-MM-DD
 */
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildPlotContext, findAddress, fixtureFetch } from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: tsx scripts/replay-validation.ts <report dir>");
const before = JSON.parse(readFileSync(`${dir}/results.json`, "utf8")) as {
  rows: { address: string; access?: string; flags?: string[] }[];
};
for (const file of readdirSync(`${dir}/recordings`).sort()) {
  const rec = JSON.parse(
    gunzipSync(readFileSync(`${dir}/recordings/${file}`)).toString(),
  ) as Record<string, { links?: unknown[] }>;
  for (const body of Object.values(rec)) body.links = []; // pages were merged when recording
  // The recorded address is the one whose label the slug was made from.
  const docs = (rec.locatieserver as { response: { docs: Record<string, unknown>[] } }).response
    .docs;
  const slug = (d: Record<string, unknown>) =>
    String(d.weergavenaam)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const doc = docs.find((d) => `${slug(d)}.json.gz` === file) ?? docs[0]!;
  const addition = `${(doc.huisletter as string) ?? ""}${(doc.huisnummertoevoeging as string) ?? ""}`;
  const fetchFn = fixtureFetch(rec as never);
  const tracer = new Tracer();
  const address = await tracer.step("find-address", "Find address", (c) =>
    findAddress(
      {
        postcode: doc.postcode as string,
        number: doc.huisnummer as number,
        ...(addition ? { addition } : {}),
      },
      c,
      fetchFn,
    ),
  );
  const ctx = await buildPlotContext(address, tracer, fetchFn);
  const old = before.rows.find((r) => r.address === address.label);
  const across = ctx.pavementRuns.map((r) => `${r.lengthM}m@${r.acrossM}m via ${r.via.join("+")}`);
  console.log(
    [
      address.label.padEnd(44),
      `${old?.access ?? "?"} -> ${ctx.access.level}${ctx.access.route ? `/${ctx.access.route}` : ""}`.padEnd(
        40,
      ),
      `homes+${ctx.otherHomesOnPlot}`,
      ctx.flags.map((f) => f.code).join(","),
    ].join(" "),
  );
  if (across.length) console.log("   ", across.join(" | "));
}
