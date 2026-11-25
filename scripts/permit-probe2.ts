/** Probe 2: which SRU query finds Woensdrecht permit publications for an address. */
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("fixtures/permit-probe", { recursive: true });
const queries = [
  'c.product-area==officielepublicaties AND dt.creator=="Woensdrecht"',
  'c.product-area==officielepublicaties AND dt.creator="Woensdrecht" AND cql.textAndIndexes="Aalbersestraat"',
  'c.product-area==officielepublicaties AND cql.textAndIndexes="Aalbersestraat" AND cql.textAndIndexes="Hoogerheide"',
  'c.product-area==officielepublicaties AND dt.creator="Woensdrecht" AND cql.textAndIndexes="Zonnedauw"',
  'c.product-area==officielepublicaties AND dt.creator="Woensdrecht" AND cql.textAndIndexes="omgevingsvergunning" AND cql.textAndIndexes="Markt"',
];
let i = 0;
for (const q of queries) {
  const url = `https://repository.overheid.nl/sru?query=${encodeURIComponent(q)}&maximumRecords=20`;
  const text = await (await fetch(url)).text();
  const n = /<sru:numberOfRecords>(\d+)/.exec(text)?.[1];
  console.log(`\n### ${q}\n  records: ${n}`);
  for (const m of text.matchAll(
    /<dcterms:title>([^<]*)<\/dcterms:title>[\s\S]*?<dcterms:available>([^<]*)/g,
  ))
    console.log(`  ${m[2]}  ${m[1].slice(0, 160)}`);
  writeFileSync(`fixtures/permit-probe/sru2-${i++}.xml`, text);
}
