import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

interface ManifestAsset {
  readonly sourceFilename: string;
  readonly publicPath: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly mimeType: "image/jpeg";
  readonly exportedAt: string;
  readonly role: string;
}

interface AssetManifest {
  readonly sourceManifest: string;
  readonly sourcePolicy: "preserved-originals-only";
  readonly assets: readonly ManifestAsset[];
}

const EXPECTED = [
  {
    sourceFilename: "Company as Software hero.jpg",
    publicPath: "/creative/editorial-proof/company-as-software.jpg",
    sha256: "5341bfd2c73648d2ff686a2ee6623cd8d93144300961d715ef8ce071e8fd6478",
    width: 1200,
    height: 630,
    bytes: 66837,
  },
  {
    sourceFilename: "Seat to flow to service.jpg",
    publicPath: "/creative/editorial-proof/seat-flow-service.jpg",
    sha256: "d61c6d5696ee06d90b33b75b265cc79ef65421a206e1aa47f4e2bef5c04062d6",
    width: 1200,
    height: 630,
    bytes: 79380,
  },
  {
    sourceFilename: "Website to grounded service.jpg",
    publicPath: "/creative/editorial-proof/website-grounded-service.jpg",
    sha256: "8ae2fdc4d137e71609c3bef0d7da9b7fa4aa0fb901748b2dafa4567e5bd7a9f3",
    width: 1200,
    height: 630,
    bytes: 71608,
  },
  {
    sourceFilename: "Verified product inventory.jpg",
    publicPath: "/creative/editorial-proof/verified-product-inventory.jpg",
    sha256: "8c9a7d26aeb8233f319374b1cd0e8901a447f2fc61e79d8dbc9c56dc0cbb4ccf",
    width: 1200,
    height: 630,
    bytes: 51607,
  },
  {
    sourceFilename: "Draft to Live control.jpg",
    publicPath: "/creative/editorial-proof/draft-live-control.jpg",
    sha256: "9b05db847e6704bd77cbf7d4615d250e27e6a8b589927e8ccb1d14178c8518d1",
    width: 1200,
    height: 630,
    bytes: 73984,
  },
  {
    sourceFilename: "Staff the company. Sell the work.jpg",
    publicPath: "/creative/editorial-proof/staff-company-sell-work.jpg",
    sha256: "1d4f78f566204415eea1ac9faa9414eece0c7eb67f4cffd954b8c0c954d60272",
    width: 1080,
    height: 1080,
    bytes: 72700,
  },
] as const;

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (SOF_MARKERS.has(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }

  throw new Error("JPEG dimensions not found");
}

describe("editorial proof asset bundle", () => {
  test("ships the six authoritative export bytes with exact provenance and dimensions", () => {
    const manifestPath = resolve(process.cwd(), "public/creative/editorial-proof/manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    if (!existsSync(manifestPath)) return;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AssetManifest;
    expect(manifest.sourcePolicy).toBe("preserved-originals-only");
    expect(manifest.assets).toHaveLength(6);
    expect(new Set(manifest.assets.map((asset) => asset.publicPath)).size).toBe(6);

    for (const expected of EXPECTED) {
      const asset = manifest.assets.find((candidate) => candidate.publicPath === expected.publicPath);
      expect(asset).toMatchObject({
        ...expected,
        mimeType: "image/jpeg",
        exportedAt: "2026-07-28T09:06:17Z",
      });
      expect(asset?.role.trim().length).toBeGreaterThan(0);

      const assetPath = resolve(process.cwd(), `public${expected.publicPath}`);
      expect(existsSync(assetPath)).toBe(true);
      if (!existsSync(assetPath)) continue;
      const bytes = readFileSync(assetPath);
      expect(bytes.byteLength).toBe(expected.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
      expect(jpegDimensions(bytes)).toEqual({ width: expected.width, height: expected.height });
    }
  });
});

