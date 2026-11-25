/**
 * Re-records the example homes (reports/validation-*) through the live pipeline, keeping exactly
 * the same homes: for every row of each run's results.json, the address is taken from its own
 * recording and every answer (JSON and binary: height scan, infrared photo) is stored again.
 * The run's results.json and README stay as they were; the site replays the new recordings.
 *
 * Usage: tsx scripts/rerecord.ts [run-dir-filter]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildPlotContext,
  findAddress,
  recordingFetch,
  type RecordedResponses,
} from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const root = new URL("..", import.meta.url).pathname;
const reports = join(root, "reports");
const filter = process.argv[2] ?? "";
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

let ok = 0;
let failed = 0;
for (const dir of readdirSync(reports).filter(
  (d) => d.startsWith("validation-") && d.includes(filter),
)) {
  const resultsPath = join(reports, dir, "results.json");
  if (!existsSync(resultsPath)) continue;
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as {
    rows: { address: string; error?: string }[];
  };
  for (const row of results.rows) {
    if (row.error) continue;
    const file = join(reports, dir, "recordings", `${slug(row.address)}.json.gz`);
    if (!existsSync(file)) continue;
    const old = JSON.parse(gunzipSync(readFileSync(file)).toString()) as {
      locatieserver?: { response?: { docs?: Record<string, string | number>[] } };
    };
    const doc = old.locatieserver?.response?.docs?.find(
      (d) => slug(String(d.weergavenaam)) === slug(row.address),
    );
    if (!doc) {
      console.log(`skip  ${row.address} (no address in recording)`);
      continue;
    }
    const addition = `${doc.huisletter ?? ""}${doc.huisnummertoevoeging ?? ""}`;
    const store: RecordedResponses = {};
    const fetchFn = recordingFetch(store);
    const tracer = new Tracer();
    const t0 = performance.now();
    try {
      const address = await tracer.step("find-address", "Find address", (c) =>
        findAddress(
          {
            postcode: String(doc.postcode),
            number: Number(doc.huisnummer),
            ...(addition ? { addition } : {}),
          },
          c,
          fetchFn,
        ),
      );
      const ctx = await buildPlotContext(address, tracer, fetchFn);
      writeFileSync(file, gzipSync(JSON.stringify(store)));
      const street = (ctx.boundary?.pieces ?? []).filter((p) => p.side === "street");
      const m = (s: string) => street.filter((p) => p.state === s).length * 0.5;
      console.log(
        `ok    ${row.address} (${Math.round(performance.now() - t0)} ms): echoes ${ctx.boundary?.echo?.points ?? "–"}, photo ${ctx.boundary?.ndviLayer ? "yes" : "no"}; street ${m("exit")} exit / ${m("open")} open / ${m("hedge")} hedge / ${m("barrier")} fence-wall / ${m("unknown")} unknown`,
      );
      ok++;
    } catch (e) {
      console.log(`error ${row.address}: ${(e as Error).message}`);
      failed++;
    }
  }
}
console.log(`${ok} re-recorded, ${failed} failed`);
