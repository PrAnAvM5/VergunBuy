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
 *  3. Trees: cells ≥ tallM that touch (8 directions) form one tall group; each group takes in
 *     the lower cells directly around it (one cell wide), its crown edge.
 *  4. Everything else ≥ mediumM that touches forms a medium group (hedges, shrubs, low
 *     structures, or a car that stood there during the scan).
 *  5. Only groups that reach into the plot are kept. A tall group whose highest point lies
 *     outside the plot is a neighbour's tree hanging over ("overhang"), not an obstacle on the
 *     plot; one whose highest point is inside is "tall".
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
}

export const OBSTACLE_SETTINGS: ObstacleSettings = {
  mediumM: 1.0,
  tallM: 2.5,
  buildingBufferM: 0.75,
  minAreaM2: 0.5,
};

export type ObstacleKind = "tall" | "medium" | "overhang";

export interface Obstacle {
  id: string;
  /**
   * tall: a tree or high structure standing on the plot. medium: hedge, shrub, low structure
   * or something movable. overhang: the crown of a tree standing outside the plot.
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
  // 3. Tall groups, then their one-cell fringe of lower cells.
  for (let i = 0; i < N; i++)
    if (group[i] === -1 && height[i]! >= settings.tallM) flood(i, (h) => h >= settings.tallM, true);
  for (const g of groups) {
    const fringe: number[] = [];
    for (const i of g.cells)
      for (const j of neighbours(i))
        if (group[j] === -1 && height[j]! >= settings.mediumM) {
          group[j] = groups.indexOf(g);
          fringe.push(j);
        }
    g.cells.push(...fringe);
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
    const kind: ObstacleKind = !g.tall ? "medium" : peakInside ? "tall" : "overhang";
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
      peak: centre(peak),
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
    groundFilledShare: yard ? Math.round((filled / yard) * 100) / 100 : 0,
    areaAboveM2: Object.fromEntries(
      Object.entries(areaAbove).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
}
