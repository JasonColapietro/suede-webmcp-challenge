import { describe, expect, it } from "vitest";
import {
  OPERATIONAL_SUEDE_ENDPOINT_IDS,
  PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS,
  PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS,
  SUEDE_ENDPOINTS,
} from "@/lib/rails/suede-endpoints";
import { isPublicEndpointMarketingAllowed } from "@/lib/marketing-holds";

describe("Suede gateway profiles", () => {
  it("pins compatibility defaults without treating them as public inventory", () => {
    expect(
      Object.fromEntries(
        Object.values(SUEDE_ENDPOINTS).map((endpoint) => [
          endpoint.path,
          endpoint.priceUsdc,
        ]),
      ),
    ).toEqual({
      "/create-music": 0.5,
      "/agent/video": 4.99,
      "/agent/image": 0.15,
      "/v1/rights": 0.015,
      "/v1/analyze": 0.01,
      "/v1/extend": 1,
      "/v1/cover": 1,
      "/v1/vox": 1,
      "/v1/continue": 1,
      "/v1/stems-pro": 1,
      "/v1/stems": 0.5,
      "/v1/acapella": 0.5,
      "/v1/midi": 0.25,
      "/v1/mastering": 0.25,
      "/v1/lyric-sync": 0.25,
      "/v1/lyrics": 0.1,
      "/v1/style-coach": 0.05,
      "/v1/rig/analyze": 0.25,
      "/v1/rig/oracle": 0.25,
      "/v1/rig/roast": 0.15,
      "/v1/prompt-analyze": 0.01,
      "/v1/chain-chat": 0.05,
    });
  });

  it("separates five operational profiles from the exact-three public catalog", () => {
    expect(OPERATIONAL_SUEDE_ENDPOINT_IDS).toEqual([
      "generateSong",
      "generateVideo",
      "generateImage",
      "rightsLookup",
      "analyze",
    ]);
    expect(PUBLIC_DISCOVERABLE_SUEDE_ENDPOINT_IDS).toEqual([
      "generateSong",
      "generateVideo",
      "generateImage",
    ]);
    expect(
      PUBLIC_DISCOVERABLE_SUEDE_ENDPOINTS.map(({ path, priceUsdc }) => [
        path,
        priceUsdc,
      ]),
    ).toEqual([
      ["/create-music", 0.5],
      ["/agent/video", 4.99],
      ["/agent/image", 0.15],
    ]);
  });

  it("never markets internal or compatibility profiles as public routes", () => {
    expect(isPublicEndpointMarketingAllowed("rightsLookup")).toBe(false);
    expect(isPublicEndpointMarketingAllowed("analyze")).toBe(false);
    expect(isPublicEndpointMarketingAllowed("chainChat")).toBe(false);
    expect(isPublicEndpointMarketingAllowed("stems")).toBe(false);
    expect(isPublicEndpointMarketingAllowed("not-a-profile")).toBe(false);
  });
});
