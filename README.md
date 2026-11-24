# VergunBuy

Check where a renovation fits on a real Dutch plot, using public data and versioned municipal rules.
v1: **carports** (single and double), **real addresses**, **one municipality (Woensdrecht)**.

Built to be transparent: every result can be traced back to the data, the definition and the rule
that produced it.

## How it works

```
address ──▶ facts ──▶ legal concepts ──▶ rules ──▶ result per position
            (data)    (Bbl definitions)  (versioned)  pass · fail · unknown
```

| Layer          | What it holds                                                                                                                           | Where                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Facts          | Plot, house, neighbours, public area, trees, exits. Each fact has a **certainty**: measured, derived, assumed, user-answered or unknown | `packages/data`, `packages/engine/src/facts.ts` |
| Legal concepts | Plot edge classes, hoofdgebouw, voorkant, achtererfgebied, bebouwingsgebied, 1 m buffer                                                 | `packages/engine/src/concepts`                  |
| Rules          | Public-law rules (bruidsschat, local plan, Bbl) decide the verdict; civil-law checks are advisory only                                  | `rulesets/<municipality>/<date>.json`           |
| Trace          | Every request records each pipeline step, its upstream calls, timing and status                                                         | `packages/engine/src/trace.ts`                  |

Principles:

- **Zero false greens.** A position is green only when every hard check passes on known data.
  Missing data gives "unknown", shown as amber with the reason.
- **Data first, questions last.** The user is only asked what public data cannot answer.
- **Rules are data.** Each rule cites its source document, article and version.
- **Everything is inspectable.** The API returns the trace with every response, including errors.

## Repository

```
apps/api           HTTP API (Hono) – Vercel Functions in production, Node locally
apps/web           Frontend (the MVP source is in apps/web/legacy until it is ported)
packages/engine    Pure TypeScript engine, runs in the browser and on the server
packages/data      Adapters for PDOK, BAG, BRK, BGT, 3D BAG and DSO
rulesets           Versioned rule files per municipality
fixtures           Recorded API responses for the hand-checked test plots
docs/adr           Architecture decision records
scripts            Live API contract check
```

## Run it

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm check            # lint, formatting, typecheck, tests
pnpm dev:api          # http://localhost:8787/api/health
pnpm --filter @vergunbuy/web dev   # the web app on http://localhost:5173
pnpm contract-check   # calls the real public APIs (needs internet)
```

Try `/api/search?postcode=<postcode>&number=<house number>` with any Woensdrecht address.

## API

| Endpoint                                      | Returns                                 |
| --------------------------------------------- | --------------------------------------- |
| `GET /api/health`                             | Status and version                      |
| `GET /api/search?postcode=&number=&addition=` | Address with BAG ids and RD coordinates |

Every response is `{ data?, error?, trace, requestId }`. Errors have a stable `code`
(e.g. `ADDRESS_NOT_FOUND`, `OUTSIDE_PILOT`, `UPSTREAM_TIMEOUT`) and a message safe to show users.

## Data sources

PDOK Locatieserver, BAG, BRK Kadastrale kaart, BGT (via PDOK), 3D BAG (CC BY 4.0), DSO
Omgevingsdocumenten. Plot boundaries from the BRK are indicative, not legal boundaries.

## Live site

https://pranavm5.github.io/VergunBuy/ (deployed from `main` by GitHub Actions). The site calls the
public PDOK services directly from the browser (they allow it). A server is only needed once secret
keys (DSO) are involved. Add `?demo` to a check URL to replay a recorded real response set.

## Status

Early development. Results are not legal advice.
