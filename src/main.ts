import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Music } from "./audio";
import { cursor, IN_TAURI, startInput } from "./input";
import { listPacks, resolvePack, validateManifest, type Manifest, type PackRef } from "./packs";
import { WindowPhysics } from "./physics";
import type { FrameInput, Renderer, StateName } from "./renderer";
import { Renderer2D } from "./renderer2d";
import { Renderer3D } from "./renderer3d";
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged, type Settings } from "./settings-store";

const BASE_W = 320;
const BASE_H = 440;

// ---------- stage ----------
const stage3d = document.getElementById("stage") as HTMLCanvasElement;
const stage2d = document.getElementById("stage2d") as HTMLCanvasElement;

let renderer: Renderer | null = null;
let renderer3d: Renderer3D | null = null;
let renderer2d: Renderer2D | null = null;
let manifest: Manifest | null = null;
let pack: PackRef | null = null;

let cssW = BASE_W;
let cssH = BASE_H;
function resize() {
  const w = window.innerWidth || BASE_W;
  const h = window.innerHeight || BASE_H;
  if (w !== cssW || h !== cssH) {
    cssW = w;
    cssH = h;
    renderer3d?.resize(w, h);
    renderer2d?.resize(w, h);
  }
}

// ---------- state ----------
let settings: Settings = { ...DEFAULT_SETTINGS };
let physics: WindowPhysics | null = null;
let music: Music | null = null;
let scaleFactor = 1;
let loading = false;

let danceAmount = 0;
let sincePoke = Infinity;
let sinceLand = Infinity;
let landStrength = 0;
let yaw = 0;
let pitch = 0;
let ignoringCursor: boolean | null = null;
let currentState: StateName = "idle";
let pokeUntil = -1;
let pokePending = false;
let settingsEvents = 0;
let bootStamp = Date.now() % 100000;

const headWorld = new THREE.Vector3();

// ---------- boot ----------
async function boot() {
  await startInput();
  settings = await getSettings();

  const p = new WindowPhysics({ gravity: false, throwable: false });
  p.onPoke = () => {
    sincePoke = 0;
    pokePending = true;
  };
  p.onLand = (speed) => {
    sinceLand = 0;
    landStrength = Math.min(1, speed / 2500);
  };
  await p.init();
  if (IN_TAURI) {
    const win = getCurrentWindow();
    scaleFactor = await win.scaleFactor();
    await win.onScaleChanged(async ({ payload }) => {
      scaleFactor = payload.scaleFactor;
      const size = await win.outerSize();
      p.w = size.width;
      p.h = size.height;
    });
  } else {
    p.x = window.screenX;
    p.y = window.screenY;
  }
  physics = p;

  await applySize(settings.size);
  await loadPack(settings.character);
  applySettings(settings);
  await onSettingsChanged(async (s) => {
    settingsEvents++;
    const prev = settings;
    settings = s;
    if (s.character !== prev.character) await loadPack(s.character);
    if (s.size !== prev.size) await applySize(s.size);
    applySettings(s);
  });
}

async function loadPack(id: string) {
  if (loading) return;
  loading = true;
  try {
    const ref = await resolvePack(id);
    const raw = await (await fetch(ref.base + "manifest.json")).json();
    const m = validateManifest(raw);

    // Both renderers stay alive for the life of the app; a pack loads into one of them and
    // only becomes the active renderer once it is fully loaded, so the previous character
    // keeps drawing in the meantime and a half-loaded pack can never reach the frame loop.
    let next: Renderer;
    if (m.renderer === "3d") {
      renderer3d ??= new Renderer3D(stage3d);
      next = renderer3d;
    } else {
      renderer2d ??= new Renderer2D(stage2d);
      next = renderer2d;
    }
    next.resize(cssW, cssH);
    await next.load(ref, m);
    if (renderer && renderer !== next) renderer.unload();
    renderer = next;
    stage3d.hidden = m.renderer !== "3d";
    stage2d.hidden = m.renderer !== "2d";
    pack = ref;
    manifest = m;

    // The music analyser lives across packs; only the threshold changes.
    if (!music) {
      music = new Music(settings.musicThreshold);
      await music.start();
    }
    currentState = "idle";
    danceAmount = 0;
  } catch (err) {
    console.error(`failed to load pack "${id}"`, err);
    if (id !== "rocco") {
      loading = false;
      await loadPack("rocco");
      return;
    }
  } finally {
    loading = false;
  }
}

async function applySize(scale: number) {
  const s = Math.min(3, Math.max(0.4, scale || 1));
  if (!IN_TAURI || !physics) return;
  const win = getCurrentWindow();
  const wasOnFloor = physics.mode === "rest";
  await win.setSize(new LogicalSize(Math.round(BASE_W * s), Math.round(BASE_H * s)));
  const size = await win.outerSize();
  physics.w = size.width;
  physics.h = size.height;
  // Keep the feet on the floor after a resize instead of leaving him hovering.
  if (wasOnFloor && physics.opts.gravity) physics.mode = "falling";
}

function applySettings(s: Settings) {
  if (physics) {
    const phys = manifest?.reactions.physics ?? {};
    physics.opts.gravity = s.physicsEnabled && (phys.gravity ?? true);
    physics.opts.throwable = s.physicsEnabled && (phys.throwable ?? true);
    if (physics.opts.gravity && physics.mode === "rest") physics.mode = "falling";
  }
  if (music) music.threshold = s.musicThreshold;
  ignoringCursor = null; // force the click-through mode to be re-applied
}

// ---------- input ----------
function onGrab(e: PointerEvent) {
  if (e.button !== 0 || !physics || settings.clickThrough === "locked") return;
  physics.grab();
}
stage3d.addEventListener("pointerdown", onGrab);
stage2d.addEventListener("pointerdown", onGrab);
// Double-click the buddy to open settings.
function onOpenSettings() {
  if (IN_TAURI) invoke("open_settings").catch(() => {});
}
stage3d.addEventListener("dblclick", onOpenSettings);
stage2d.addEventListener("dblclick", onOpenSettings);
document.addEventListener("contextmenu", (e) => e.preventDefault());

function cursorInCanvas(): { x: number; y: number } | null {
  if (!physics || !cursor.valid) return null;
  const x = (cursor.x - physics.x) / scaleFactor;
  const y = (cursor.y - physics.y) / scaleFactor;
  if (x < 0 || y < 0 || x >= cssW || y >= cssH) return null;
  return { x, y };
}

function updateLook(dt: number) {
  const mouse = settings.mouseEnabled && !settings.paused && (manifest?.reactions.mouse?.lookAtCursor ?? true);
  let targetYaw = 0;
  let targetPitch = 0;
  if (mouse && physics && cursor.valid) {
    // Reference point: where the head is on screen, for either renderer.
    let headX = cssW / 2;
    let headY = cssH * 0.2;
    const head = renderer3d?.debugCharacter?.bone("head");
    if (head && renderer3d) {
      head.getWorldPosition(headWorld).project(renderer3d.camera);
      headX = ((headWorld.x + 1) / 2) * cssW;
      headY = ((1 - headWorld.y) / 2) * cssH;
    }
    const dx = (cursor.x - physics.x) / scaleFactor - headX;
    const dy = (cursor.y - physics.y) / scaleFactor - headY;
    if (Math.hypot(dx, dy) < cssH * 1.5) {
      targetYaw = THREE.MathUtils.clamp(dx / (cssW * 0.9), -1, 1) * 0.75;
      targetPitch = THREE.MathUtils.clamp(-dy / (cssH * 0.9), -1, 1) * 0.45;
    }
  }
  const k = 1 - Math.exp(-dt * 9);
  yaw += (targetYaw - yaw) * k;
  pitch += (targetPitch - pitch) * k;
}

function updateClickThrough() {
  if (!IN_TAURI || !physics || !renderer) return;
  let shouldIgnore: boolean;
  if (settings.clickThrough === "locked") shouldIgnore = true;
  else if (physics.mode === "held") shouldIgnore = false;
  else if (settings.clickThrough === "window") shouldIgnore = false;
  else {
    const p = cursorInCanvas();
    shouldIgnore = !p || renderer.alphaAt(p.x, p.y) < 16;
  }
  if (shouldIgnore !== ignoringCursor) {
    ignoringCursor = shouldIgnore;
    getCurrentWindow().setIgnoreCursorEvents(shouldIgnore).catch(() => {});
  }
}

/** Pick the behaviour state for this frame. */
function resolveState(t: number): StateName {
  if (physics?.mode === "held") return "dragged";
  if (physics?.airborne) return "fall";
  if (pokeUntil > t) return "poked";
  if (danceAmount > 0.5) return "dance";
  return "idle";
}

// ---------- loop ----------
let lastTitle = 0;
function debugTitle(t: number) {
  if (!import.meta.env.DEV || !IN_TAURI || !physics || t - lastTitle < 0.1) return;
  lastTitle = t;
  const p = physics;
  const m = music;
  const cp = cursorInCanvas();
  const alpha = cp && renderer ? renderer.alphaAt(cp.x, cp.y) : -1;
  const probe = renderer3d ? renderer3d.debugProbe() : "2d";
  const title =
    `Robo Buddy | ${p.mode} y=${p.y.toFixed(0)} air=${p.airborne} yaw=${yaw.toFixed(2)} cur=${cursor.x},${cursor.y},${cursor.buttons}` +
    ` | pack=${pack?.id} state=${currentState} ct=${settings.clickThrough} ign=${ignoringCursor} alpha=${alpha} probe=[${probe}] px=${p.x} canvas=${stage3d.width}x${stage3d.height} paused=${settings.paused} size=${settings.size} evt=${settingsEvents} boot=${bootStamp}` +
    (m ? ` | lvl=${m.level.toFixed(2)} bpm=${m.bpm.toFixed(0)} dance=${m.dancing} amt=${danceAmount.toFixed(2)} beats=${m.beats.toFixed(1)}` : "");
  getCurrentWindow().setTitle(title).catch(() => {});
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  resize();

  const paused = settings.paused;
  if (music) {
    music.requireTempo = settings.requireTempo;
    music.update(dt, t);
    const musicOn = settings.musicEnabled && !paused && (manifest?.reactions.music?.enabled ?? true);
    const target = musicOn && music.dancing && !physics?.airborne && physics?.mode !== "held" ? 1 : 0;
    danceAmount += (target - danceAmount) * (1 - Math.exp(-dt * (target ? 2.5 : 1.5)));
  }
  sincePoke += dt;
  sinceLand += dt;
  updateLook(dt);

  // A poke starts the pack's poked clip (if any) for its duration, else a short procedural hop.
  if (pokePending) {
    pokePending = false;
    if (!paused) pokeUntil = t + (renderer?.hasClip("poked") ? renderer.clipDuration("poked") : 0.45);
  }
  currentState = resolveState(t);

  if (renderer) {
    const input: FrameInput = {
      t,
      dt,
      state: currentState,
      danceAmount,
      music,
      yaw,
      pitch,
      sincePoke,
      sinceLand,
      landStrength,
      airborne: physics?.airborne ?? false,
      vx: physics?.vx ?? 0,
    };
    renderer.frame(input);
  }
  if (!paused || physics?.mode === "held" || physics?.airborne) physics?.step(dt);
  updateClickThrough();
  debugTitle(t);
}

let frameErrors = 0;
function loop() {
  try {
    frame();
  } catch (err) {
    // One bad frame must not kill the buddy; log the first few and keep going.
    if (frameErrors++ < 5) console.error("frame failed", err);
  }
  requestAnimationFrame(loop);
}

if (import.meta.env.DEV) {
  Object.defineProperty(window, "__buddy", {
    get: () => ({ renderer, renderer3d, physics, music, settings, danceAmount, yaw, pitch, cursor, currentState, frame, listPacks, THREE }),
  });
}

boot().catch((err) => console.error("boot failed", err));
loop();
