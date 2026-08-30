import { describe, expect, it } from "vitest";
import { applyJsonPatchWithInverse } from "@/lib/flow/json-patch";

describe("restricted immutable JSON Patch", () => {
  it("applies object add, replace, and remove with an exact inverse", () => {
    const source = { prompt: "old", nested: { count: 1 }, stable: true };
    const result = applyJsonPatchWithInverse(source, [
      { op: "replace", path: "/prompt", value: "new" },
      { op: "remove", path: "/nested/count" },
      { op: "add", path: "/created", value: { ok: true } },
    ]);

    expect(result.value).toEqual({ prompt: "new", nested: {}, stable: true, created: { ok: true } });
    expect(source).toEqual({ prompt: "old", nested: { count: 1 }, stable: true });
    expect(applyJsonPatchWithInverse(result.value, result.inverse).value).toEqual(source);
  });

  it("supports escaped object keys and array insertion, append, replace, and removal", () => {
    const source = { "a/b": { "~key": 1 }, items: ["a", "c"] };
    const result = applyJsonPatchWithInverse(source, [
      { op: "replace", path: "/a~1b/~0key", value: 2 },
      { op: "add", path: "/items/1", value: "b" },
      { op: "add", path: "/items/-", value: "d" },
      { op: "remove", path: "/items/0" },
    ]);

    expect(result.value).toEqual({ "a/b": { "~key": 2 }, items: ["b", "c", "d"] });
    expect(applyJsonPatchWithInverse(result.value, result.inverse).value).toEqual(source);
  });

  it("does not retain aliases to patch values", () => {
    const inserted = { nested: [1, 2] };
    const result = applyJsonPatchWithInverse({}, [{ op: "add", path: "/value", value: inserted }]);
    inserted.nested.push(3);
    expect(result.value).toEqual({ value: { nested: [1, 2] } });
  });

  it.each([
    [{ op: "replace", path: "", value: {} }],
    [{ op: "add", path: "/__proto__/polluted", value: true }],
    [{ op: "add", path: "/constructor/polluted", value: true }],
    [{ op: "add", path: "/prototype/polluted", value: true }],
    [{ op: "replace", path: "/missing", value: true }],
    [{ op: "remove", path: "/missing" }],
    [{ op: "add", path: "/items/3", value: "sparse" }],
    [{ op: "replace", path: "/items/-", value: "bad" }],
    [{ op: "add", path: "/bad~2escape", value: true }],
  ])("rejects unsafe or invalid operation %#", (patch) => {
    expect(() => applyJsonPatchWithInverse({ items: ["a"] }, patch as never)).toThrow();
  });

  it("rejects non-JSON source and values", () => {
    expect(() => applyJsonPatchWithInverse({ value: Number.NaN }, [])).toThrow(/json|finite/i);
    expect(() => applyJsonPatchWithInverse({}, [{ op: "add", path: "/value", value: undefined }] as never)).toThrow(/json/i);
  });

  it("rejects mutation of node identity paths by contract callers", () => {
    for (const path of ["/id", "/type", "/position"]) {
      expect(() => applyJsonPatchWithInverse({}, [{ op: "add", path, value: "blocked" }], { forbiddenRootKeys: ["id", "type", "position"] })).toThrow(/forbidden/i);
    }
  });
});
