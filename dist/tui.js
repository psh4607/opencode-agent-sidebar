import { MouseButton } from "@opentui/core";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createUpdateNotifier } from "./update-notifier.js";
const PLUGIN_ID = "subagent-sidebar";
const PLUGIN_VERSION = "0.2.4";
const SIDEBAR_ORDER = 200;
const TICK_INTERVAL_MS = 1000;
const COMPLETION_RETENTION_MS = 3_000;
const DESCRIPTION_MAX_LEN = 26;
const COLLAPSED_KV_KEY = "agents-panel.collapsed";
const BG_STATUS_PATTERN = /\[BACKGROUND TASK (COMPLETED|ERROR|TIMEOUT|CANCELLED|RETRYING)\]/;
const BG_ID_IN_TEXT_PATTERN = /\*\*ID:\*\*\s*`?(bg_[A-Za-z0-9]+)`?/;
const BG_ID_IN_OUTPUT_PATTERN = /Background Task ID:\s*(bg_[A-Za-z0-9]+)/;
const BG_ID_IN_METADATA_BLOCK_PATTERN = /background_task_id:\s*(bg_[A-Za-z0-9]+)/;
const DELEGATION_STARTED_PATTERN = /Delegation started:\s*([^\s]+)/;
const TASK_SUMMARY_LINE_PATTERN = /-\s+`(bg_[A-Za-z0-9]+)`:\s*([^\n]+)/g;
function readString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function extractBgIDFromText(haystack) {
    const meta = BG_ID_IN_METADATA_BLOCK_PATTERN.exec(haystack);
    if (meta)
        return meta[1];
    const launched = BG_ID_IN_OUTPUT_PATTERN.exec(haystack);
    if (launched)
        return launched[1];
    const fallback = BG_ID_IN_TEXT_PATTERN.exec(haystack);
    return fallback?.[1];
}
function extractDelegationIDFromText(haystack) {
    return DELEGATION_STARTED_PATTERN.exec(haystack)?.[1];
}
function resolveAgentName(input, metadata) {
    return readString(input.subagent_type) ?? readString(input.agent) ?? readString(metadata.agent) ?? "agent";
}
function resolveDescription(input, metadata) {
    return readString(input.description) ?? readString(metadata.description) ?? "";
}
function makeKey(kind, id) {
    return `${kind}:${id}`;
}
const tui = async (api) => {
    const active = new Map();
    const [now, setNow] = createSignal(Date.now());
    const [version, setVersion] = createSignal(0);
    const [collapsed, setCollapsed] = createSignal(api.kv.get(COLLAPSED_KV_KEY, false));
    const [updateStatus, setUpdateStatus] = createSignal(null);
    const bumpVersion = () => {
        setVersion((value) => value + 1);
    };
    const updateNotifier = createUpdateNotifier(api, PLUGIN_VERSION, setUpdateStatus);
    const toggleCollapsed = () => {
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
    const touchEntry = (entry, agent, description) => {
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
    const completeEntry = (entry, status, completedAt) => {
        const nextStatus = status === "error" ? "error" : "completed";
        const statusChanged = entry.status !== nextStatus;
        // Stamp completedAt only on the first transition to a terminal state.
        // Re-stamping (e.g. when scanSessionState re-matches the same
        // [ALL BACKGROUND TASKS COMPLETE] system reminder on every 1s tick) would
        // make the elapsed timer keep climbing past completion, so a "Done" entry
        // visually behaves like it's still running.
        const stampChanged = entry.completedAt === undefined;
        if (stampChanged)
            entry.completedAt = completedAt;
        if (statusChanged)
            entry.status = nextStatus;
        return statusChanged || stampChanged;
    };
    const promoteCallIDToBgID = (callID, bgID) => {
        const callKey = makeKey("background", callID);
        const staleForegroundKey = makeKey("foreground", callID);
        const bgKey = makeKey("background", bgID);
        const entry = active.get(callKey);
        active.delete(staleForegroundKey);
        if (!entry)
            return false;
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
    const pruneMainEntries = (sessionID, keepKey) => {
        let mutated = false;
        for (const [key, entry] of active) {
            if (entry.sessionID === sessionID && entry.kind === "main" && key !== keepKey) {
                active.delete(key);
                mutated = true;
            }
        }
        return mutated;
    };
    const upsertMainMessage = (sessionID, message) => {
        if (message.role !== "assistant" || !message.id || !message.agent)
            return false;
        const key = makeKey("main", message.id);
        let mutated = pruneMainEntries(sessionID, key);
        const startedAt = message.time?.created ?? Date.now();
        const completedAt = message.time?.completed;
        const status = message.error ? "error" : completedAt ? "completed" : "running";
        if (completedAt && isExpired(completedAt, Date.now()))
            return active.delete(key) || mutated;
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
        if (completedAt && existing.completedAt !== completedAt)
            mutated = completeEntry(existing, status, completedAt) || mutated;
        if (!completedAt && existing.status !== status) {
            existing.status = status;
            mutated = true;
        }
        return mutated;
    };
    const upsertSubtaskPart = (sessionID, part) => {
        if (part.type !== "subtask")
            return false;
        const partID = part.id;
        if (!partID)
            return false;
        const key = makeKey("foreground", partID);
        const agent = readString(part.agent) ?? "agent";
        const description = readString(part.description) ?? "subtask";
        const existing = active.get(key);
        if (existing)
            return touchEntry(existing, agent, description);
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
    const upsertAgentPart = (sessionID, part) => {
        if (part.type !== "agent")
            return false;
        const partID = part.id;
        const agent = readString(part.name);
        if (!partID || !agent)
            return false;
        const key = makeKey("foreground", partID);
        const existing = active.get(key);
        if (existing)
            return touchEntry(existing, agent, "agent part");
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
    const upsertToolPart = (sessionID, part) => {
        if (part.type !== "tool")
            return false;
        if (part.tool !== "task" && part.tool !== "delegate")
            return false;
        const callID = part.callID ?? part.id;
        if (!callID)
            return false;
        const status = part.state?.status;
        const input = (part.state?.input ?? {});
        const metadata = (part.state?.metadata ?? {});
        const output = part.state?.output ?? "";
        const isBackground = input.run_in_background === true || part.tool === "delegate";
        const kind = isBackground ? "background" : "foreground";
        const key = makeKey(kind, callID);
        const agent = resolveAgentName(input, metadata);
        const description = resolveDescription(input, metadata);
        const startedAt = part.state?.time?.start ?? Date.now();
        if (status === "pending" || status === "running") {
            const existing = active.get(key);
            if (existing)
                return touchEntry(existing, agent, description);
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
                if (!bgID)
                    return active.delete(key);
                const existing = active.get(key);
                if (existing) {
                    touchEntry(existing, agent, description);
                    return promoteCallIDToBgID(callID, bgID);
                }
                const bgKey = makeKey("background", bgID);
                const promoted = active.get(bgKey);
                if (promoted)
                    return touchEntry(promoted, agent, description);
                // Live launches always pass through pending/running before reaching
                // completed, so observing status="completed" with no in-flight entry
                // means scanSessionState is replaying a historical message. Resurrecting
                // here would stamp startedAt to part.time.start (potentially hours old)
                // and let handleBackgroundStatusText finalize completedAt = Date.now()
                // on the next tick, producing a spurious "Done 1230m" row before
                // retention prunes it.
                return false;
            }
            const existing = active.get(key);
            if (!existing)
                return false;
            return completeEntry(existing, "completed", part.state?.time?.end ?? Date.now());
        }
        if (status === "error") {
            const existing = active.get(key);
            if (!existing)
                return false;
            return completeEntry(existing, "error", part.state?.time?.end ?? Date.now());
        }
        return false;
    };
    const handleBackgroundStatusText = (sessionID, part, completedAt) => {
        if (part.type !== "text")
            return false;
        const body = part.text ?? "";
        if (body.length === 0)
            return false;
        const statusMatch = BG_STATUS_PATTERN.exec(body);
        const singleID = BG_ID_IN_TEXT_PATTERN.exec(body)?.[1];
        let mutated = false;
        if (statusMatch && singleID) {
            const entry = active.get(makeKey("background", singleID));
            if (entry) {
                const statusText = statusMatch[1];
                if (statusText === "COMPLETED")
                    mutated = completeEntry(entry, "completed", completedAt) || mutated;
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
                    if (description.length > 0)
                        mutated = touchEntry(existing, existing.agent, description) || mutated;
                    mutated = completeEntry(existing, "completed", completedAt) || mutated;
                }
                // No in-flight entry: same reasoning as upsertToolPart's completed
                // branch — fabricating a row from a system reminder match alone
                // means we're staring at historical message text. Don't resurrect.
            }
        }
        return mutated;
    };
    const scanSessionState = (sessionID) => {
        let mutated = false;
        const messages = api.state.session.messages(sessionID);
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        if (lastAssistant)
            mutated = upsertMainMessage(sessionID, lastAssistant) || mutated;
        for (const message of messages) {
            if (!message.id)
                continue;
            const parts = api.state.part(message.id);
            for (const part of parts) {
                mutated = upsertToolPart(sessionID, part) || mutated;
                mutated = upsertSubtaskPart(sessionID, part) || mutated;
                mutated = upsertAgentPart(sessionID, part) || mutated;
                // system-reminder parts lack time fields; mirror handlePart fallback so BG completion isn't dropped on rescan.
                const completedAt = part.time?.end ?? part.time?.start ?? Date.now();
                mutated = handleBackgroundStatusText(sessionID, part, completedAt) || mutated;
            }
        }
        return mutated;
    };
    const handlePart = (sessionID, part) => {
        const mutated = upsertToolPart(sessionID, part) ||
            upsertSubtaskPart(sessionID, part) ||
            upsertAgentPart(sessionID, part) ||
            handleBackgroundStatusText(sessionID, part, Date.now());
        if (mutated)
            bumpVersion();
    };
    const handleEvent = (props) => {
        if (!props)
            return;
        const sessionID = props.info?.sessionID ?? props.sessionID;
        const part = props.part ?? props.info?.part;
        if (!sessionID || !part)
            return;
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
        if (pruned)
            bumpVersion();
        if (active.size > 0 && hasLiveEntries(active))
            setNow(current);
    }, TICK_INTERVAL_MS);
    const unsubscribers = [
        api.event.on("message.part.updated", (event) => {
            handleEvent(event.properties);
        }),
        api.event.on("message.updated", (event) => {
            const props = event.properties;
            const sessionID = props?.sessionID;
            const message = props?.info;
            if (!sessionID || !message)
                return;
            if (upsertMainMessage(sessionID, message))
                bumpVersion();
        }),
        api.event.on("message.part.removed", (event) => {
            const props = event.properties;
            const partID = props?.part?.id;
            if (!partID)
                return;
            const fgKey = makeKey("foreground", partID);
            const bgKey = makeKey("background", partID);
            if (active.delete(fgKey) || active.delete(bgKey))
                bumpVersion();
        }),
    ];
    api.lifecycle.onDispose(() => {
        clearInterval(tickTimer);
        updateNotifier.dispose();
        unregisterCommand();
        for (const unsubscribe of unsubscribers)
            unsubscribe();
        active.clear();
    });
    api.slots.register({
        order: SIDEBAR_ORDER,
        slots: {
            sidebar_content(_ctx, props) {
                return buildPanel(props.session_id);
            },
        },
    });
    function buildPanel(sessionID) {
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
    function renderChildren(sessionID, tickNow, isCollapsed, status) {
        const inSession = [];
        for (const entry of active.values()) {
            if (entry.sessionID === sessionID)
                inSession.push(entry);
        }
        inSession.sort(compareEntriesForDisplay);
        const main = inSession.filter((entry) => entry.kind === "main" && isLive(entry));
        const fg = inSession.filter((entry) => entry.kind === "foreground");
        const bg = inSession.filter((entry) => entry.kind === "background");
        const visibleEntries = [...main, ...fg, ...bg];
        const live = visibleEntries.filter(isLive).length;
        const done = visibleEntries.length - live;
        const nodes = [renderHeader(visibleEntries.length, live, done, isCollapsed, status, toggleCollapsed)];
        if (isCollapsed)
            return nodes;
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
function hasLiveEntries(active) {
    for (const entry of active.values()) {
        if (entry.status === "queued" || entry.status === "running")
            return true;
    }
    return false;
}
function compareEntriesForDisplay(a, b) {
    if (a.kind === "main" && b.kind !== "main")
        return -1;
    if (a.kind !== "main" && b.kind === "main")
        return 1;
    if (isLive(a) && !isLive(b))
        return -1;
    if (!isLive(a) && isLive(b))
        return 1;
    return b.startedAt - a.startedAt;
}
function isLive(entry) {
    return entry.status === "queued" || entry.status === "running";
}
function isExpired(completedAt, now) {
    return now - completedAt > COMPLETION_RETENTION_MS;
}
function appendGroup(nodes, label, entries, tickNow, showLabel) {
    if (entries.length === 0)
        return;
    if (showLabel)
        nodes.push(renderMutedLine(`  ${label}`));
    for (const entry of entries) {
        nodes.push(renderAgentLine(entry, tickNow));
        const desc = renderDescriptionLine(entry);
        if (desc)
            nodes.push(desc);
    }
}
function renderHeader(total, live, done, isCollapsed, status, onToggle) {
    const chevron = isCollapsed ? "▶" : "▼";
    const updateSuffix = status?.isUpdateAvailable ? `  [⬆ v${status.latest} available]` : "";
    const handleMouseDown = onToggle
        ? (event) => {
            if (event.button !== MouseButton.LEFT)
                return;
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
function buildCountSuffix(total, live, done) {
    if (total === 0)
        return "(0)";
    if (live > 0 && done > 0)
        return `(${live} active, ${done} done)`;
    if (done > 0)
        return `(${done} done)`;
    return `(${live})`;
}
function renderAgentLine(entry, tickNow) {
    const elapsedMs = entry.completedAt ? entry.completedAt - entry.startedAt : tickNow - entry.startedAt;
    const elapsed = formatDuration(elapsedMs);
    return makeText(`  • ${entry.agent} ${formatStatus(entry.status)} ${elapsed}`, {
        fg: pickLineColor(entry),
    });
}
function renderDescriptionLine(entry) {
    if (entry.description.length === 0)
        return undefined;
    if (entry.kind === "main" && entry.agent === entry.description)
        return undefined;
    return makeText(`    ${truncate(entry.description, DESCRIPTION_MAX_LEN)}`, { fg: "gray" });
}
function formatStatus(status) {
    if (status === "queued")
        return "Queued";
    if (status === "running")
        return "Running";
    if (status === "completed")
        return "Done";
    return "Error";
}
function pickLineColor(entry) {
    if (entry.status === "queued")
        return "gray";
    if (entry.status === "running")
        return "white";
    if (entry.status === "completed")
        return "gray";
    return "red";
}
function renderMutedLine(content) {
    return makeText(content, { fg: "gray" });
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
function truncate(value, maxLen) {
    if (value.length <= maxLen)
        return value;
    return `${value.slice(0, maxLen - 1)}…`;
}
function makeText(content, props = {}) {
    const node = createElement("text");
    for (const [key, value] of Object.entries(props)) {
        if (value !== undefined)
            setProp(node, key, value);
    }
    insert(node, content);
    return node;
}
const plugin = {
    id: PLUGIN_ID,
    tui,
};
export default plugin;
//# sourceMappingURL=tui.js.map