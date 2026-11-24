/**
 * Validation run: picks random homes across the five Woensdrecht villages, runs the real pipeline on
 * each, and writes a report (JSON + Markdown) plus the data needed to draw an aerial check image.
 * Usage: tsx scripts/validate.ts [perVillage=4] [seed=20261124]
 * Random but reproducible: the seed fixes which addresses are drawn.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  buildPlotContext,
  findAddress,
  fixtureKey,
  LOCATIESERVER_FIELDS,
  type PlotContext,
} from "@vergunbuy/data";
import { distanceBetween, Tracer } from "@vergunbuy/engine";

const VILLAGES = ["Hoogerheide", "Huijbergen", "Ossendrecht", "Putte", "Woensdrecht"];
const perVillage = Number(process.argv[2] ?? 4);
const seed = Number(process.argv[3] ?? 20261124);
const MAX_TRIES = perVillage * 6;
const LS = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

/** Small seeded generator (mulberry32) so the sample can be reproduced. */
function rng(s: number) {
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(seed);

async function lsQuery(village: string, start: number, rows: number) {
  const url = new URL(LS);
  url.searchParams.set("q", "*:*");
  url.searchParams.append("fq", "type:adres");
  url.searchParams.append("fq", "gemeentenaam:Woensdrecht");
  url.searchParams.append("fq", `woonplaatsnaam:"${village}"`);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("start", String(start));
  url.searchParams.set("sort", "id asc");
  url.searchParams.set("fl", LOCATIESERVER_FIELDS);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Locatieserver ${res.status}`);
  return (await res.json()) as {
    response: {
      numFound: number;
      docs: {
        postcode?: string;
        huisnummer: number;
        huisletter?: string;
        huisnummertoevoeging?: string;
      }[];
    };
  };
}

interface Row {
  village: string;
  address: string;
  ms: number;
  error?: string;
  skipped?: string;
  use?: string | undefined;
  houseType?: string;
  plotAreaM2?: number;
  frontMethod?: string;
  frontStreet?: string | undefined;
  access?: string;
  route?: string;
  accessReason?: string;
  pavementRuns?: { lengthM: number; acrossM: number; via: string[] }[];
  otherHomesOnPlot?: number;
  exits?: { alongPlotM: number }[];
  carReachableM?: number;
  carReachableSides?: string[];
  nearestInritM?: number | null;
  inritWithin10m?: number;
  quality?: Record<string, string>;
  flags?: string[];
  sides?: string;
  outbuildings?: number;
  steps?: string[];
  draw?: unknown;
}

const outDir = `reports/validation-${new Date().toISOString().slice(0, 10)}-s${seed}`;
mkdirSync(`${outDir}/recordings`, { recursive: true });

function slugOf(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function summarise(village: string, ctx: PlotContext, ms: number, tracer: Tracer): Row {
  const inrits = (ctx.publicAreas ?? []).filter((a) => a.label === "inrit");
  const dists = inrits.map((a) => distanceBetween(a.outline, ctx.plot.outline));
  return {
    village,
    address: ctx.address.label,
    ms,
    use: ctx.house[0]?.use,
    houseType: ctx.houseType,
    plotAreaM2: Math.round(ctx.plot.areaM2),
    frontMethod: ctx.frame.method,
    frontStreet: ctx.frame.streetName,
    access: ctx.access.level,
    ...(ctx.access.route ? { route: ctx.access.route } : {}),
    accessReason: ctx.access.reason,
    pavementRuns: ctx.pavementRuns.map((r) => ({
      lengthM: r.lengthM,
      acrossM: r.acrossM,
      via: r.via,
    })),
    otherHomesOnPlot: ctx.otherHomesOnPlot,
    exits: ctx.exits.map((e) => ({ alongPlotM: e.alongPlotM })),
    carReachableM: Math.round(ctx.carReachableEdges.reduce((s, e) => s + e.lengthM, 0) * 10) / 10,
    carReachableSides: ctx.sides
      .filter((s) => s.parts.some((p) => /road|parking|yard|driveway|street/i.test(p.label)))
      .map((s) => s.side),
    nearestInritM: dists.length ? Math.round(Math.min(...dists) * 10) / 10 : null,
    inritWithin10m: dists.filter((d) => d <= 10).length,
    quality: Object.fromEntries(Object.entries(ctx.quality).map(([k, v]) => [k, v.status])),
    flags: ctx.flags.map((f) => f.code),
    sides: ctx.sides
      .map((s) => `${s.side}: ${s.parts.map((p) => `${p.label} ${p.lengthM} m`).join(", ")}`)
      .join(" | "),
    outbuildings: ctx.outbuildings.length,
    steps: tracer.steps.map((s) => `${s.status} ${s.id} (${s.ms} ms): ${s.summary}`),
    draw: {
      plot: ctx.plot.outline,
      house: ctx.house.map((b) => b.outline),
      outbuildings: ctx.outbuildings.map((b) => b.outline),
      exits: ctx.exits.map((e) => e.outline),
      inritsNear: inrits.filter((_, i) => (dists[i] ?? 99) <= 15).map((a) => a.outline),
      carEdges: [...ctx.carReachableEdges, ...ctx.pavementRuns].map((e) => {
        const p = ctx.plot.outline;
        const a = p[e.edge]!;
        const b = p[(e.edge + 1) % p.length]!;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const at = (t: number) => [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L];
        return [at(e.from), at(e.to)];
      }),
    },
  };
}

const rows: Row[] = [];
for (const village of VILLAGES) {
  const total = (await lsQuery(village, 0, 0)).response.numFound;
  let done = 0;
  const seen = new Set<number>();
  for (let tries = 0; done < perVillage && tries < MAX_TRIES; tries++) {
    const start = Math.floor(rand() * total);
    if (seen.has(start)) continue;
    seen.add(start);
    const doc = (await lsQuery(village, start, 1)).response.docs[0];
    if (!doc?.postcode) continue;
    const addition = `${doc.huisletter ?? ""}${doc.huisnummertoevoeging ?? ""}`;
    const label = `${doc.postcode} ${doc.huisnummer}${addition}`;
    const recorded: Record<string, { features?: unknown[] }> = {};
    const recordingFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      const key = fixtureKey(url);
      const body = (await res
        .clone()
        .json()
        .catch(() => undefined)) as { features?: unknown[] } | undefined;
      if (key && body && res.ok) {
        const prev = recorded[key];
        if (prev?.features && body.features) prev.features.push(...body.features);
        else recorded[key] = { ...body };
      }
      return res;
    };
    const tracer = new Tracer();
    const t0 = performance.now();
    try {
      const address = await tracer.step("find-address", "Find address", (c) =>
        findAddress(
          { postcode: doc.postcode!, number: doc.huisnummer, ...(addition ? { addition } : {}) },
          c,
          recordingFetch,
        ),
      );
      const ctx = await buildPlotContext(address, tracer, recordingFetch);
      const ms = Math.round(performance.now() - t0);
      const use = ctx.house[0]?.use ?? "";
      if (!/woonfunctie/.test(use)) {
        console.log(`skip  ${label} (${use || "no use"})`);
        continue;
      }
      const row = summarise(village, ctx, ms, tracer);
      rows.push(row);
      writeFileSync(
        `${outDir}/recordings/${slugOf(address.label)}.json.gz`,
        gzipSync(JSON.stringify(recorded)),
      );
      done++;
      console.log(`ok    ${address.label}: ${row.access}, exits ${row.exits?.length}, ${ms} ms`);
    } catch (e) {
      // "12" next to "12A": the site asks the user which one; the sampler just draws again.
      if ((e as { code?: string }).code === "ADDRESS_AMBIGUOUS") {
        console.log(`skip  ${label} (needs a letter or addition)`);
        continue;
      }
      const ms = Math.round(performance.now() - t0);
      rows.push({ village, address: label, ms, error: String((e as Error).message ?? e) });
      done++;
      console.log(`error ${label}: ${(e as Error).message}`);
    }
  }
}

writeFileSync(`${outDir}/results.json`, JSON.stringify({ seed, perVillage, rows }, null, 2));

// Markdown summary.
const ok = rows.filter((r) => !r.error);
const pct = (n: number) => `${n} (${Math.round((100 * n) / Math.max(ok.length, 1))}%)`;
const count = (f: (r: Row) => boolean) => ok.filter(f).length;
const lines = [
  `# Validation run ${outDir.replace("reports/validation-", "")}`,
  "",
  `Seed ${seed}, ${perVillage} homes per village, ${rows.length} addresses, ${rows.length - ok.length} errors.`,
  "",
  "## Totals",
  "",
  `- Access registered (driveway crossing in BGT): ${pct(count((r) => r.access === "registered"))}`,
  `- Access possible, plot touches road/parking: ${pct(count((r) => r.access === "possible" && r.route === "direct"))}`,
  `- Access possible, road just beyond pavement/verge: ${pct(count((r) => r.access === "possible" && r.route === "across-pavement"))}`,
  `- Parcel shared with other homes: ${pct(count((r) => (r.otherHomesOnPlot ?? 0) > 0))}`,
  `- No access found: ${pct(count((r) => r.access === "none-found"))}`,
  `- Access unknown (data missing): ${pct(count((r) => r.access === "unknown"))}`,
  `- A driveway crossing within 10 m but not touching the plot: ${pct(count((r) => r.access !== "registered" && (r.inritWithin10m ?? 0) > 0))}`,
  `- Front found by street name: ${pct(count((r) => r.frontMethod === "street-label"))}`,
  `- Any data cut off: ${pct(count((r) => r.flags?.includes("DATA_TRUNCATED") ?? false))}`,
  `- Building on the plot boundary: ${pct(count((r) => r.flags?.includes("BUILDING_ON_BOUNDARY") ?? false))}`,
  `- Invalid geometry: ${pct(count((r) => r.flags?.includes("INVALID_GEOMETRY") ?? false))}`,
  `- Median time: ${ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? "-"} ms`,
  "",
  "## Per address",
  "",
  "| Village | Address | Type | Access | Exits | Road contact | Nearest crossing | Front | Flags |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) =>
    r.error
      ? `| ${r.village} | ${r.address} | error | ${r.error} | | | | | |`
      : `| ${r.village} | ${r.address} | ${r.houseType} | ${r.access}${r.route ? ` (${r.route})` : ""} | ${r.exits?.length} | ${r.carReachableM} m | ${r.nearestInritM ?? "none"} m | ${r.frontMethod} | ${r.flags?.join(", ")} |`,
  ),
  "",
];
writeFileSync(`${outDir}/README.md`, lines.join("\n"));
console.log(lines.join("\n"));
