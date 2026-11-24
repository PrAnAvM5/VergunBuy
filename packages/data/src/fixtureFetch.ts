/**
 * A fake `fetch` that answers from recorded real responses.
 * Used by tests and by the app's demo mode, so a recorded address works offline
 * through exactly the same code path as live data.
 */
import type { FetchFn } from "./http.ts";

/** Keys: "locatieserver", "<dataset>/<collection>" (e.g. "bgt/wegdeel") or "3dbag/pand". */
export type RecordedResponses = Record<string, unknown>;

export function fixtureKey(url: URL): string | undefined {
  if (url.pathname.includes("/locatieserver/")) return "locatieserver";
  if (url.hostname === "api.3dbag.nl" && url.pathname.includes("/collections/pand/items"))
    return "3dbag/pand";
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
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
