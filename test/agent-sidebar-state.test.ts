import { describe, expect, test } from "bun:test";
import {
  classifyChildCompletion,
  createLifecycleTracker,
  deduplicateCandidates,
  isAgentToolPart,
  isBackgroundInvocation,
  isVisible,
  parseLegacyBackgroundUpdates,
  resolveChildReference,
  resolveLegacyBackgroundStatus,
  resolveToolStatus,
  type AgentCandidate,
  type AgentEntry,
} from "../src/agent-sidebar-state.ts";

function entry(overrides: Partial<AgentCandidate> = {}): AgentCandidate {
  return {
    key: "session:tool:one",
    sessionID: "session",
    kind: "background",
    agent: "explore",
    description: "inspect state",
    status: "running",
    startedAt: 1_000,
    childSessionID: "child",
    ...overrides,
  };
}

test("deduplicates resumed work across foreground and background invocations", () => {
  const selected = deduplicateCandidates([
    entry({ key: "old", kind: "background", startedAt: 1_000 }),
    entry({ key: "new", kind: "foreground", startedAt: 2_000 }),
  ]);

  expect(selected).toHaveLength(1);
  expect(selected[0]?.key).toBe("new");
});

test("deduplicates a resume by task_id before metadata arrives", () => {
  const child = resolveChildReference({ task_id: "child" }, {}, "");
  const selected = deduplicateCandidates([
    entry({ key: "old", childSessionID: "child", startedAt: 1_000 }),
    entry({
      key: "new",
      kind: "foreground",
      childSessionID: child?.id,
      startedAt: 2_000,
    }),
  ]);

  expect(child).toEqual({ id: "child", kind: "session" });
  expect(selected).toHaveLength(1);
  expect(selected[0]?.key).toBe("new");
});

test("retains a terminal transition for exactly three seconds", () => {
  const tracker = createLifecycleTracker();
  const running = entry();
  expect(tracker.retain(running, 1_000)).toBe(true);

  tracker.observe([running], 10_000);
  const completed = entry({ status: "completed", completedAt: 1_100 });
  expect(tracker.retain(completed, 10_500)).toBe(true);
  expect(completed.completedAt).toBe(10_500);
  expect(isVisible(completed, 13_500)).toBe(true);
  expect(isVisible(completed, 13_501)).toBe(false);
});

test("preserves a late child assistant error after idle", () => {
  const tracker = createLifecycleTracker();
  expect(tracker.retain(entry(), 1_000)).toBe(true);

  const completed = entry({ status: "completed", completedAt: 1_100 });
  expect(tracker.retain(completed, 2_000)).toBe(true);
  expect(completed.completedAt).toBe(2_000);

  const child = classifyChildCompletion([
    { role: "assistant", time: { completed: 2_100 } },
    { role: "assistant", error: { name: "UnknownError" }, time: { completed: 2_200 } },
  ]);
  const failed = entry({ status: child.status, completedAt: child.completedAt });
  expect(tracker.retain(failed, 2_500)).toBe(true);
  expect(failed.status).toBe("error");
  expect(failed.completedAt).toBe(2_000);
});

test("does not resurrect a historical completion", () => {
  const tracker = createLifecycleTracker();
  expect(tracker.retain(entry(), 1_000)).toBe(true);

  const completed = entry({ status: "completed", completedAt: 1_100 });
  expect(tracker.retain(completed, 10_000)).toBe(false);
  expect(completed.completedAt).toBe(1_100);
});

test("keeps the first observed timestamp while a task is queued", () => {
  const tracker = createLifecycleTracker();
  expect(tracker.startTime("queued", "queued", undefined, 1_000)).toBe(1_000);
  expect(tracker.startTime("queued", "queued", undefined, 5_000)).toBe(1_000);
  expect(tracker.startTime("queued", "running", 1_500, 6_000)).toBe(1_500);
});

test("reactive removal clears the prior live transition", () => {
  const tracker = createLifecycleTracker();
  const running = entry({ key: "session:tool:removed", childSessionID: undefined });
  expect(tracker.retain(running, 1_000)).toBe(true);
  tracker.cleanup("session", new Set());

  const completed: AgentEntry = { ...running, status: "completed", completedAt: 1_100 };
  expect(tracker.retain(completed, 10_000)).toBe(false);
});

test("only real task and delegate tool parts can produce activity", () => {
  expect(isAgentToolPart("tool", "task")).toBe(true);
  expect(isAgentToolPart("tool", "delegate")).toBe(true);
  expect(isAgentToolPart("subtask", undefined)).toBe(false);
  expect(isAgentToolPart("agent", undefined)).toBe(false);
  expect(isAgentToolPart("tool", "read")).toBe(false);
});

describe("background classification compatibility", () => {
  test.each([
    ["native input", "task", { background: true }, {}, true],
    ["native metadata", "task", {}, { background: true }, true],
    ["legacy input", "task", { run_in_background: true }, {}, true],
    ["OMO delegate", "delegate", {}, {}, true],
    ["foreground task", "task", {}, {}, false],
  ])("classifies %s", (_name, tool, input, metadata, expected) => {
    expect(isBackgroundInvocation(tool, input, metadata)).toBe(expected);
  });
});

test("resolves native and legacy child identifiers in precedence order", () => {
  expect(
    resolveChildReference(
      { task_id: "ses_input" },
      { sessionId: "ses_current", jobId: "ses_job", backgroundTaskId: "bg_old" },
      "Background Task ID: bg_output",
    ),
  ).toEqual({ id: "ses_current", kind: "session" });
  expect(resolveChildReference({}, { jobId: "ses_job" }, "")).toEqual({
    id: "ses_job",
    kind: "session",
  });
  expect(resolveChildReference({ task_id: "ses_input" }, {}, "")).toEqual({
    id: "ses_input",
    kind: "session",
  });
  expect(resolveChildReference({}, { backgroundTaskId: "bg_old" }, "")).toEqual({
    id: "bg_old",
    kind: "legacy",
  });
  expect(resolveChildReference({}, {}, "Background Task ID: bg_output")).toEqual({
    id: "bg_output",
    kind: "legacy",
  });
  expect(resolveChildReference({}, {}, "background_task_id: bg_block")).toEqual({
    id: "bg_block",
    kind: "legacy",
  });
  expect(resolveChildReference({}, {}, "Delegation started: bg_delegate")).toEqual({
    id: "bg_delegate",
    kind: "legacy",
  });
});

test("follows native child busy, retry, and idle states after parent completion", () => {
  expect(resolveToolStatus("completed", "busy", true)).toBe("running");
  expect(resolveToolStatus("completed", "retry", true)).toBe("retrying");
  expect(resolveToolStatus("completed", "idle", true)).toBe("completed");
  expect(resolveToolStatus("running", "retry", false)).toBe("retrying");
});

test("legacy OMO reminders update only an observed tool lifecycle", () => {
  const updates = new Map(parseLegacyBackgroundUpdates("[BACKGROUND TASK ERROR]\n**ID:** `bg_failed`"));
  expect(updates.get("bg_failed")).toEqual({ status: "error" });
  expect(resolveLegacyBackgroundStatus("completed", updates.get("bg_failed"), false)).toBe("error");
  expect(resolveLegacyBackgroundStatus("completed", undefined, true)).toBe("running");
  expect(resolveLegacyBackgroundStatus("completed", { status: "running" }, false)).toBe("completed");
});

test("an observed legacy task remains live while its sidebar is hidden", () => {
  const tracker = createLifecycleTracker();
  const running = entry({ key: "session:tool:legacy", childSessionID: "bg_live" });
  expect(tracker.retain(running, 1_000)).toBe(true);

  expect(tracker.wasObservedLive(running.key)).toBe(true);
  expect(resolveLegacyBackgroundStatus("completed", undefined, tracker.wasObservedLive(running.key))).toBe(
    "running",
  );
});

test("legacy all-complete summaries retain their descriptions", () => {
  const updates = new Map(
    parseLegacyBackgroundUpdates("[ALL BACKGROUND TASKS COMPLETE]\n- `bg_done`: inspect lifecycle"),
  );
  expect(updates.get("bg_done")).toEqual({ status: "completed", description: "inspect lifecycle" });
});
