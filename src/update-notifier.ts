import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

const RELEASES_URL = "https://api.github.com/repos/psh4607/opencode-agent-sidebar/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const KV_LAST_CHECK_AT = "update-notifier.last-check-at";
const KV_LATEST_VERSION = "update-notifier.latest-version";

export type UpdateStatus = {
  current: string;
  latest: string;
  isUpdateAvailable: boolean;
};

export type UpdateNotifier = {
  getStatus: () => UpdateStatus | null;
  refresh: () => Promise<void>;
  dispose: () => void;
};

type ReleaseResponse = { tag_name: string };

function isReleaseResponse(value: unknown): value is ReleaseResponse {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as Record<string, unknown>).tag_name;
  return typeof tag === "string" && tag.length > 0;
}

function stripV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function isUpdateAvailable(current: string, latest: string): boolean {
  const currentParts = stripV(current).split(".");
  const latestParts = stripV(latest).split(".");
  const maxLen = Math.max(currentParts.length, latestParts.length);
  for (let i = 0; i < maxLen; i++) {
    const a = parseInt(currentParts[i] ?? "0", 10);
    const b = parseInt(latestParts[i] ?? "0", 10);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    if (b > a) return true;
    if (a > b) return false;
  }
  return false;
}

function readCachedLatest(api: TuiPluginApi): string {
  const cached = api.kv.get<unknown>(KV_LATEST_VERSION, "");
  return typeof cached === "string" ? cached : "";
}

function readLastCheckAt(api: TuiPluginApi): number {
  const cached = api.kv.get<unknown>(KV_LAST_CHECK_AT, 0);
  return typeof cached === "number" ? cached : 0;
}

export function createUpdateNotifier(
  api: TuiPluginApi,
  currentVersion: string,
  onChange: (status: UpdateStatus | null) => void,
): UpdateNotifier {
  let cachedStatus: UpdateStatus | null = null;
  let disposed = false;
  let inFlight: AbortController | null = null;

  const cachedLatest = readCachedLatest(api);
  if (cachedLatest.length > 0) {
    cachedStatus = {
      current: currentVersion,
      latest: cachedLatest,
      isUpdateAvailable: isUpdateAvailable(currentVersion, cachedLatest),
    };
    onChange(cachedStatus);
  }

  const fetchLatest = async (): Promise<void> => {
    if (disposed) return;
    const controller = new AbortController();
    inFlight = controller;
    const timeoutID = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(RELEASES_URL, {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) return;
      const json: unknown = await response.json();
      if (!isReleaseResponse(json)) return;
      const latest = stripV(json.tag_name);
      if (latest.length === 0) return;
      api.kv.set(KV_LATEST_VERSION, latest);
      api.kv.set(KV_LAST_CHECK_AT, Date.now());
      const status: UpdateStatus = {
        current: currentVersion,
        latest,
        isUpdateAvailable: isUpdateAvailable(currentVersion, latest),
      };
      cachedStatus = status;
      if (!disposed) onChange(status);
    } catch {
      // Silent: network/abort/parse errors fall through; cached status is preserved.
    } finally {
      clearTimeout(timeoutID);
      if (inFlight === controller) inFlight = null;
    }
  };

  const lastCheckAt = readLastCheckAt(api);
  if (Date.now() - lastCheckAt >= CHECK_INTERVAL_MS) void fetchLatest();

  return {
    getStatus: () => cachedStatus,
    refresh: fetchLatest,
    dispose: () => {
      disposed = true;
      inFlight?.abort();
    },
  };
}
