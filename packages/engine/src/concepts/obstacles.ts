/**
 * Obstacles in the garden from the national laser height scan (AHN). No machine learning: only
 * measured heights, the registered outlines and fixed thresholds, so it works the same for any
 * address in the Netherlands.
 *
 *   height above ground = surface (DSM: top of whatever was there) − ground (DTM: bare earth)
 *
 * Steps (all on 0.5 m cells, over the plot plus a margin around it):
 *  1. Fill gaps in the ground model (no laser points reach the ground under roofs and dense
 *     crowns) from the surrounding ground: fillGaps.
 *  2. Leave out cells on or within buildingBufferM of a registered building (roof overhang).
 *  3. Trees, one by one (crowns of neighbouring trees often touch, so "touching tall cells" is
 *     not one tree). On cells ≥ tallM, lightly smoothed (3 × 3 mean):
 *       a. from every cell, step to the highest neighbouring cell until no neighbour is higher:
 *          that cell is a local top;
 *       b. local tops closer than TREETOP_MERGE_M to a higher top belong to that higher top
 *          (one tree with several leaders);
 *       c. every crown cell belongs to the top it climbed to: one tree per remaining top.
 *     Each tree then takes in the lower cells directly around it (one cell wide), its crown edge.
 *  4. Everything else ≥ mediumM that touches forms a medium group (hedges, shrubs, low
 *     structures, or a car that stood there during the scan).
 *  5. Only groups that reach into the plot are kept. Where a tree stands is where its top is:
 *       top inside the plot, more than boundaryToleranceM from the line → "tall" (on the plot);
 *       top outside, more than boundaryToleranceM from the line → "overhang" (next door);
 *       top within boundaryToleranceM of the line → "boundary" (the cadastral line itself is
 *       only accurate to about a metre, so it may stand on either side; treated as fixed).
 *  6. Each group reports only its cells inside the plot, with every cell's own height.
 */
import { contains, distanceToBoundary, type Point, type Polygon } from "../geometry.ts";

export interface HeightGrid {
  /** Top-left corner of the grid (RD New), rows run southwards. */
  x0: number;
  y0: number;
  /** Cell size in metres. */
  res: number;
  cols: number;
  rows: number;
  /** Surface heights, row-major; NaN where unknown. */
  dsm: Float32Array;
  /** Ground heights, row-major; NaN where unknown. */
  dtm: Float32Array;
}

export interface ObstacleSettings {
  mediumM: number;
  tallM: number;
  /** Cells this close to a registered building are left out (roof overhang, wall noise). */
  buildingBufferM: number;
  /** Groups with less than this inside the plot are ignored as noise. */
  minAreaM2: number;
  /** Local tops closer than this to a higher top are the same tree. */
  treetopMergeM: number;
  /** A treetop this close to the plot line may stand on either side. */
  boundaryToleranceM: number;
}

export const OBSTACLE_SETTINGS: ObstacleSettings = {
  mediumM: 1.0,
  tallM: 2.5,
  buildingBufferM: 0.75,
  minAreaM2: 0.5,
  treetopMergeM: 2.5,
  boundaryToleranceM: 1.0,
};

export type ObstacleKind = "tall" | "medium" | "overhang" | "boundary";

export interface Obstacle {
  id: string;
  /**
   * tall: a tree or high structure standing on the plot. medium: hedge, shrub, low structure
   * or something movable. overhang: the crown of a tree standing outside the plot. boundary: a
   * tree whose top is within a metre of the plot line, so it may stand on either side.
   */
  kind: ObstacleKind;
  /** Centres of the cells inside the plot, RD New; each cell is res × res. */
  cells: Point[];
  /** Height above ground of each of those cells (metres, 1 decimal), same order. */
  cellHeights: number[];
  /** Area inside the plot. */
  areaM2: number;
  /** Whole group, inside and outside the plot. */
  totalAreaM2: number;
  /** Share of the group that lies inside the plot (0..1). */
  insideShare: number;
  /** Highest point of the whole group, and whether it lies inside the plot. */
  maxHeightM: number;
  peakInside: boolean;
  peak: Point;
  /** Distance from the top to the plot line (m); positive inside the plot, negative outside. */
  peakToLineM: number;
  /** For overhang: how far the crown reaches into the plot from the line (m). */
  reachIntoPlotM: number;
  /** Heights of the cells inside the plot. */
  medianHeightM: number;
  p90HeightM: number;
  /** Share of the cells inside the plot whose ground height had to be filled in. */
  groundFilledShare: number;
  centroid: Point;
}

export interface ObstacleResult {
  obstacles: Obstacle[];
  res: number;
  settings: ObstacleSettings;
  /** Open ground of the plot that was examined (plot minus buildings and margin). */
  yardM2: number;
  tallM2: number;
  mediumM2: number;
  overhangM2: number;
  boundaryM2: number;
  /** Number of separate trees found (tops), on and around the plot. */
  treesFound: number;
  /** Share of examined plot cells whose ground height had to be filled in. */
  groundFilledShare: number;
  /** Area inside the plot above each height, for comparing thresholds. */
  areaAboveM2: Record<string, number>;
}

/** Fills NaN cells with the mean of their known neighbours, growing inwards until none are left. */
export function fillGaps(values: Float32Array, cols: number, rows: number): Float32Array {
  const g = Float32Array.from(values);
  for (let iter = 0; iter < cols + rows; iter++) {
    const next = Float32Array.from(g);
    let missing = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!Number.isNaN(g[i]!)) continue;
        let sum = 0;
        let n = 0;
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const v = g[rr * cols + cc]!;
          if (!Number.isNaN(v)) {
            sum += v;
            n++;
          }
        }
        if (n > 0) next[i] = sum / n;
        else missing++;
      }
    g.set(next);
    if (missing === 0) break;
  }
  return g;
}

export function detectObstacles(
  grid: HeightGrid,
  plot: Polygon,
  buildings: Polygon[],
  settings: ObstacleSettings = OBSTACLE_SETTINGS,
  compareAt: number[] = [1.0, 1.5, 2.0, 2.5],
): ObstacleResult {
  const { cols, rows, res, x0, y0 } = grid;
  const N = cols * rows;
  const ground = fillGaps(grid.dtm, cols, rows);
  const cellArea = res * res;
  const centre = (i: number): Point => [
    x0 + ((i % cols) + 0.5) * res,
    y0 - (Math.floor(i / cols) + 0.5) * res,
  ];

  // Heights over the whole grid (outside buildings), and which cells lie in the plot.
  const height = new Float32Array(N).fill(Number.NaN);
  const inPlot = new Uint8Array(N);
  let yard = 0;
  let filled = 0;
  const areaAbove: Record<string, number> = Object.fromEntries(
    compareAt.map((t) => [String(t), 0]),
  );
  // Bounding boxes first: only buildings whose (buffered) box holds the cell are tested exactly.
  // Same result, but large parcels with many buildings stay fast.
  const buf = settings.buildingBufferM;
  const boxes = buildings.map((b) => {
    const xs = b.map((q) => q[0]);
    const ys = b.map((q) => q[1]);
    return {
      b,
      minX: Math.min(...xs) - buf,
      maxX: Math.max(...xs) + buf,
      minY: Math.min(...ys) - buf,
      maxY: Math.max(...ys) + buf,
    };
  });
  const pxs = plot.map((q) => q[0]);
  const pys = plot.map((q) => q[1]);
  const plotBox = {
    minX: Math.min(...pxs),
    maxX: Math.max(...pxs),
    minY: Math.min(...pys),
    maxY: Math.max(...pys),
  };
  for (let i = 0; i < N; i++) {
    const p = centre(i);
    if (
      boxes.some(
        (x) =>
          p[0] >= x.minX &&
          p[0] <= x.maxX &&
          p[1] >= x.minY &&
          p[1] <= x.maxY &&
          (contains(x.b, p) || distanceToBoundary(x.b, p) <= buf),
      )
    )
      continue;
    const sv = grid.dsm[i]!;
    const gv = ground[i]!;
    if (Number.isNaN(sv) || Number.isNaN(gv)) continue;
    const h = sv - gv;
    height[i] = h;
    if (
      p[0] < plotBox.minX ||
      p[0] > plotBox.maxX ||
      p[1] < plotBox.minY ||
      p[1] > plotBox.maxY ||
      !contains(plot, p)
    )
      continue;
    inPlot[i] = 1;
    yard++;
    if (Number.isNaN(grid.dtm[i]!)) filled++;
    for (const t of compareAt) if (h >= t) areaAbove[String(t)]! += cellArea;
  }

  const neighbours = (i: number): number[] => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const out: number[] = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) out.push(rr * cols + cc);
      }
    return out;
  };
  const group = new Int32Array(N).fill(-1);
  const groups: { cells: number[]; tall: boolean }[] = [];
  const flood = (start: number, accept: (h: number) => boolean, tall: boolean) => {
    const id = groups.length;
    const cells: number[] = [];
    const stack = [start];
    group[start] = id;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      for (const j of neighbours(i))
        if (group[j] === -1 && accept(height[j]!)) {
          group[j] = id;
          stack.push(j);
        }
    }
    groups.push({ cells, tall });
  };
  // 3. Trees one by one: smoothed crown heights, climb to local tops, merge close tops.
  const canopy = (i: number) => height[i]! >= settings.tallM;
  const smooth = new Float32Array(N).fill(Number.NaN);
  for (let i = 0; i < N; i++) {
    if (!canopy(i)) continue;
    let sum = height[i]!;
    let n = 1;
    for (const j of neighbours(i))
      if (canopy(j)) {
        sum += height[j]!;
        n++;
      }
    smooth[i] = sum / n;
  }
  // Total order on crown cells: smoothed height, then position, so a flat crown has one top.
  const higher = (a: number, b: number) =>
    smooth[a]! > smooth[b]! || (smooth[a] === smooth[b] && a > b);
  const climbTo = new Int32Array(N).fill(-1);
  const climb = (start: number): number => {
    let i = start;
    const path: number[] = [];
    for (;;) {
      if (climbTo[i] !== -1) {
        i = climbTo[i]!;
        break;
      }
      path.push(i);
      let best = i;
      for (const j of neighbours(i)) if (canopy(j) && higher(j, best)) best = j;
      if (best === i) break;
      i = best;
    }
    for (const p of path) climbTo[p] = i;
    return i;
  };
  const tops = new Set<number>();
  for (let i = 0; i < N; i++) if (canopy(i)) tops.add(climb(i));
  // Merge each top into the highest top within treetopMergeM, repeatedly, so chains resolve.
  const mergeR = settings.treetopMergeM / res;
  const topList = [...tops].sort((a, b) => (higher(a, b) ? -1 : 1));
  const rootOf = new Map<number, number>();
  for (const t of topList) {
    const tr = Math.floor(t / cols);
    const tc = t % cols;
    let root = t;
    for (const u of topList) {
      if (!higher(u, t)) break; // sorted: only higher tops can absorb this one
      const ur = Math.floor(u / cols);
      const uc = u % cols;
      if (Math.hypot(ur - tr, uc - tc) <= mergeR) {
        root = rootOf.get(u) ?? u;
        break;
      }
    }
    rootOf.set(t, root);
  }
  const treeIndex = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    if (!canopy(i)) continue;
    const root = rootOf.get(climbTo[i]!)!;
    let id = treeIndex.get(root);
    if (id === undefined) {
      id = groups.length;
      treeIndex.set(root, id);
      groups.push({ cells: [], tall: true });
    }
    group[i] = id;
    groups[id]!.cells.push(i);
  }
  // Crown edge: lower cells right next to a tree join the tree of their highest crown neighbour.
  const fringe: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    if (group[i] !== -1 || !(height[i]! >= settings.mediumM)) continue;
    let best = -1;
    for (const j of neighbours(i))
      if (canopy(j) && (best === -1 || height[j]! > height[best]!)) best = j;
    if (best !== -1) fringe.push([i, group[best]!]);
  }
  for (const [i, id] of fringe) {
    group[i] = id;
    groups[id]!.cells.push(i);
  }
  // 4. Medium groups from what is left.
  for (let i = 0; i < N; i++)
    if (group[i] === -1 && height[i]! >= settings.mediumM)
      flood(i, (h) => h >= settings.mediumM && h < settings.tallM, false);

  // 5–6. Keep groups that reach into the plot; report their cells inside it.
  const obstacles: Obstacle[] = [];
  for (const g of groups) {
    const inside = g.cells.filter((i) => inPlot[i]);
    const areaM2 = inside.length * cellArea;
    if (areaM2 < settings.minAreaM2) continue;
    let peak = g.cells[0]!;
    for (const i of g.cells) if (height[i]! > height[peak]!) peak = i;
    const peakInside = inPlot[peak] === 1;
    const hs = inside.map((i) => height[i]!).sort((a, b) => a - b);
    const q = (f: number) =>
      Math.round((hs[Math.min(hs.length - 1, Math.floor(f * hs.length))] ?? 0) * 10) / 10;
    const pts = inside.map(centre);
    // Where a tree stands is where its top is; within the tolerance of the line, either side.
    const peakPt = centre(peak);
    const lineDist = distanceToBoundary(plot, peakPt);
    const peakToLineM = Math.round((peakInside ? lineDist : -lineDist) * 10) / 10;
    // A crown cut off by the edge of the loaded area has its real top further out; if what we
    // see of it is all outside the plot, it stands next door.
    const atGridEdge = g.cells.some((i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      return r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
    });
    const kind: ObstacleKind = !g.tall
      ? "medium"
      : atGridEdge && !peakInside
        ? "overhang"
        : lineDist <= settings.boundaryToleranceM
          ? "boundary"
          : peakInside
            ? "tall"
            : "overhang";
    const reachIntoPlotM =
      kind === "overhang"
        ? Math.round(Math.max(0, ...inside.map((i) => distanceToBoundary(plot, centre(i)))) * 10) /
          10
        : 0;
    obstacles.push({
      id: "",
      kind,
      cells: pts,
      cellHeights: inside.map((i) => Math.round(height[i]! * 10) / 10),
      areaM2: Math.round(areaM2 * 100) / 100,
      totalAreaM2: Math.round(g.cells.length * cellArea * 100) / 100,
      insideShare: Math.round((inside.length / g.cells.length) * 100) / 100,
      maxHeightM: Math.round(height[peak]! * 10) / 10,
      peakInside,
      peak: peakPt,
      peakToLineM,
      reachIntoPlotM,
      medianHeightM: q(0.5),
      p90HeightM: q(0.9),
      groundFilledShare:
        Math.round(
          (inside.filter((i) => Number.isNaN(grid.dtm[i]!)).length / inside.length) * 100,
        ) / 100,
      centroid: [
        pts.reduce((s2, p) => s2 + p[0], 0) / pts.length,
        pts.reduce((s2, p) => s2 + p[1], 0) / pts.length,
      ],
    });
  }
  obstacles.sort((a, b) => b.areaM2 - a.areaM2);
  obstacles.forEach((o, i) => (o.id = `obstacle-${i + 1}`));
  const sum = (k: ObstacleKind) =>
    Math.round(obstacles.filter((o) => o.kind === k).reduce((s2, o) => s2 + o.areaM2, 0) * 10) / 10;
  return {
    obstacles,
    res,
    settings,
    yardM2: Math.round(yard * cellArea * 10) / 10,
    tallM2: sum("tall"),
    mediumM2: sum("medium"),
    overhangM2: sum("overhang"),
    boundaryM2: sum("boundary"),
    treesFound: groups.filter((g) => g.tall).length,
    groundFilledShare: yard ? Math.round((filled / yard) * 100) / 100 : 0,
    areaAboveM2: Object.fromEntries(
      Object.entries(areaAbove).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
}
