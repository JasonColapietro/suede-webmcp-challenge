import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createLocalMemory } from "../src/memory.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kit-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createLocalMemory", () => {
  it("returns undefined for a key that was never set", async () => {
    const mem = createLocalMemory(tmpDir);
    const val = await mem.get<string>("missing-key");
    expect(val).toBeUndefined();
  });

  it("persists a value and retrieves it", async () => {
    const mem = createLocalMemory(tmpDir);
    await mem.set("lastPrice", 42.5);
    const val = await mem.get<number>("lastPrice");
    expect(val).toBe(42.5);
  });

  it("overwrites an existing value", async () => {
    const mem = createLocalMemory(tmpDir);
    await mem.set("key", "first");
    await mem.set("key", "second");
    expect(await mem.get<string>("key")).toBe("second");
  });

  it("stores multiple keys independently", async () => {
    const mem = createLocalMemory(tmpDir);
    await mem.set("a", 1);
    await mem.set("b", 2);
    expect(await mem.get<number>("a")).toBe(1);
    expect(await mem.get<number>("b")).toBe(2);
  });

  it("persists across separate createLocalMemory instances (same dir)", async () => {
    const mem1 = createLocalMemory(tmpDir);
    await mem1.set("persisted", true);

    const mem2 = createLocalMemory(tmpDir);
    expect(await mem2.get<boolean>("persisted")).toBe(true);
  });

  it("writes to .suede/memory.json inside the given dir", async () => {
    const mem = createLocalMemory(tmpDir);
    await mem.set("x", 99);
    const file = path.join(tmpDir, ".suede", "memory.json");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("handles complex object values", async () => {
    const mem = createLocalMemory(tmpDir);
    await mem.set("obj", { price: 1.5, items: ["a", "b"] });
    const val = await mem.get<{ price: number; items: string[] }>("obj");
    expect(val?.price).toBe(1.5);
    expect(val?.items).toEqual(["a", "b"]);
  });
});
