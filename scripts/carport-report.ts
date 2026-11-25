/**
 * Runs the carport engine on every recorded example home (offline): the numbered options for a
 * single and a double carport (with the car's routes), what keeps #1 from green, and the time.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { prepare, RuleSet, options, CARPORT_PRESETS, Tracer } from "@vergunbuy/engine";
import { buildPlotContext, carportSite, findAddress, fixtureFetch } from "@vergunbuy/data";

const rules = RuleSet.parse(
  JSON.parse(readFileSync("rulesets/woensdrecht/carport/2026-11-24.json", "utf8")),
);
const snap = JSON.parse(readFileSync("apps/web/public/rules/dso-snapshot.json", "utf8")) as {
  takenAt: string;
  points: {
    documents: { workId: string; expressionId: string }[];
    drafts: { workId: string; expressionId: string }[];
  }[];
};
const freshness = {
  current: {
    inForce: snap.points.flatMap((p) => p.documents),
    drafts: snap.points.flatMap((p) => p.drafts),
  },
  checkedAt: new Date().toISOString(),
  source: "snapshot" as const,
};

const dir = "apps/web/public/validation";
const rows: string[] = [];
const tally: Record<string, number> = {};
const blockers: Record<string, number> = {};
for (const run of readdirSync(dir).filter((d) => !d.endsWith(".json"))) {
  for (const f of readdirSync(`${dir}/${run}`).filter((x) => x.endsWith(".json.gz.bin"))) {
    const rec = JSON.parse(gunzipSync(readFileSync(`${dir}/${run}/${f}`)).toString()) as Record<
      string,
      { links?: unknown[] }
    >;
    for (const b of Object.values(rec)) if (b && typeof b === "object") b.links = [];
    const docs = (rec.locatieserver as unknown as { response: { docs: Record<string, unknown>[] } })
      .response.docs;
    const slug = (x: Record<string, unknown>) =>
      String(x.weergavenaam)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const doc = docs.find((x) => `${slug(x)}.json.gz.bin` === f) ?? docs[0]!;
    const addition = `${(doc.huisletter as string) ?? ""}${(doc.huisnummertoevoeging as string) ?? ""}`;
    const fetchFn = fixtureFetch(rec as never);
    const t = new Tracer();
    try {
      const a = await t.step("a", "a", (c) =>
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
      const ctx = await buildPlotContext(a, t, fetchFn);
      const { site, gate } = carportSite(ctx, rules, freshness);
      if (!site) {
        tally.gated = (tally.gated ?? 0) + 1;
        rows.push(`| ${a.label} | gated | | ${gate} |`);
        continue;
      }
      const t0 = performance.now();
      const prep = prepare(site);
      const tPrep = Math.round(performance.now() - t0);
      const one = options(prep, CARPORT_PRESETS.single);
      const two = options(prep, CARPORT_PRESETS.double);
      const ms = Math.round(performance.now() - t0);
      const v = one[0]?.verdict;
      const list = (o: typeof one) =>
        o
          .map(
            (x) =>
              `${x.verdict.colour[0]}${x.zone[0]}${x.verdict.access.via === "new-exit" ? "*" : ""}`,
          )
          .join(" ") || "–";
      const colour = v?.colour ?? "none";
      tally[colour] = (tally[colour] ?? 0) + 1;
      const notPass = v
        ? v.checks.filter((c) => c.outcome !== "pass").map((c) => `${c.id}:${c.outcome}`)
        : ["no spot"];
      for (const n of notPass) blockers[n] = (blockers[n] ?? 0) + 1;
      rows.push(
        `| ${a.label} | ${list(one)} | ${list(two)} | ${tPrep} / ${ms} ms | ${notPass.join(", ")} |`,
      );
    } catch (e) {
      rows.push(`| ${f} | error | | ${(e as Error).message} |`);
    }
  }
}
const out = [
  `# Carport engine on the recorded example homes`,
  "",
  `Option #1 (single carport) per home: ${Object.entries(tally)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
  "",
  "What keeps option #1 from green (count of homes):",
  "",
  ...Object.entries(blockers)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- ${k}: ${v}`),
  "",
  "Options: colour (g/a) + zone (b back, s side, f front); * = via a new exit.",
  "",
  "| Home | Single options | Double options | Prepare / total | Not passing (#1 single) |",
  "|---|---|---|---|---|",
  ...rows,
].join("\n");
writeFileSync("/tmp/carport-report.md", out);
console.log(out.split("\n").slice(0, 30).join("\n"));
