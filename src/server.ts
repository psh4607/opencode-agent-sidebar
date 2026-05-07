import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_ID = "subagent-sidebar";

const server: Plugin = async () => {
  return {};
};

const plugin = {
  id: PLUGIN_ID,
  server,
};

export default plugin;
