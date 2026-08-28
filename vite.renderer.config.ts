import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

/** Browser-mock development surface: exercises the renderer without installing or launching Electron. */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
    },
  },
});
