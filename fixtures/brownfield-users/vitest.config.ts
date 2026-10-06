import { defineConfig } from "vitest/config";

// Present so vitest never walks up and picks a parent directory's config.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
