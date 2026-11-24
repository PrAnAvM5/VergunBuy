/**
 * Obstacles in the garden from the national laser height scan (AHN).
 *
 *   height above ground = surface (DSM: top of whatever was there) − ground (DTM: bare earth)
 *
 * Within the plot, outside registered buildings (plus a margin for roof overhang), every 0.5 m
 * cell taller than a threshold is an obstacle cell; touching cells form one obstacle.
 *  - tall   (≥ tallM, default 2.5 m): trees, high structures. Treated as fixed.
 *  - medium (≥ mediumM, default 1.0 m): hedges, shrubs, garden structures, but also a car or
 *    trailer that happened to stand there during the scan. Shown as "check: may be movable".
 *
 * The ground model has no points under buildings and dense crowns; those gaps are filled from
 * the surrounding ground before subtracting (fillGaps). The scan is a snapshot of one date.
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
  /** Smaller groups of cells are ignored as noise. */
  minAreaM2: number;
}

export const OBSTACLE_SETTINGS: ObstacleSettings = {
  mediumM: 1.0,
  tallM: 2.5,
  buildingBufferM: 0.75,
  minAreaM2: 0.5,
};

export interface Obstacle {
  id: string;
  kind: "tall" | "medium";
  /** Centres of the cells, RD New; each cell is res × res. */
  cells: Point[];
  /** Height above ground of each cell, same order as cells (metres, 1 decimal). */
  cellHeights: number[];
  areaM2: number;
  maxHeightM: number;
  centroid: Point;
}

export interface ObstacleResult {
  obstacles: Obstacle[];
  res: number;
  /** Open ground of the plot that was examined (plot minus buildings and margin). */
  yardM2: number;
  tallM2: number;
  mediumM2: number;
  /** Share of examined cells whose ground height had to be filled in. */
  groundFilledShare: number;
  /** Area above each height, for comparing thresholds. */
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
  const ground = fillGaps(grid.dtm, cols, rows);
  const cellArea = res * res;
  const centre = (r: number, c: number): Point => [x0 + (c + 0.5) * res, y0 - (r + 0.5) * res];

  const height = new Float32Array(cols * rows).fill(Number.NaN);
  let yard = 0;
  let filled = 0;
  const areaAbove: Record<string, number> = Object.fromEntries(
    compareAt.map((t) => [String(t), 0]),
  );
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const p = centre(r, c);
      if (!contains(plot, p)) continue;
      if (
        buildings.some(
          (b) => contains(b, p) || distanceToBoundary(b, p) <= settings.buildingBufferM,
        )
      )
        continue;
      const i = r * cols + c;
      const s = grid.dsm[i]!;
      const g = ground[i]!;
      if (Number.isNaN(s) || Number.isNaN(g)) continue;
      yard++;
      if (Number.isNaN(grid.dtm[i]!)) filled++;
      const h = s - g;
      height[i] = h;
      for (const t of compareAt) if (h >= t) areaAbove[String(t)]! += cellArea;
    }

  // Touching cells (8-neighbourhood) above the medium threshold form one obstacle.
  const seen = new Uint8Array(cols * rows);
  const obstacles: Obstacle[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (seen[start] || !(height[start]! >= settings.mediumM)) continue;
    const stack = [start];
    seen[start] = 1;
    const cells: Point[] = [];
    const cellHeights: number[] = [];
    let max = 0;
    let tallCells = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const r = Math.floor(i / cols);
      const c = i % cols;
      cells.push(centre(r, c));
      const h = height[i]!;
      cellHeights.push(Math.round(h * 10) / 10);
      max = Math.max(max, h);
      if (h >= settings.tallM) tallCells++;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!seen[j] && height[j]! >= settings.mediumM) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    const areaM2 = cells.length * cellArea;
    if (areaM2 < settings.minAreaM2) continue;
    const cx = cells.reduce((s, p) => s + p[0], 0) / cells.length;
    const cy = cells.reduce((s, p) => s + p[1], 0) / cells.length;
    obstacles.push({
      id: `obstacle-${obstacles.length + 1}`,
      // Tall when at least ~1 m² of it reaches the tall threshold: a tree, not a hedge's spike.
      kind: tallCells * cellArea >= 1 ? "tall" : "medium",
      cells,
      cellHeights,
      areaM2: Math.round(areaM2 * 100) / 100,
      maxHeightM: Math.round(max * 10) / 10,
      centroid: [cx, cy],
    });
  }
  obstacles.sort((a, b) => b.areaM2 - a.areaM2);
  obstacles.forEach((o, i) => (o.id = `obstacle-${i + 1}`));
  const sum = (k: Obstacle["kind"]) =>
    Math.round(obstacles.filter((o) => o.kind === k).reduce((s, o) => s + o.areaM2, 0) * 10) / 10;
  return {
    obstacles,
    res,
    yardM2: Math.round(yard * cellArea * 10) / 10,
    tallM2: sum("tall"),
    mediumM2: sum("medium"),
    groundFilledShare: yard ? Math.round((filled / yard) * 100) / 100 : 0,
    areaAboveM2: Object.fromEntries(
      Object.entries(areaAbove).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
}
