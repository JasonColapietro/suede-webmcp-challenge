import "server-only";
import { z } from "zod";
import {
  EphemeralPlaceCandidateSchema,
  ProspectWebsiteSchema,
  type EphemeralPlaceCandidate,
} from "./contracts";
import {
  ScanDiagnosticHandoffSchema,
  type ScanDiagnosticHandoff,
} from "../operating-system/outbound-diagnostic";

const PlacesResponseSchema = z.object({
  places: z.array(z.object({
    id: z.string().trim().min(1).max(256),
    displayName: z.object({ text: z.string().trim().min(1).max(300) }).passthrough().optional(),
    websiteUri: z.string().optional(),
    googleMapsUri: z.string().optional(),
  }).passthrough()).max(10).default([]),
}).passthrough();

export class ProspectAdapterUnavailableError extends Error {}
export class ProspectAdapterResponseError extends Error {}

export async function discoverGooglePlaces(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<EphemeralPlaceCandidate[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) throw new ProspectAdapterUnavailableError("Google Places discovery is not configured. Use manual website import.");
  const response = await fetcher("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.websiteUri,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 10 }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new ProspectAdapterResponseError("Google Places search failed.");
  const parsed = PlacesResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ProspectAdapterResponseError("Google Places returned an invalid response.");
  return parsed.data.places.map((place) => {
    const website = place.websiteUri ? ProspectWebsiteSchema.safeParse(place.websiteUri) : null;
    return EphemeralPlaceCandidateSchema.parse({
      placeId: place.id,
      displayName: place.displayName?.text ?? "Google Maps business",
      websiteUrl: website?.success ? website.data : null,
      mapsUri: typeof place.googleMapsUri === "string" ? place.googleMapsUri : null,
      sourceAttribution: "Google Maps",
    });
  });
}

const OperatorAuditEnvelopeSchema = z.union([
  ScanDiagnosticHandoffSchema,
  z.object({ handoff: ScanDiagnosticHandoffSchema }).strict().transform((value) => value.handoff),
]);

export async function runOptimizeOperatorAudit(
  websiteUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ScanDiagnosticHandoff> {
  const endpoint = process.env.OPTIMIZE_OPERATOR_AUDIT_URL?.trim();
  const token = process.env.OPTIMIZE_OPERATOR_AUDIT_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new ProspectAdapterUnavailableError(
      "Optimize operator audit is not configured. Set OPTIMIZE_OPERATOR_AUDIT_URL and OPTIMIZE_OPERATOR_AUDIT_TOKEN.",
    );
  }
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) {
    throw new ProspectAdapterUnavailableError("Optimize operator audit endpoint must be a clean HTTPS URL.");
  }
  const response = await fetcher(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url: websiteUrl }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) throw new ProspectAdapterResponseError("Optimize operator audit failed.");
  const parsed = OperatorAuditEnvelopeSchema.safeParse(await response.json());
  if (!parsed.success) throw new ProspectAdapterResponseError("Optimize returned an invalid or unsigned operator audit.");
  return parsed.data;
}
