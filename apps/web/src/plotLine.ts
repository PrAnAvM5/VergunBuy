/**
 * The street-side plot line as drawn: smoothed for reading only. The carport engine keeps using
 * the raw 0.5 m pieces; this never changes a check.
 *
 * 1. Each street piece takes the most common reading within 1.25 m on either side (exits are
 *    never changed and never vote).
 * 2. A stretch shorter than 1.5 m joins the longer stretch next to it.
 */
import type { BoundaryPiece } from "@vergunbuy/engine";

const WINDOW = 2; // pieces each side (2 × 0.5 m + the piece itself ≈ 2.5 m)
const MIN_RUN = 3; // pieces (1.5 m)

export function smoothedPieces<P extends Pick<BoundaryPiece, "side" | "state">>(pieces: P[]): P[] {
  const out = pieces.map((p) => ({ ...p }));
  // Consecutive street pieces (a street side may be split by other sides).
  const groups: number[][] = [];
  pieces.forEach((p, i) => {
    if (p.side !== "street") return;
    const g = groups[groups.length - 1];
    if (g && g[g.length - 1] === i - 1) g.push(i);
    else groups.push([i]);
  });
  for (const g of groups) {
    const raw = g.map((i) => pieces[i]!.state);
    const vote = raw.map((s, k) => {
      if (s === "exit") return s;
      const count = new Map<string, number>();
      for (let j = Math.max(0, k - WINDOW); j <= Math.min(raw.length - 1, k + WINDOW); j++)
        if (raw[j] !== "exit") count.set(raw[j]!, (count.get(raw[j]!) ?? 0) + 1);
      let best: string = s;
      let bn = count.get(s) ?? 0;
      for (const [x, n] of count) if (n > bn) [best, bn] = [x, n];
      return best;
    });
    for (let pass = 0; pass < 4; pass++) {
      let i = 0;
      while (i < vote.length) {
        let j = i;
        while (j < vote.length && vote[j] === vote[i]) j++;
        if (vote[i] !== "exit" && j - i < MIN_RUN) {
          const L = i > 0 && vote[i - 1] !== "exit" ? vote[i - 1] : undefined;
          const R = j < vote.length && vote[j] !== "exit" ? vote[j] : undefined;
          const len = (from: number, dir: number, s: string) => {
            let n = 0;
            for (let k = from; k >= 0 && k < vote.length && vote[k] === s; k += dir) n++;
            return n;
          };
          const fill = L && R ? (len(i - 1, -1, L) >= len(j, 1, R) ? L : R) : (L ?? R);
          if (fill) for (let k = i; k < j; k++) vote[k] = fill;
        }
        i = j;
      }
    }
    g.forEach((i, k) => (out[i]!.state = vote[k] as P["state"]));
  }
  return out;
}
