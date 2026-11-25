/** Calls the echo reader directly (as the server does) for one bbox, on GitHub Actions. */
import { createAhn } from "../apps/api/src/ahn.ts";
const g = await createAhn().echoes([84900, 383320, 84940, 383360]);
console.log(
  JSON.stringify({
    version: g.version,
    sheets: g.sheets,
    points: g.points,
    ms: g.ms,
    cols: g.cols,
  }),
);
