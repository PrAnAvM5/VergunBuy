/**
 * Laser-scan echoes around a plot, from the AHN point cloud (COPC files on the official AHN
 * storage). The browser cannot read that storage itself (no CORS headers), so the server reads
 * the points near the plot and returns a small grid:
 *
 *   per 0.5 m cell: how many non-ground points fell in it, and how many of those came from a
 *   laser pulse with several echoes. Leaves and branches let part of a pulse through (several
 *   echoes); walls, fences, roofs and cars stop it (one echo). On the 60 example homes, 69% of
 *   tree points and 12% of roof points had several echoes.
 *
 * Only the 1 km sheets the bbox touches are read, and inside them only the octree nodes that
 * overlap the bbox (HTTP range requests). Newest scan first: AHN6, then AHN5.
 */
import { readFile } from "node:fs/promises";
import { Copc } from "copc";
import { createLazPerf, type LazPerf } from "laz-perf";
import { z } from "zod";

export const AHN_BASE = "https://fsn1.your-objectstorage.com/hwh-ahn";
export const ECHO_RES = 0.5;
/** Largest side of a request, metres (big rural plots plus a margin). */
export const ECHO_MAX_SIDE_M = 220;

export const EchoQuery = z.object({
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .refine(
      ([x0, y0, x1, y1]) =>
        x1 > x0 &&
        y1 > y0 &&
        x1 - x0 <= ECHO_MAX_SIDE_M &&
        y1 - y0 <= ECHO_MAX_SIDE_M &&
        x0 > -7000 &&
        x1 < 300000 &&
        y0 > 289000 &&
        y1 < 629000,
      "bbox must be in RD New and at most 220 m per side",
    ),
});
export type EchoQuery = z.infer<typeof EchoQuery>;

export interface EchoGrid {
  /** Which scan the points came from, e.g. "AHN5". */
  version: string;
  sheets: string[];
  res: number;
  /** Top-left corner (RD New); rows run southwards, like the height grid. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  /** Non-ground, non-water points per cell. */
  n: number[];
  /** Of those, points from pulses with several echoes. */
  multi: number[];
  points: number;
  ms: number;
}

type Fetch = typeof fetch;

let lazPerfPromise: Promise<LazPerf> | undefined;
/** The LAZ decoder (WebAssembly). In the Vercel bundle its .wasm file sits next to the code. */
function lazPerf(): Promise<LazPerf> {
  lazPerfPromise ??= (async () => {
    try {
      const wasm = await readFile(new URL("./laz-perf.wasm", import.meta.url));
      return await createLazPerf({ wasmBinary: wasm });
    } catch {
      return await createLazPerf();
    }
  })();
  return lazPerfPromise;
}

const sheetName = (v: string, x: number, y: number, year?: number) =>
  v === "AHN6"
    ? `${AHN_BASE}/AHN6/01_LAZ/AHN6_${year}_C_${x}_${y}.COPC.LAZ`
    : `${AHN_BASE}/${v}_KM/01_LAZ/${v}_C_${String(x).padStart(6, "0")}_${String(y).padStart(6, "0")}.COPC.LAZ`;

export function createAhn(opts: { fetchFn?: Fetch; timeoutMs?: number; cacheMs?: number } = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const cacheMs = opts.cacheMs ?? 3_600_000;
  const sheets = new Map<string, Promise<{ url: string; version: string } | null>>();
  const files = new Map<string, Promise<Awaited<ReturnType<typeof Copc.create>>>>();
  const answers = new Map<string, { at: number; grid: EchoGrid }>();

  const getter = (url: string) => async (begin: number, end: number) => {
    const res = await fetchFn(url, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`AHN storage answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  /** The newest sheet that exists for the 1 km cell with lower-left corner (x, y). */
  function sheet(x: number, y: number) {
    const key = `${x}_${y}`;
    let p = sheets.get(key);
    if (!p) {
      p = (async () => {
        const cands: [string, string][] = [
          ...[2027, 2026, 2025].map(
            (yr) => ["AHN6", sheetName("AHN6", x, y, yr)] as [string, string],
          ),
          ["AHN5", sheetName("AHN5", x, y)],
        ];
        for (const [version, url] of cands) {
          const r = await fetchFn(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(timeoutMs),
          }).catch(() => null);
          if (r?.ok) return { url, version };
        }
        return null;
      })();
      sheets.set(key, p);
    }
    return p;
  }

  function open(url: string) {
    let p = files.get(url);
    if (!p) {
      p = Copc.create(getter(url));
      p.catch(() => files.delete(url));
      files.set(url, p);
    }
    return p;
  }

  async function echoes(bbox: [number, number, number, number]): Promise<EchoGrid> {
    const started = performance.now();
    const key = bbox.map((v) => v.toFixed(1)).join(",");
    const hit = answers.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.grid;

    const x0 = Math.floor(bbox[0] / ECHO_RES) * ECHO_RES;
    const y1 = Math.ceil(bbox[3] / ECHO_RES) * ECHO_RES;
    const cols = Math.ceil((bbox[2] - x0) / ECHO_RES);
    const rows = Math.ceil((y1 - bbox[1]) / ECHO_RES);
    const n = new Array<number>(cols * rows).fill(0);
    const multi = new Array<number>(cols * rows).fill(0);
    const lp = await lazPerf();

    const cells: [number, number][] = [];
    for (let y = Math.floor(bbox[1] / 1000) * 1000; y < bbox[3]; y += 1000)
      for (let x = Math.floor(bbox[0] / 1000) * 1000; x < bbox[2]; x += 1000) cells.push([x, y]);
    const found = (await Promise.all(cells.map(([x, y]) => sheet(x, y)))).filter(
      (s): s is { url: string; version: string } => s !== null,
    );
    if (!found.length) throw new Error("No AHN point cloud sheet found here.");

    let points = 0;
    for (const s of found) {
      const copc = await open(s.url);
      const get = getter(s.url);
      const cube = copc.info.cube;
      const span = cube[3] - cube[0];
      const overlaps = (key: string) => {
        const [d, nx, ny] = key.split("-").map(Number) as [number, number, number];
        const size = span / 2 ** d;
        const bx = cube[0] + nx * size;
        const by = cube[1] + ny * size;
        return !(bx > bbox[2] || bx + size < bbox[0] || by > bbox[3] || by + size < bbox[1]);
      };
      // Walk the hierarchy pages that overlap the bbox, collecting the nodes that do.
      const nodes: Awaited<ReturnType<typeof Copc.loadHierarchyPage>>["nodes"][string][] = [];
      const queue = [copc.info.rootHierarchyPage];
      while (queue.length) {
        const page = await Copc.loadHierarchyPage(get, queue.shift()!);
        for (const [k, node] of Object.entries(page.nodes))
          if (node && node.pointCount > 0 && overlaps(k)) nodes.push(node);
        for (const [k, sub] of Object.entries(page.pages)) if (sub && overlaps(k)) queue.push(sub);
      }
      const views = await Promise.all(
        nodes.map((node) =>
          Copc.loadPointDataView(get, copc, node!, {
            lazPerf: lp,
            include: ["X", "Y", "NumberOfReturns", "Classification"],
          }),
        ),
      );
      for (const view of views) {
        const gx = view.getter("X");
        const gy = view.getter("Y");
        const gn = view.getter("NumberOfReturns");
        const gc = view.getter("Classification");
        for (let i = 0; i < view.pointCount; i++) {
          const x = gx(i);
          const y = gy(i);
          if (x < x0 || y > y1) continue;
          const c = Math.floor((x - x0) / ECHO_RES);
          const r = Math.floor((y1 - y) / ECHO_RES);
          if (c >= cols || r >= rows) continue;
          const cls = gc(i);
          // Ground (2) and water (9) say nothing about what stands there.
          if (cls === 2 || cls === 9) continue;
          const k = r * cols + c;
          n[k]!++;
          if (gn(i) > 1) multi[k]!++;
          points++;
        }
      }
    }
    const grid: EchoGrid = {
      version: found[0]!.version,
      sheets: found.map((s) => s.url.split("/").pop()!),
      res: ECHO_RES,
      x0,
      y0: y1,
      cols,
      rows,
      n,
      multi,
      points,
      ms: Math.round(performance.now() - started),
    };
    answers.set(key, { at: Date.now(), grid });
    if (answers.size > 200) answers.delete(answers.keys().next().value!);
    return grid;
  }

  return { echoes };
}
