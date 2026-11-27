/** Probe: do the BGT street-object collections answer, and what types do they hold near a home? */
const base = "https://api.pdok.nl/kadaster/bgt/ogc/v1";
const crs = "http://www.opengis.net/def/crs/EPSG/0/28992";
const r = await fetch(`${base}/collections?f=json`);
const cols = ((await r.json()) as { collections: { id: string }[] }).collections.map((c) => c.id);
console.log("collections:", cols.join(" "));
// Moleneind 54 Ossendrecht, Waterdrieblad 6 Huijbergen (rough RD centres, ±40 m).
for (const [x, y] of [[80800, 377380], [84920, 383340]]) {
  for (const c of cols.filter((c) => /paal|kast|bord|meubilair|put|sensor/.test(c))) {
    const u = `${base}/collections/${c}/items?f=json&limit=200&bbox=${x - 40},${y - 40},${x + 40},${y + 40}&bbox-crs=${crs}&crs=${crs}`;
    const res = await fetch(u);
    const text = await res.text();
    let types = "";
    try {
      const j = JSON.parse(text) as { features: { properties: Record<string, unknown>; geometry: { type: string } }[] };
      const m: Record<string, number> = {};
      for (const f of j.features) {
        const k = `${String(f.properties.plus_type ?? f.properties.type)}/${f.geometry?.type}`;
        m[k] = (m[k] ?? 0) + 1;
      }
      types = JSON.stringify(m);
    } catch {
      types = text.slice(0, 200);
    }
    console.log(x, y, c, res.status, types);
  }
}
