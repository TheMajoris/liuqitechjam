import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: repositoryRoot,
  plugins: [react()],
  test: {
    name: "web",
    environment: "node",
    include: [
      "tests/web/**/*.test.ts",
      "tests/web/**/*.spec.ts",
      "tests/web/**/*.test.tsx",
      "tests/web/**/*.spec.tsx",
    ],
  },
});
