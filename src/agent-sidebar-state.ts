export const TICK_INTERVAL_MS = 1_000;
export const COMPLETION_RETENTION_MS = 3_000;

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

type EventTime = { completed?: number };

type AssistantMessage = {
  role?: string;
  time?: EventTime;
  error?: unknown;
};

const BG_STATUS_PATTERN = /\[BACKGROUND TASK (COMPLETED|ERROR|TIMEOUT|CANCELLED|RETRYING)\]/;
const BG_ID_IN_TEXT_PATTERN = /\*\*ID:\*\*\s*`?(bg_[A-Za-z0-9]+)`?/;
const BG_ID_IN_OUTPUT_PATTERN = /Background Task ID:\s*(bg_[A-Za-z0-9]+)/;
const BG_ID_IN_METADATA_BLOCK_PATTERN = /background_task_id:\s*(bg_[A-Za-z0-9]+)/;
const DELEGATION_STARTED_PATTERN = /Delegation started:\s*([^\s]+)/;
const TASK_SUMMARY_LINE_PATTERN = /-\s+`(bg_[A-Za-z0-9]+)`:\s*([^\n]+)/g;

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isAgentToolPart(type: string | undefined, tool: string | undefined): boolean {
  return type === "tool" && (tool === "task" || tool === "delegate");
}

export function isBackgroundInvocation(
  tool: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  return (
    tool === "delegate" ||
    input.background === true ||
    input.run_in_background === true ||
    metadata.background === true
  );
}

export function resolveChildReference(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  output: string,
): ChildReference | undefined {
  const sessionID =
    readString(metadata.sessionId) ?? readString(metadata.jobId) ?? readString(input.task_id);
  if (sessionID) return { id: sessionID, kind: "session" };

  const legacyID =
    readString(metadata.backgroundTaskId) ??
    BG_ID_IN_METADATA_BLOCK_PATTERN.exec(output)?.[1] ??
    BG_ID_IN_OUTPUT_PATTERN.exec(output)?.[1] ??
    BG_ID_IN_TEXT_PATTERN.exec(output)?.[1] ??
    DELEGATION_STARTED_PATTERN.exec(output)?.[1];
  return legacyID ? { id: legacyID, kind: "legacy" } : undefined;
}

export function parseLegacyBackgroundUpdates(body: string): Array<[string, LegacyBackgroundUpdate]> {
  const updates: Array<[string, LegacyBackgroundUpdate]> = [];
  const statusMatch = BG_STATUS_PATTERN.exec(body);
  const singleID = BG_ID_IN_TEXT_PATTERN.exec(body)?.[1];

  if (statusMatch && singleID) {
    const statusText = statusMatch[1];
    const status =
      statusText === "COMPLETED"
        ? "completed"
        : statusText === "RETRYING"
          ? "running"
          : "error";
    updates.push([singleID, { status }]);
  }

  if (body.includes("[ALL BACKGROUND TASKS COMPLETE") || body.includes("[ALL BACKGROUND TASKS FINISHED")) {
    for (const match of body.matchAll(TASK_SUMMARY_LINE_PATTERN)) {
      const id = match[1];
      if (id) updates.push([id, { status: "completed", description: match[2] ?? "" }]);
    }
  }

  return updates;
}

export function resolveToolStatus(
  toolStatus: string | undefined,
  childStatus: "idle" | "busy" | "retry" | undefined,
  followChildAfterCompletion: boolean,
): AgentStatus | undefined {
  if (toolStatus === "pending") return "queued";
  if (toolStatus === "running") return childStatus === "retry" ? "retrying" : "running";
  if (toolStatus === "error") return "error";
  if (toolStatus !== "completed") return undefined;
  if (followChildAfterCompletion && childStatus === "busy") return "running";
  if (followChildAfterCompletion && childStatus === "retry") return "retrying";
  return "completed";
}

export function resolveLegacyBackgroundStatus(
  status: AgentStatus,
  update: LegacyBackgroundUpdate | undefined,
  wasObservedLive: boolean,
): AgentStatus {
  if (status !== "completed") return status;
  if (update?.status === "completed" || update?.status === "error") return update.status;
  return wasObservedLive ? "running" : "completed";
}

export function classifyChildCompletion(messages: ReadonlyArray<AssistantMessage>): {
  status: "completed" | "error";
  completedAt?: number;
} {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    status: assistant?.error === undefined ? "completed" : "error",
    completedAt: assistant?.time?.completed,
  };
}

export function isLive(status: AgentStatus): boolean {
  return status === "queued" || status === "running" || status === "retrying";
}

export function isVisible(entry: AgentEntry, tick: number): boolean {
  return (
    isLive(entry.status) ||
    (entry.completedAt !== undefined && tick - entry.completedAt <= COMPLETION_RETENTION_MS)
  );
}

export function compareEntries(a: AgentEntry, b: AgentEntry): number {
  if (a.kind === "main" && b.kind !== "main") return -1;
  if (a.kind !== "main" && b.kind === "main") return 1;
  if (isLive(a.status) && !isLive(b.status)) return -1;
  if (!isLive(a.status) && isLive(b.status)) return 1;
  return b.startedAt - a.startedAt;
}

export function deduplicateCandidates<Candidate extends AgentCandidate>(candidates: Candidate[]): Candidate[] {
  const entries: Candidate[] = [];
  const newestByChild = new Map<string, Candidate>();
  for (const entry of candidates) {
    if (!entry.childSessionID) {
      entries.push(entry);
      continue;
    }
    const previous = newestByChild.get(entry.childSessionID);
    if (!previous || entry.startedAt >= previous.startedAt) newestByChild.set(entry.childSessionID, entry);
  }
  entries.push(...newestByChild.values());
  return entries;
}

export function createLifecycleTracker() {
  const liveKeys = new Map<string, number>();
  const completionTimes = new Map<string, number>();
  const firstSeenTimes = new Map<string, number>();

  const wasRecentlyLive = (key: string, tick: number): boolean => {
    const lastObserved = liveKeys.get(key);
    return lastObserved !== undefined && tick - lastObserved <= TICK_INTERVAL_MS * 2;
  };

  return {
    observe(entries: AgentEntry[], tick: number): void {
      for (const entry of entries) {
        if (isLive(entry.status)) liveKeys.set(entry.key, tick);
      }
    },
    wasObservedLive(key: string): boolean {
      return liveKeys.has(key);
    },
    startTime(key: string, status: AgentStatus, supplied: number | undefined, tick: number): number {
      if (supplied !== undefined || status !== "queued") {
        firstSeenTimes.delete(key);
        return supplied ?? tick;
      }
      const startedAt = firstSeenTimes.get(key) ?? tick;
      firstSeenTimes.set(key, startedAt);
      return startedAt;
    },
    retain(entry: AgentEntry, tick: number): boolean {
      if (isLive(entry.status)) {
        entry.completedAt = undefined;
        liveKeys.set(entry.key, tick);
        completionTimes.delete(entry.key);
        return true;
      }

      let completedAt = completionTimes.get(entry.key) ?? entry.completedAt;
      if (wasRecentlyLive(entry.key, tick)) {
        completedAt = tick;
        completionTimes.set(entry.key, tick);
      }
      liveKeys.delete(entry.key);
      if (completedAt === undefined || tick - completedAt > COMPLETION_RETENTION_MS) {
        completionTimes.delete(entry.key);
        return false;
      }
      entry.completedAt = completedAt;
      return true;
    },
    cleanup(sessionID: string, seen: Set<string>): void {
      const prefix = `${sessionID}:`;
      for (const key of liveKeys.keys()) {
        if (key.startsWith(prefix) && !seen.has(key)) liveKeys.delete(key);
      }
      for (const key of completionTimes.keys()) {
        if (key.startsWith(prefix) && !seen.has(key)) completionTimes.delete(key);
      }
      for (const key of firstSeenTimes.keys()) {
        if (key.startsWith(prefix) && !seen.has(key)) firstSeenTimes.delete(key);
      }
    },
    clear(): void {
      liveKeys.clear();
      completionTimes.clear();
      firstSeenTimes.clear();
    },
  };
}
