import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
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
export declare function createUpdateNotifier(api: TuiPluginApi, currentVersion: string, onChange: (status: UpdateStatus | null) => void): UpdateNotifier;
//# sourceMappingURL=update-notifier.d.ts.map