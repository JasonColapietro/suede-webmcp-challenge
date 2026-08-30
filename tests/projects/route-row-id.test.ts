import { describe, expect, it } from "vitest";
import { decodeRouteRowId } from "@/lib/projects/route-row-id";

describe("route row ID decoding", () => {
  it("decodes exactly the one URL-segment layer supplied by Next navigation", () => {
    expect(decodeRouteRowId("flow%3Aopaque-row%40v2")).toBe("flow:opaque-row@v2");
    expect(decodeRouteRowId("literal%253Avalue")).toBe("literal%3Avalue");
    expect(decodeRouteRowId("ordinary-row-id")).toBe("ordinary-row-id");
  });

  it("fails closed to the original row ID when percent syntax is malformed", () => {
    expect(decodeRouteRowId("literal%value")).toBe("literal%value");
    expect(decodeRouteRowId("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
