import { ImageResponse } from "next/og";
import { BRAND_INK, BRAND_PRIMARY, BRAND_WHITE } from "@/lib/brand-colors";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: BRAND_INK,
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 36,
        }}
      >
        <div
          style={{
            background: BRAND_PRIMARY,
            width: 148,
            height: 148,
            borderRadius: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              color: BRAND_WHITE,
              fontSize: 100,
              fontWeight: 800,
              fontFamily: "system-ui",
              lineHeight: 1,
            }}
          >
            S
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
