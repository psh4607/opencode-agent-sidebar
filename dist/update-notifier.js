const RELEASES_URL = "https://api.github.com/repos/psh4607/opencode-agent-sidebar/releases/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const KV_LAST_CHECK_AT = "update-notifier.last-check-at";
const KV_LATEST_VERSION = "update-notifier.latest-version";
function isReleaseResponse(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const tag = value.tag_name;
    return typeof tag === "string" && tag.length > 0;
}
function stripV(version) {
    return version.startsWith("v") ? version.slice(1) : version;
}
function isUpdateAvailable(current, latest) {
    const currentParts = stripV(current).split(".");
    const latestParts = stripV(latest).split(".");
    const maxLen = Math.max(currentParts.length, latestParts.length);
    for (let i = 0; i < maxLen; i++) {
        const a = parseInt(currentParts[i] ?? "0", 10);
        const b = parseInt(latestParts[i] ?? "0", 10);
        if (Number.isNaN(a) || Number.isNaN(b))
            return false;
        if (b > a)
            return true;
        if (a > b)
            return false;
    }
    return false;
}
function readCachedLatest(api) {
    const cached = api.kv.get(KV_LATEST_VERSION, "");
    return typeof cached === "string" ? cached : "";
}
function readLastCheckAt(api) {
    const cached = api.kv.get(KV_LAST_CHECK_AT, 0);
    return typeof cached === "number" ? cached : 0;
}
export function createUpdateNotifier(api, currentVersion, onChange) {
    let cachedStatus = null;
    let disposed = false;
    let inFlight = null;
    const cachedLatest = readCachedLatest(api);
    if (cachedLatest.length > 0) {
        cachedStatus = {
            current: currentVersion,
            latest: cachedLatest,
            isUpdateAvailable: isUpdateAvailable(currentVersion, cachedLatest),
        };
        onChange(cachedStatus);
    }
    const fetchLatest = async () => {
        if (disposed)
            return;
        const controller = new AbortController();
        inFlight = controller;
        const timeoutID = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(RELEASES_URL, {
                signal: controller.signal,
                headers: { Accept: "application/vnd.github+json" },
            });
            if (!response.ok)
                return;
            const json = await response.json();
            if (!isReleaseResponse(json))
                return;
            const latest = stripV(json.tag_name);
            if (latest.length === 0)
                return;
            api.kv.set(KV_LATEST_VERSION, latest);
            api.kv.set(KV_LAST_CHECK_AT, Date.now());
            const status = {
                current: currentVersion,
                latest,
                isUpdateAvailable: isUpdateAvailable(currentVersion, latest),
            };
            cachedStatus = status;
            if (!disposed)
                onChange(status);
        }
        catch {
            // Silent: network/abort/parse errors fall through; cached status is preserved.
        }
        finally {
            clearTimeout(timeoutID);
            if (inFlight === controller)
                inFlight = null;
        }
    };
    const lastCheckAt = readLastCheckAt(api);
    if (Date.now() - lastCheckAt >= CHECK_INTERVAL_MS)
        void fetchLatest();
    return {
        getStatus: () => cachedStatus,
        refresh: fetchLatest,
        dispose: () => {
            disposed = true;
            inFlight?.abort();
        },
    };
}
//# sourceMappingURL=update-notifier.js.map