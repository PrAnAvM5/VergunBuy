/**
 * "Look around" links: open free outside viewers at this house. Nothing is embedded or measured:
 * Google's viewers need a paid key to embed and may not be used for measuring, so they open in
 * a new tab, for looking only.
 */
import type { PlotContext } from "@vergunbuy/data";
import { at, centroid, outwardNormal, rdToWgs84, type Point } from "@vergunbuy/engine";
import { esc } from "./format.ts";

interface Viewpoint {
  /** Where to stand: in the street in front of the plot. */
  street: { lat: number; lon: number };
  /** What to look at: the house (or the plot). */
  target: { lat: number; lon: number };
  /** Compass heading from street to target, degrees. */
  heading: number;
}

export function viewpoint(ctx: PlotContext): Viewpoint {
  const target: Point = ctx.house[0] ? centroid(ctx.house[0].outline) : centroid(ctx.plot.outline);
  let stand: Point;
  const front = ctx.frame.frontEdge;
  if (front >= 0) {
    const a = at(ctx.plot.outline, front);
    const b = at(ctx.plot.outline, front + 1);
    const n = outwardNormal(ctx.plot.outline, a, b);
    // Stand on the road: beyond the pavement or verge when we know how far it is, else ~6 m out.
    const front_ = ctx.sides.find((s) => s.side === "front");
    const out = (front_?.roadBeyond?.acrossM ?? 3) + 3;
    stand = [(a[0] + b[0]) / 2 + n[0] * out, (a[1] + b[1]) / 2 + n[1] * out];
  } else {
    stand = [target[0], target[1] - 15];
  }
  const heading =
    ((Math.atan2(target[0] - stand[0], target[1] - stand[1]) * 180) / Math.PI + 360) % 360;
  const s = rdToWgs84(stand[0], stand[1]);
  const t = rdToWgs84(target[0], target[1]);
  return { street: s, target: t, heading: Math.round(heading) };
}

const f = (n: number) => n.toFixed(6);

export function lookAround(ctx: PlotContext): string {
  const v = viewpoint(ctx);
  const sv = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${f(v.street.lat)},${f(v.street.lon)}&heading=${v.heading}&pitch=0&fov=80`;
  const earth = `https://earth.google.com/web/@${f(v.target.lat)},${f(v.target.lon)},15a,90d,35y,${v.heading}h,60t,0r`;
  const mapillary = `https://www.mapillary.com/app/?lat=${f(v.street.lat)}&lng=${f(v.street.lon)}&z=19`;
  const card = (title: string, body: string, href: string, button: string) =>
    `<div class="look"><h3>${esc(title)}</h3><p class="small muted">${esc(body)}</p><a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${esc(button)} ↗</a></div>`;
  return `<div class="looks">
    ${card(
      "Street View from the road",
      "Stand in the street in front of the plot, facing the house. Best for the kerb, the hedge or fence, and whether there is a drive. Check the photo date in the corner: it can be several years old.",
      sv,
      "Open Street View",
    )}
    ${card(
      "3D photo model you can fly around",
      "Google Earth's photo-realistic 3D: tilt, rotate and zoom around the house and garden. Good for trees and what stands in the garden. Free to look at, but it may not be used for measuring.",
      earth,
      "Open Google Earth 3D",
    )}
    ${card(
      "Mapillary street photos (open)",
      "Open street-level photos taken by volunteers and companies. Coverage in the villages is patchy, but the photos are open data.",
      mapillary,
      "Open Mapillary",
    )}
  </div>
  <p class="small muted" style="padding:0 16px 14px">These open in a new tab, in the providers' own viewers. Nothing seen there is used in the checks: they are for looking, so you can confirm what the data suggests.</p>`;
}
