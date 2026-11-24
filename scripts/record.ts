/**
 * Records every public-data response the pipeline makes for one address, so the address can be
 * replayed offline (tests, demo mode, Review lab). Usage: tsx scripts/record.ts 4631CC 1 [addition]
 * Paged responses are merged into one body per collection.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AddressQuery, buildPlotContext, findAddress, fixtureKey } from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const [postcode, number, addition] = process.argv.slice(2);
if (!postcode || !number) {
  console.error("Usage: tsx scripts/record.ts <postcode> <number> [addition]");
  process.exit(2);
}

const recorded: Record<string, { features?: unknown[]; [k: string]: unknown }> = {};
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
    else recorded[key] = { ...body, links: [] };
  }
  return res;
};

const tracer = new Tracer();
const query = AddressQuery.parse({ postcode, number, ...(addition ? { addition } : {}) });
const address = await tracer.step("find-address", "Find address", (ctx) =>
  findAddress(query, ctx, recordingFetch),
);
const context = await buildPlotContext(address, tracer, recordingFetch);

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
console.log(`Recorded ${Object.keys(recorded).length} collections to ${dir}`);
