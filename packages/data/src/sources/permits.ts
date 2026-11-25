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
  ["extension", /aanbouw|uitbouw|uitbreid|uitbreiding|dakopbouw|serre|erker/i],
  ["conversion", /verbouw|transform|wijzigen van (het )?(pand|gebruik)|splitsen/i],
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

/** Publications that are not about building on the plot (events, traffic, cables). */
const UNRELATED =
  /alcoholwet|evenement|verkeersmaatregel|verkeersbesluit|kabels en leidingen|standplaats|drank- en horeca|exploitatievergunning/i;
const BUILDING = /omgevingsvergunning|bouw|sloop|kap/i;

/** What the work is: the "Beschrijving:" field, or the sentence after the address. */
export function describe(text: string): string | undefined {
  const field = /Beschrijving:\s*([^]*?)(?:\s+(?:Verzonden|Ontvangen|Datum|Hoogerheide,)|$)/i.exec(
    text,
  )?.[1];
  if (field) return field.trim().slice(0, 260);
  const after =
    /\d{4}\s?[A-Z]{2}\s+(?:in\s+)?[A-Z][a-z]+\s+(.*?)(?:\s+(?:Verzonden|Ontvangen|Hoogerheide,))/.exec(
      text,
    )?.[1];
  return after?.trim().slice(0, 260);
}

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
  const records = answer.data.publications
    .filter((p) => !UNRELATED.test(`${p.title} ${p.text ?? ""}`) || BUILDING.test(p.title))
    .map((p) => {
      const all = `${p.title} ${p.text ?? ""}`;
      const near = describe(p.text ?? "");
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
