import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./src/test/db-global-setup.ts"],
    include: ["src/**/*.db.test.ts"],
    maxWorkers: 1,
  },
});
