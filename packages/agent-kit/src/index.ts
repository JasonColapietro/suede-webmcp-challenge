/**
 * @suedeai/agents — Suede SDK v0
 *
 * Define, trigger, serve, and earn with agents on the Suede platform.
 * https://agents.suedeai.ai
 */

export { defineAgent } from "./define.js";
export { schedule, paidCall, manual, webhook } from "./triggers.js";
export { suede, GatewayError } from "./gateway.js";
export { createLocalMemory } from "./memory.js";
export { serve } from "./serve.js";
export {
  SUPPORTED_FLOW_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  VERSION_DEPENDENCY_KINDS,
  VersionClientError,
  createVersionBundle,
  createVersionClient,
} from "./version-client.js";
export type { AgentContext, AgentDefinition, AgentMemory, Trigger } from "./types.js";
export type { LlmInput, LlmResult, RunResult } from "./gateway.js";
export type { ServeOptions, ServeHandle } from "./serve.js";
export type {
  FlowVersionRecord,
  FlowVersionSummary,
  PortableDependencyPin,
  VersionBundle,
  VersionClient,
  VersionClientErrorKind,
  VersionClientOptions,
  VersionDependencyKind,
  VersionEnvelope,
  VersionsEnvelope,
} from "./version-client.js";
