/**
 * Permit history of a home from the official publications (Gemeenteblad) of its municipality,
 * through the public SRU search of repository.overheid.nl. No key is needed; the server does it
 * so the browser gets one compact, cached answer.
 *
 * Municipalities must publish every permit application and decision. Each publication carries a
 * location point (RD New) and an address label, so a publication is matched to a plot by its point
 * lying on the plot, or by its exact address. Coverage starts when the municipality began
 * publishing digitally (Woensdrecht: 2014); anything older is not in this source.
 */
import { z } from "zod";

const SRU = "https://repository.overheid.nl/sru";

export const PermitQuery = z.object({
  municipality: z.string().min(2).max(60),
  street: z.string().min(2).max(80),
  number: z.number().int().positive(),
  letter: z.string().max(6).optional(),
  ring: z
    .array(z.tuple([z.number().min(-7000).max(300000), z.number().min(289000).max(629000)]))
    .min(3)
    .max(500),
});

export interface Publication {
  id: string;
  title: string;
  date: string | null;
  activities: string[];
  /** e.g. "Aalbersestraat 7 te Hoogerheide". */
  label: string | null;
  point: [number, number] | null;
  url: string | null;
  xmlUrl: string | null;
  /** Why it was matched to this plot. */
  match: "point-on-plot" | "address" | null;
  /** The decision text (application, granted, refused, ...), plain, cut to a readable length. */
  text?: string;
}

const tag = (rec: string, name: string) =>
  [...rec.matchAll(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "g"))].map((m) => decode(m[1]!));

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function parseRecords(xml: string): { total: number | null; records: Publication[] } {
  const total = Number(/<sru:numberOfRecords>(\d+)/.exec(xml)?.[1] ?? NaN);
  const records = xml
    .split("<sru:record>")
    .slice(1)
    .map((rec) => {
      const geom = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(rec);
      return {
        id: tag(rec, "dcterms:identifier")[0] ?? "",
        title: tag(rec, "dcterms:title")[0] ?? "",
        date: tag(rec, "dcterms:available")[0] ?? tag(rec, "dcterms:modified")[0] ?? null,
        activities: tag(rec, "overheidwetgeving:activiteit"),
        label: tag(rec, "overheidwetgeving:geometrielabel")[0] ?? null,
        point: geom ? ([Number(geom[1]), Number(geom[2])] as [number, number]) : null,
        url: tag(rec, "gzd:preferredUrl")[0] ?? null,
        xmlUrl: tag(rec, "gzd:url")[0] ?? null,
        match: null,
      } satisfies Publication;
    });
  return { total: Number.isFinite(total) ? total : null, records };
}

function inside(ring: [number, number][], p: [number, number]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** "Aalbersestraat 7 te Hoogerheide" or "Hoogerheide - Aalbersestraat 7" contains this house. */
export function addressMatches(text: string, street: string, number: number, letter = ""): boolean {
  const esc = street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(^|[^\\p{L}])${esc}\\s+${number}\\s*${letter ? letter : "(?![0-9a-z])"}`,
    "iu",
  );
  return re.test(text);
}

export function createPermits(cfg: { fetchFn?: typeof fetch; cacheMs?: number } = {}) {
  const fetchFn = cfg.fetchFn ?? fetch;
  const cache = new Map<string, { at: number; value: unknown }>();
  const cacheMs = cfg.cacheMs ?? 24 * 3600_000;

  return {
    async historyFor(q: z.infer<typeof PermitQuery>) {
      const key = JSON.stringify(q);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < cacheMs) return hit.value;

      const query = `c.product-area==officielepublicaties AND dt.creator="${q.municipality}" AND cql.textAndIndexes="${q.street}"`;
      const all: Publication[] = [];
      let total: number | null = null;
      let complete = true;
      for (let start = 1; start <= 2000; start += 100) {
        const url = `${SRU}?query=${encodeURIComponent(query)}&maximumRecords=100&startRecord=${start}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
        if (!res?.ok) {
          complete = false;
          break;
        }
        const page = parseRecords(await res.text());
        total = page.total;
        all.push(...page.records);
        if (!page.records.length || (total !== null && all.length >= total)) break;
      }
      if (total !== null && all.length < total) complete = false;

      const ring = q.ring;
      const matched = all
        .map((p) => ({
          ...p,
          match:
            p.point && inside(ring, p.point)
              ? ("point-on-plot" as const)
              : addressMatches(`${p.label ?? ""} | ${p.title}`, q.street, q.number, q.letter)
                ? ("address" as const)
                : null,
        }))
        .filter((p) => p.match !== null);

      // The decision text says what was asked or allowed ("het plaatsen van een carport").
      for (const p of matched.slice(0, 30)) {
        if (!p.xmlUrl) continue;
        const res = await fetchFn(p.xmlUrl, { signal: AbortSignal.timeout(15000) }).catch(
          () => null,
        );
        if (!res?.ok) continue;
        const text = decode((await res.text()).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
        p.text = text.slice(0, 1200);
      }
      matched.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const value = {
        complete,
        searched: all.length,
        totalForStreet: total,
        earliestOnStreet: all.reduce<string | null>(
          (min, p) => (p.date && (!min || p.date < min) ? p.date : min),
          null,
        ),
        publications: matched,
      };
      if (complete) cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}
