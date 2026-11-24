/**
 * Live contract check: calls the real public APIs and verifies they still return
 * data in the shape our adapters expect. Runs weekly in CI and on demand
 * (`pnpm contract-check`), never on every push, so upstream hiccups don't block work.
 */
import { getJson, LocatieserverResponse } from "@vergunbuy/data";
import { Tracer } from "@vergunbuy/engine";

const tracer = new Tracer();
let failed = false;

async function check(id: string, label: string, run: Parameters<Tracer["step"]>[2]) {
  try {
    await tracer.step(id, label, run);
  } catch {
    failed = true;
  }
}

await check("locatieserver", "PDOK Locatieserver: address search", async (ctx) => {
  const url = new URL("https://api.pdok.nl/bzk/locatieserver/search/v3_1/free");
  url.searchParams.set("q", "Hoogerheide");
  url.searchParams.set("fq", "type:adres");
  url.searchParams.set("rows", "3");
  const data = await getJson({
    url,
    schema: LocatieserverResponse,
    ctx,
    serviceName: "PDOK Locatieserver",
  });
  const doc = data.response.docs[0];
  if (doc?.gemeentenaam !== "Woensdrecht") throw new Error("Expected a Woensdrecht address");
  ctx.summarize(`ok: ${doc.weergavenaam}`);
});

for (const s of tracer.steps) {
  console.log(`${s.status.padEnd(8)} ${s.label} (${s.ms} ms) ${s.error ?? s.summary}`);
}
process.exit(failed ? 1 : 0);
