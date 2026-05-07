import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createUpdateNotifier, type UpdateStatus } from "./update-notifier.js";

const PLUGIN_ID = "subagent-sidebar";
const PLUGIN_VERSION = "0.2.0";
const SIDEBAR_ORDER = 200;
const TICK_INTERVAL_MS = 1000;
const COMPLETION_RETENTION_MS = 10_000;
const DESCRIPTION_MAX_LEN = 26;
const COLLAPSED_KV_KEY = "agents-panel.collapsed";

type AgentKind = "main" | "foreground" | "background";
type AgentStatus = "queued" | "running" | "completed" | "error";

type AgentEntry = {
  key: string;
  sessionID: string;
  kind: AgentKind;
  agent: string;
  description: string;
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  bgID?: string;
  callID?: string;
};

type EventTime = { start?: number; end?: number; created?: number; completed?: number };

type EventToolState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  metadata?: Record<string, unknown>;
  time?: EventTime;
};

type EventPart = {
  type?: string;
  tool?: string;
  callID?: string;
  id?: string;
  messageID?: string;
  text?: string;
  name?: string;
  agent?: string;
  description?: string;
  state?: EventToolState;
  time?: EventTime;
};

type EventMessage = {
  id?: string;
  sessionID?: string;
  role?: string;
  agent?: string;
  mode?: string;
  time?: EventTime;
  error?: unknown;
};

type EventInfo = {
  sessionID?: string;
  part?: EventPart;
};

type EventProperties = {
  info?: EventInfo;
  part?: EventPart;
  sessionID?: string;
};

const BG_STATUS_PATTERN = /\[BACKGROUND TASK (COMPLETED|ERROR|TIMEOUT|CANCELLED|RETRYING)\]/;
const BG_ID_IN_TEXT_PATTERN = /\*\*ID:\*\*\s*`?(bg_[A-Za-z0-9]+)`?/;
const BG_ID_IN_OUTPUT_PATTERN = /Background Task ID:\s*(bg_[A-Za-z0-9]+)/;
const BG_ID_IN_METADATA_BLOCK_PATTERN = /background_task_id:\s*(bg_[A-Za-z0-9]+)/;
const DELEGATION_STARTED_PATTERN = /Delegation started:\s*([^\s]+)/;
const TASK_SUMMARY_LINE_PATTERN = /-\s+`(bg_[A-Za-z0-9]+)`:\s*([^\n]+)/g;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractBgIDFromText(haystack: string): string | undefined {
  const meta = BG_ID_IN_METADATA_BLOCK_PATTERN.exec(haystack);
  if (meta) return meta[1];
  const launched = BG_ID_IN_OUTPUT_PATTERN.exec(haystack);
  if (launched) return launched[1];
  const fallback = BG_ID_IN_TEXT_PATTERN.exec(haystack);
  return fallback?.[1];
}

function extractDelegationIDFromText(haystack: string): string | undefined {
  return DELEGATION_STARTED_PATTERN.exec(haystack)?.[1];
}

function resolveAgentName(input: Record<string, unknown>, metadata: Record<string, unknown>): string {
  return readString(input.subagent_type) ?? readString(input.agent) ?? readString(metadata.agent) ?? "agent";
}

function resolveDescription(input: Record<string, unknown>, metadata: Record<string, unknown>): string {
  return readString(input.description) ?? readString(metadata.description) ?? "";
}

function makeKey(kind: AgentKind, id: string): string {
  return `${kind}:${id}`;
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const active = new Map<string, AgentEntry>();

  const [now, setNow] = createSignal(Date.now());
  const [version, setVersion] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal<boolean>(api.kv.get(COLLAPSED_KV_KEY, false));
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus | null>(null);
  const bumpVersion = (): void => {
    setVersion((value) => value + 1);
  };

  const updateNotifier = createUpdateNotifier(api, PLUGIN_VERSION, setUpdateStatus);

  const toggleCollapsed = (): void => {
    const next = !collapsed();
    setCollapsed(next);
    api.kv.set(COLLAPSED_KV_KEY, next);
  };

  const unregisterCommand = api.command.register(() => [
    {
      title: collapsed() ? "Expand Agents Panel" : "Collapse Agents Panel",
      value: "subagent-sidebar.toggle",
      description: "Toggle the Agents section in the sidebar",
      category: "Plugin",
      keybind: "ctrl+x a",
      slash: { name: "agents-toggle" },
      onSelect: toggleCollapsed,
    },
  ]);

  const touchEntry = (entry: AgentEntry, agent: string, description: string): boolean => {
    let mutated = false;
    if (description.length > 0 && entry.description !== description) {
      entry.description = description;
      mutated = true;
    }
    if (agent !== "agent" && entry.agent !== agent) {
      entry.agent = agent;
      mutated = true;
    }
    return mutated;
  };

  const completeEntry = (entry: AgentEntry, status: AgentStatus, completedAt: number): boolean => {
    const nextStatus = status === "error" ? "error" : "completed";
    const mutated = entry.status !== nextStatus || entry.completedAt !== completedAt;
    entry.status = nextStatus;
    entry.completedAt = completedAt;
    return mutated;
  };

  const promoteCallIDToBgID = (callID: string, bgID: string): boolean => {
    const callKey = makeKey("background", callID);
    const staleForegroundKey = makeKey("foreground", callID);
    const bgKey = makeKey("background", bgID);
    const entry = active.get(callKey);
    active.delete(staleForegroundKey);
    if (!entry) return false;
    if (active.has(bgKey)) {
      active.delete(callKey);
      return true;
    }
    active.delete(callKey);
    entry.key = bgKey;
    entry.bgID = bgID;
    entry.callID = callID;
    active.set(bgKey, entry);
    return true;
  };

  const pruneMainEntries = (sessionID: string, keepKey: string): boolean => {
    let mutated = false;
    for (const [key, entry] of active) {
      if (entry.sessionID === sessionID && entry.kind === "main" && key !== keepKey) {
        active.delete(key);
        mutated = true;
      }
    }
    return mutated;
  };

  const upsertMainMessage = (sessionID: string, message: EventMessage): boolean => {
    if (message.role !== "assistant" || !message.id || !message.agent) return false;
    const key = makeKey("main", message.id);
    let mutated = pruneMainEntries(sessionID, key);
    const startedAt = message.time?.created ?? Date.now();
    const completedAt = message.time?.completed;
    const status: AgentStatus = message.error ? "error" : completedAt ? "completed" : "running";
    if (completedAt && isExpired(completedAt, Date.now())) return active.delete(key) || mutated;
    const existing = active.get(key);
    if (!existing) {
      active.set(key, {
        key,
        sessionID,
        kind: "main",
        agent: message.agent,
        description: message.mode ?? "main",
        status,
        startedAt,
        completedAt,
      });
      return true;
    }
    mutated = touchEntry(existing, message.agent, message.mode ?? "main") || mutated;
    if (completedAt && existing.completedAt !== completedAt) mutated = completeEntry(existing, status, completedAt) || mutated;
    if (!completedAt && existing.status !== status) {
      existing.status = status;
      mutated = true;
    }
    return mutated;
  };

  const upsertSubtaskPart = (sessionID: string, part: EventPart): boolean => {
    if (part.type !== "subtask") return false;
    const partID = part.id;
    if (!partID) return false;
    const key = makeKey("foreground", partID);
    const agent = readString(part.agent) ?? "agent";
    const description = readString(part.description) ?? "subtask";
    const existing = active.get(key);
    if (existing) return touchEntry(existing, agent, description);
    active.set(key, {
      key,
      sessionID,
      kind: "foreground",
      agent,
      description,
      status: "running",
      startedAt: part.time?.start ?? Date.now(),
    });
    return true;
  };

  const upsertAgentPart = (sessionID: string, part: EventPart): boolean => {
    if (part.type !== "agent") return false;
    const partID = part.id;
    const agent = readString(part.name);
    if (!partID || !agent) return false;
    const key = makeKey("foreground", partID);
    const existing = active.get(key);
    if (existing) return touchEntry(existing, agent, "agent part");
    active.set(key, {
      key,
      sessionID,
      kind: "foreground",
      agent,
      description: "agent part",
      status: "running",
      startedAt: part.time?.start ?? Date.now(),
    });
    return true;
  };

  const upsertToolPart = (sessionID: string, part: EventPart): boolean => {
    if (part.type !== "tool") return false;
    if (part.tool !== "task" && part.tool !== "delegate") return false;

    const callID = part.callID ?? part.id;
    if (!callID) return false;

    const status = part.state?.status;
    const input = (part.state?.input ?? {}) as Record<string, unknown>;
    const metadata = (part.state?.metadata ?? {}) as Record<string, unknown>;
    const output = part.state?.output ?? "";
    const isBackground = input.run_in_background === true || part.tool === "delegate";
    const kind: AgentKind = isBackground ? "background" : "foreground";
    const key = makeKey(kind, callID);
    const agent = resolveAgentName(input, metadata);
    const description = resolveDescription(input, metadata);
    const startedAt = part.state?.time?.start ?? Date.now();

    if (status === "pending" || status === "running") {
      const existing = active.get(key);
      if (existing) return touchEntry(existing, agent, description);
      active.set(key, {
        key,
        sessionID,
        kind,
        agent,
        description,
        status: status === "pending" ? "queued" : "running",
        startedAt,
        callID,
      });
      return true;
    }

    if (status === "completed") {
      if (isBackground) {
        const bgID = readString(metadata.backgroundTaskId) ?? extractBgIDFromText(output) ?? extractDelegationIDFromText(output);
        active.delete(makeKey("foreground", callID));
        if (!bgID) return active.delete(key);
        const existing = active.get(key);
        if (existing) {
          touchEntry(existing, agent, description);
          return promoteCallIDToBgID(callID, bgID);
        }
        const bgKey = makeKey("background", bgID);
        const promoted = active.get(bgKey);
        if (promoted) return touchEntry(promoted, agent, description);
        active.set(bgKey, {
          key: bgKey,
          sessionID,
          kind: "background",
          agent,
          description,
          status: "running",
          startedAt,
          bgID,
          callID,
        });
        return true;
      }
      const existing = active.get(key);
      if (!existing) return false;
      return completeEntry(existing, "completed", part.state?.time?.end ?? Date.now());
    }

    if (status === "error") {
      const existing = active.get(key);
      if (!existing) return false;
      return completeEntry(existing, "error", part.state?.time?.end ?? Date.now());
    }

    return false;
  };

  const handleBackgroundStatusText = (sessionID: string, part: EventPart, completedAt: number): boolean => {
    if (part.type !== "text") return false;
    const body = part.text ?? "";
    if (body.length === 0) return false;

    const statusMatch = BG_STATUS_PATTERN.exec(body);
    const singleID = BG_ID_IN_TEXT_PATTERN.exec(body)?.[1];
    let mutated = false;

    if (statusMatch && singleID) {
      const entry = active.get(makeKey("background", singleID));
      if (entry) {
        const statusText = statusMatch[1];
        if (statusText === "COMPLETED") mutated = completeEntry(entry, "completed", completedAt) || mutated;
        if (statusText === "ERROR" || statusText === "TIMEOUT" || statusText === "CANCELLED") {
          mutated = completeEntry(entry, "error", completedAt) || mutated;
        }
      }
    }

    if (body.includes("[ALL BACKGROUND TASKS COMPLETE") || body.includes("[ALL BACKGROUND TASKS FINISHED")) {
      const matches = body.matchAll(TASK_SUMMARY_LINE_PATTERN);
      for (const match of matches) {
        const bgID = match[1];
        const description = match[2] ?? "";
        const key = makeKey("background", bgID);
        const existing = active.get(key);
        if (existing) {
          if (description.length > 0) mutated = touchEntry(existing, existing.agent, description) || mutated;
          mutated = completeEntry(existing, "completed", completedAt) || mutated;
        } else if (!isExpired(completedAt, Date.now())) {
          active.set(key, {
            key,
            sessionID,
            kind: "background",
            agent: "agent",
            description,
            status: "completed",
            startedAt: completedAt,
            completedAt,
            bgID,
          });
          mutated = true;
        }
      }
    }

    return mutated;
  };

  const scanSessionState = (sessionID: string): boolean => {
    let mutated = false;
    const messages = api.state.session.messages(sessionID) as ReadonlyArray<EventMessage>;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) mutated = upsertMainMessage(sessionID, lastAssistant) || mutated;

    for (const message of messages) {
      if (!message.id) continue;
      const parts = api.state.part(message.id) as ReadonlyArray<EventPart>;
      for (const part of parts) {
        mutated = upsertToolPart(sessionID, part) || mutated;
        mutated = upsertSubtaskPart(sessionID, part) || mutated;
        mutated = upsertAgentPart(sessionID, part) || mutated;
        const completedAt = part.time?.end ?? part.time?.start;
        if (completedAt) mutated = handleBackgroundStatusText(sessionID, part, completedAt) || mutated;
      }
    }
    return mutated;
  };

  const handlePart = (sessionID: string, part: EventPart): void => {
    const mutated =
      upsertToolPart(sessionID, part) ||
      upsertSubtaskPart(sessionID, part) ||
      upsertAgentPart(sessionID, part) ||
      handleBackgroundStatusText(sessionID, part, Date.now());
    if (mutated) bumpVersion();
  };

  const handleEvent = (props: EventProperties | undefined): void => {
    if (!props) return;
    const sessionID = props.info?.sessionID ?? props.sessionID;
    const part = props.part ?? props.info?.part;
    if (!sessionID || !part) return;
    handlePart(sessionID, part);
  };

  const tickTimer = setInterval(() => {
    const current = Date.now();
    let pruned = false;
    for (const [key, entry] of active) {
      if (entry.completedAt && current - entry.completedAt > COMPLETION_RETENTION_MS) {
        active.delete(key);
        pruned = true;
      }
    }
    if (pruned) bumpVersion();
    if (active.size > 0 && hasLiveEntries(active)) setNow(current);
  }, TICK_INTERVAL_MS);

  const unsubscribers = [
    api.event.on("message.part.updated", (event) => {
      handleEvent(event.properties as EventProperties | undefined);
    }),
    api.event.on("message.updated", (event) => {
      const props = event.properties as { sessionID?: string; info?: EventMessage } | undefined;
      const sessionID = props?.sessionID;
      const message = props?.info;
      if (!sessionID || !message) return;
      if (upsertMainMessage(sessionID, message)) bumpVersion();
    }),
    api.event.on("message.part.removed", (event) => {
      const props = event.properties as EventProperties | undefined;
      const partID = props?.part?.id;
      if (!partID) return;
      const fgKey = makeKey("foreground", partID);
      const bgKey = makeKey("background", partID);
      if (active.delete(fgKey) || active.delete(bgKey)) bumpVersion();
    }),
  ];

  api.lifecycle.onDispose(() => {
    clearInterval(tickTimer);
    updateNotifier.dispose();
    unregisterCommand();
    for (const unsubscribe of unsubscribers) unsubscribe();
    active.clear();
  });

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return buildPanel(props.session_id) as never;
      },
    },
  });

  function buildPanel(sessionID: string): unknown {
    const box = createElement("box");
    setProp(box, "flexDirection", "column");
    setProp(box, "paddingTop", 1);
    setProp(box, "paddingBottom", 1);

    insert(box, () => {
      const mutatedFromScan = scanSessionState(sessionID);
      if (mutatedFromScan) {
        // Defer to break the self-trigger cycle: scanSessionState mutates
        // `active`, but we are inside the reactive accessor that depends on
        // `version()`. queueMicrotask schedules the bump after this run finishes.
        queueMicrotask(bumpVersion);
      }
      version();
      const tick = now();
      const status = updateStatus();
      return renderChildren(sessionID, tick, collapsed(), status);
    });

    return box;
  }

  function renderChildren(sessionID: string, tickNow: number, isCollapsed: boolean, status: UpdateStatus | null): unknown[] {
    const inSession: AgentEntry[] = [];
    for (const entry of active.values()) {
      if (entry.sessionID === sessionID) inSession.push(entry);
    }
    inSession.sort(compareEntriesForDisplay);

    const main = inSession.filter((entry) => entry.kind === "main" && isLive(entry));
    const fg = inSession.filter((entry) => entry.kind === "foreground");
    const bg = inSession.filter((entry) => entry.kind === "background");
    const visibleEntries = [...main, ...fg, ...bg];
    const live = visibleEntries.filter(isLive).length;
    const done = visibleEntries.length - live;

    const nodes: unknown[] = [renderHeader(visibleEntries.length, live, done, isCollapsed, status)];

    if (isCollapsed) return nodes;

    if (visibleEntries.length === 0) {
      nodes.push(renderMutedLine("  idle"));
      return nodes;
    }

    appendGroup(nodes, "main", main, tickNow, false);
    appendGroup(nodes, "foreground", fg, tickNow, main.length > 0 || bg.length > 0);
    appendGroup(nodes, "background", bg, tickNow, main.length > 0 || fg.length > 0);
    return nodes;
  }
};

function hasLiveEntries(active: Map<string, AgentEntry>): boolean {
  for (const entry of active.values()) {
    if (entry.status === "queued" || entry.status === "running") return true;
  }
  return false;
}

function compareEntriesForDisplay(a: AgentEntry, b: AgentEntry): number {
  if (a.kind === "main" && b.kind !== "main") return -1;
  if (a.kind !== "main" && b.kind === "main") return 1;
  if (isLive(a) && !isLive(b)) return -1;
  if (!isLive(a) && isLive(b)) return 1;
  return b.startedAt - a.startedAt;
}

function isLive(entry: AgentEntry): boolean {
  return entry.status === "queued" || entry.status === "running";
}

function isExpired(completedAt: number, now: number): boolean {
  return now - completedAt > COMPLETION_RETENTION_MS;
}

function appendGroup(nodes: unknown[], label: string, entries: AgentEntry[], tickNow: number, showLabel: boolean): void {
  if (entries.length === 0) return;
  if (showLabel) nodes.push(renderMutedLine(`  ${label}`));
  for (const entry of entries) {
    nodes.push(renderAgentLine(entry, tickNow));
    const desc = renderDescriptionLine(entry);
    if (desc) nodes.push(desc);
  }
}

function renderHeader(total: number, live: number, done: number, isCollapsed: boolean, status: UpdateStatus | null): unknown {
  const chevron = isCollapsed ? "▶" : "▼";
  const updateSuffix = status?.isUpdateAvailable ? `  [⬆ v${status.latest} available]` : "";
  return makeText(`${chevron} Agents ${buildCountSuffix(total, live, done)}${updateSuffix}`, { fg: "white", bold: true });
}

function buildCountSuffix(total: number, live: number, done: number): string {
  if (total === 0) return "(0)";
  if (live > 0 && done > 0) return `(${live} active, ${done} done)`;
  if (done > 0) return `(${done} done)`;
  return `(${live})`;
}

function renderAgentLine(entry: AgentEntry, tickNow: number): unknown {
  const elapsedMs = entry.completedAt ? entry.completedAt - entry.startedAt : tickNow - entry.startedAt;
  const elapsed = formatDuration(elapsedMs);
  return makeText(`  • ${entry.agent} ${formatStatus(entry.status)} ${elapsed}`, {
    fg: pickLineColor(entry),
  });
}

function renderDescriptionLine(entry: AgentEntry): unknown | undefined {
  if (entry.description.length === 0) return undefined;
  if (entry.kind === "main" && entry.agent === entry.description) return undefined;
  return makeText(`    ${truncate(entry.description, DESCRIPTION_MAX_LEN)}`, { fg: "gray" });
}

function formatStatus(status: AgentStatus): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Done";
  return "Error";
}

function pickLineColor(entry: AgentEntry): string {
  if (entry.status === "queued") return "gray";
  if (entry.status === "running") return "white";
  if (entry.status === "completed") return "gray";
  return "red";
}

function renderMutedLine(content: string): unknown {
  return makeText(content, { fg: "gray" });
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

function makeText(content: string, props: Record<string, unknown> = {}): unknown {
  const node = createElement("text");
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value as never);
  }
  insert(node, content);
  return node;
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
