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
