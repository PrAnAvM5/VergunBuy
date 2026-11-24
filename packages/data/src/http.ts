/**
 * The only way the backend talks to the outside world.
 *
 *  - Only hosts on the allowlist can be called (ADR-025), so user input can never
 *    make the server fetch an arbitrary URL.
 *  - Every call has a timeout and is recorded in the trace (host, path, status, ms).
 *  - Responses are validated with Zod; a response that does not match is an
 *    UPSTREAM_INVALID error, never silently passed on.
 *  - Errors shown to users are SafeErrors with fixed wording, never raw upstream text.
 */
import { SafeError, type StepContext } from "@vergunbuy/engine";
import type { z } from "zod";

export const ALLOWED_HOSTS = new Set([
  "api.pdok.nl",
  "api.3dbag.nl",
  "service.omgevingswet.overheid.nl",
]);

export const DEFAULT_TIMEOUT_MS = 8000;

export type FetchFn = typeof fetch;

export interface GetJsonOptions<T> {
  url: URL;
  schema: z.ZodType<T>;
  ctx: StepContext;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Name of the service in user-facing errors, e.g. "the address service". */
  serviceName: string;
}

export async function getJson<T>(opts: GetJsonOptions<T>): Promise<T> {
  const { url, schema, ctx, serviceName } = opts;
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new SafeError("HOST_NOT_ALLOWED", `Calls to ${url.hostname} are not allowed.`);
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const started = performance.now();
  const record = (httpStatus: number | null) =>
    ctx.recordCall({
      host: url.hostname,
      path: url.pathname,
      httpStatus,
      ms: Math.round(performance.now() - started),
    });

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: "application/json", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    record(null);
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new SafeError("UPSTREAM_TIMEOUT", `${capitalise(serviceName)} did not answer in time.`);
    }
    throw new SafeError("UPSTREAM_UNREACHABLE", `${capitalise(serviceName)} could not be reached.`);
  }
  record(res.status);
  if (!res.ok) {
    throw new SafeError(
      "UPSTREAM_ERROR",
      `${capitalise(serviceName)} returned an error (${res.status}).`,
    );
  }

  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new SafeError(
      "UPSTREAM_INVALID",
      `${capitalise(serviceName)} sent data in an unexpected format.`,
    );
  }
  return parsed.data;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
