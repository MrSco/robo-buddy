import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

/** Short commit and build date, shown in the settings window so a bug report can name a build. */
const BUILD = (() => {
  let commit = "nogit";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (dirty) commit += "+";
  } catch {
    // not a git checkout
  }
  return `${commit} ${new Date().toISOString().slice(0, 10)}`;
})();

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: {
    rollupOptions: {
      input: {
        buddy: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
