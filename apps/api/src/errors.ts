import { SafeError } from "@vergunbuy/engine";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Every error code the API can return, with its HTTP status. One place, easy to audit. */
export const ERROR_STATUS: Record<string, ContentfulStatusCode> = {
  INVALID_INPUT: 400,
  ADDRESS_NOT_FOUND: 404,
  ADDRESS_AMBIGUOUS: 409,
  OUTSIDE_PILOT: 422,
  RATE_LIMITED: 429,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_UNREACHABLE: 502,
  UPSTREAM_ERROR: 502,
  UPSTREAM_INVALID: 502,
  HOST_NOT_ALLOWED: 500,
  INTERNAL: 500,
};

export interface ErrorBody {
  code: string;
  message: string;
}

export function toErrorBody(err: unknown): { status: ContentfulStatusCode; body: ErrorBody } {
  if (err instanceof SafeError) {
    return {
      status: ERROR_STATUS[err.code] ?? 500,
      body: { code: err.code, message: err.message },
    };
  }
  return { status: 500, body: { code: "INTERNAL", message: "Something went wrong on our side." } };
}
