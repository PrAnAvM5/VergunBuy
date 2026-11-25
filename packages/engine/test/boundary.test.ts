import { describe, expect, it } from "vitest";
import {
  boundaryPieces,
  boundaryRuns,
  majority,
  materialAt,
  type EchoGrid,
  type HeightGrid,
  type NdviGrid,
  type Polygon,
} from "../src/index.ts";

/** 10 × 10 m area, 0.5 m cells, top-left at (0, 10). */
function grids(
  fill: (x: number, y: number) => { h: number; n: number; multi: number; ndvi: number },
) {
  const cols = 20;
  const rows = 20;
  const g: HeightGrid = {
    x0: 0,
    y0: 10,
    res: 0.5,
    cols,
    rows,
    dsm: new Float32Array(cols * rows),
    dtm: new Float32Array(cols * rows),
  };
  const e: EchoGrid = { version: "AHN5", x0: 0, y0: 10, res: 0.5, cols, rows, n: [], multi: [] };
  const v: NdviGrid = {
    layer: "t",
    x0: 0,
    y0: 10,
    res: 0.5,
    cols,
    rows,
    ndvi: new Float32Array(cols * rows),
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const f = fill(c * 0.5 + 0.25, 10 - r * 0.5 - 0.25);
      g.dsm[k] = f.h;
      e.n[k] = f.n;
      e.multi[k] = f.multi;
      v.ndvi[k] = f.ndvi;
    }
  return { g, e, v };
}

const plot: Polygon = [
  [1, 1],
  [9, 1],
  [9, 9],
  [1, 9],
];

describe("material from echoes and plant index", () => {
  const { e, v } = grids((x) =>
    x < 5 ? { h: 0, n: 20, multi: 12, ndvi: -0.1 } : { h: 0, n: 20, multi: 1, ndvi: -0.1 },
  );
  it("many multi-echo points: plant; few: solid", () => {
    expect(materialAt([2, 5], e, v).material).toBe("plant");
    expect(materialAt([7, 5], e, v).material).toBe("solid");
  });
  it("a high plant index makes it a plant even with single echoes (dense evergreen hedge)", () => {
    const g2 = grids(() => ({ h: 0, n: 20, multi: 1, ndvi: 0.3 }));
    expect(materialAt([7, 5], g2.e, g2.v).material).toBe("plant");
  });
  it("too few points and no photo: unknown", () => {
    const g3 = grids(() => ({ h: 0, n: 0, multi: 0, ndvi: Number.NaN }));
    expect(materialAt([5, 5], g3.e, null).material).toBe("unknown");
  });
  it("majority prefers plant on a tie", () => {
    expect(majority(["plant", "solid"])).toBe("plant");
    expect(majority(["solid", "solid", "plant"])).toBe("solid");
    expect(majority(["unknown"])).toBe("unknown");
  });
});

describe("what stands on the plot line", () => {
  // Street along the bottom (y = 1). A 1.5 m wall along it from x = 1 to 6, a hedge from 6 to 7,
  // nothing from 7 to 9 (a gap). A registered exit at x 8–9.
  const { g, e, v } = grids((x, y) => {
    const onLine = y > 0.5 && y < 1.8;
    if (onLine && x < 6) return { h: 1.5, n: 20, multi: 1, ndvi: -0.1 };
    if (onLine && x < 7) return { h: 1.5, n: 20, multi: 10, ndvi: 0.2 };
    return { h: 0, n: 0, multi: 0, ndvi: 0 };
  });
  const pieces = boundaryPieces({
    plot,
    streetRuns: [{ a: [1, 1], b: [9, 1] }],
    exits: [
      [
        [8.2, -1],
        [9, -1],
        [9, 1],
        [8.2, 1],
      ],
    ],
    grid: g,
    buildings: [],
    echo: e,
    ndvi: v,
    mapBarriers: [],
    mapHedges: [],
  });
  const street = pieces.filter((p) => p.side === "street");
  const stateAt = (x: number) =>
    street.find((p) => Math.min(p.a[0], p.b[0]) <= x && Math.max(p.a[0], p.b[0]) >= x)!.state;

  it("labels wall, hedge, gap and exit along the street", () => {
    expect(stateAt(3)).toBe("barrier");
    expect(stateAt(6.5)).toBe("hedge");
    expect(stateAt(7.5)).toBe("open");
    expect(stateAt(8.75)).toBe("exit");
  });
  it("the other sides are not street", () => {
    expect(pieces.filter((p) => p.side === "other").length).toBe(48);
  });
  it("a registered fence on the map wins over the scan", () => {
    const p2 = boundaryPieces({
      plot,
      streetRuns: [{ a: [1, 1], b: [9, 1] }],
      exits: [],
      grid: g,
      buildings: [],
      echo: e,
      ndvi: v,
      mapBarriers: [],
      mapHedges: [
        [
          [1, 1.2],
          [5, 1.2],
        ],
      ],
    });
    expect(p2.find((p) => p.side === "street")!.state).toBe("hedge");
  });
  it("runs join neighbouring pieces", () => {
    const runs = boundaryRuns(street);
    expect(runs.map((r) => r.state)).toEqual(["barrier", "hedge", "open", "exit"]);
  });
});
