import { readFileSync, readdirSync } from "node:fs";
import { Tracer } from "@vergunbuy/engine";
import { buildPlotContext, fixtureFetch } from "@vergunbuy/data";
for (const d of readdirSync("fixtures").filter((d) => /-\d/.test(d))) {
  let meta, res;
  try {
    meta = JSON.parse(readFileSync(`fixtures/${d}/meta.json`, "utf8"));
    res = JSON.parse(readFileSync(`fixtures/${d}/responses.json`, "utf8"));
  } catch {
    continue;
  }
  const fetchFn = fixtureFetch(res);
  const { findAddress } = await import("@vergunbuy/data");
  const t = new Tracer();
  const addr = await t.step("a", "a", (ctx) => findAddress(meta.query, ctx, fetchFn));
  const ctx = await buildPlotContext(addr, t, fetchFn);
  console.log(`\n${d}: zoning ${ctx.legal.zoning.status}, monuments ${ctx.legal.monuments.status}`);
  for (const e of ctx.legal.exclusions)
    console.log(`  ${e.ruleId.padEnd(26)} ${e.state.padEnd(22)} ${e.reason.slice(0, 160)}`);
}
