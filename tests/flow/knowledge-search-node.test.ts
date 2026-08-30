import { describe, expect, it } from "vitest";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { NODE_META } from "@/lib/flow/node-meta";
import { DURABLE_NODE_ADMISSION } from "@/lib/runtime/admission";
import {
  createKnowledgeSearchExecutor,
  rankKnowledgeChunks,
} from "@/lib/flow/nodes/docs/knowledgeSearch";
import { makeCtx } from "../_helpers";

describe("docs.knowledgeSearch registration", () => {
  it("is registered in the server executor list, client-safe meta, and durable admission", () => {
    expect(NODE_DEFS.some((d) => d.type === "docs.knowledgeSearch")).toBe(true);
    expect(NODE_META.some((m) => m.type === "docs.knowledgeSearch")).toBe(true);
    expect(DURABLE_NODE_ADMISSION["docs.knowledgeSearch"]).toBe("direct");
  });
});

describe("rankKnowledgeChunks", () => {
  it("ranks a chunk sharing the query's vocabulary above an unrelated chunk", () => {
    const matches = rankKnowledgeChunks(
      [
        { text: "The refund policy allows returns within thirty days of purchase." },
        { text: "Our office is located near the river with a view of the mountains." },
      ],
      "refund policy returns",
      5,
      100,
    );

    expect(matches[0]?.text).toContain("refund policy");
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("scores an exact vocabulary match higher than a disjoint one", () => {
    const [same, disjoint] = rankKnowledgeChunks(
      [
        { text: "alpha beta gamma" },
        { text: "delta epsilon zeta" },
      ],
      "alpha beta gamma",
      5,
      100,
    ).sort((a, b) => a.documentIndex - b.documentIndex);

    expect(same!.score).toBeGreaterThan(disjoint!.score);
    expect(disjoint!.score).toBe(0);
  });

  it("splits one long document into multiple chunks and honors topK", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const matches = rankKnowledgeChunks([{ text: `${words} ${words} ${words}` }], "word5", 2, 20);

    expect(matches.length).toBe(2);
    expect(new Set(matches.map((m) => m.chunkIndex)).size).toBe(matches.length);
  });

  it("returns no matches for empty documents", () => {
    expect(rankKnowledgeChunks([], "anything", 3, 100)).toEqual([]);
    expect(rankKnowledgeChunks([{ text: "   " }], "anything", 3, 100)).toEqual([]);
  });
});

describe("createKnowledgeSearchExecutor", () => {
  it("requires a query", async () => {
    const executor = createKnowledgeSearchExecutor();
    const res = await executor(makeCtx(), { documents: [{ text: "some text" }] }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("query");
  });

  it("requires documents from params or upstream", async () => {
    const executor = createKnowledgeSearchExecutor();
    const res = await executor(makeCtx(), { query: "hello" }, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("documents");
  });

  it("searches configured documents and returns ranked matches", async () => {
    const executor = createKnowledgeSearchExecutor();
    const res = await executor(makeCtx(), {
      query: "refund policy",
      documents: [
        { id: "doc-a", text: "The refund policy allows returns within thirty days." },
        { id: "doc-b", text: "Our office is located near the river." },
      ],
      topK: 1,
    }, {});

    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { matches: Array<{ text: string; documentId?: string; score: number }> };
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.documentId).toBe("doc-a");
    }
  });

  it("falls back to a single upstream document shaped like extractText/extractDocx output", async () => {
    const executor = createKnowledgeSearchExecutor();
    const res = await executor(makeCtx(), { query: "invoice total" }, {
      in: { text: "The invoice total is due within thirty days of receipt." },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { matches: Array<{ text: string }> };
      expect(result.matches.length).toBeGreaterThan(0);
    }
  });

  it("accepts an upstream array of extracted documents (e.g. from a loop over extract nodes)", async () => {
    const executor = createKnowledgeSearchExecutor();
    const res = await executor(makeCtx(), { query: "mountains" }, {
      in: [
        { text: "The refund policy allows returns within thirty days." },
        { text: "Our office has a view of the mountains and the river." },
      ],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.outputs.result as { matches: Array<{ text: string; documentIndex: number }> };
      expect(result.matches[0]?.text).toContain("mountains");
      expect(result.matches[0]?.documentIndex).toBe(1);
    }
  });

  it("rejects documents exceeding the total character cap", async () => {
    const executor = createKnowledgeSearchExecutor();
    const huge = "a".repeat(2_000_001);
    const res = await executor(makeCtx(), { query: "a", documents: [{ text: huge }] }, {});
    expect(res.ok).toBe(false);
  });
});
