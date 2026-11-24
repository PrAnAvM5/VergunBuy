/**
 * National laser height scan (AHN) from the PDOK WCS: surface (DSM) and ground (DTM) at 0.5 m.
 * Both come as compressed GeoTIFF; nodata (no laser points, e.g. ground under buildings and
 * dense crowns) becomes NaN.
 */
import type { HeightGrid, StepContext } from "@vergunbuy/engine";
import { fromArrayBuffer } from "geotiff";
import { getBytes, type FetchFn } from "../http.ts";

export const AHN_WCS = "https://service.pdok.nl/rws/ahn/wcs/v1_0";

function coverageUrl(coverage: string, bbox: [number, number, number, number]): URL {
  const url = new URL(AHN_WCS);
  url.searchParams.set("service", "WCS");
  url.searchParams.set("version", "2.0.1");
  url.searchParams.set("request", "GetCoverage");
  url.searchParams.set("coverageid", coverage);
  url.searchParams.append("subset", `x(${bbox[0]},${bbox[2]})`);
  url.searchParams.append("subset", `y(${bbox[1]},${bbox[3]})`);
  url.searchParams.set("format", "image/tiff");
  return url;
}

async function readRaster(buf: ArrayBuffer) {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const [band] = (await img.readRasters()) as unknown as Float32Array[];
  const nodata = img.getGDALNoData();
  const values = Float32Array.from(band!, (v) =>
    (nodata !== null && v === nodata) || v > 1e30 ? Number.NaN : v,
  );
  const [x0, y0] = img.getOrigin() as [number, number];
  const [res] = img.getResolution() as [number, number];
  return { values, x0, y0, res, cols: img.getWidth(), rows: img.getHeight() };
}

/** Fetches DSM and DTM for a bbox (RD New, metres) and returns them as one grid. */
export async function fetchHeightGrid(
  bbox: [number, number, number, number],
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<HeightGrid> {
  const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 2) / 2 : Math.floor(v * 2) / 2);
  const box: [number, number, number, number] = [
    snap(bbox[0], false),
    snap(bbox[1], false),
    snap(bbox[2], true),
    snap(bbox[3], true),
  ];
  const [dsmBuf, dtmBuf] = await Promise.all(
    ["dsm_05m", "dtm_05m"].map((c) =>
      getBytes({
        url: coverageUrl(c, box),
        ctx,
        ...(fetchFn ? { fetchFn } : {}),
        timeoutMs: 15000,
        serviceName: "the national height scan (AHN)",
      }),
    ),
  );
  const dsm = await readRaster(dsmBuf!);
  const dtm = await readRaster(dtmBuf!);
  if (dsm.cols !== dtm.cols || dsm.rows !== dtm.rows || dsm.x0 !== dtm.x0 || dsm.y0 !== dtm.y0)
    throw new Error("Surface and ground rasters do not line up");
  return {
    x0: dsm.x0,
    y0: dsm.y0,
    res: dsm.res,
    cols: dsm.cols,
    rows: dsm.rows,
    dsm: dsm.values,
    dtm: dtm.values,
  };
}
