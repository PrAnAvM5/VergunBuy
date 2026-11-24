/**
 * PDOK Locatieserver: postcode + house number → address with BAG ids and RD coordinates.
 * Docs: https://api.pdok.nl/bzk/locatieserver/search/v3_1/ui/
 */
import { SafeError, type StepContext } from "@vergunbuy/engine";
import { z } from "zod";
import { getJson, type FetchFn } from "../http.ts";

const BASE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

/** Fields we request explicitly, so the response never depends on the service's default field list. */
export const LOCATIESERVER_FIELDS = [
  "weergavenaam",
  "straatnaam",
  "huisnummer",
  "huisletter",
  "huisnummertoevoeging",
  "postcode",
  "woonplaatsnaam",
  "gemeentenaam",
  "centroide_rd",
  "nummeraanduiding_id",
  "adresseerbaarobject_id",
].join(",");

/** Pilot municipality (v1 scope). */
export const PILOT_MUNICIPALITY = "Woensdrecht";

export const AddressQuery = z.object({
  postcode: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[1-9]\d{3}[A-Z]{2}$/, "Use a Dutch postcode like 4631AB")),
  number: z.coerce.number().int().min(1).max(99999),
  /** House letter or addition, e.g. "a" or "2". Optional. */
  addition: z.string().trim().max(6).optional(),
});
export type AddressQuery = z.infer<typeof AddressQuery>;

const Doc = z.object({
  weergavenaam: z.string(),
  straatnaam: z.string(),
  huisnummer: z.number(),
  huisletter: z.string().optional(),
  huisnummertoevoeging: z.string().optional(),
  postcode: z.string(),
  woonplaatsnaam: z.string(),
  gemeentenaam: z.string(),
  centroide_rd: z.string(),
  nummeraanduiding_id: z.string(),
  adresseerbaarobject_id: z.string(),
});

/** Exported for the live contract check (scripts/contract-check.ts). */
export const LocatieserverResponse = z.object({
  response: z.object({ numFound: z.number(), docs: z.array(Doc) }),
});

export interface Address {
  label: string;
  street: string;
  number: number;
  addition?: string;
  postcode: string;
  town: string;
  municipality: string;
  /** RD New (EPSG:28992) point of the address. */
  pointRd: [number, number];
  bagNummeraanduidingId: string;
  bagVerblijfsobjectId: string;
}

function parsePoint(wkt: string): [number, number] {
  const m = /^POINT\(([-\d.]+) ([-\d.]+)\)$/.exec(wkt);
  if (!m?.[1] || !m[2])
    throw new SafeError("UPSTREAM_INVALID", "The address service sent an unreadable location.");
  return [Number(m[1]), Number(m[2])];
}

export async function findAddress(
  query: AddressQuery,
  ctx: StepContext,
  fetchFn?: FetchFn,
): Promise<Address> {
  const url = new URL(BASE);
  url.searchParams.set("q", `postcode:${query.postcode} AND huisnummer:${query.number}`);
  url.searchParams.set("fq", "type:adres");
  url.searchParams.set("rows", "10");
  url.searchParams.set("fl", LOCATIESERVER_FIELDS);

  const data = await getJson({
    url,
    schema: LocatieserverResponse,
    ctx,
    serviceName: "the address service (PDOK Locatieserver)",
    ...(fetchFn ? { fetchFn } : {}),
  });

  const wanted = query.addition?.toLowerCase();
  const matches = data.response.docs.filter((d) => {
    const extra = `${d.huisletter ?? ""}${d.huisnummertoevoeging ?? ""}`.toLowerCase();
    return wanted === undefined ? true : extra === wanted;
  });
  const doc = matches[0];
  if (!doc) throw new SafeError("ADDRESS_NOT_FOUND", "We could not find that address.");
  if (
    wanted === undefined &&
    matches.length > 1 &&
    matches.some((d) => d.huisletter || d.huisnummertoevoeging)
  ) {
    throw new SafeError(
      "ADDRESS_AMBIGUOUS",
      "Several addresses share this number. Add the letter or addition.",
    );
  }
  if (doc.gemeentenaam !== PILOT_MUNICIPALITY) {
    throw new SafeError(
      "OUTSIDE_PILOT",
      `This address is in ${doc.gemeentenaam}. VergunBuy currently covers ${PILOT_MUNICIPALITY} only.`,
    );
  }

  const addition = `${doc.huisletter ?? ""}${doc.huisnummertoevoeging ?? ""}`;
  ctx.summarize(`Found ${doc.weergavenaam}`);
  return {
    label: doc.weergavenaam,
    street: doc.straatnaam,
    number: doc.huisnummer,
    ...(addition ? { addition } : {}),
    postcode: doc.postcode,
    town: doc.woonplaatsnaam,
    municipality: doc.gemeentenaam,
    pointRd: parsePoint(doc.centroide_rd),
    bagNummeraanduidingId: doc.nummeraanduiding_id,
    bagVerblijfsobjectId: doc.adresseerbaarobject_id,
  };
}
