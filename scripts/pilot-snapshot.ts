/**
 * Pilot snapshot: runs the whole check on the 60 recorded example homes and writes one compact
 * metrics file per home set, for the Pilot dashboard (apps/web/src/views/pilot.ts).
 *
 *   pnpm tsx scripts/pilot-snapshot.ts [label]
 *
 * Writes apps/web/public/pilot/<id>.json and updates apps/web/public/pilot/index.json. Same
 * recordings in, same numbers out: compare two snapshots to see what a change did.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  CARPORT_PRESETS,
  options,
  prepare,
  regionArea,
  RuleSet,
  Tracer,
  type CarportOption,
} from "@vergunbuy/engine";
import { buildPlotContext, carportSite, findAddress, fixtureFetch } from "@vergunbuy/data";

const label = process.argv.slice(2).join(" ").trim();
const rules = RuleSet.parse(
  JSON.parse(readFileSync("rulesets/woensdrecht/carport/2026-11-24.json", "utf8")),
);
const snap = JSON.parse(readFileSync("apps/web/public/rules/dso-snapshot.json", "utf8")) as {
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
  checkedAt: "2026-01-01T00:00:00Z",
  source: "snapshot" as const,
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const sh = (cmd: string) => {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

type Json = Record<string, unknown>;

function optionSummary(list: CarportOption[]): Json {
  const o = list[0];
  const tally: Record<string, number> = {};
  for (const x of list) tally[x.verdict.colour] = (tally[x.verdict.colour] ?? 0) + 1;
  if (!o) return { n: 0, colours: tally };
  const v = o.verdict;
  const route = v.access.bays.find((b) => b.route)?.route;
  return {
    n: list.length,
    colours: tally,
    best: list.some((x) => x.verdict.colour === "green")
      ? "green"
      : list.some((x) => x.verdict.colour === "amber")
        ? "amber"
        : "red",
    first: {
      colour: v.colour,
      via: v.access.via,
      zone: o.zone,
      rotation: o.placement.rotation,
      checks: Object.fromEntries(v.checks.map((c) => [c.id, c.outcome])),
      routeM: route ? r1(route.lengthM) : null,
      shunts: route?.shunts ?? null,
      backingIn: !!route?.rev,
      sweptShrubM2: v.access.sweptShrubM2,
      sweptSolidM2: v.access.sweptSolidM2,
      sweptPublicM2: v.access.sweptPublicM2,
    },
  };
}

const slug = (d: Json) =>
  String(d.weergavenaam)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function home(rec: Json, file: string): Promise<Json> {
  for (const b of Object.values(rec)) if (b && typeof b === "object") (b as Json).links = [];
  const docs = (rec.locatieserver as { response: { docs: Json[] } }).response.docs;
  // A shared house number: the recording holds every address; pick this file's one.
  const doc = docs.find((x) => slug(x) === file) ?? docs[0]!;
  const addition = `${String(doc.huisletter ?? "")}${String(doc.huisnummertoevoeging ?? "")}`;
  const fetchFn = fixtureFetch(rec as never);
  const t = new Tracer();
  const t0 = performance.now();
  const address = await t.step("address", "Address", (c) =>
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
  const ctx = await buildPlotContext(address, t, fetchFn);
  const ctxMs = performance.now() - t0;

  const lenBy = <T>(items: T[], key: (x: T) => string, len: (x: T) => number) => {
    const out: Record<string, number> = {};
    for (const x of items) out[key(x)] = r1((out[key(x)] ?? 0) + len(x));
    return out;
  };
  const dist = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
  const pieces = ctx.boundary?.pieces ?? [];
  const street = pieces.filter((p) => p.side === "street");
  const obstacles = ctx.obstacles?.obstacles ?? [];
  const cells = obstacles.reduce((n, o) => n + (o.cells?.length ?? 0), 0);
  const unclearCells = obstacles.reduce(
    (n, o) => n + (o.cellMaterials?.filter((m) => m === "unknown").length ?? 0),
    0,
  );

  const out: Json = {
    postcode: String(doc.postcode),
    number: String(doc.huisnummer),
    ...(addition ? { addition } : {}),
    address: `${address.street} ${address.number}${address.addition ?? ""}`,
    place: address.town,
    plotM2: r1(ctx.plot.areaM2 ?? 0),
    front: {
      method: ctx.frame.method,
      edge: ctx.frame.frontEdge ?? null,
      rotation: Math.round((ctx.frame.rotation * 180) / Math.PI),
      street: ctx.frame.streetName ?? null,
    },
    edges: lenBy(
      ctx.edges,
      (e) => e.kind,
      (e) => e.lengthM,
    ),
    streetSide: lenBy(
      street,
      (p) => p.state,
      (p) => dist(p.a, p.b),
    ),
    exits: {
      registered: ctx.exits.length,
      onLineM: r1(street.filter((p) => p.state === "exit").reduce((m, p) => m + dist(p.a, p.b), 0)),
      access: ctx.access?.level ?? null,
    },
    laser: {
      echoes: ctx.boundary?.echo ? ctx.boundary.echo.points : null,
      infrared: !!ctx.boundary?.ndviLayer,
      objects: obstacles.length,
      byKind: lenBy(
        obstacles,
        (o) => o.kind,
        () => 1,
      ),
      byMaterial: lenBy(
        obstacles,
        (o) => `${o.kind === "medium" ? "low" : "tall"}-${o.material ?? "unknown"}`,
        () => 1,
      ),
      unclearShare: cells ? r1((unclearCells / cells) * 100) : null,
      outsideCells: ctx.boundary?.outside?.length ?? 0,
      streetObjects: ctx.streetObjects?.length ?? null,
    },
    quality: Object.fromEntries(Object.entries(ctx.quality).map(([k, q]) => [k, q.status])),
    steps: Object.fromEntries(t.steps.map((s) => [s.id, s.status])),
    ms: { context: Math.round(ctxMs) },
  };

  const { site } = carportSite(ctx, rules, freshness);
  if (!site) {
    out.carport = null;
    return out;
  }
  const t1 = performance.now();
  const prep = prepare(site);
  const backM2 = regionArea(prep.yard.region);
  out.yard = {
    backM2: r1(backM2),
    frontKnown: ctx.frame.method !== "longest-public" && ctx.frame.method !== "none",
    method: prep.yard.method,
  };
  const single = options(prep, CARPORT_PRESETS.single);
  const t2 = performance.now();
  const double = options(prep, CARPORT_PRESETS.double);
  const t3 = performance.now();
  out.carport = { single: optionSummary(single), double: optionSummary(double) };
  (out.ms as Json).single = Math.round(t2 - t1);
  (out.ms as Json).double = Math.round(t3 - t2);
  return out;
}

const dir = process.env.PILOT_RECORDINGS ?? "apps/web/public/validation";
const homes: Record<string, Json> = {};
for (const run of readdirSync(dir)
  .filter((d) => !d.endsWith(".json"))
  .sort())
  for (const f of readdirSync(`${dir}/${run}`)
    .filter((x) => x.endsWith(".json.gz.bin"))
    .sort()) {
    const id = f.replace(/\.json\.gz\.bin$/, "");
    const rec = JSON.parse(gunzipSync(readFileSync(`${dir}/${run}/${f}`)).toString()) as Json;
    try {
      homes[id] = { run, ...(await home(rec, id)) };
    } catch (e) {
      homes[id] = { run, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
    }
    process.stdout.write(".");
  }

const sha = sh("git rev-parse --short HEAD") || "unknown";
const subject = sh("git log -1 --format=%s");
// Order of the code version (a snapshot of older code can be taken later).
const commitAt = sh("git log -1 --format=%cI") || new Date().toISOString();
const dirty = sh("git status --porcelain -- packages apps/web/src rulesets").length > 0;
const at = new Date().toISOString();
const id = `${at.slice(0, 16).replace(/[-:T]/g, "")}-${sha}`;
const outDir = process.env.PILOT_OUT ?? "apps/web/public/pilot";
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  `${outDir}/${id}.json`,
  JSON.stringify({ id, at, commitAt, sha, subject, dirty, label, homes }) + "\n",
);
const indexPath = `${outDir}/index.json`;
const index = existsSync(indexPath)
  ? (JSON.parse(readFileSync(indexPath, "utf8")) as { snapshots: Json[] })
  : { snapshots: [] };
index.snapshots = index.snapshots.filter((s) => s.id !== id);
index.snapshots.push({
  id,
  at,
  commitAt,
  sha,
  subject,
  dirty,
  label,
  homes: Object.keys(homes).length,
});
writeFileSync(indexPath, JSON.stringify(index, null, 1) + "\n");
console.log(`\npilot snapshot ${id}: ${Object.keys(homes).length} homes`);
