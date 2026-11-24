/**
 * Records every public-data response the pipeline makes for one address, so the address can be
 * replayed offline (tests, demo mode, Review lab).
 * Usage: tsx scripts/record.ts 4631CC:1 4641HR:10:a ...
 * Paged responses are merged into one body per collection; height rasters are stored as base64.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AddressQuery,
  buildPlotContext,
  findAddress,
  fixtureKey,
  recordingFetch,
  type RecordedResponses,
} from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

// One or more addresses: "4631CC:1 4641RN:1 4641HR:10:a" (or the old form: <postcode> <number> [addition]).
const args = process.argv.slice(2);
const targets = args.some((a) => a.includes(":"))
  ? args
      .flatMap((a) => a.split(/\s+/))
      .filter(Boolean)
      .map((a) => a.split(":"))
  : [args];
if (!targets.length || !targets[0]?.[0] || !targets[0]?.[1]) {
  console.error("Usage: tsx scripts/record.ts <postcode>:<number>[:addition] ...");
  process.exit(2);
}

/** 3D BAG pages each have their own vertex transform; hand the pipeline absolute vertices. */
const normalisingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (fixtureKey(url) !== "3dbag/pand" || !res.ok) return res;
  const body = (await res.json()) as never;
  normalise3dbag(body);
  return new Response(JSON.stringify(body), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
};

/** 3D BAG scales vertices per response; make them absolute so pages can be merged. */
function normalise3dbag(page: {
  features?: { vertices?: number[][] }[];
  metadata?: { transform?: { scale: number[]; translate: number[] } };
}) {
  const t = page.metadata?.transform;
  if (!t) return;
  for (const f of page.features ?? [])
    f.vertices = (f.vertices ?? []).map((v) =>
      v.map((n, i) => n * (t.scale[i] ?? 1) + (t.translate[i] ?? 0)),
    );
  page.metadata = { ...page.metadata, transform: { scale: [1, 1, 1], translate: [0, 0, 0] } };
}

for (const [postcode, number, addition] of targets) {
  const recorded: RecordedResponses = {};
  const fetchFn = recordingFetch(recorded, normalisingFetch);
  const tracer = new Tracer();
  const query = AddressQuery.parse({ postcode, number, ...(addition ? { addition } : {}) });
  const address = await tracer.step("find-address", "Find address", (ctx) =>
    findAddress(query, ctx, fetchFn),
  );
  const context = await buildPlotContext(address, tracer, fetchFn);

  const slug = `${address.town}-${address.street}-${address.number}${address.addition ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-");
  const dir = `fixtures/${slug}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/responses.json`, JSON.stringify(recorded));
  writeFileSync(
    `${dir}/meta.json`,
    JSON.stringify(
      {
        address: address.label,
        query,
        recordedAt: new Date().toISOString().slice(0, 10),
        steps: tracer.steps.map((s) => `${s.status} ${s.id}: ${s.summary}`),
        flags: context.flags.map((f) => f.code),
      },
      null,
      2,
    ) + "\n",
  );
  for (const s of tracer.steps) console.log(s.status.padEnd(8), s.id, s.summary);
  console.log(`Recorded ${Object.keys(recorded).length} responses to ${dir}`);
}
