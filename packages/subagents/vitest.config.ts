import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspaceEntry = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const piAiCompat = workspaceEntry("../ai/dist/compat.js");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@earendil-works\/pi-ai$/, replacement: piAiCompat },
      { find: /^@earendil-works\/pi-ai\/compat$/, replacement: piAiCompat },
      {
        find: /^@earendil-works\/pi-coding-agent$/,
        replacement: workspaceEntry("../coding-agent/dist/index.js"),
      },
      {
        find: /^@earendil-works\/pi-agent-core$/,
        replacement: workspaceEntry("../agent/dist/index.js"),
      },
      {
        find: /^@earendil-works\/pi-tui$/,
        replacement: workspaceEntry("../tui/dist/index.js"),
      },
    ],
  },
  test: {
    server: {
      deps: {
        external: [/@earendil-works\/pi-/],
      },
    },
  },
});
