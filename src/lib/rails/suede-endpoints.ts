/**
 * Studio's Suede gateway compatibility profiles and their USDC defaults on
 * Base. Existing saved flows still reference profiles whose routes are not
 * currently operational, so this exhaustive map is not a live-service claim.
 * Public surfaces must consume PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS below.
 *
 * Source of truth: Suede-AI-App profile defaults plus unpaid live HTTP 402
 * probes of the operational allowlist (verified 2026-08-09).
 */
export interface SuedeEndpoint {
  id: string;
  method: "GET" | "POST";
  path: string;
  description: string;
  priceUsdc: number;
}

export const SUEDE_ENDPOINTS = {
  generateSong: { id: "generateSong", method: "POST", path: "/create-music", description: "Generate an original, full-length Suede song", priceUsdc: 0.5 },
  generateVideo: { id: "generateVideo", method: "POST", path: "/agent/video", description: "Generate a short-form music-video clip", priceUsdc: 4.99 },
  generateImage: { id: "generateImage", method: "POST", path: "/agent/image", description: "Generate a single still image from a text prompt", priceUsdc: 0.15 },
  rightsLookup: { id: "rightsLookup", method: "GET", path: "/v1/rights", description: "Resolve registry attestation for a content hash", priceUsdc: 0.015 },
  analyze: { id: "analyze", method: "POST", path: "/v1/analyze", description: "BPM, key, mode, energy, danceability, loudness, duration", priceUsdc: 0.01 },
  extend: { id: "extend", method: "POST", path: "/v1/extend", description: "Extend a track with natural continuation", priceUsdc: 1 },
  cover: { id: "cover", method: "POST", path: "/v1/cover", description: "Generate a stylistic cover / re-imagining", priceUsdc: 1 },
  vox: { id: "vox", method: "POST", path: "/v1/vox", description: "Replace lead vocal with a target Suede voice", priceUsdc: 1 },
  continue: { id: "continue", method: "POST", path: "/v1/continue", description: "Continue uploaded audio preserving style and key", priceUsdc: 1 },
  stemsPro: { id: "stemsPro", method: "POST", path: "/v1/stems-pro", description: "4-track stem separation", priceUsdc: 1 },
  stems: { id: "stems", method: "POST", path: "/v1/stems", description: "2-track stem separation (vocals + instrumental)", priceUsdc: 0.5 },
  acapella: { id: "acapella", method: "POST", path: "/v1/acapella", description: "Isolate vocal stem (acapella)", priceUsdc: 0.5 },
  midi: { id: "midi", method: "POST", path: "/v1/midi", description: "Transcribe audio into a MIDI file", priceUsdc: 0.25 },
  mastering: { id: "mastering", method: "POST", path: "/v1/mastering", description: "Render a high-quality WAV master", priceUsdc: 0.25 },
  lyricSync: { id: "lyricSync", method: "POST", path: "/v1/lyric-sync", description: "Timestamped (synced) lyrics for a track", priceUsdc: 0.25 },
  lyrics: { id: "lyrics", method: "POST", path: "/v1/lyrics", description: "Fresh lyrics from a creative prompt", priceUsdc: 0.1 },
  styleCoach: { id: "styleCoach", method: "POST", path: "/v1/style-coach", description: "Expand a style-tag seed into a prompt-ready brief", priceUsdc: 0.05 },
  rigAnalyze: { id: "rigAnalyze", method: "POST", path: "/v1/rig/analyze", description: "Infer a guitar/bass signal chain from a clip", priceUsdc: 0.25 },
  rigOracle: { id: "rigOracle", method: "POST", path: "/v1/rig/oracle", description: "Recommend rig components for a tone goal", priceUsdc: 0.25 },
  rigRoast: { id: "rigRoast", method: "POST", path: "/v1/rig/roast", description: "Roast a declared gear list (entertainment)", priceUsdc: 0.15 },
  promptAnalyze: { id: "promptAnalyze", method: "POST", path: "/v1/prompt-analyze", description: "Analyze a prompt for genre, mood, structure", priceUsdc: 0.01 },
  chainChat: { id: "chainChat", method: "POST", path: "/v1/chain-chat", description: "Chat with the on-chain registry about provenance", priceUsdc: 0.05 },
} as const satisfies Record<string, SuedeEndpoint>;

export type SuedeEndpointId = keyof typeof SUEDE_ENDPOINTS;

/**
 * The only Suede gateway routes verified to return live x402 payment terms.
 * Rights lookup and analysis are internal operational profiles, not public App
 * offerings; the narrower public/discoverable allowlist follows this one.
 */
export const OPERATIONAL_SUEDE_ENDPOINT_IDS = [
  "generateSong",
  "generateVideo",
  "generateImage",
  "rightsLookup",
  "analyze",
] as const satisfies readonly SuedeEndpointId[];

export type OperationalSuedeEndpointId =
  (typeof OPERATIONAL_SUEDE_ENDPOINT_IDS)[number];

const OPERATIONAL_SUEDE_ENDPOINT_ID_SET: ReadonlySet<string> =
  new Set(OPERATIONAL_SUEDE_ENDPOINT_IDS);

export function isOperationalSuedeEndpointId(
  id: string,
): id is OperationalSuedeEndpointId {
  return OPERATIONAL_SUEDE_ENDPOINT_ID_SET.has(id);
}

/** The exact-three App offerings allowed in public marketing and discovery. */
export const PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS = [
  "generateSong",
  "generateVideo",
  "generateImage",
] as const satisfies readonly OperationalSuedeEndpointId[];

export type PublicDiscoverableSuedeEndpointId =
  (typeof PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS)[number];

const PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_ID_SET: ReadonlySet<string> =
  new Set(PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS);

export const PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS: readonly SuedeEndpoint[] =
  PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS.map((id) => SUEDE_ENDPOINTS[id]);

export function isPublicDiscoverableSuedeEndpointId(
  id: string,
): id is PublicDiscoverableSuedeEndpointId {
  return PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_ID_SET.has(id);
}
