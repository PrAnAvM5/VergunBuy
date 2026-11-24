/**
 * A fake `fetch` that answers from recorded real responses.
 * Used by tests and by the app's demo mode, so a recorded address works offline
 * through exactly the same code path as live data.
 */
import type { FetchFn } from "./http.ts";

/** Keys: "locatieserver" or "<dataset>/<collection>", e.g. "bgt/wegdeel". */
export type RecordedResponses = Record<string, unknown>;

export function fixtureFetch(responses: RecordedResponses, delayMs = 0): FetchFn {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let key: string | undefined;
    if (url.pathname.includes("/locatieserver/")) key = "locatieserver";
    else {
      const m = /\/kadaster\/(bag|bgt|brk)[^/]*\/ogc\/v\d+\/collections\/([^/]+)\/items/.exec(
        url.pathname,
      );
      if (m) key = `${m[1]}/${m[2]}`;
    }
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
