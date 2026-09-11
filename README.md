# Robo Buddy

A lightweight desktop companion for Windows in the spirit of BonziBuddy and Clippy.
The default character is Rocco, a 3D scan of the author. Users can add their own
characters as GLB, VRM, animated WebP, GIF or PNG packs.

He watches your mouse, can be dragged and thrown, and dances to whatever is playing
through your speakers.

- Stack: Tauri v2 (Rust) + WebView2 + three.js. See `PLAN.md` for the design and milestones.
- Dev: `pnpm install`, then `pnpm tauri dev`.
- Build: `pnpm tauri build` produces NSIS and MSI installers under `src-tauri/target/release/bundle`.

Drop a GLB, VRM or FBX model onto the buddy to use it, or drop an FBX/GLB animation to add it to
the shared library; every clip is retargeted to every model at load, nothing is baked per rig.

Character packs live in `public/characters/` (bundled) and
`%APPDATA%/com.rocco.robobuddy/characters/` (user). Each has a `manifest.json`;
see `public/characters/rocco/manifest.json` and `pixel-pal/manifest.json` for the two formats.

## Install and run

**Just install it (you or a friend):** run `release\RoboBuddy-Setup-<version>.exe`. It installs per user, adds "Robo Buddy"
to the Start menu, and starts the buddy. The only requirement is Windows 10/11 with the WebView2 runtime, which every
current Windows already has (the installer fetches it otherwise). Uninstall from Settings > Apps like any other app.

- He lives in the tray: right-click the tray icon or the buddy himself for the menu (Settings, Bring buddy here, Pause, Quit).
- Settings > Window > "Start with Windows" launches him at sign-in.
- Everything he saves (settings, imported characters and clips, Piper voices, generated lines) lives in
  `%APPDATA%\com.rocco.robobuddy\`. Delete that folder for a clean slate.
- Talking needs an API key (Groq is free): Settings > Talk, see the Help tab there for the two-minute setup.

**Build the installer yourself:** `pnpm install` once, then `pwsh scripts/make-installer.ps1`. It runs `pnpm tauri build`
and copies the setup exe and the MSI into `release\`. Requirements: Node 20+, pnpm, Rust (this repo uses the gnu toolchain;
see the top of this README), and the Visual C++ build tools that Rust asks for.

**Run from source while developing:** `pnpm tauri dev` starts the Vite dev server and a debug build with hot reload of the
frontend. Rust changes need a restart.
