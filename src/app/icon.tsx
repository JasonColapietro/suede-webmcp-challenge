import { ImageResponse } from "next/og";
import { BRAND_INK, BRAND_PRIMARY, BRAND_WHITE } from "@/lib/brand-colors";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 6,
        }}
      >
        <div
          style={{
            background: BRAND_PRIMARY,
            width: 26,
            height: 26,
            borderRadius: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              color: BRAND_WHITE,
              fontSize: 18,
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
