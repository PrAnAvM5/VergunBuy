import { describe, expect, it, vi } from "vitest";

// A fake COPC file: one sheet, one hierarchy page with a root node (covers the km) and a deep
// node far away (must be skipped), and three points.
vi.mock("copc", () => {
  const pts = [
    { X: 81000.2, Y: 385000.2, NumberOfReturns: 3, Classification: 1 },
    { X: 81000.3, Y: 385000.3, NumberOfReturns: 1, Classification: 1 },
    { X: 81000.3, Y: 385000.3, NumberOfReturns: 1, Classification: 2 },
    { X: 81500, Y: 385500, NumberOfReturns: 1, Classification: 1 },
  ];
  return {
    Copc: {
      create: vi.fn(async () => ({
        info: { cube: [81000, 385000, 0, 82000, 386000, 1000], rootHierarchyPage: {} },
      })),
      loadHierarchyPage: vi.fn(async () => ({
        nodes: {
          "0-0-0-0": { pointCount: 4, pointDataOffset: 0, pointDataLength: 1 },
          "3-7-7-0": { pointCount: 9, pointDataOffset: 0, pointDataLength: 1 },
        },
        pages: {},
      })),
      loadPointDataView: vi.fn(
        async (_get: unknown, _copc: unknown, node: { pointCount: number }) => {
          if (node.pointCount !== 4) throw new Error("far node must not be read");
          return {
            pointCount: pts.length,
            getter: (d: keyof (typeof pts)[number]) => (i: number) => pts[i]![d],
          };
        },
      ),
    },
  };
});

const { createAhn, EchoQuery } = await import("../src/ahn.ts");

describe("AHN echoes", () => {
  it("rejects boxes that are too big or outside the Netherlands", () => {
    expect(EchoQuery.safeParse({ bbox: [81000, 385000, 81300, 385100] }).success).toBe(false);
    expect(EchoQuery.safeParse({ bbox: [0, 0, 10, 10] }).success).toBe(false);
    expect(EchoQuery.safeParse({ bbox: [81000, 385000, 81010, 385010] }).success).toBe(true);
  });

  it("counts non-ground points and multi-echo points per 0.5 m cell, newest sheet first", async () => {
    const asked: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url.split("/").pop()}`);
      return new Response(null, { status: String(url).includes("AHN5") ? 200 : 404 });
    }) as unknown as typeof fetch;
    const ahn = createAhn({ fetchFn });
    const g = await ahn.echoes([81000, 385000, 81002, 385001]);
    expect(g.version).toBe("AHN5");
    expect(asked[0]).toContain("AHN6_2027");
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(2);
    // Bottom-left cell (row 1, col 0): two non-ground points, one with several echoes.
    expect(g.n[4]).toBe(2);
    expect(g.multi[4]).toBe(1);
    expect(g.points).toBe(2);
  });
});
