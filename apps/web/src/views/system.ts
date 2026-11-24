import { esc } from "../format.ts";
import { lastRun } from "../run.ts";

const STATUS_TEXT: Record<string, string> = {
  ok: "OK",
  degraded: "Finished with gaps",
  failed: "Failed",
  skipped: "Skipped",
};

export function renderSystem(root: HTMLElement): void {
  const run = lastRun();
  if (!run) {
    root.innerHTML = `
      <h1>System view</h1>
      <p class="muted" style="max-width:640px">This page shows exactly what the platform did for the last address you checked: every step, every call to a public data service, how long it took, and where anything failed or was incomplete.</p>
      <a class="btn btn-primary" href="#/">Check an address first</a>`;
    return;
  }
  const failed = run.trace.filter((s) => s.status === "failed").length;
  const degraded = run.trace.filter((s) => s.status === "degraded").length;
  const calls = run.trace.reduce((n, s) => n + s.calls.length, 0);
  const verdict = failed
    ? `<span class="pill bad">${failed} step${failed > 1 ? "s" : ""} failed</span>`
    : degraded
      ? `<span class="pill warn">${degraded} step${degraded > 1 ? "s" : ""} with gaps</span>`
      : `<span class="pill ok">All steps OK</span>`;

  root.innerHTML = `
    <div class="check-head">
      <div>
        <div class="muted small">${run.mode === "demo" ? "Recorded example" : "Live data"} · ${esc(new Date(run.startedAt).toLocaleString())}</div>
        <h1>System view</h1>
        <p class="muted" style="margin:6px 0 0">${esc(run.context?.address.label ?? `${run.query.postcode} ${run.query.number}`)}</p>
      </div>
      <div>${verdict}</div>
    </div>
    <div class="grid2">
      <div class="card">
        <h2>Pipeline</h2>
        <p class="small muted">${run.trace.length} steps, ${calls} calls to public data services, ${run.totalMs} ms in total.</p>
        ${run.mode === "demo" ? `<p class="small" style="background:var(--warn-soft);color:var(--warn);padding:8px 12px;border-radius:8px">Recorded example: these calls were replayed from real responses recorded on 24-11-2026, through the same code. No live requests were made.</p>` : ""}
        <div class="pipeline">
          ${run.trace
            .map(
              (s, i) => `
            <div class="pstep ${esc(s.status)}">
              <div class="pdot ${esc(s.status)}" title="${esc(STATUS_TEXT[s.status])}"></div>
              <div>
                <h3>${i + 1}. ${esc(s.label)}</h3>
                <div class="small ${s.status === "failed" ? "" : "muted"}">${esc(s.error ?? s.summary ?? "")}</div>
                ${
                  s.calls.length
                    ? `<div class="calls">${s.calls
                        .map(
                          (c) =>
                            `${c.httpStatus === null ? "no answer" : c.httpStatus} · ${esc(c.host)}${esc(c.path)} · ${c.ms} ms`,
                        )
                        .join("<br/>")}</div>`
                    : ""
                }
              </div>
              <div class="small muted" style="text-align:right">${s.ms} ms<br/><span class="pill ${s.status === "ok" ? "ok" : s.status === "degraded" ? "warn" : s.status === "failed" ? "bad" : "grey"}">${esc(STATUS_TEXT[s.status])}</span></div>
            </div>`,
            )
            .join("")}
        </div>
        ${run.error ? `<p class="small" style="color:var(--bad)">Stopped: ${esc(run.error.message)} (${esc(run.error.code)})</p>` : ""}
      </div>
      <div class="side">
        <div class="card">
          <h2>Data sources used</h2>
          ${
            run.context?.sources.length
              ? `<table class="src"><tr><th>Source</th><th>Objects</th><th>Licence</th></tr>${run.context.sources
                  .map(
                    (s) =>
                      `<tr><td>${esc(s.name)}</td><td>${s.objects}</td><td>${esc(s.licence)}</td></tr>`,
                  )
                  .join("")}</table>`
              : `<p class="small muted">No sources were reached.</p>`
          }
        </div>
        <div class="card">
          <h2>Flags raised</h2>
          ${
            run.context?.flags.length
              ? run.context.flags
                  .map(
                    (f) =>
                      `<div class="flag"><span class="dot"></span><span><span class="mono">${esc(f.code)}</span><br/>${esc(f.detail)}</span></div>`,
                  )
                  .join("")
              : `<p class="small muted" style="margin:0">None.</p>`
          }
        </div>
        <div class="card">
          <h2>How to read this</h2>
          <p class="small muted" style="margin:0">Green: the step worked. Amber: it finished, but some data was missing, so later checks treat that part as unknown. Red: the step failed. If the address or plot cannot be found the run stops; any other failure only affects its own part.</p>
        </div>
      </div>
    </div>`;
}
