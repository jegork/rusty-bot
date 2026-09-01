import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/github",
      "packages/github-action",
      "packages/azure-devops",
      "packages/gitlab",
      "packages/cli",
    ],
  },
});
