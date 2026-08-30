/**
 * Scoped retrieval over a small, in-run set of documents: no vector database,
 * no embedding model, no network call. Chunks each document by word count and
 * ranks chunks against the query with TF-IDF cosine similarity — a
 * dependency-light stand-in for a knowledge base, local computation only, so
 * it carries the same "direct" replay-safe classification as extractText and
 * extractDocx (see admission.ts's DURABLE_NODE_ADMISSION).
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage } from "../_util";

const documentSchema = z.object({
  id: z.string().optional(),
  text: z.string(),
});

export const knowledgeSearchParamsSchema = z.object({
  query: z.string().optional(),
  documents: z.array(documentSchema).optional(),
  topK: z.number().int().positive().max(20).optional(),
  chunkWords: z.number().int().positive().max(2000).optional(),
});

export type KnowledgeSearchParams = z.infer<typeof knowledgeSearchParamsSchema>;
export type KnowledgeDocument = z.infer<typeof documentSchema>;

export const DEFAULT_TOP_K = 3;
export const DEFAULT_CHUNK_WORDS = 150;
/** Generous for a "small set of documents"; bounded against CPU/memory abuse. */
export const MAX_TOTAL_CHARS = 2_000_000;
export const MAX_DOCUMENTS = 25;

export interface KnowledgeMatch {
  readonly text: string;
  readonly score: number;
  readonly documentIndex: number;
  readonly chunkIndex: number;
  readonly documentId?: string;
}

/** Reads documents from an upstream value shaped like a raw string, an
 * extractText/extractDocx-style `{ text }` object, or an array of either
 * (e.g. a loop node's aggregated results over several extract nodes). */
export function normalizeUpstreamDocuments(value: unknown): KnowledgeDocument[] {
  if (typeof value === "string") return value.trim() ? [{ text: value }] : [];
  if (Array.isArray(value)) return value.flatMap((item) => normalizeUpstreamDocuments(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.trim()
        ? [{ ...(typeof record.id === "string" ? { id: record.id } : {}), text: record.text }]
        : [];
    }
  }
  return [];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function termFrequency(terms: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  return tf;
}

function cosineSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  for (const [term, weight] of a) {
    const other = b.get(term);
    if (other) dot += weight * other;
  }
  const norm = (vector: ReadonlyMap<string, number>) =>
    Math.sqrt([...vector.values()].reduce((sum, weight) => sum + weight * weight, 0));
  const normA = norm(a);
  const normB = norm(b);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

interface Chunk {
  readonly documentId?: string;
  readonly documentIndex: number;
  readonly chunkIndex: number;
  readonly text: string;
  readonly terms: readonly string[];
}

function chunkDocument(doc: KnowledgeDocument, documentIndex: number, chunkWords: number): Chunk[] {
  const words = doc.text.match(/\S+/g) ?? [];
  const chunks: Chunk[] = [];
  for (let start = 0, chunkIndex = 0; start < words.length; start += chunkWords, chunkIndex += 1) {
    const text = words.slice(start, start + chunkWords).join(" ");
    chunks.push({
      ...(doc.id !== undefined ? { documentId: doc.id } : {}),
      documentIndex,
      chunkIndex,
      text,
      terms: tokenize(text),
    });
  }
  return chunks;
}

/** Ranks document chunks against a query via TF-IDF cosine similarity. Pure and deterministic. */
export function rankKnowledgeChunks(
  documents: readonly KnowledgeDocument[],
  query: string,
  topK: number,
  chunkWords: number,
): KnowledgeMatch[] {
  const chunks = documents.flatMap((doc, documentIndex) => chunkDocument(doc, documentIndex, chunkWords));
  if (chunks.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const chunk of chunks) {
    for (const term of new Set(chunk.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const totalChunks = chunks.length;
  const idf = (term: string): number => Math.log(totalChunks / (1 + (documentFrequency.get(term) ?? 0))) + 1;

  const queryVector = new Map<string, number>();
  for (const [term, freq] of termFrequency(tokenize(query))) queryVector.set(term, freq * idf(term));

  const scored: KnowledgeMatch[] = chunks.map((chunk) => {
    const chunkVector = new Map<string, number>();
    for (const [term, freq] of termFrequency(chunk.terms)) chunkVector.set(term, freq * idf(term));
    return {
      ...(chunk.documentId !== undefined ? { documentId: chunk.documentId } : {}),
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunkVector),
      documentIndex: chunk.documentIndex,
      chunkIndex: chunk.chunkIndex,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.chunkIndex - b.chunkIndex)
    .slice(0, topK);
}

export const createKnowledgeSearchExecutor = (): NodeExecutor => async (_ctx, rawParams, inputs) => {
  let params: KnowledgeSearchParams;
  try {
    params = knowledgeSearchParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }

  const query = params.query?.trim();
  if (!query) {
    return { ok: false, error: "query is required", costUsdc: 0 };
  }

  const documents = params.documents && params.documents.length > 0
    ? params.documents
    : normalizeUpstreamDocuments(inputs.in);

  if (documents.length === 0) {
    return { ok: false, error: "documents is required (or an upstream document/array of documents)", costUsdc: 0 };
  }
  if (documents.length > MAX_DOCUMENTS) {
    return { ok: false, error: `Documents exceed the ${MAX_DOCUMENTS}-document cap`, costUsdc: 0 };
  }
  const totalChars = documents.reduce((sum, doc) => sum + doc.text.length, 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return { ok: false, error: `Documents exceed the ${MAX_TOTAL_CHARS}-character cap`, costUsdc: 0 };
  }

  const matches = rankKnowledgeChunks(
    documents,
    query,
    params.topK ?? DEFAULT_TOP_K,
    params.chunkWords ?? DEFAULT_CHUNK_WORDS,
  );

  return { ok: true, outputs: { result: { matches } }, costUsdc: 0 };
};

export const knowledgeSearchNode = defineExecutableNode(getNodeDefinition("docs.knowledgeSearch"), {
  paramsSchema: knowledgeSearchParamsSchema,
  executor: createKnowledgeSearchExecutor(),
});
