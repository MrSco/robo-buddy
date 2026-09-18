<div align="center">

<img src="assets/brand/logo.png" alt="Robo Buddy Logo" width="380" style="border-radius: 18px;" />

# Robo Buddy

**A lightweight, reactive 3D desktop companion for Windows.**  
*In the spirit of classic desktop pets like BonziBuddy and Clippy — reimagined for modern Windows.*

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20x64-0078D4?style=flat-square&logo=windows&logoColor=white)](https://github.com/MrSco/robo-buddy/releases/latest)
[![Latest Release](https://img.shields.io/github/v/release/MrSco/robo-buddy?style=flat-square&color=10B981&label=release)](https://github.com/MrSco/robo-buddy/releases/latest)
[![Website](https://img.shields.io/badge/website-robo--buddy-06B6D4?style=flat-square&logo=cloudflare&logoColor=white)](https://robo-buddy.roccojuliano.workers.dev/)
[![Issues](https://img.shields.io/github/issues/MrSco/robo-buddy?style=flat-square&color=F59E0B)](https://github.com/MrSco/robo-buddy/issues)

[🌐 Official Website & Live 3D Playground](https://robo-buddy.roccojuliano.workers.dev/) • [📦 Download Latest Release](#-downloads) • [📖 Features](#-features) • [🐛 Report an Issue](https://github.com/MrSco/robo-buddy/issues)

</div>

---

## 📦 Downloads

| Package | Type | Description | Link |
| :--- | :--- | :--- | :--- |
| **RoboBuddy-Setup-0.7.2.exe** | **EXE Setup (Recommended)** | Standard per-user installer. Creates desktop & Start Menu shortcuts, auto-checks WebView2. | [📥 Download .exe](https://github.com/MrSco/robo-buddy/releases/latest/download/RoboBuddy-Setup-0.7.2.exe) |
| **RoboBuddy-0.7.2.msi** | **MSI Installer** | Windows Installer package for system administrators and enterprise deployment. | [📥 Download .msi](https://github.com/MrSco/robo-buddy/releases/latest/download/RoboBuddy-0.7.2.msi) |

> [!TIP]
> All releases, release notes, and file checksums are published on the [GitHub Releases](https://github.com/MrSco/robo-buddy/releases) page.

---

## ✨ Features

- 🔊 **Web Audio Foley Soundscape**: Realistic multi-sample physical sound effects for all interactions (footsteps, landings, impacts, jumps, pokes, sleep, wake, greetings, and bubble pops) with micro-pitch jitter and dynamic velocity scaling.
- 🎵 **Audio-Reactive Beat Dancing**: Listens to desktop audio using Windows WASAPI loopback without recording or uploading anything. The beat lock algorithm locks onto tempos so Buddy only grooves when real music is playing, with intelligent gating against his own footsteps and speech.
- 🪟 **Window Physics & Edge Climbing**: Open applications act as physical platforms. Throw Buddy across the screen with drag-and-fling momentum, watch him tumble, land on app title bars, grab ledges, and climb himself up.
- 📎 **Context-Aware Clippy Mode**: Buddy detects active apps (VS Code, Chrome, Terminal, Notepad, etc.) and chimes in with clever contextual tips and interactive action chips. Sensitive applications (e.g. password managers, incognito windows) are automatically blacklisted.
- 💥 **Screensaver Havoc**: When idle, Buddy takes over the screen and treats a freeze-frame snapshot of your desktop as an arena. He leaps around breaking falling grid tiles or fractured glass cutouts before a CRT TV power-off collapse into the void.
- 📷 **Webcam Mocap & Mirror**: MediaPipe tracks body posture and 21 points per hand locally on your machine. Turn on *Mirror* to make Buddy mimic your moves live on your desktop.
- 🗣️ **Local & Cloud AI Voice**: High-speed cloud providers (Groq, Gemini) or 100% offline local LLMs via Ollama. Offline Piper neural voices synthesize speech locally with zero latency.
- 🎭 **Custom 3D Characters**: Drag-and-drop any GLB, VRM, or animated WebP/GIF pack directly onto Buddy to swap characters instantly. All animation clips are retargeted dynamically at runtime.

---

## 💻 System Requirements

- **Operating System**: Windows 10 (64-bit) or Windows 11 (64-bit)
- **Runtime**: Microsoft Edge WebView2 Runtime *(preinstalled on modern Windows 10 and 11)*
- **Audio Reaction**: Requires standard Windows audio output device (WASAPI loopback)
- **Webcam Mocap (Optional)**: Any standard USB or built-in webcam
- **AI Voice (Optional)**: Free Groq or Gemini API key, or local Ollama instance

---

## 🚀 Quick Start Guide

1. **Install**: Run `RoboBuddy-Setup-0.7.2.exe` and follow the quick setup wizard.
2. **System Tray**: Look for the Robo Buddy icon in your Windows taskbar notification area (system tray). Right-click it (or right-click Buddy himself) to access:
   - **Settings**: Audio sensitivity, character management, AI brains, and screensaver options.
   - **Bring Buddy Here**: Instantly teleports Buddy to your current cursor position.
   - **Pause / Wake**: Pauses physics and animation when you need full focus.
   - **Quit**: Closes the application.
3. **Throw & Interact**: Left-click and drag Buddy to fling him across your monitors. Click on him to trigger reactions.
4. **Drag-and-Drop Characters**: Drag any `.glb` or `.vrm` 3D model file directly onto Buddy's body to switch models on the fly.
5. **Data Directory**: User settings, custom models, and downloaded voice packs are stored cleanly in:
   ```plaintext
   %APPDATA%\com.rocco.robobuddy\
   ```

---

## 🐛 Bug Reports & Feature Requests

Encountered an issue or have a suggestion? We'd love to hear from you!

- Search existing reports or file a new bug on our [Issue Tracker](https://github.com/MrSco/robo-buddy/issues).
- Please provide your Windows version, graphics hardware, and steps to reproduce.

---

<div align="center">
  <sub>Built with Tauri v2, Rust, Three.js, and Web Technologies.</sub>
</div>

---

## 🛠️ Developing

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

A manifest's `persona`, `lines` and `llm` say who that character is when it talks. For a
character you imported, Settings > Talk > Personality with "As the character" chosen edits
those three in place and writes them back to that pack's own `manifest.json`, so the
personality belongs to the model and survives switching profiles. Bundled packs are
install-directory assets and stay read-only; copy one to a profile of your own instead.

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
