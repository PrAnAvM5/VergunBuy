/** Prints the permit history of every recorded fixture home (offline). */
import { readdirSync, readFileSync } from "node:fs";
import { Tracer } from "@vergunbuy/engine";
import { buildPlotContext, findAddress, fixtureFetch } from "@vergunbuy/data";

for (const d of readdirSync("fixtures").filter((x) => /-\d/.test(x))) {
  const meta = JSON.parse(readFileSync(`fixtures/${d}/meta.json`, "utf8")) as {
    query: { postcode: string; number: number; addition?: string };
  };
  const fetchFn = fixtureFetch(JSON.parse(readFileSync(`fixtures/${d}/responses.json`, "utf8")));
  const t = new Tracer();
  const a = await t.step("a", "a", (c) => findAddress(meta.query, c, fetchFn));
  const ctx = await buildPlotContext(a, t, fetchFn);
  console.log(`\n${a.label}: ${ctx.permits.status}, since ${ctx.permits.earliestOnStreet}`);
  for (const r of ctx.permits.records)
    console.log(
      `  ${r.date} ${r.stage.padEnd(8)} [${r.topics.join(",")}] ${r.summary.slice(0, 120)}`,
    );
}
