import { describe, expect, it } from "vitest";
import { rdToWgs84 } from "../src/index.ts";

describe("rdToWgs84", () => {
  it("maps the RD origin (Amersfoort) exactly", () => {
    const p = rdToWgs84(155000, 463000);
    expect(p.lat).toBeCloseTo(52.1551744, 7);
    expect(p.lon).toBeCloseTo(5.38720621, 7);
  });
  it("matches the Westertoren reference point to within about a metre", () => {
    const p = rdToWgs84(120700.723, 487525.501);
    expect(p.lat).toBeCloseTo(52.37453253, 4);
    expect(p.lon).toBeCloseTo(4.88352559, 4);
  });
});
