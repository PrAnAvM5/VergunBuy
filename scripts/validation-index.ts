/**
 * Copies every validation run (reports/validation-*) into the web app's public folder, so each home
 * can be opened on the site exactly as it was recorded, next to its aerial check image.
 * Writes apps/web/public/validation/index.json plus one recording and image per home.
 * Each home is replayed through the current pipeline, so the list shows what the site shows today;
 * the result at recording time is kept next to it, to see what changed.
 * Runs before every web build (see apps/web/package.json).
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildPlotContext, findAddress, fixtureFetch } from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const root = new URL("..", import.meta.url).pathname;
const reports = join(root, "reports");
const out = join(root, "apps/web/public/validation");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const imageSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

interface Home {
  label: string;
  village: string;
  access: string | null;
  route: string | null;
  flags: string[];
  houseType: string | null;
  error: string | null;
  recorded?: { access: string | null; route: string | null };
  postcode?: string;
  number?: string;
  addition?: string;
  rec?: string;
  image?: string;
}
interface Row {
  address: string;
  village: string;
  access?: string;
  route?: string;
  flags?: string[];
  houseType?: string;
  error?: string;
}
const runs: { id: string; date: string; seed: number; homes: Home[] }[] = [];
const dirs = existsSync(reports)
  ? readdirSync(reports)
      .filter((d) => d.startsWith("validation-"))
      .sort()
  : [];
for (const dir of dirs) {
  const results = JSON.parse(readFileSync(join(reports, dir, "results.json"), "utf8")) as {
    seed: number;
    rows: Row[];
  };
  const id = dir.replace("validation-", "");
  mkdirSync(join(out, id), { recursive: true });
  const recDir = join(reports, dir, "recordings");
  const recordings = existsSync(recDir) ? readdirSync(recDir) : [];
  const homes: Home[] = [];
  for (const row of results.rows) {
    const home: Home = {
      label: row.address,
      village: row.village,
      access: row.access ?? null,
      route: row.route ?? null,
      flags: row.flags ?? [],
      houseType: row.houseType ?? null,
      error: row.error ?? null,
    };
    const file = `${slug(row.address)}.json.gz`;
    // A newer recording of the same home (e.g. from the obstacle sweep, with the height scan)
    // replaces the original one.
    const newer = newestRecording(file);
    if (!row.error && (newer || recordings.includes(file))) {
      type Rec = Record<
        string,
        { links?: unknown[]; response?: { docs?: Record<string, string | number>[] } }
      >;
      const read = (p: string) => JSON.parse(gunzipSync(readFileSync(p)).toString()) as Rec;
      // Merge: the run's own recording plus anything only the later sweep recorded (the height
      // scan), and the other way round (zoning, monuments, permits were added after the sweep).
      const own = recordings.includes(file) ? read(join(recDir, file)) : {};
      const rec: Rec = { ...own, ...(newer ? read(newer) : {}) };
      for (const [k, v] of Object.entries(own))
        if (!(k in rec) || k.startsWith("vergunbuy/") || k.startsWith("rce/")) rec[k] = v;
      const doc = rec.locatieserver?.response?.docs?.find(
        (d) => slug(String(d.weergavenaam)) === slug(row.address),
      );
      if (doc) {
        home.postcode = String(doc.postcode);
        home.number = String(doc.huisnummer);
        const addition = `${doc.huisletter ?? ""}${doc.huisnummertoevoeging ?? ""}`;
        if (addition) home.addition = addition;
        home.rec = `${id}/${slug(row.address)}`;
        await replay(home, rec);
        writeFileSync(
          join(out, id, `${slug(row.address)}.json.gz.bin`),
          gzipSync(JSON.stringify(rec)),
        );
      }
    }
    const img = `${imageSlug(row.address)}.jpg`;
    if (existsSync(join(reports, dir, img))) {
      copyFileSync(join(reports, dir, img), join(out, id, img));
      home.image = `${id}/${img}`;
    }
    homes.push(home);
  }
  runs.push({
    id,
    date: id.slice(0, 10),
    seed: results.seed,
    homes,
  });
}
// Newest batch first.
runs.reverse();
writeFileSync(join(out, "index.json"), JSON.stringify({ runs }));
console.log(
  `validation index: ${runs.length} runs, ${runs.reduce((n, r) => n + r.homes.length, 0)} homes`,
);

/** The most recent recording of this home from a later run (obstacle sweeps), if any. */
function newestRecording(file: string): string | undefined {
  const later = readdirSync(reports)
    .filter((d) => d.startsWith("obstacles-"))
    .sort()
    .reverse();
  for (const d of later) {
    const p = join(reports, d, "recordings", file);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Re-runs one recorded home through today's pipeline and updates the row in place. */
async function replay(home: Home, rec: Record<string, { links?: unknown[] }>): Promise<void> {
  for (const body of Object.values(rec)) if (body && typeof body === "object") body.links = [];
  const fetchFn = fixtureFetch(rec as never);
  const tracer = new Tracer();
  home.recorded = { access: home.access, route: home.route };
  try {
    const address = await tracer.step("find-address", "Find address", (c) =>
      findAddress(
        {
          postcode: home.postcode!,
          number: Number(home.number),
          ...(home.addition ? { addition: home.addition } : {}),
        },
        c,
        fetchFn,
      ),
    );
    const ctx = await buildPlotContext(address, tracer, fetchFn);
    home.access = ctx.access.level;
    home.route = ctx.access.route ?? null;
    home.flags = ctx.flags.map((f) => f.code);
    home.houseType = ctx.houseType;
  } catch (e) {
    home.error = (e as Error).message;
  }
}
