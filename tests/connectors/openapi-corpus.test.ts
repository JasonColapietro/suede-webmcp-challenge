import { describe, expect, it } from "vitest";
import basic from "../fixtures/openapi/supported-basic.json";
import apiKey from "../fixtures/openapi/supported-api-key.json";
import oauth from "../fixtures/openapi/refused-oauth.json";
import remoteRef from "../fixtures/openapi/refused-remote-ref.json";
import bearer from "../fixtures/openapi/supported-bearer.json";
import basicAuth from "../fixtures/openapi/supported-basic-auth.json";
import noContent from "../fixtures/openapi/supported-204.json";
import privateOrigin from "../fixtures/openapi/refused-private-origin.json";
import multipart from "../fixtures/openapi/refused-multipart.json";
import multiSuccess from "../fixtures/openapi/refused-multi-success.json";
import polymorphism from "../fixtures/openapi/refused-polymorphism.json";
import { compileOpenApi310 } from "@/lib/connectors/openapi/compile";

const CORPUS_VERSION = "openapi-compiler-corpus-v1";

describe(CORPUS_VERSION, () => {
  it("records representative supported and refused operations without parity claims", () => {
    const records = [
      ["basic", basic, "supported"],
      ["api-key-local-ref", apiKey, "supported"],
      ["oauth", oauth, "SECURITY_REFUSED"],
      ["remote-ref", remoteRef, "REMOTE_REFERENCE_REFUSED"],
      ["bearer", bearer, "supported"],
      ["basic", basicAuth, "supported"],
      ["204", noContent, "supported"],
      ["private-origin", privateOrigin, "SERVER_ORIGIN_REFUSED"],
      ["multipart", multipart, "REQUEST_BODY_REFUSED"],
      ["multi-success", multiSuccess, "RESPONSE_SELECTION_REFUSED"],
      ["polymorphism", polymorphism, "SCHEMA_KEYWORD_REFUSED"],
    ] as const;

    expect(records.map(([name, fixture, expected]) => {
      const result = compileOpenApi310(JSON.stringify(fixture));
      return [name, result.ok ? "supported" : result.code, expected];
    })).toEqual(records.map(([name, , expected]) => [name, expected, expected]));
  });
});
