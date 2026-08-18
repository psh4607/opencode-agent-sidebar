export declare const TICK_INTERVAL_MS = 1000;
export declare const COMPLETION_RETENTION_MS = 3000;
export type AgentKind = "main" | "foreground" | "background";
export type AgentStatus = "queued" | "running" | "retrying" | "completed" | "error";
export type AgentEntry = {
    key: string;
    sessionID: string;
    kind: AgentKind;
    agent: string;
    description: string;
    status: AgentStatus;
    startedAt: number;
    completedAt?: number;
};
export type AgentCandidate = AgentEntry & {
    childSessionID?: string;
};
export type ChildReference = {
    id: string;
    kind: "session" | "legacy";
};
export type LegacyBackgroundUpdate = {
    status: "running" | "completed" | "error";
    description?: string;
};
type EventTime = {
    completed?: number;
};
type AssistantMessage = {
    role?: string;
    time?: EventTime;
    error?: unknown;
};
export declare function readString(value: unknown): string | undefined;
export declare function isAgentToolPart(type: string | undefined, tool: string | undefined): boolean;
export declare function isBackgroundInvocation(tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>): boolean;
export declare function resolveChildReference(input: Record<string, unknown>, metadata: Record<string, unknown>, output: string): ChildReference | undefined;
export declare function parseLegacyBackgroundUpdates(body: string): Array<[string, LegacyBackgroundUpdate]>;
export declare function resolveToolStatus(toolStatus: string | undefined, childStatus: "idle" | "busy" | "retry" | undefined, followChildAfterCompletion: boolean): AgentStatus | undefined;
export declare function resolveLegacyBackgroundStatus(status: AgentStatus, update: LegacyBackgroundUpdate | undefined, wasObservedLive: boolean): AgentStatus;
export declare function classifyChildCompletion(messages: ReadonlyArray<AssistantMessage>): {
    status: "completed" | "error";
    completedAt?: number;
};
export declare function isLive(status: AgentStatus): boolean;
export declare function isVisible(entry: AgentEntry, tick: number): boolean;
export declare function compareEntries(a: AgentEntry, b: AgentEntry): number;
export declare function deduplicateCandidates<Candidate extends AgentCandidate>(candidates: Candidate[]): Candidate[];
export declare function createLifecycleTracker(): {
    observe(entries: AgentEntry[], tick: number): void;
    wasObservedLive(key: string): boolean;
    startTime(key: string, status: AgentStatus, supplied: number | undefined, tick: number): number;
    retain(entry: AgentEntry, tick: number): boolean;
    cleanup(sessionID: string, seen: Set<string>): void;
    clear(): void;
};
export {};
//# sourceMappingURL=agent-sidebar-state.d.ts.map