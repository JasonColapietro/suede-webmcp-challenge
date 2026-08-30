import {
  SubflowCandidatePageSchema,
  SubflowResolveProjectionSchema,
  SubflowResolveRequestSchema,
  SubflowVersionPageSchema,
  type SubflowCandidate,
  type SubflowCandidatePage,
  type SubflowResolveProjection,
  type SubflowVersionPage,
} from "./subflow-api";
import type { SubflowReference } from "./types";

export type SubflowReferenceClientState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly lane: "candidates" | "versions" | "resolve" }
  | { readonly status: "ready"; readonly flows: readonly SubflowCandidate[]; readonly nextCursor?: string; readonly truncated: boolean }
  | { readonly status: "versions"; readonly versions: SubflowVersionPage["versions"]; readonly nextCursor?: string; readonly truncated: boolean }
  | { readonly status: "drift"; readonly projection: SubflowResolveProjection }
  | { readonly status: "resolved"; readonly projection: SubflowResolveProjection }
  | { readonly status: "error"; readonly lane: "candidates" | "versions" | "resolve"; readonly message: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CandidateRequest {
  readonly parentFlowId: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface VersionRequest {
  readonly parentFlowId: string;
  readonly childFlowId: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface ResolveRequest {
  readonly parentFlowId: string;
  readonly nodeId: string;
  readonly reference: SubflowReference;
  readonly signal?: AbortSignal;
}

export interface SubflowReferenceClient {
  candidates(input: CandidateRequest): Promise<SubflowCandidatePage>;
  versions(input: VersionRequest): Promise<SubflowVersionPage>;
  resolve(input: ResolveRequest): Promise<SubflowResolveProjection>;
}

export function pickerOptionIndex(
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  current: number,
  count: number,
): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (Math.max(current, -1) + 1) % count;
  return current <= 0 ? count - 1 : current - 1;
}


async function privateJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} unavailable`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid ${label} response`);
  }
}

function parseStrict<T>(parse: (value: unknown) => T, value: unknown, label: string): T {
  try {
    return parse(value);
  } catch {
    throw new Error(`Invalid ${label} response`);
  }
}

export function createSubflowReferenceClient(
  fetcher: FetchLike = fetch,
): SubflowReferenceClient {
  return {
    async candidates(input) {
      const query = new URLSearchParams({
        parentFlowId: input.parentFlowId,
        query: input.query,
        limit: String(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const response = await fetcher(`/api/v2/subflows/candidates?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: input.signal,
      });
      return parseStrict(
        (value) => SubflowCandidatePageSchema.parse(value),
        await privateJson(response, "subflow candidates"),
        "subflow candidates",
      );
    },
    async versions(input) {
      const query = new URLSearchParams({
        parentFlowId: input.parentFlowId,
        childFlowId: input.childFlowId,
        limit: String(input.limit),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const response = await fetcher(`/api/v2/subflows/versions?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: input.signal,
      });
      return parseStrict(
        (value) => SubflowVersionPageSchema.parse(value),
        await privateJson(response, "subflow versions"),
        "subflow versions",
      );
    },
    async resolve(input) {
      const request = SubflowResolveRequestSchema.parse({
        parentFlowId: input.parentFlowId,
        nodeId: input.nodeId,
        reference: input.reference,
      });
      const response = await fetcher("/api/v2/subflows/resolve", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: input.signal,
      });
      return parseStrict(
        (value) => SubflowResolveProjectionSchema.parse(value),
        await privateJson(response, "subflow resolution"),
        "subflow resolution",
      );
    },
  };
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class SubflowReferenceController {
  private state: SubflowReferenceClientState = { status: "idle" };
  private candidateController: AbortController | null = null;
  private versionController: AbortController | null = null;
  private resolveController: AbortController | null = null;
  private candidateToken = 0;
  private versionToken = 0;
  private resolveToken = 0;
  private generation = 0;

  constructor(
    private readonly client: SubflowReferenceClient,
    private readonly onState: (state: SubflowReferenceClientState) => void,
    private readonly onResolved: (projection: SubflowResolveProjection) => void = () => undefined,
  ) {}

  getState(): SubflowReferenceClientState {
    return this.state;
  }

  dispose(): void {
    this.generation += 1;
    this.abortAll();
  }

  private abortAll(): void {
    this.candidateController?.abort();
    this.versionController?.abort();
    this.resolveController?.abort();
    this.candidateController = null;
    this.versionController = null;
    this.resolveController = null;
  }

  private publish(state: SubflowReferenceClientState): void {
    this.state = state;
    this.onState(state);
  }

  async searchCandidates(input: {
    readonly parentFlowId: string;
    readonly query: string;
    readonly cursor?: string;
  }): Promise<void> {
    this.abortAll();
    const controller = new AbortController();
    this.candidateController = controller;
    const token = ++this.candidateToken;
    const generation = ++this.generation;
    const previous = input.cursor !== undefined && this.state.status === "ready"
      ? this.state.flows
      : [];
    this.publish({ status: "loading", lane: "candidates" });
    try {
      const page = await this.client.candidates({ ...input, limit: 20, signal: controller.signal });
      if (generation !== this.generation || token !== this.candidateToken || controller.signal.aborted) return;
      const flows = [...previous, ...page.flows].filter((flow, index, values) =>
        values.findIndex((candidate) => candidate.flowId === flow.flowId) === index);
      this.publish({
        status: "ready",
        flows,
        truncated: page.truncated,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    } catch (error) {
      if (generation !== this.generation || token !== this.candidateToken || controller.signal.aborted || aborted(error)) return;
      this.publish({ status: "error", lane: "candidates", message: "Flow choices unavailable. Try again." });
    }
  }

  async loadVersions(input: {
    readonly parentFlowId: string;
    readonly childFlowId: string;
    readonly cursor?: string;
  }): Promise<void> {
    this.abortAll();
    const controller = new AbortController();
    this.versionController = controller;
    const token = ++this.versionToken;
    const generation = ++this.generation;
    const previous = input.cursor !== undefined && this.state.status === "versions"
      ? this.state.versions
      : [];
    this.publish({ status: "loading", lane: "versions" });
    try {
      const page = await this.client.versions({ ...input, limit: 20, signal: controller.signal });
      if (generation !== this.generation || token !== this.versionToken || controller.signal.aborted) return;
      const versions = [...previous, ...page.versions].filter((version, index, values) =>
        values.findIndex((candidate) => candidate.versionId === version.versionId) === index);
      this.publish({
        status: "versions",
        versions,
        truncated: page.truncated,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    } catch (error) {
      if (generation !== this.generation || token !== this.versionToken || controller.signal.aborted || aborted(error)) return;
      this.publish({ status: "error", lane: "versions", message: "Versions unavailable. Try again." });
    }
  }

  async resolve(input: ResolveRequest): Promise<void> {
    this.abortAll();
    const controller = new AbortController();
    this.resolveController = controller;
    const token = ++this.resolveToken;
    const generation = ++this.generation;
    this.publish({ status: "loading", lane: "resolve" });
    try {
      const projection = await this.client.resolve({ ...input, signal: controller.signal });
      if (generation !== this.generation || token !== this.resolveToken || controller.signal.aborted) return;
      if (projection.issues.length > 0) {
        this.publish({ status: "drift", projection });
        return;
      }
      this.publish({ status: "resolved", projection });
      this.onResolved(projection);
    } catch (error) {
      if (generation !== this.generation || token !== this.resolveToken || controller.signal.aborted || aborted(error)) return;
      this.publish({ status: "error", lane: "resolve", message: "Reference could not be verified. Try again." });
    }
  }
}
