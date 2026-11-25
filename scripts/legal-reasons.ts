/** Replays validation recordings and prints why the safety exclusion is not clear. */
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Tracer } from "@vergunbuy/engine";
import { buildPlotContext, findAddress, fixtureFetch } from "@vergunbuy/data";

const dirs = readdirSync("reports").filter((d) => d.startsWith("validation-"));
for (const d of dirs) {
  for (const f of readdirSync(`reports/${d}/recordings`)) {
    const raw = readFileSync(`reports/${d}/recordings/${f}`);
    const rec = JSON.parse(gunzipSync(raw).toString("utf8")) as Record<
      string,
      { links?: unknown[] }
    >;
    for (const body of Object.values(rec)) body.links = [];
    const docs = (rec.locatieserver as unknown as { response: { docs: Record<string, unknown>[] } })
      .response.docs;
    const slug = (x: Record<string, unknown>) =>
      String(x.weergavenaam)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const doc = docs.find((x) => `${slug(x)}.json.gz` === f) ?? docs[0]!;
    const addition = `${(doc.huisletter as string) ?? ""}${(doc.huisnummertoevoeging as string) ?? ""}`;
    const query = {
      postcode: String(doc.postcode),
      number: Number(doc.huisnummer),
      ...(addition ? { addition } : {}),
    };
    const fetchFn = fixtureFetch(rec as never);
    const t = new Tracer();
    try {
      const a = await t.step("a", "a", (c) => findAddress(query, c, fetchFn));
      const ctx = await buildPlotContext(a, t, fetchFn);
      const s = ctx.legal.exclusions.find((e) => e.ruleId === "ex-safety-2236")!;
      if (s.state !== "clear") console.log(`${a.label} | ${s.state} | ${s.reason.slice(0, 260)}`);
    } catch (e) {
      console.log(`${f}: ${(e as Error).message}`);
    }
  }
}
