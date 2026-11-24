/**
 * Daily DSO snapshot (run by .github/workflows/dso-daily.yml).
 *
 * Asks which rule documents and drafts apply at each reference point, all pages, and writes
 * apps/web/public/rules/dso-snapshot.json. Compares with the previous snapshot and writes the
 * differences to $CHANGES_OUT (markdown) when there are any.
 *
 * Source: the DSO directly when DSO_API_KEY is set (GitHub secret), otherwise our own server
 * ($SERVER), so the monitor keeps running even if one of the two is unavailable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDso, fingerprint, type DsoDocument } from "../apps/api/src/dso.ts";
import {
  changesReport,
  diffSnapshots,
  type DsoSnapshot,
  type SnapshotPoint,
} from "../apps/api/src/dsoSnapshot.ts";

const OUT = "apps/web/public/rules/dso-snapshot.json";
const SERVER = process.env.SERVER ?? "https://vergunbuy-inky.vercel.app";

/** Reference points in Woensdrecht (RD New), at least one per village with test homes. */
const POINTS = [
  { name: "Putte, Verdelingsweg 514", x: 86549.8, y: 376598.204 },
  { name: "Putte, Berkenlaan 1", x: 85402, y: 374971 },
  { name: "Huijbergen, Zonnedauw 13", x: 84909, y: 383328 },
  { name: "Hoogerheide, Aalbersestraat 1", x: 81029.282, y: 381929.681 },
  { name: "Ossendrecht, Markt 10a", x: 81201.381, y: 379008.519 },
  { name: "Ossendrecht, Bremweg 1", x: 81374, y: 380528 },
];

interface Answer {
  complete: boolean;
  documents: DsoDocument[];
  drafts: DsoDocument[];
  note?: string;
}

async function ask(x: number, y: number): Promise<Answer> {
  const key = process.env.DSO_API_KEY;
  if (key) {
    const dso = createDso({ keys: { prod: key }, cacheMs: 0 });
    const r = await dso.regelingenAt({ x, y, env: "prod" });
    return { complete: r.complete, documents: r.regelingen.documents, drafts: r.drafts.documents };
  }
  const res = await fetch(`${SERVER}/api/dso/regelingen?x=${x}&y=${y}`, {
    signal: AbortSignal.timeout(60_000),
  }).catch(() => null);
  if (!res?.ok)
    return { complete: false, documents: [], drafts: [], note: `server ${res?.status}` };
  const { data } = (await res.json()) as {
    data: {
      complete: boolean;
      regelingen: { documents: DsoDocument[] };
      drafts: { documents: DsoDocument[] };
    };
  };
  return {
    complete: data.complete,
    documents: data.regelingen.documents,
    drafts: data.drafts.documents,
  };
}

const prev: DsoSnapshot | null = existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, "utf8")) as DsoSnapshot)
  : null;
const takenAt = new Date().toISOString();
const points: SnapshotPoint[] = [];
let failures = 0;
for (const p of POINTS) {
  const a = await ask(p.x, p.y);
  const old = prev?.points.find((q) => q.name === p.name);
  if (a.complete) {
    points.push({
      ...p,
      checkedAt: takenAt,
      latestAttemptComplete: true,
      fingerprint: fingerprint(a.documents),
      documents: a.documents,
      drafts: a.drafts,
    });
    console.log(`${p.name}: ${a.documents.length} documents, ${a.drafts.length} drafts`);
  } else {
    failures++;
    console.log(`${p.name}: INCOMPLETE ${a.note ?? ""} — keeping the previous answer`);
    if (old) points.push({ ...old, latestAttemptComplete: false });
  }
}

const next: DsoSnapshot = { schema: 1, takenAt, points };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(next, null, 1) + "\n");

const changes = diffSnapshots(prev, next);
console.log(`${changes.length} change(s) since the previous snapshot`);
if (changes.length && process.env.CHANGES_OUT)
  writeFileSync(process.env.CHANGES_OUT, changesReport(changes, next));
if (failures === POINTS.length) {
  console.error("No reference point could be answered: the DSO or the server is down.");
  process.exit(1);
}
