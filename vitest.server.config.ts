import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: repositoryRoot,
  test: {
    name: "server",
    environment: "node",
    include: [
      "tests/server/**/*.test.ts",
      "tests/server/**/*.spec.ts",
      "tests/server/**/*.test.tsx",
      "tests/server/**/*.spec.tsx",
    ],
  },
});
