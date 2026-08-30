import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ArtifactDownloadButton from "@/components/runs/ArtifactDownloadButton";
import { artifactDescriptor } from "@/lib/artifacts/download";

const PDF = Buffer.from("%PDF-1.7\nsmall test artifact", "utf8").toString("base64");
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]).toString("base64");

describe("ArtifactDownloadButton", () => {
  it("finds a nested allowed artifact and renders an explicit download control", () => {
    const output = { result: { fileBase64: PDF, fileName: "report.pdf", mimeType: "application/pdf" } };
    expect(artifactDescriptor(output)).toMatchObject({ fileName: "report.pdf", mimeType: "application/pdf" });
    const markup = renderToStaticMarkup(<ArtifactDownloadButton artifact={artifactDescriptor(output)} />);
    expect(markup).toContain("Download report.pdf");
    expect(markup).not.toContain(PDF);
  });

  it("refuses arbitrary MIME types, invalid base64, and unsafe empty filenames", () => {
    expect(artifactDescriptor({ fileBase64: PDF, fileName: "page.html", mimeType: "text/html" })).toBeNull();
    expect(artifactDescriptor({ fileBase64: "not-base64", fileName: "report.pdf", mimeType: "application/pdf" })).toBeNull();
    expect(artifactDescriptor({ fileBase64: PDF, fileName: "   ", mimeType: "application/pdf" })).toBeNull();
    expect(artifactDescriptor({ fileBase64: PDF, fileName: "report.xlsx", mimeType: "application/pdf" })).toBeNull();
    expect(artifactDescriptor({ fileBase64: Buffer.from("<html>not a pdf</html>").toString("base64"), fileName: "report.pdf", mimeType: "application/pdf" })).toBeNull();
  });

  it("sanitizes filesystem punctuation from filenames", () => {
    expect(artifactDescriptor({ fileBase64: PDF, fileName: "quarter:report?.pdf", mimeType: "application/pdf" })?.fileName)
      .toBe("quarter-report-.pdf");
  });

  it("accepts an XLSX ZIP signature only with the XLSX MIME and extension", () => {
    expect(artifactDescriptor({
      fileBase64: XLSX,
      fileName: "data.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).toMatchObject({ fileName: "data.xlsx" });
    expect(artifactDescriptor({ fileBase64: XLSX, fileName: "data.pdf", mimeType: "application/pdf" })).toBeNull();
  });
});
