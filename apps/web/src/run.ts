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
  /** Validation recording replayed in demo mode, e.g. "2026-11-24-s7/zandfort-48-4631rm-hoogerheide". */
  rec?: string;
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

async function demoFetch(rec?: string): Promise<FetchFn> {
  if (rec) return fixtureFetch(await loadRecording(rec), 20);
  const mod = await import("../../../fixtures/hoogerheide-aalbersestraat-1/responses.json");
  return fixtureFetch(mod.default as Record<string, unknown>, 60);
}

/** Loads one validation recording (gzip, published with the site under validation/). */
async function loadRecording(rec: string): Promise<Record<string, unknown>> {
  if (!/^[\w-]+\/[\w-]+$/.test(rec)) throw new Error("Bad recording name");
  const res = await fetch(`${import.meta.env.BASE_URL}validation/${rec}.json.gz.bin`);
  if (!res.ok) throw new Error(`Recording not found (${res.status})`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, { links?: unknown }>;
  // Pages were merged when recording, so no response should point to a next page.
  for (const body of Object.values(data)) if (body && typeof body === "object") body.links = [];
  return data;
}

export async function runCheck(
  query: RunResult["query"],
  mode: RunResult["mode"],
  rec?: string,
): Promise<RunResult> {
  const tracer = new Tracer();
  const started = performance.now();
  const result: RunResult = {
    query,
    mode,
    startedAt: new Date().toISOString(),
    totalMs: 0,
    trace: tracer.steps,
    ...(rec ? { rec } : {}),
  };
  try {
    const fetchFn = mode === "demo" ? await demoFetch(rec) : undefined;
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
      : rec
        ? { code: "RECORDING", message: "This recorded example could not be loaded." }
        : { code: "INTERNAL", message: "Something went wrong on our side." };
    if (!isSafeError(err)) console.error(err);
  }
  result.totalMs = Math.round(performance.now() - started);
  last = result;
  listeners.forEach((fn) => fn(result));
  return result;
}
