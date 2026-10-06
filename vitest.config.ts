import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/ and templates/ contain their own test suites that run inside agent workspaces.
    include: ["test/**/*.test.ts"],
  },
});
