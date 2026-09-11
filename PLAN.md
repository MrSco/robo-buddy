# Robo Buddy — Plan

A lightweight, slick desktop companion for Windows in the spirit of BonziBuddy / Clippy.
Default character: Rocco (`rocco_3d_dancing.webm`). Users can drop in their own characters.
Reacts to music playing on the PC and to the mouse. Every reaction is optional.

## 1. Stack decision

**Tauri v2 (Rust backend) + WebView2 renderer + Vite/TypeScript frontend.**

Why this and not the alternatives:

| Option | Verdict | Reason |
|---|---|---|
| Tauri v2 + WebView2 | **Pick** | ~8 MB install, ~60-90 MB RAM. WebView2 is preinstalled on Win11. Plays VP9-alpha webm natively in `<video>`. Transparent always-on-top windows supported. Character packs can be plain media or HTML/CSS/JS, so customization is trivial for users. Rust side handles the OS-level bits (audio loopback, cursor, tray, click-through). |
| Electron | No | 150 MB+ install, 150 MB+ RAM. Not "lightweight". |
| WPF / WinUI (C#) | No | Layered transparent windows are slow paths, and nothing native plays VP9-alpha. We'd have to convert every character to PNG sequences. |
| Pure Rust (winit + wgpu) | Later, maybe | Smallest footprint (~20 MB RAM) but we'd bundle a VP9 decoder and lose the HTML-based character format. Only worth it if RAM complaints show up. |
| Godot | No | Good transparent-window support but no audio loopback, and user-made characters require Godot skills. |

Asset finding: `rocco_3d_dancing.webm` is VP9, 512x512, 30 fps, 2.7 s loop, with a true alpha channel.
Decode with `libvpx-vp9` (not the default ffmpeg VP9 decoder) whenever we process it offline.
Webm is NOT the core character format (see section 3). It is an import that gets converted.

## 2. Architecture

```
robo-buddy/
  src-tauri/                 Rust
    src/main.rs              app setup, windows, tray, plugins
    src/audio.rs             WASAPI loopback capture -> FFT -> bands/energy/beat/BPM, emitted as events
    src/cursor.rs            GetCursorPos polling (60 Hz) + global click detection, emitted as events
    src/clickthrough.rs      toggles set_ignore_cursor_events based on frontend alpha hit-test
    src/settings.rs          JSON settings in %APPDATA%
    tauri.conf.json          buddy window: transparent, decorations off, shadow off, alwaysOnTop, skipTaskbar
  src/                       Frontend (Vite + TS, Svelte or Solid for the settings UI)
    buddy/                   the character window
      renderer3d.ts          three.js: GLB skinned mesh, AnimationMixer, look-at bone, transparent canvas
      renderer2d.ts          ImageDecoder-based frame player for webp/gif/apng/sprite sheets
      brain.ts               behaviour state machine (idle, dance, look, dragged, thrown, sleep)
      physics.ts             drag, throw, gravity to screen bottom, walk along bottom edge
      audio-react.ts         maps audio features -> playbackRate, bounce, scale pulse
      mouse-react.ts         maps cursor position -> look direction, hover, poke
    settings/                settings window UI
  public/characters/         bundled packs, served as static assets by Vite
    rocco/
      manifest.json
      rocco.glb              in3D export: 10k verts, 52-bone Mixamo skeleton, T-pose, 1 texture, 1.6 MB
    pixel-cat/               2D sample pack: one animated webp per state
  (user packs live in %APPDATA%/robo-buddy/characters and load via the asset protocol)
  scripts/
    convert-webm.ps1         ffmpeg (libvpx-vp9) -> animated webp, alpha preserved
    validate-pack.ts         manifest checker
```

Two windows:
- **Buddy window**: transparent, undecorated, always on top, not in taskbar, sized to the character. Moves with drag.
- **Settings window**: normal window, opened from the tray menu.

Tray menu: Characters submenu, Settings, Pause reactions, Quit.

### Data flow
1. Rust `audio.rs` captures the default output device in loopback mode via the `wasapi` crate, runs `rustfft` on ~1024-sample frames, and emits `{rms, bass, mid, treble, onset, bpm}` at 30 Hz.
2. Rust `cursor.rs` emits `{x, y, buttons}` at 60 Hz plus `screen` geometry.
3. Frontend `brain.ts` consumes both, picks a state, and `renderer.ts` shows the state's clip with transforms.
4. Frontend hit-tests the canvas alpha under the cursor each frame and tells Rust to enable click-through when over transparent pixels. That gives pixel-perfect clicking on the character while everything around it stays clickable.

## 3. Character format

Decision: webm is not the core format. Two tiers.

### Tier 1 (flagship): real-time 3D, GLB/glTF via three.js
Rocco is a 3D model, so ship the model, not baked video.
- Real cursor tracking through a head/neck bone, not a sprite flip.
- AnimationMixer blends idle -> dance, and dance weight follows music energy.
- Crisp at any size, one file of a few MB instead of one video per state.
- Animations are retargeted by bone name from the app's shared clip library (see section 7). No manual rendering.
- Cost: three.js (~600 KB) and a WebGL canvas. One skinned mesh at 256 px is negligible GPU load.
  Render at 30 fps while active, drop to 5 fps idle, stop entirely when asleep.

### Tier 2 (easy mode): 2D raster
- On disk: animated WebP (default), PNG sprite sheet, GIF, APNG.
- Decoded with the browser ImageDecoder API into a frame array. Exact frame stepping,
  so frames can be placed on beats instead of nudging playback speed.
- Frames are decoded at display size to keep memory sane (256 px x 80 frames ~ 20 MB).
- A folder containing a single GIF is a valid character.

### Imports
- webm with alpha: converted to animated WebP by `scripts/convert-webm.ps1` (libvpx-vp9 decode).
- Possible tier 3 later: Rive, for vector characters with authored state machines and inputs.

### manifest.json

```json
{
  "name": "Rocco",
  "author": "rocco",
  "version": 1,
  "size": 256,
  "anchor": [0.5, 1.0],
  "renderer": "3d",
  "model": "rocco.glb",
  "lookAtBone": "mixamorigHead",
  "states": {
    "idle":     { "clip": "Idle",         "loop": true },
    "dance":    { "clip": "HipHopDance",  "loop": true, "beatsPerLoop": 8 },
    "dragged":  { "clip": "Falling",      "loop": true },
    "poked":    { "clip": "Surprised",    "loop": false, "then": "idle" },
    "sleep":    { "clip": "Idle",         "loop": true, "playbackRate": 0.3 }
  },
  "reactions": {
    "music":   { "enabled": true, "threshold": 0.15 },
    "mouse":   { "enabled": true, "lookAtCursor": true, "pokeState": "poked" },
    "physics": { "gravity": true, "throwable": true, "walk": false }
  }
}
```

A 2D pack sets `"renderer": "2d"` and each state's `clip` is a file
(`"dance.webp"`, or `{ "sheet": "dance.png", "frames": 24, "fps": 30 }`).
Any missing state falls back to `idle`.

`beatsPerLoop` makes dancing feel real: once BPM is detected, the clip runs so one loop spans exactly N beats.

## 4. Milestones

**M0 — Skeleton (goal: transparent Rocco on the desktop)** — DONE Sep 10 2026
- Scaffold Tauri v2 + Vite TS.
- Buddy window: transparent, undecorated, always on top, skip taskbar.
- Rocco rendered as a GLB via three.js on a transparent canvas (or, until the model arrives, as a 2D webp converted from the existing webm).
- Drag to move via `startDragging`. Tray icon with Quit. Remember position.
- Verify: no white box, no shadow, no flicker, GPU use idle when nothing moves.
- Result: works. Drag, close, relaunch restores position. Note: Rust here is the Chocolatey gnu toolchain, so the lib is `rlib` only (cdylib overflowed the MinGW export table). Memory: ~43 MB app + WebView2 helper processes, to be measured properly and trimmed in M4.

**M1 — Mouse** — DONE Sep 10 2026 (plus VRM support)
- Rust polls the global cursor and buttons at ~120 Hz and streams `cursor` events; `work_area` command returns the monitor's work area.
- Pixel-perfect click-through: after each render the alpha under the cursor is read back and `setIgnoreCursorEvents` toggled.
- Head/neck/chest look-at with smoothing. Poke (click without drag) hops and throws the head back.
- Custom drag (not the OS drag loop) so release velocity is known; throw, gravity, floor bounce, wall bounce, landing squash, airborne flail.
- VRM loads through `@pixiv/three-vrm` on the same GLTFLoader. `scripts/glb_to_vrm.py` wraps a Mixamo GLB as VRM 1.0; Rocco exists in both forms.
- Lesson: every procedural bone must be reset each frame before rotating, or it accumulates. Debug builds mirror physics state into the window title.

**M2 — Music** — DONE Sep 10 2026 (procedural dance; clip-based dance comes with M3 packs)
- `src-tauri/src/audio.rs`: WASAPI loopback of the default output via the `wasapi` crate, 2048-point FFT at 512-sample hops,
  bass/mid/treble/level with slow AGC plus an absolute loudness gate (-55..-35 dBFS), spectral-flux onsets, autocorrelation BPM (60-180),
  emitted as `audio` events at 30 Hz. Verified: locks onto a synthetic 120 bpm track within ~6 s; idle with no music.
- `src/audio.ts`: smoothing, dance hysteresis (0.8 s on, 2.5 s off), beat clock that resyncs on detected beats and free-runs from BPM.
- `src/dance.ts`: procedural groove (bounce, sway, twist, knees, alternating arm raise, head nod) designed for a front camera.
- Lesson (again): every bone a procedural layer touches must be reset each frame. Dance-only bones (hips, legs) are reset in `applyDance`.
- Lesson: screen coordinates are negative on monitors left of or above the primary. Never use a negative coordinate as a sentinel; `cursor.valid` exists for that. Scale factor is refreshed on `onScaleChanged` for mixed-DPI setups.
- Lesson: hidden Browser-pane tabs do not run requestAnimationFrame, so visual checks of the dev fallback need the pane visible.
- Sensitivity slider and per-character threshold UI: deferred to M3 settings window.

**M3 — Characters and settings** — DONE Sep 10 2026
- Packs: bundled (`public/characters/index.json`) plus user packs in `%APPDATA%/com.rocco.robobuddy/characters/<folder>/`,
  served through the Tauri asset protocol. `import_pack` copies a GLB/VRM/WebP/GIF/PNG into a new folder with a generated manifest.
- Clip pipeline: embedded glTF animations and external clip files (`manifest.clips`) retargeted by bone name onto the humanoid map.
  Procedural layers reset to the mixer's output each frame, and idle only drops arms a clip is not driving. Rocco's poke plays `clips/wave.glb`,
  a synthetic clip baked by `scripts/make_wave_clip.py` in the same shape a Mixamo FBX->GLB conversion produces.
- State machine in `main.ts`: dragged > fall > poked > dance > idle; each state maps to a pack clip or a procedural fallback.
- 2D renderer (`renderer2d.ts`): ImageDecoder frame stepping for WebP/GIF/APNG plus PNG sprite sheets, beat-synced loops, alpha hit-test via getImageData.
  Bundled sample "Pixel Pal" is generated by `scripts/make_pixel_pal.py`.
- Settings window (`settings.html`): character picker + import, size, pause, mouse/physics/music toggles, sensitivity, steady-tempo gate,
  click-through mode (pixel/window/locked), autostart. Opens from the tray or by double-clicking the buddy. Live-applies via `settings-changed`.
- Tray: Settings, Pause reactions (check item), Quit.
- Lesson: never assign a renderer before its assets are loaded, and wrap the frame in try/catch; an exception in requestAnimationFrame silently kills the loop.
- Lesson: keep one WebGL renderer per canvas for the app lifetime; `forceContextLoss` leaves the canvas unusable for the next renderer.
- Not tested here: the autostart toggle (writes a Run registry entry) and the file-picker import; both use stock Tauri plugins.

**M4 — Polish and ship** — in progress, Sep 10 2026
- Done: idle-to-sleep (`sleepAfterMin`, hover/poke/drag/music wake him), speech bubbles (`src/bubble.ts`, per-pack `lines`),
  sounds (`src/sound.ts`, per-pack `sounds`; Pixel Pal ships boing/thud), sounds/bubbles/sleep controls in settings, autostart (M3).
- Done: release build via `pnpm tauri build` (NSIS + MSI under `src-tauri/target/release/bundle`).
- Done: Quaternius Universal Animation Library (Standard, CC0) retargeted onto the Mixamo rig by `scripts/retarget_clips.py`
  (world-space delta method between T-poses, hips offset scaled by hip height). 42 clips in `public/clips/ual/`, source GLB in `assets/ual/`.
- Done: idle behaviour (`src/behavior.ts`): idle variants, fidget one-shots and sequences, wandering along the taskbar with a walk clip
  and body turn; dance choice per session (random / fixed / procedural) from the pack's `dances` list. Settings: wander toggle, dance picker.
- Done: model thumbnails in the settings character picker (`src/preview.ts`).
- Deferred: updater plugin (needs a signing key pair and a hosted latest.json), code signing,
  memory trimming of the WebView2 helper processes, interacting with other windows (sit on title bars, push windows) -> M5.
- Done: "Bring buddy here" (tray + settings button) teleports him to the floor of the monitor under the cursor. Wandering keeps him on his current monitor, so on a multi-monitor desk he can be out of sight.
- Done: uncaught errors are mirrored into the hidden window title in every build (read with GetWindowText) since release builds have no devtools.
- Lesson (the invisible-buddy bug): Tauri v2 creates config windows before `setup`, and the release frontend loads fast enough to call `get_settings` before `app.manage` ran. Anything a window needs on load must be managed on the Builder. Debug builds hid it because the Vite dev server is slower.
- Note: when the screen saver or secure desktop is active, GetCursorPos fails and WebView2 stops painting; the app shows cur=0,0 and an all-zero probe. Not a bug.
- Done: 19 Mixamo dances plus hanging/falling/landing and 8 idles, fetched through the user's logged-in Chrome, converted by `scripts/fbx_to_glb.py` (Blender headless) and baked with `--map=mixamo`. Source FBX kept in `assets/mixamo/`.
- Done: click-vs-hold (a press becomes a grab after 6 px or 220 ms; a quick release is a poke), held plays Hanging Idle, airborne plays Falling Idle.
- Done: clip transitions never drop total mixer weight below one (no more T-pose flashes); a state without a clip keeps the last clip as its base.
- Done: drag across monitors picks the destination monitor's work area synchronously (all work areas cached).
- Done: settings gallery with posed thumbnails, a live animated preview, per-pack idle-set checkboxes.
- More dances: only one in the free library. See `docs/dances.md` for the Mixamo route and the Fortnite-emote lookalike list.
- Lesson: a scheduler that picks an activity must also push its own next-event time, or it re-rolls every frame.
- Lesson: clips that key only some bones flicker during crossfades (unkeyed bones blend toward the rest pose). Hips translation must be kept for crouches and kneels or the feet leave the floor.
- Lesson: procedural rotations about world X need the sign checked visually; look-at uses negative pitch for "up".

## 5. Known Windows gotchas
- Transparent windows need `decorations: false` and `shadow: false` or you get a grey frame.
- The default ffmpeg VP9 decoder drops alpha. Use `-c:v libvpx-vp9` for any offline processing.
- `cpal` does not do WASAPI loopback. Use the `wasapi` crate directly.
- Click-through must be toggled dynamically, or the character either blocks clicks in its bounding box or can't be clicked at all.
- WebView2 may throttle timers when the window is unfocused. Drive animation from `requestAnimationFrame` and video playback, not `setInterval`.

## 6. Open items that need Rocco's input
- (resolved) The rigged source model exists: `Rocco 3D Model - in3D/model.glb`. Rocco launches in 3D.
- Framework for the settings UI: Svelte is the lightest. Solid or React are fine if preferred.
- Name of the app and whether packs should be shareable from a public gallery in a later version.

## 7. User workflow: from "me" to a rigged buddy (verified Sep 2026)

### The key fact
Rocco's in3D export is a skinned GLB with the **Mixamo skeleton** (`mixamorig:Hips` ... 52 joints), T-pose, no animations.
Tripo, Meshy, and in3D all emit Mixamo-named rigs. So the app standardises on that skeleton and ships **one animation
library** that retargets by bone name onto any user's character. Users never open Blender and never touch Mixamo.

Confirmed by rendering `model.glb` in three.js: loads, skinned, head bone found and deforms the mesh.

### Three ways in (pick by what the user has)

| Path | Tool | Cost | Output | Notes |
|---|---|---|---|---|
| A. Scan yourself (photoreal) | in3D (iOS) | 2 free scans, then $19.99 / 5 scans | rigged GLB, Mixamo skeleton, T-pose | Exactly what Rocco has. Best likeness. |
| B. One photo (AI) | Tripo or Meshy (web) | Free tier: Tripo 300 cr/mo, Meshy 100 cr/mo; rig + animate free on Meshy | rigged GLB/FBX, optional preset clips baked in | Free-tier models are public + CC BY 4.0. "AI guess of you", not a scan. Also makes cartoon/non-human characters. |
| C. Bring a mesh | KIRI Engine (free scans) or any modeller, then AccuRIG 2.0 (free, Windows) or Sorceress (browser) | Free | rigged FBX/GLB, Reallusion or SMPL bone names | Needs the app's bone-name maps (Mixamo, Reallusion/CC, VRM). Power-user path. |

Dead ends: Ready Player Me shut down Jan 31 2026. Mixamo is free but has been unreliable since June 2025 and
is unsupported; treat it as a personal download source, not as a pipeline dependency.

### Animation library (shipped with the app)
- Base set: Quaternius Universal Animation Library (CC0, built for the Mixamo skeleton): idle, dances, waves, sits, falls.
- Optional: user drops their own Mixamo FBX downloads (their licence, their download) into the pack folder.
- Optional: clips already baked into a Tripo/Meshy GLB are used as-is.
- Retarget rule: match by bone name after normalising prefixes (`mixamorig:`, `mixamorig`, none). Non-Mixamo rigs go through a name map.

### In-app "Character Studio" (M3)
1. Drop a GLB or FBX (FBX converted via three.js FBXLoader -> GLTFExporter).
2. Detect skeleton convention, show preview, warn if not T/A-pose or if head bone missing.
3. Auto-assign states from the shared library (idle, dance, poked, dragged, sleep) with a picker to swap clips.
4. Save as a pack folder with manifest. Share as a zip.

### Rocco specifically
- Use `model.glb` as-is. Textures are a single 2048 atlas at 978 KB; fine for a 256 px buddy.
- Higher-detail `model_T.fbx` (separate 2048 head/body/arms/legs textures) is available if we ever want a close-up mode.

## 8. Prior art (checked Sep 10 2026) and what we borrow

| Project | What it is | Open? | Take-away |
|---|---|---|---|
| Desktop Mate (Steam) | Unity, VRM avatars, very popular, custom models only via MelonLoader mods | No | Validates the market. VRM is the de-facto avatar format users already own. |
| 3D Desktop Pets (Steam, app 3404940) | Free, VRM import, desktop effects, Workshop. 18 reviews, 72% | No | Small. No music reactivity. Also VRM-first. |
| BongoCat (ayangweb) | Tauri v2, MIT, 21k stars, Live2D cat reacting to keyboard/mouse, custom model import, autostart | Yes | Same shell as ours. Reference for global input hooks (rdev), click-through, autostart, tray and settings UX. |
| Roboticela/Animator | Tauri + three.js animation studio, bone-name heuristics incl. VRM | Yes | Reference for retargeting heuristics and GLB export of clips. |

Conclusion: nothing open-source does 3D + music + "scan yourself". The shell (transparent window, tray, drag)
is commodity and took one session. We keep our codebase and borrow patterns from BongoCat.

### VRM becomes a first-class format (added to Tier 1)
- Same GLTFLoader plus the `@pixiv/three-vrm` plugin. Gives a standard humanoid bone map, built-in look-at, and expressions.
- Opens the whole VRoid Studio (free) and VRoid Hub ecosystem, plus every model Desktop Mate users already have.
- VRM's humanoid map also solves retargeting generically: Mixamo, Reallusion and VRM rigs all map to the same humanoid bone list.

## M5 — Any animation on any model (DONE Sep 10 2026)
- Runtime humanoid retargeting (`src/retarget.ts`): clips are expressed as world-rotation deltas against a T-pose and fitted
  to the target rig at load, lazily on first use. Bone maps for Mixamo, Unreal/Quaternius, VRM and common Blender names
  (`src/humanoid.ts`); A-posed rigs are straightened for the reference; facing and Z-up are detected and corrected.
  Verified on Rocco (Mixamo), the Quaternius mannequin (Unreal rig, GLB and FBX) and Rocco VRM.
- Native FBX for models and animations via three.js FBXLoader; units and up-axis normalised on load.
- Shared library (`src/library.ts`): bundled UAL + Mixamo clips plus user clips in `%APPDATA%/.../clips/`; every 3D pack sees
  every clip; per-clip roles (idle/fidget/dance/poke/held/fall/walk/off) live in settings and override manifest defaults.
- Import: drag a model or animation onto the buddy or the settings window; the file is staged, classified by whether it has a
  mesh, and filed as a pack or a clip. The Import button still works. FBX textures beside the file are brought along.
- Settings: animation library panel with search, source filter, role picker and preview-on-model.
- Polish: single-instance (a second launch summons the buddy), right-click menu on the buddy, hide while a fullscreen app is
  focused, frame skipping while asleep/hidden, camera fits the pose so raised arms are never clipped.
- Deferred: auto-updater (Tauri's updater needs a public endpoint for the manifest; the repo is private), code signing,
  window interactions (sit on title bars), keyboard reactions.
- Grab-aware holding: the body part under the cursor at press time decides the hold. Head/torso: two-handed hanging clip
  (re-downloaded from Mixamo with Character Arm-Space 85 so the hands are together). Arm: that arm aims straight up and the body
  dangles from it. Leg: he flips upside down. The held point is steered under the cursor and dragging sideways swings him like a pendulum.
- Lesson: procedural limb poses should aim bones at world directions (`aimBone`) rather than add fixed angles, so they work over any base clip.

## Ragdoll, step 1 (DONE Sep 10 2026)
- Physically driven limbs while held or airborne (`src/secondary.ts`): each arm, leg and the head is a damped spring driven by the
  window's own acceleration (`WindowPhysics.accelX/Y`, finite differences smoothed). Yank sideways and the limbs lag and swing back;
  drop him and they trail upward. Layered over whatever clip plays; a limb the cursor holds stays rigid.
- Throw spin: releasing with sideways speed sets `spin`; the renderer integrates a tumble while airborne, rotates about the body's
  middle and widens the camera fit to the rotated extent so no part leaves the window. Spin is zeroed on floor contact; a stiff spring
  brings him upright, then a hard landing plays the pack's `land` clip (Jump Land) before the idle resumes.
- Knocked down: a landing while tumbling (or a very hard one) freezes the clip, flops him onto his side with the lowest point on
  the floor line, arms and head go limp for 1.1-1.7 s, then he springs upright into the land clip. Music moves and the dance clip
  are suppressed while held, airborne or down; limb holds use the hanging clip as their base. Wall bounces reverse the spin.
- Lesson: a pointerdown must seed the left-button bit itself; the global button poll can lag a frame and the press was read as a
  release, turning a drag into a poke.
- Music gate: compares a ~1 s average of the level with the threshold (hysteresis 0.8x to stop) instead of requiring the raw
  level to stay above it continuously; real music swings around any threshold every beat and never satisfied the old gate.
  Settings show a live level meter with the threshold marker under the sensitivity slider. Changing the dance while he dances
  switches the clip immediately.
- Camera fit is now per-frame from every bone (padded), perspective-correct including how far the nearest part leans toward
  the camera, with the feet at a fixed margin; zooms out within a frame or two, back in gently. Clips with root motion toward
  the camera no longer crop him. He re-asserts always-on-top every 2 s so newer topmost windows (the Claude app, players) do
  not bury him.
- Holds are procedural ragdoll dangles now: head/torso hang everything below the grab point, arm and leg holds as before.
  The bundled packs no longer name a hanging clip (a pack or a library "held" role can still add one, which is then used for
  head/torso holds). The root rotation is reset before posing each frame; hold poses aim at world directions and last frame's
  flip was folding him over.
- Settings: two columns when wider than 800 px (character + window left, reactions right, library full width), one column
  below that; default window 940x780. Library previews revert to the idle after one play (loops: a few seconds); the play
  button turns into a stop button while previewing.
- Step 2 (deferred until played with): a real Rapier ragdoll with joint limits while airborne, blended back to the idle on landing.

## What is left (Sep 10 2026)
- Ragdoll step 2: joint-limited Rapier ragdoll while airborne, blended back to the idle on landing.
- Window interactions: sit on title bars, peek over windows, get pushed by a window dragged into him.
- Keyboard reactions (typing burst = he watches the keyboard, Ctrl+S = thumbs up).
- Auto-updater (needs a public manifest endpoint or a GitHub release feed) and code signing.
- WebView2 memory trimming while asleep / hidden.
- A "Getting Up" clip for the knocked-down recovery instead of Jump Land.

## M6 — Talk to him (built Sep 11 2026)
Goal: dynamic phrases and a real conversation, free by default, bring-your-own-key optional.
- Input: a text box that opens under the bubble on double-click or a hotkey; push-to-talk via Windows' built-in
  offline speech recognition (WinRT `Windows.Media.SpeechRecognition` from Rust, no cloud, no key) as the mic path.
- Output: the speech bubble, plus optional voice via the Windows speech synthesiser (WinRT, offline) or the WebView's
  `speechSynthesis`; a `talk` idle clip and lip-less "talking" head motion while he speaks.
- Brain: an OpenAI-compatible chat endpoint in settings (URL + key + model). Works unchanged with a local Ollama
  (free, private), Groq / Gemini free tiers, OpenAI, or Anthropic through its OpenAI-compatible route. Persona prompt per
  character pack (`manifest.persona`), short memory of the last few turns, hard cap on tokens per reply.
- Dynamic phrases: once an endpoint is set, batches of idle lines (greet, poked, land, dance, sleep) are generated per pack
  and cached in `%APPDATA%`, so the bubble stops repeating the same ten strings; falls back to the manifest lines offline.
- Guardrails: nothing leaves the machine unless an endpoint is configured; the key is stored in Windows Credential
  Manager, not in settings.json; a per-day request cap in settings.
- As built: `src-tauri/src/chat.rs` (reqwest to `{endpoint}/chat/completions` and `/audio/transcriptions`, `keyring`
  for the key, daily cap in `chat_usage.json`, phrase cache in `phrases/<pack>.json`); `src/chat.ts` (ChatClient with the
  last 10 turns, TalkBox strip at his feet with mic via MediaRecorder, Voice via speechSynthesis, phrase generation);
  Settings > Talk with presets for Groq, Gemini, OpenAI, Ollama and custom. Double-click him or right-click > Talk to him.
  Mic transcription goes to the same endpoint (Groq's Whisper); Gemini and Ollama have no speech model, so the mic hides.
- Lesson: the cursor poll only emits on change, so a click shorter than one poll interval is invisible to it. Presses end on
  the WebView's own pointerup; the poll is trusted for "released" only after it has seen the button down.
- Verified against a local mock OpenAI server (chat, phrase generation, the settings Test button); the mic path and real
  providers were not exercised here (no key on this machine).

- Follow-ups (Sep 11): the window covers the whole taskbar band and the camera reserves that band under the soles, so he
  stands on the taskbar's top edge with nothing clipped; topmost is re-asserted from a Rust thread with SetWindowPos (Tauri's
  set_always_on_top is a no-op when the flag is already set); the music gate holds while his own voice plays; replies outrank
  quips in the bubble and persist while the strip is open; the strip has a session history panel (memory only, 30 lines) and
  closes after 45 s idle; a separate speech endpoint (a local Vibe server is OpenAI-compatible at /v1/audio/transcriptions);
  Piper as a local voice (piper.exe + .onnx, WAV returned over IPC); personality profiles (`public/personalities/index.json`:
  persona, line bucket, temperature, reply length) selectable in Settings > Talk, with generated lines cached per pack+profile;
  settings use two balanced CSS columns; gentle drops no longer chain a land clip and a hop fidget (jump fidget removed,
  12 s calm after landing, land clip only for hard landings). A T-pose detector counts frames in the status title.

- Follow-ups (Sep 11, later): the topmost thread stands down while a menu (class #32768) or one of our own windows is in
  front, so the right-click menu is not covered; soft drops settle without bouncing (bounce only above 700 px/s), the falling
  clip waits a quarter second and survives bounces, the land clip needs a hard landing; personality profiles can be viewed and
  edited in Settings > Talk (built-ins read-only, "Save as new" makes a user copy in `%APPDATA%/.../personalities.json`,
  the buddy reloads on a `personalities-changed` event, generated lines are cached per persona text); Piper installed under
  `%APPDATA%/com.rocco.robobuddy/piper/` with the user's own `voices/rocco.onnx` (22 kHz, en-us); T-pose sightings are
  appended to `%APPDATA%/.../buddy.log` with state, clip and time so the user can send them back.

- Follow-ups (Sep 11, evening): settings are tabbed (Character, Reactions, Talk, Animations, Window; a side strip that
  becomes a top strip below 640 px), pages use two columns only above 860 px; the chat model is a pick-or-type box fed by
  `GET {endpoint}/models` (whisper-ish ids feed the speech box), default `groq/compound`; Groq requests carry
  `reasoning_format: hidden` and every reply passes `cleanReply` (drops <think> blocks, "Reasoning ... Response" preambles
  and markdown) before the bubble and the voice; Piper is managed by the app (`piper.rs`: install the 22 MB zip on demand,
  list `voices/*.onnx`, download from a small catalogue, open the folder) with an advanced override for a custom exe; the
  personality editor shows the pack's real persona and lines, read-only fields and disabled Save/Delete for built-ins,
  "Copy to a new profile" to fork.

- Follow-ups (Sep 11, night): the Animations tab shows the live preview beside a card grid of clips (the one WebGL canvas
  moves between the Character and Animations pages); soft drops: the falling clip waits 0.35 s, the arm flail is only for packs
  without a falling clip, bounces need 1100 px/s, the land line needs strength 0.55 and the land clip 0.7; the user's other
  Piper voices (bluey, friday, glados, hal, jarvis, tars) live in the managed voices folder (not bundled: 63 MB each).

- Settings polish (Sep 11): every option carries a tooltip; a Help tab covers getting started, characters (in3D -> Mixamo
  -> FBX/GLB), animations and roles, the two-minute Talk setup (Groq, Gemini, Ollama), microphone and local Whisper, Piper
  voices, and troubleshooting; the Character page is grouped (characters, size) and the Window page split into Clicking and
  Behaviour; the import dialog and hints include FBX (packs.rs accepted it already).

## M7 — Keyboard, window surfaces, webcam capture (in progress, Sep 11 2026)
- Keyboard (done): a Rust thread counts key presses four times a second (never which keys; only Ctrl+S and Ctrl+Z are
  recognised) and streams `keys` events. Three keys per second for a moment puts him in a `typing` state (the pack's
  `typing` clip, Texting by default); Ctrl+S and Ctrl+Z earn a quip, at most one per 15 s. Setting: React to typing.
- Window surfaces (done): a Rust thread streams the visible top-level windows (DWM frame bounds, z-order, cloaked and tool
  windows skipped). Falling, he lands on the first window top edge under his centre that no window in front covers; resting,
  he rides along when it moves and falls when it closes, minimises or slides away; wandering is bounded by that window.
  Setting: Stand on other windows. Lesson: GetAsyncKeyState polling misses taps shorter than the poll; bit 0 (pressed since
  the last poll) catches them.
- Climbing (done): falling past a title bar within arm's reach (edge between his crown and chest, not covered by another
  window) he grabs it and hangs (Hanging_Idle, hands at the edge, follows the window if it moves) for 0.9 s, then a 0.8 s
  eased pull-up during which the hanging clip gives way to the landing crouch, and he stands on top. Idle: `climbable()`
  finds a reachable edge (40-460 px above his hands, walkable, unoccluded); the scheduler walks him under it and `hop()`
  gives just enough jump for his hands to reach; on a window he sometimes walks off the edge and drops. All under the
  "Stand on and climb other windows" toggle plus wandering.
- Hand tracking (done): MediaPipe Hand Landmarker (bundled, loads on demand, "Hands and fingers" toggle on the Capture
  tab) adds 21 points per hand; finger segments become swing deltas on the 30 finger bones plus a hand bone aimed from
  the wrist to the knuckles. Poses carry a mask so untracked bones keep the clip's pose, and recordings only write tracks
  for bones the tracker saw. Handedness is swapped (MediaPipe labels assume a mirrored image) and then mirrored again.
- Mirror smoothness (done): every frame goes to the buddy and the renderer eases the shown pose toward the latest frame
  (nlerp, ~22/s), so 30 fps tracking reads smooth at 60 fps. The camera now also stops when the settings window is
  hidden: Rust emits `settings-hidden` on close (WebView2 does not fire visibilitychange for a hidden window).
- Get-up clips (done): Getting_Up (2.7 s), Getting_Up_2 (8.4 s) and Standing_Up (11.4 s) from Mixamo, converted and
  baked into the Mixamo library; the packs' `getup` state uses Getting_Up and the knocked-down recovery plays it instead
  of the landing crouch.
- Chat commands (done): `src/commands.ts` parses plain requests locally (dance / a named dance / for N seconds, stop,
  sleep, wake, come here, jump, climb, walk left/right, be quiet for N minutes, "do the <clip>") and acts at once; the
  model gets an abilities line in its system prompt and may append one `<do:...>` tag, which is stripped and run when the
  local parse found nothing. A commanded dance runs without music (45 s default); "stop" also mutes music dancing for two
  minutes; a commanded nap ignores mouse traffic for five minutes; "quiet" pauses idle chatter. Typing into the talk strip
  no longer counts as typing-along.
- Landing bands (done): edge between crown and chest -> grab and hang; between chest and feet -> a quick step-up mantle
  (0.25-0.7 s, landing crouch); at or below the feet -> the ordinary landing.
- Webcam capture (done): Settings > Capture (or right-click > Copy me). MediaPipe Pose Landmarker (lite model and WASM
  bundled under `public/mediapipe/`, nothing leaves the PC) tracks 33 landmarks on the webcam feed with a wire skeleton
  drawn over it. `src/mocap.ts` turns world landmarks into world-space rotation deltas against the canonical rig's T-pose
  (limb bones by direction, hips/chest/head by a right-up basis; mirrored so your left drives his right; One Euro filtered;
  hips height from the hip-to-ankle span) and `MirrorApplier` puts them on any rig with the clip retargeter's delta method.
  The settings preview mirrors live; "Mirror on the buddy" streams every other frame as a `pose` event and he enters a
  `mirror` state. Record / Stop / Save turns frames into a 30 fps clip on the canonical rig (loop ends eased together),
  exports a GLB and files it under the user's clips with a role. WebView2 asks for camera permission once per origin.

- Help tab mentions Capture. Left for later: a "Copy me" toggle that survives closing the settings window (the camera
  lives in that webview, so mirroring stops when it hides), hand and finger tracking, and a get-up clip for M8's ragdoll.

## M7 (original proposal) — Webcam motion capture
Goal: drive the model live from the user's webcam, and record what they do as a clip for the library (a dance, an idle).
- Tracking in the settings window (it already has a camera-free 3D preview): MediaPipe Pose Landmarker (tasks-vision,
  WASM + the lite model bundled locally, no cloud) on a `getUserMedia` stream. 33 world landmarks at 30 fps on CPU/GPU.
- Preview: the webcam frame with the wire skeleton drawn over it, next to the live 3D preview mirroring the pose. Started
  from Settings > Capture or right-click > "Copy me" on the buddy (which mirrors the pose live on the desktop until stopped).
- Landmarks to bones: build a canonical-rig pose per frame from limb directions (shoulder->elbow->wrist, hip->knee->ankle,
  hips->shoulders for the spine, ear/nose for the head), smoothed with the One Euro filter, hips height from the ankles.
  The same `retarget.ts` delta method then fits it to any character, so a recording works on every model.
- Recording: 30 fps quaternion tracks on the canonical rig, trimmed, looped by cross-fading the ends, exported as a GLB
  into the user clips folder and tagged with a role (dance/idle/fidget) like any imported clip.
- Stretch: two-hand gestures as pokes, mirroring the user's head turn when idle.
