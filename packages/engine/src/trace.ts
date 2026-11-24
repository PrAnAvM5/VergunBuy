/**
 * Pipeline trace (ADR-024).
 *
 * Every request records the steps it ran: what each step did, how long it took,
 * which upstream APIs it called and whether it was ok, degraded or failed.
 * The System view page draws this; the Inspector links facts back to their step.
 */
export type StepStatus = "ok" | "degraded" | "failed" | "skipped";

export interface UpstreamCall {
  host: string;
  path: string;
  /** HTTP status, or null when the call never got a response (timeout, network). */
  httpStatus: number | null;
  ms: number;
}

export interface TraceStep {
  id: string;
  label: string;
  status: StepStatus;
  ms: number;
  summary: string;
  calls: UpstreamCall[];
  /** Safe, user-readable error text. Never a raw upstream message. */
  error?: string;
}

export interface StepContext {
  /** One plain-language line about what the step found. */
  summarize(text: string): void;
  /** Mark the step as degraded: it finished, but with gaps (e.g. tree data missing). */
  degrade(reason: string): void;
  recordCall(call: UpstreamCall): void;
}

export class Tracer {
  readonly steps: TraceStep[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  async step<T>(id: string, label: string, run: (ctx: StepContext) => Promise<T> | T): Promise<T> {
    const started = this.now();
    const record: TraceStep = { id, label, status: "ok", ms: 0, summary: "", calls: [] };
    this.steps.push(record);
    const ctx: StepContext = {
      summarize: (text) => {
        record.summary = text;
      },
      degrade: (reason) => {
        record.status = "degraded";
        record.summary = record.summary ? `${record.summary} (${reason})` : reason;
      },
      recordCall: (call) => {
        record.calls.push(call);
      },
    };
    try {
      return await run(ctx);
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof SafeError ? err.message : "This step failed unexpectedly.";
      throw err;
    } finally {
      record.ms = Math.round(this.now() - started);
    }
  }

  skip(id: string, label: string, reason: string): void {
    this.steps.push({ id, label, status: "skipped", ms: 0, summary: reason, calls: [] });
  }
}

/** An error whose message is safe to show to users and in the trace. */
export class SafeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Developer-only detail (e.g. schema issues). Logged, never shown to users or put in the trace. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "SafeError";
  }
}
