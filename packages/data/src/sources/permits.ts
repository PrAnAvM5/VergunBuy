/**
 * Permit history of a home: the municipality's official publications (applications, granted and
 * refused permits, demolition notices) that lie on the plot or name its exact address. Read through
 * our server, which searches repository.overheid.nl. Older than the municipality's first digital
 * publication (Woensdrecht: 2014) is not covered: absence of a permit there proves nothing.
 */
import type { Polygon, StepContext } from "@vergunbuy/engine";
import { z } from "zod";
import { getJson, VERGUNBUY_API, type FetchFn } from "../http.ts";
import type { Address } from "./locatieserver.ts";

const Answer = z.object({
  data: z.object({
    complete: z.boolean(),
    searched: z.number(),
    earliestOnStreet: z.string().nullable(),
    publications: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        date: z.string().nullable(),
        activities: z.array(z.string()),
        label: z.string().nullable(),
        url: z.string().nullable(),
        match: z.enum(["point-on-plot", "address"]).nullable(),
        text: z.string().optional(),
      }),
    ),
  }),
});

/** What a publication is about, from its text: the kinds of work that matter for annexes. */
const TOPICS: [string, RegExp][] = [
  ["carport", /carport|overkapping/i],
  ["extension", /aanbouw|uitbouw|uitbreid|uitbreiding van de woning|serre|erker/i],
  ["outbuilding", /bijgebouw|berging|schuur|tuinhuis|garage|bijbehorend bouwwerk|poolhouse/i],
  ["dormer", /dakkapel/i],
  ["exit", /uitweg|inrit|uitrit/i],
  ["demolition", /sloop/i],
  ["tree", /kap(pen)?\b|vellen|houtopstand/i],
  ["new-build", /nieuwbouw|oprichten van een woning|bouwen van een woning/i],
];
const STAGE: [string, RegExp][] = [
  ["refused", /geweigerd|weigering|buiten behandeling/i],
  ["granted", /verleend|verlening/i],
  ["applied", /aangevraagd|ingekomen|binnengekomen|aanvraag/i],
  ["notice", /melding/i],
];

export interface PermitRecord {
  id: string;
  date: string | null;
  title: string;
  stage: string;
  topics: string[];
  label: string | null;
  url: string | null;
  match: "point-on-plot" | "address";
  summary: string;
}

export interface PermitHistory {
  status: "complete" | "incomplete" | "missing";
  records: PermitRecord[];
  /** Earliest publication of any kind found for this street: how far back the source reaches. */
  earliestOnStreet: string | null;
}

export async function fetchPermitHistory(
  address: Address,
  plot: Polygon,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<PermitHistory> {
  const letter = (address.addition ?? "").replace(/[^a-z]/gi, "");
  const answer = await getJson({
    url: new URL(`${VERGUNBUY_API}/api/permits`),
    schema: Answer,
    ctx,
    ...(fetchFn ? { fetchFn } : {}),
    timeoutMs: 45000,
    serviceName: "the permit history service",
    postBody: {
      municipality: address.municipality,
      street: address.street,
      number: address.number,
      ...(letter ? { letter } : {}),
      ring: plot.map(([x, y]) => [x, y]),
    },
  });
  const records = answer.data.publications.map((p) => {
    const all = `${p.title} ${p.text ?? ""}`;
    // The sentence naming this address usually says what the work is.
    const near = (p.text ?? "").match(
      new RegExp(`${address.street}[^.;]{0,20}${address.number}[^.;]{0,240}`, "i"),
    )?.[0];
    return {
      id: p.id,
      date: p.date,
      title: p.title,
      stage: STAGE.find(([, re]) => re.test(p.title) || re.test(all))?.[0] ?? "other",
      topics: TOPICS.filter(([, re]) => re.test(near ?? all)).map(([t]) => t),
      label: p.label,
      url: p.url,
      match: p.match ?? "address",
      summary: (near ?? p.title).slice(0, 260),
    };
  });
  return {
    status: answer.data.complete ? "complete" : "incomplete",
    records,
    earliestOnStreet: answer.data.earliestOnStreet,
  };
}
