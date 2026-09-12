import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const git = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** Short commit and build date, shown in the settings window so a bug report can name a build. */
const { stamp: BUILD, dirty: DIRTY } = (() => {
  let commit = "nogit";
  let dirty: string[] = [];
  try {
    commit = git("git rev-parse --short HEAD");
    dirty = git("git status --porcelain").split("\n").filter(Boolean);
    if (dirty.length) commit += "+";
  } catch {
    // not a git checkout
  }
  return { stamp: `${commit} ${new Date().toISOString().slice(0, 10)}`, dirty };
})();

/**
 * A build made from a dirty tree is stamped with the commit it is *not*: commit afterwards and the
 * hash in the settings window names a tree that was never built, which is how one build went out
 * labelled as the commit before it. Building dirty to test is the normal way to work, so this only
 * says so; set ROBO_BUILD_STRICT=1 to make it an error instead.
 */
function warnIfDirty() {
  if (!DIRTY.length) return;
  // "XY path", though the first line has lost its leading space to the trim above.
  const names = DIRTY.map((l) => l.replace(/^.{0,2}\s+/, ""));
  const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? `, +${names.length - 6} more` : "");
  const msg =
    `\n  Building from a dirty tree. This build will be stamped "${BUILD}", which is not a commit\n` +
    `  anyone can check out; commit and rebuild if you are about to install or ship it.\n` +
    `  Uncommitted: ${shown}\n`;
  if (process.env.ROBO_BUILD_STRICT) throw new Error(msg);
  console.warn(`\x1b[33m${msg}\x1b[0m`);
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ command }) => {
  if (command === "build") warnIfDirty();
  return {
    clearScreen: false,
    define: { __BUILD__: JSON.stringify(BUILD) },
    build: {
      rollupOptions: {
        input: {
          buddy: resolve(__dirname, "index.html"),
          settings: resolve(__dirname, "settings.html"),
          screensaver: resolve(__dirname, "screensaver.html"),
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      watch: { ignored: ["**/src-tauri/**"] },
    },
  };
});
