/**
 * A fake `fetch` that answers from recorded real responses.
 * Used by tests and by the app's demo mode, so a recorded address works offline
 * through exactly the same code path as live data.
 */
import type { FetchFn } from "./http.ts";

/** Keys: "locatieserver", "<dataset>/<collection>" (e.g. "bgt/wegdeel", "nwb/wegvakken") or "3dbag/pand". */
export type RecordedResponses = Record<string, unknown>;

export function fixtureKey(url: URL): string | undefined {
  if (url.pathname.includes("/locatieserver/")) return "locatieserver";
  if (url.hostname === "service.pdok.nl" && url.pathname.includes("/ahn/wcs/")) {
    const cov = url.searchParams.get("coverageid") ?? url.searchParams.get("coverageId");
    return cov ? `ahn/${cov}` : undefined;
  }
  if (url.hostname === "api.3dbag.nl" && url.pathname.includes("/collections/pand/items"))
    return "3dbag/pand";
  if (url.hostname === "vergunbuy-inky.vercel.app" && url.pathname === "/api/rp/zoning")
    return "vergunbuy/rp-zoning";
  if (url.hostname === "vergunbuy-inky.vercel.app" && url.pathname === "/api/permits")
    return "vergunbuy/permits";
  if (url.hostname === "vergunbuy-inky.vercel.app" && url.pathname === "/api/ahn/echoes")
    return "vergunbuy/ahn-echoes";
  if (url.hostname === "vergunbuy-inky.vercel.app" && url.pathname === "/api/ahn/ground")
    return "vergunbuy/ahn-ground";
  if (url.hostname === "service.pdok.nl" && url.pathname.includes("/luchtfotocir/"))
    return `cir/${url.searchParams.get("layers") ?? "?"}`;
  const nwb = /\/rws\/nationaal-wegenbestand-wegen\/ogc\/v\d+\/collections\/([^/]+)\/items/.exec(
    url.pathname,
  );
  if (nwb) return `nwb/${nwb[1]}`;
  const rce = /\/rce\/[^/]+\/ogc\/v\d+\/collections\/([^/]+)\/items/.exec(url.pathname);
  if (rce) return `rce/${rce[1]}`;
  const m = /\/kadaster\/(bag|bgt|brk)[^/]*\/ogc\/v\d+\/collections\/([^/]+)\/items/.exec(
    url.pathname,
  );
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export function fixtureFetch(responses: RecordedResponses, delayMs = 0): FetchFn {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = fixtureKey(url);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const body = key ? responses[key] : undefined;
    if (body === undefined)
      return new Response(JSON.stringify({ error: "not recorded" }), { status: 404 });
    // Binary responses (height rasters) are recorded as { base64, contentType }.
    if (isBinary(body))
      return new Response(base64ToBytes(body.base64), {
        status: 200,
        headers: { "content-type": body.contentType },
      });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

export interface BinaryRecording {
  base64: string;
  contentType: string;
}
export const isBinary = (b: unknown): b is BinaryRecording =>
  typeof b === "object" && b !== null && typeof (b as BinaryRecording).base64 === "string";

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Wraps a fetch so every response is also stored under its fixture key: JSON bodies as JSON
 * (pages of one collection merged into one), binary bodies as base64.
 */
export function recordingFetch(store: RecordedResponses, inner: FetchFn = fetch): FetchFn {
  return async (input, init) => {
    const res = await inner(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = fixtureKey(url);
    if (!key || !res.ok) return res;
    const type = res.headers.get("content-type") ?? "";
    if (/json/.test(type)) {
      const body = (await res
        .clone()
        .json()
        .catch(() => undefined)) as { features?: unknown[] } | undefined;
      if (body) {
        const prev = store[key] as { features?: unknown[] } | undefined;
        if (prev?.features && body.features) prev.features.push(...body.features);
        else store[key] = { ...body, links: [] };
      }
    } else {
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      store[key] = { base64: bytesToBase64(bytes), contentType: type };
    }
    return res;
  };
}
