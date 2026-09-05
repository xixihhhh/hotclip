import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import packageJson from "./package.json";

const runtimeDependencies = ["electron", ...Object.keys(packageJson.dependencies)];

export default defineConfig({
  main: {
    build: { rollupOptions: {
      external: (id) => runtimeDependencies.some((name) => id === name || id.startsWith(`${name}/`)),
      input: { index: resolve(__dirname, "src/main/index.ts"), "speech-worker": resolve(__dirname, "src/main/speech-worker.ts") },
      output: { format: "cjs", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js" },
    } },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@core": resolve(__dirname, "src/core"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
