/**
 * Runs the full pipeline in the browser and keeps the last run for the System view.
 * Live mode calls PDOK directly (CORS is open). Demo mode answers from a real recorded
 * response set through the same code path.
 */
import {
  AddressQuery,
  buildPlotContext,
  findAddress,
  fixtureFetch,
  type FetchFn,
  type PlotContext,
} from "@vergunbuy/data";
import { isSafeError, Tracer, type TraceStep } from "@vergunbuy/engine";

export interface RunResult {
  query: { postcode: string; number: string; addition?: string };
  mode: "live" | "demo";
  startedAt: string;
  totalMs: number;
  context?: PlotContext;
  error?: { code: string; message: string };
  trace: TraceStep[];
}

export const DEMO = { postcode: "4631CC", number: "1" } as const;

let last: RunResult | undefined;
const listeners = new Set<(r: RunResult) => void>();
export const lastRun = () => last;
export const onRun = (fn: (r: RunResult) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

async function demoFetch(): Promise<FetchFn> {
  const mod = await import("../../../fixtures/hoogerheide-aalbersestraat-1/responses.json");
  return fixtureFetch(mod.default as Record<string, unknown>, 60);
}

export async function runCheck(
  query: RunResult["query"],
  mode: RunResult["mode"],
): Promise<RunResult> {
  const tracer = new Tracer();
  const started = performance.now();
  const result: RunResult = {
    query,
    mode,
    startedAt: new Date().toISOString(),
    totalMs: 0,
    trace: tracer.steps,
  };
  try {
    const fetchFn = mode === "demo" ? await demoFetch() : undefined;
    const parsed = AddressQuery.safeParse(query);
    if (!parsed.success) {
      tracer.skip("find-address", "Find the address (PDOK Locatieserver)", "Input was not valid.");
      result.error = {
        code: "INVALID_INPUT",
        message: parsed.error.issues[0]?.message ?? "Check the postcode and number.",
      };
    } else {
      const address = await tracer.step(
        "find-address",
        "Find the address (PDOK Locatieserver)",
        (ctx) => findAddress(parsed.data, ctx, fetchFn),
      );
      result.context = await buildPlotContext(address, tracer, fetchFn);
    }
  } catch (err) {
    result.error = isSafeError(err)
      ? { code: err.code, message: err.message }
      : { code: "INTERNAL", message: "Something went wrong on our side." };
    if (!isSafeError(err)) console.error(err);
  }
  result.totalMs = Math.round(performance.now() - started);
  last = result;
  listeners.forEach((fn) => fn(result));
  return result;
}
