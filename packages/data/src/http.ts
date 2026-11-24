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
  "service.pdok.nl",
  "service.omgevingswet.overheid.nl",
  // Our own server: holds the keys for the DSO and the old zoning plans (Ruimtelijke Plannen).
  "vergunbuy-inky.vercel.app",
]);

/** Our own server (Vercel). Keys for key-protected public APIs live only there. */
export const VERGUNBUY_API = "https://vergunbuy-inky.vercel.app";

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
  /** Send this JSON body with POST instead of a GET. */
  postBody?: unknown;
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
      ...(opts.postBody !== undefined
        ? { method: "POST", body: JSON.stringify(opts.postBody) }
        : {}),
      headers: {
        accept: "application/json",
        ...(opts.postBody !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
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
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SafeError(
      "UPSTREAM_INVALID",
      `${capitalise(serviceName)} sent data in an unexpected format.`,
      detail,
    );
  }
  return parsed.data;
}

/** Same guarantees as getJson, for binary bodies (height rasters). */
export async function getBytes(opts: {
  url: URL;
  ctx: StepContext;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  serviceName: string;
}): Promise<ArrayBuffer> {
  const { url, ctx, serviceName } = opts;
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
    res = await fetchFn(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    record(null);
    if (err instanceof DOMException && err.name === "TimeoutError")
      throw new SafeError("UPSTREAM_TIMEOUT", `${capitalise(serviceName)} did not answer in time.`);
    throw new SafeError("UPSTREAM_UNREACHABLE", `${capitalise(serviceName)} could not be reached.`);
  }
  record(res.status);
  if (!res.ok)
    throw new SafeError(
      "UPSTREAM_ERROR",
      `${capitalise(serviceName)} returned an error (${res.status}).`,
    );
  return res.arrayBuffer();
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
