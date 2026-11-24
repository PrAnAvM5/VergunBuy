import { describe, expect, it } from "vitest";
import { classifyEdges, plotFrame, plotLayout, toLocal, type Polygon } from "../src/index.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Polygon => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

// Plot with streets on the west (x < 0) and the south (y < 0). The address street is on the west.
const plot = rect(0, 0, 8, 20);
const house = rect(0, 4, 6, 14);
const runs = classifyEdges({
  plot,
  house,
  neighbourBuildings: [],
  publicAreas: [
    { id: "west", kind: "road", outline: rect(-6, -10, 0, 30) },
    { id: "south", kind: "road", outline: rect(-10, -6, 20, 0) },
  ],
});

describe("plotFrame", () => {
  it("uses the street-name label to pick the front, even when another public side is longer", () => {
    const frame = plotFrame(plot, runs, [{ at: [-3, 10], name: "Westweg" }]);
    expect(frame.method).toBe("street-label");
    expect(frame.streetName).toBe("Westweg");
    // After rotation the street (west) is at the bottom: a point in the street has a lower y than the plot.
    expect(toLocal(frame, [-3, 10])[1]).toBeLessThan(toLocal(frame, [4, 10])[1]);
  });

  it("falls back to the longest public side without a label", () => {
    const frame = plotFrame(plot, runs, []);
    expect(frame.method).toBe("longest-public");
  });

  it("computes plot size and setbacks in the plot's own frame", () => {
    const frame = plotFrame(plot, runs, [{ at: [-3, 10], name: "Westweg" }]);
    const layout = plotLayout(frame, plot, house);
    expect(layout.plotWidthM).toBeCloseTo(20, 1); // along the street
    expect(layout.plotDepthM).toBeCloseTo(8, 1); // away from the street
    expect(layout.setbacks?.frontM).toBeCloseTo(0, 1); // house stands on the street side
    expect(layout.setbacks?.rearM).toBeCloseTo(2, 1);
  });
});

describe("describeSides", () => {
  it("assigns every edge to front, rear, left or right and accounts for the whole boundary", async () => {
    const { describeSides } = await import("../src/index.ts");
    const frame = plotFrame(plot, runs, [{ at: [-3, 10], name: "Westweg" }]);
    const sides = describeSides(frame, plot, runs, (id) =>
      id === "west" ? "road (Westweg)" : id === "south" ? "road (Zuidweg)" : undefined,
    );
    const by = Object.fromEntries(sides.map((s) => [s.side, s]));
    // West is the front (street label), so south becomes a side.
    expect(by.front?.parts[0]?.label).toBe("road (Westweg)");
    expect(by.front?.lengthM).toBeCloseTo(20, 1);
    expect(sides.some((s) => s.parts.some((p) => p.label === "road (Zuidweg)"))).toBe(true);
    const total = sides.reduce((s, x) => s + x.lengthM, 0);
    expect(total).toBeCloseTo(2 * (8 + 20), 0);
  });
});
