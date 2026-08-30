/**
 * Core type definitions for the @suedeai/agents SDK.
 * Shape is frozen in Phase 6 — downstream (codegen, CLI, relay) depend on it.
 */
export interface AgentMemory {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
}
export interface AgentContext {
    input: unknown;
    memory: AgentMemory;
    trigger: "manual" | "schedule" | "paidCall" | "webhook";
}
export interface AgentDefinition {
    name: string;
    description?: string;
    triggers: Trigger[];
    run(ctx: AgentContext): Promise<unknown>;
}
export type Trigger = {
    kind: "manual";
} | {
    kind: "schedule";
    cron: string;
} | {
    kind: "paidCall";
    priceUsdc: number;
} | {
    kind: "webhook";
};
//# sourceMappingURL=types.d.ts.map