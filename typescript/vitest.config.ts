import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    typecheck: {
      // Type-level tests (plan M2): *.test-d.ts files assert what
      // compiles and what must not.
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
});
