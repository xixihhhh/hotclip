import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@core": resolve(__dirname, "src/core"),
    },
  },
});
