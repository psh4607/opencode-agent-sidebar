import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { MouseEvent } from "@opentui/core";
import { MouseButton } from "@opentui/core";
import { createElement, insert, setProp } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
import {
  TICK_INTERVAL_MS,
  classifyChildCompletion,
  compareEntries,
  createLifecycleTracker,
  deduplicateCandidates,
  isAgentToolPart,
  isBackgroundInvocation,
  isLive,
  isVisible,
  parseLegacyBackgroundUpdates,
  readString,
  resolveChildReference,
  resolveLegacyBackgroundStatus,
  resolveToolStatus,
  type AgentCandidate,
  type AgentEntry,
  type AgentStatus,
  type ChildReference,
  type LegacyBackgroundUpdate,
} from "./agent-sidebar-state.js";
import { createUpdateNotifier, type UpdateStatus } from "./update-notifier.js";

const PLUGIN_ID = "subagent-sidebar";
const PLUGIN_VERSION = "0.2.5";
const SIDEBAR_ORDER = 200;
const DESCRIPTION_MAX_LEN = 26;
const COLLAPSED_KV_KEY = "agents-panel.collapsed";

type EventTime = { start?: number; end?: number; created?: number; completed?: number };

type EventToolState = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: EventTime;
};

type EventPart = {
  type?: string;
  tool?: string;
  id?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  state?: EventToolState;
};

type EventMessage = {
  id?: string;
  role?: string;
  agent?: string;
  mode?: string;
  time?: EventTime;
  error?: unknown;
};

type ToolCandidate = AgentCandidate & {
  parentStatus: string;
  childReference?: ChildReference;
  followsChildSession: boolean;
};

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [now, setNow] = createSignal(Date.now());
  const [collapsed, setCollapsed] = createSignal<boolean>(api.kv.get(COLLAPSED_KV_KEY, false));
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus | null>(null);
  const lifecycle = createLifecycleTracker();
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

  const collectEntries = (sessionID: string, tick: number): AgentEntry[] => {
    const entries: AgentEntry[] = [];
    const candidates: ToolCandidate[] = [];
    const legacyUpdates = new Map<string, LegacyBackgroundUpdate>();
    const seen = new Set<string>();
    const messages = api.state.session.messages(sessionID) as ReadonlyArray<EventMessage>;
    const sessionStatus = api.state.session.status(sessionID)?.type;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

    if (
      lastAssistant?.id &&
      lastAssistant.agent &&
      lastAssistant.time?.completed === undefined &&
      (sessionStatus === "busy" || sessionStatus === "retry")
    ) {
      entries.push({
        key: `${sessionID}:main:${lastAssistant.id}`,
        sessionID,
        kind: "main",
        agent: lastAssistant.agent,
        description: lastAssistant.mode ?? "main",
        status: sessionStatus === "retry" ? "retrying" : "running",
        startedAt: lastAssistant.time?.created ?? tick,
      });
    }

    for (const message of messages) {
      if (!message.id) continue;
      const parts = api.state.part(message.id) as ReadonlyArray<EventPart>;
      for (const part of parts) {
        if (part.type === "text" && part.text) {
          for (const [id, update] of parseLegacyBackgroundUpdates(part.text)) {
            legacyUpdates.set(id, update);
          }
        }

        if (!isAgentToolPart(part.type, part.tool) || !part.id || !part.tool) continue;
        const state = part.state;
        if (!state?.status) continue;
        const input = state.input ?? {};
        const metadata = { ...(part.metadata ?? {}), ...(state.metadata ?? {}) };
        const output = state.output ?? "";
        const background = isBackgroundInvocation(part.tool, input, metadata);
        const childReference = resolveChildReference(input, metadata, output);
        const childStatus = childReference ? api.state.session.status(childReference.id)?.type : undefined;
        const followsChildSession = childReference?.kind === "session" || childStatus !== undefined;
        const status = resolveToolStatus(
          state.status,
          childStatus,
          background && followsChildSession,
        );
        if (!status) continue;

        const key = `${sessionID}:tool:${part.id}`;
        candidates.push({
          key,
          sessionID,
          kind: background ? "background" : "foreground",
          agent:
            readString(input.subagent_type) ??
            readString(input.agent) ??
            readString(metadata.agent) ??
            "agent",
          description:
            readString(input.description) ??
            readString(metadata.description) ??
            readString(state.title) ??
            "",
          status,
          startedAt: lifecycle.startTime(key, status, state.time?.start, tick),
          completedAt: isLive(status) ? undefined : state.time?.end,
          childSessionID: childReference?.id,
          parentStatus: state.status,
          childReference,
          followsChildSession,
        });
      }
    }

    for (const entry of deduplicateCandidates(candidates)) {
      const legacyUpdate = entry.childReference
        ? legacyUpdates.get(entry.childReference.id)
        : undefined;
      if (legacyUpdate?.description) entry.description = legacyUpdate.description;

      if (entry.kind === "background" && entry.parentStatus === "completed") {
        if (
          entry.followsChildSession &&
          entry.status === "completed" &&
          entry.childSessionID
        ) {
          const child = classifyChildCompletion(
            api.state.session.messages(entry.childSessionID) as ReadonlyArray<EventMessage>,
          );
          entry.status = child.status;
          entry.completedAt = child.completedAt ?? entry.completedAt;
        }

        if (entry.childReference?.kind === "legacy" && !entry.followsChildSession) {
          entry.status = resolveLegacyBackgroundStatus(
            entry.status,
            legacyUpdate,
            lifecycle.wasObservedLive(entry.key),
          );
          if (isLive(entry.status)) entry.completedAt = undefined;
        }
      }

      seen.add(entry.key);
      if (lifecycle.retain(entry, tick)) entries.push(entry);
    }

    lifecycle.cleanup(sessionID, seen);
    entries.sort(compareEntries);
    return entries;
  };

  const tickTimer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);

  api.lifecycle.onDispose(() => {
    clearInterval(tickTimer);
    updateNotifier.dispose();
    unregisterCommand();
    lifecycle.clear();
  });

  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        const box = createElement("box");
        const entries = createMemo(() => collectEntries(props.session_id, Date.now()));
        setProp(box, "flexDirection", "column");
        setProp(box, "paddingTop", 1);
        setProp(box, "paddingBottom", 1);
        insert(box, () => {
          const tick = now();
          const current = entries();
          lifecycle.observe(current, tick);
          return renderChildren(current, tick, collapsed(), updateStatus(), toggleCollapsed);
        });
        return box as never;
      },
    },
  });
};

function renderChildren(
  entries: AgentEntry[],
  tickNow: number,
  isCollapsed: boolean,
  status: UpdateStatus | null,
  onToggle: () => void,
): unknown[] {
  const visibleEntries = entries.filter((entry) => isVisible(entry, tickNow));
  const main = visibleEntries.filter((entry) => entry.kind === "main");
  const fg = visibleEntries.filter((entry) => entry.kind === "foreground");
  const bg = visibleEntries.filter((entry) => entry.kind === "background");
  const live = visibleEntries.filter((entry) => isLive(entry.status)).length;
  const done = visibleEntries.length - live;
  const nodes: unknown[] = [
    renderHeader(visibleEntries.length, live, done, isCollapsed, status, onToggle),
  ];

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

function appendGroup(nodes: unknown[], label: string, entries: AgentEntry[], tickNow: number, showLabel: boolean): void {
  if (entries.length === 0) return;
  if (showLabel) nodes.push(renderMutedLine(`  ${label}`));
  for (const entry of entries) {
    nodes.push(renderAgentLine(entry, tickNow));
    const desc = renderDescriptionLine(entry);
    if (desc) nodes.push(desc);
  }
}

function renderHeader(
  total: number,
  live: number,
  done: number,
  isCollapsed: boolean,
  status: UpdateStatus | null,
  onToggle?: () => void,
): unknown {
  const chevron = isCollapsed ? "▶" : "▼";
  const updateSuffix = status?.isUpdateAvailable ? `  [⬆ v${status.latest} available]` : "";
  const handleMouseDown = onToggle
    ? (event: MouseEvent): void => {
        if (event.button !== MouseButton.LEFT) return;
        event.stopPropagation();
        onToggle();
      }
    : undefined;
  return makeText(`${chevron} Agents ${buildCountSuffix(total, live, done)}${updateSuffix}`, {
    fg: "white",
    bold: true,
    width: "100%",
    selectable: false,
    onMouseDown: handleMouseDown,
  });
}

function buildCountSuffix(total: number, live: number, done: number): string {
  if (total === 0) return "(0)";
  if (live > 0 && done > 0) return `(${live} active, ${done} done)`;
  if (done > 0) return `(${done} done)`;
  return `(${live})`;
}

function renderAgentLine(entry: AgentEntry, tickNow: number): unknown {
  const elapsedMs = (entry.completedAt ?? tickNow) - entry.startedAt;
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
  if (status === "retrying") return "Retrying";
  if (status === "completed") return "Done";
  return "Error";
}

function pickLineColor(entry: AgentEntry): string {
  if (entry.status === "queued") return "gray";
  if (entry.status === "running" || entry.status === "retrying") return "white";
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
