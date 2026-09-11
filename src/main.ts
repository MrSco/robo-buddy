import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Music } from "./audio";
import { Behavior, type ClipChoice } from "./behavior";
import { applyLibrary, invalidateLibrary, listLibrary } from "./library";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Bubble } from "./bubble";
import { ChatClient, TalkBox, Voice, defaultPersona, loadOrGeneratePhrases, type LineEvent, type Lines } from "./chat";
import { Sounds } from "./sound";
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
// Talk (M6): the input strip, the conversation, the voice, and generated bubble lines.
const talk = new TalkBox();
const voice = new Voice();
const chat = new ChatClient(() => manifest?.persona ?? defaultPersona(manifest?.name ?? "Buddy"));
let extraLines: Lines = {};
let nextChatter = Infinity;

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

// Sleep / activity
let lastActivity = 0;
let asleep = false;
let sleepAmount = 0;
let nextSnore = 0;
let dancedThisSession = false;

const bubble = new Bubble();
const sounds = new Sounds();
const behavior = new Behavior();
let pokeClip: ClipChoice | null = null;
let landClip: ClipChoice | null = null;
let landUntil = -1;
/** Knocked down after a tumbling or very hard landing: limp on the floor until this time. */
let downUntil = -1;
let grabPart: import("./renderer").GrabPart | null = null;
let lastAct = "idle";
let lastFree = false;
let lastClip = "-";
let danceClip: ClipChoice | null = null;
let facing = 0;
let headX = BASE_W / 2;
let headY = BASE_H * 0.2;

const headWorld = new THREE.Vector3();

// ---------- boot ----------
async function boot() {
  await startInput();
  settings = await getSettings();

  const p = new WindowPhysics({ gravity: false, throwable: false });
  p.onPoke = () => {
    // Grabs only start after the hold threshold, so a release here is a drop, not a poke.
  };
  p.onLand = (speed) => {
    sinceLand = 0;
    landStrength = Math.min(1, speed / 2500);
    if (landStrength > 0.4) {
      speak("land");
      sounds.play("land");
    }
    // A hard landing plays the pack's landing clip (Jump Land by default) before idling.
    // If he came in tumbling (or really hard) he first lies limp for a moment, then gets up.
    const now = clock.elapsedTime;
    if (landStrength > 0.35 && renderer?.kind === "3d" && downUntil < now && landUntil < now) {
      const tumbled = Math.abs(renderer3d?.tumbleAngle ?? 0) > 0.25 || landStrength > 0.7;
      downUntil = tumbled ? now + 1.1 + Math.random() * 0.6 : -1;
      landClip = behavior.stateClip("land");
      const start = tumbled ? downUntil : now;
      if (landClip) landUntil = start + Math.max(0.4, renderer.clipDuration(landClip.name) * 0.9);
    }
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

  // Tray "Bring buddy here": drop him onto the floor of the monitor under the cursor.
  if (IN_TAURI) await listen<{ x: number; area: { left: number; top: number; right: number; bottom: number } }>("bring-here", (e) => {
    if (!physics) return;
    const a = e.payload.area;
    physics.teleport(Math.max(a.left, Math.min(a.right - physics.w, e.payload.x - physics.w / 2)), a.bottom - physics.h - 120, a);
    activity();
    behavior.interrupt(clock.elapsedTime);
    speak("wake");
  });

  if (IN_TAURI) {
    // Drop a model or animation file onto the buddy to import it.
    await getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      for (const path of e.payload.paths) await importDropped(path);
    });
    // Other always-on-top windows opened later sit above him in the topmost band; take the
    // top of it back every couple of seconds (no focus change, so nothing is interrupted).
    setInterval(() => {
      if (hiddenByFullscreen || settings.paused) return;
      getCurrentWindow().setAlwaysOnTop(true).catch(() => {});
    }, 2000);
    await listen("talk", () => openTalk());
    // Hide behind fullscreen apps (games, videos) and come back afterwards.
    await listen<{ active: boolean }>("fullscreen", async (e) => {
      fullscreenActive = e.payload.active;
      await applyVisibility();
    });
  }

  await applySize(settings.size);
  await loadPack(settings.character);
  applySettings(settings);
  await onSettingsChanged(async (s) => {
    settingsEvents++;
    const prev = settings;
    settings = s;
    if (s.character !== prev.character || JSON.stringify(s.animRoles) !== JSON.stringify(prev.animRoles)) {
      invalidateLibrary();
      await loadPack(s.character);
    }
    if (s.size !== prev.size) await applySize(s.size);
    applySettings(s);
    // A new dance choice takes effect now, not at the next song.
    if (s.danceMode !== prev.danceMode && danceAmount > 0.2) danceClip = behavior.chooseDance();
    if (s.chatEnabled !== prev.chatEnabled || s.chatGenerateLines !== prev.chatGenerateLines || s.chatEndpoint !== prev.chatEndpoint || s.chatModel !== prev.chatModel) {
      if (pack) void refreshPhrases(pack.id);
      if (!s.chatEnabled && talk.open) talk.hide();
    }
    voice.enabled = s.chatVoice;
  });
}

async function loadPack(id: string) {
  if (loading) return;
  loading = true;
  try {
    const ref = await resolvePack(id);
    const raw = await (await fetch(ref.base + "manifest.json")).json();
    const base = validateManifest(raw);
    // Every library clip is available to every 3D pack; user roles decide where it is used.
    const m = base.renderer === "3d" ? applyLibrary(base, await listLibrary(), settings.animRoles ?? {}) : base;

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
    sounds.load(ref, m);
    behavior.setPack(m, (n) => renderer?.clipDuration(n) ?? 0, clock.elapsedTime);
    activity();
    speak("greet", 3);
    chat.reset();
    void refreshPhrases(ref.id);
    sounds.play("greet");
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

let fullscreenActive = false;
let hiddenByFullscreen = false;
async function applyVisibility() {
  if (!IN_TAURI) return;
  const win = getCurrentWindow();
  const shouldHide = fullscreenActive && settings.hideWhenFullscreen && !settings.paused;
  if (shouldHide && !hiddenByFullscreen) {
    hiddenByFullscreen = true;
    await win.hide();
  } else if (!shouldHide && hiddenByFullscreen) {
    hiddenByFullscreen = false;
    await win.show();
  }
}

/** Stage a dropped file, decide whether it is a model or an animation, and file it. */
async function importDropped(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!["glb", "gltf", "vrm", "fbx", "webp", "gif", "png", "apng"].includes(ext)) {
    speak("poked");
    return;
  }
  try {
    const staged = await invoke<string>("stage_dropped", { source: path });
    let kind: "model" | "clip" = "model";
    if (["glb", "gltf", "fbx"].includes(ext)) {
      // An animation file has no mesh; a model does.
      const { loadModel } = await import("./character");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const probe = await loadModel(convertFileSrc(staged));
      let hasMesh = false;
      probe.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) hasMesh = true;
      });
      kind = hasMesh ? "model" : probe.animations.length ? "clip" : "model";
    }
    const result = await invoke<{ kind: string; id?: string; name: string }>("finalize_import", { staged, kind, name: null });
    invalidateLibrary();
    if (result.kind === "model" && result.id) {
      const { setSettings } = await import("./settings-store");
      await setSettings({ ...settings, character: result.id });
    } else {
      await loadPack(settings.character);
      bubble.say([`Got "${result.name}". Tag it in Settings.`], 3.5, clock.elapsedTime);
    }
  } catch (err) {
    reportError("import", err);
    bubble.say([`Couldn't import that: ${String(err).slice(0, 60)}`], 4, clock.elapsedTime);
  }
}

function applySettings(s: Settings) {
  if (physics) {
    const phys = manifest?.reactions.physics ?? {};
    physics.opts.gravity = s.physicsEnabled && (phys.gravity ?? true);
    physics.opts.throwable = s.physicsEnabled && (phys.throwable ?? true);
    if (physics.opts.gravity && physics.mode === "rest") physics.mode = "falling";
  }
  if (music) music.threshold = s.musicThreshold;
  sounds.enabled = s.soundsEnabled;
  behavior.opts = { wander: s.wanderEnabled, danceMode: s.danceMode };
  const set = pack ? s.idleSets?.[pack.id] : undefined;
  behavior.enabled = set ? new Set(set) : null;
  if (!s.bubblesEnabled) bubble.hide();
  ignoringCursor = null; // force the click-through mode to be re-applied
  void applyVisibility();
}

function speak(event: NonNullable<Manifest["lines"]> extends Partial<Record<infer K, string[]>> ? K : never, seconds = 2.5) {
  if (!settings.bubblesEnabled || !manifest) return;
  bubble.say(linesFor(event), seconds, clock.elapsedTime);
}

/** The pack's own lines plus any generated ones for that event. */
function linesFor(event: LineEvent): string[] {
  return [...(manifest?.lines?.[event as keyof NonNullable<Manifest["lines"]>] ?? []), ...(extraLines[event] ?? [])];
}

/** Generated bubble lines for the current pack, when talking is on (cached a week per pack). */
async function refreshPhrases(packId: string, force = false) {
  extraLines = {};
  nextChatter = Infinity;
  if (!IN_TAURI || !settings.chatEnabled || !settings.chatGenerateLines) return;
  try {
    const persona = manifest?.persona ?? defaultPersona(manifest?.name ?? "Buddy");
    const lines = await loadOrGeneratePhrases(packId, persona, force);
    if (lines && pack?.id === packId) {
      extraLines = lines;
      nextChatter = clock.elapsedTime + 90 + Math.random() * 120;
    }
  } catch (err) {
    console.warn("phrases:", err);
  }
}

/** One line about what he is doing, so replies can refer to it. */
function chatContext(): string {
  const doing = asleep ? "you were asleep" : currentState === "dance" ? `you are dancing to music at ${Math.round(music?.bpm ?? 0)} bpm` : currentState === "dragged" ? "the user is holding you" : currentState === "walk" ? "you are strolling along the taskbar" : "you are standing on the taskbar";
  return `Right now ${doing}; local time ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Character pack: ${manifest?.name ?? "buddy"}.`;
}

talk.onSend = async (text) => {
  activity();
  behavior.interrupt(clock.elapsedTime);
  bubble.say(["…"], 40, clock.elapsedTime);
  try {
    const reply = await chat.ask(text, chatContext());
    const words = reply.split(/\s+/).length;
    bubble.say([reply], Math.min(24, 3 + words * 0.45), clock.elapsedTime);
    if (settings.chatVoice) voice.say(reply);
  } catch (err) {
    bubble.say([`Can't talk right now: ${String(err).slice(0, 90)}`], 6, clock.elapsedTime);
  }
};
talk.onStatus = (text) => bubble.say([text], 4, clock.elapsedTime);
talk.onOpenChange = (open) => {
  ignoringCursor = null; // re-evaluate click-through now that the strip is (in)visible
  if (open && IN_TAURI) getCurrentWindow().setFocus().catch(() => {});
  if (!open) voice.stop();
};
function openTalk() {
  if (!settings.chatEnabled) {
    bubble.say(["Turn on Talk in Settings first."], 3, clock.elapsedTime);
    return;
  }
  talk.micEnabled = !!settings.chatSttModel;
  talk.toggle();
}

/** Any interaction: resets the sleep timer and wakes him up. */
function activity() {
  lastActivity = clock.elapsedTime;
  if (asleep) {
    asleep = false;
    speak("wake");
    sounds.play("wake");
  }
}

// ---------- input ----------
// A press is not a grab until the cursor moves or is held; a quick release is a poke.
// This keeps the current animation running through a plain click instead of snapping to "held".
// The global cursor poll only reports changes, so a quick click can come and go between two
// polls; the WebView's own pointerup is the reliable end of a press, and the poll is only
// trusted for "released" once it has actually seen the button down.
let press: { t: number; x: number; y: number; seenDown: boolean } | null = null;
const GRAB_MOVE = 6;
const GRAB_HOLD = 0.22;

function onGrab(e: PointerEvent) {
  if (e.button !== 0 || !physics || settings.clickThrough === "locked") return;
  grabPart = renderer?.partAt(e.clientX, e.clientY) ?? null;
  press = { t: clock.elapsedTime, x: cursor.x, y: cursor.y, seenDown: false };
  activity();
}

/** A press that ended without becoming a grab: a poke. */
function endPress(t: number) {
  if (!press) return;
  press = null;
  sincePoke = 0;
  pokePending = true;
  behavior.interrupt(t);
  if (!settings.paused) {
    speak("poked");
    sounds.play("poked");
  }
}

function onPointerUp(e: PointerEvent) {
  if (e.button !== 0) return;
  endPress(clock.elapsedTime);
}

function updatePress(t: number) {
  if (!press || !physics) return;
  const moved = Math.hypot(cursor.x - press.x, cursor.y - press.y);
  if (cursor.buttons & 1) press.seenDown = true;
  if (press.seenDown && !(cursor.buttons & 1)) {
    endPress(t);
    return;
  }
  if (moved > GRAB_MOVE || t - press.t > GRAB_HOLD) {
    press = null;
    physics.grab();
    downUntil = landUntil = -1;
    behavior.interrupt(t);
  }
}
stage3d.addEventListener("pointerdown", onGrab);
stage2d.addEventListener("pointerdown", onGrab);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);
// Double-click the buddy to talk to him (or to open settings while talking is off).
function onDoubleClick() {
  if (settings.chatEnabled) openTalk();
  else if (IN_TAURI) invoke("open_settings").catch(() => {});
}
stage3d.addEventListener("dblclick", onDoubleClick);
stage2d.addEventListener("dblclick", onDoubleClick);
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (IN_TAURI && settings.clickThrough !== "locked") invoke("context_menu").catch(() => {});
});

function cursorInCanvas(): { x: number; y: number } | null {
  if (!physics || !cursor.valid) return null;
  const x = (cursor.x - physics.x) / scaleFactor;
  const y = (cursor.y - physics.y) / scaleFactor;
  if (x < 0 || y < 0 || x >= cssW || y >= cssH) return null;
  return { x, y };
}

function updateHead() {
  // Where the head is on screen, for either renderer: drives look-at and the speech bubble.
  headX = cssW / 2;
  headY = cssH * 0.2;
  const head = renderer === renderer3d ? renderer3d?.debugCharacter?.bone("head") : undefined;
  if (head && renderer3d) {
    head.getWorldPosition(headWorld).project(renderer3d.camera);
    headX = ((headWorld.x + 1) / 2) * cssW;
    headY = ((1 - headWorld.y) / 2) * cssH;
  }
}

function updateLook(dt: number) {
  const mouse = settings.mouseEnabled && !settings.paused && (manifest?.reactions.mouse?.lookAtCursor ?? true);
  let targetYaw = 0;
  let targetPitch = 0;
  if (mouse && physics && cursor.valid) {
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
  else if (talk.open) shouldIgnore = false;
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

/** Pick the behaviour state for this frame, plus the clip that goes with it. */
function resolveState(t: number, act: ReturnType<Behavior["update"]>): { state: StateName; clip: ClipChoice | null } {
  // Held: a pack (or a library role) may name a hanging clip; otherwise the calm idle is the
  // base and the renderer dangles everything from the grab point.
  if (physics?.mode === "held") return { state: "dragged", clip: behavior.stateClip("dragged") ?? behavior.stateClip("idle") };
  if (downUntil > t) return { state: "down", clip: null };
  if (physics?.airborne) return { state: "fall", clip: behavior.stateClip("fall") };
  if (pokeUntil > t) return { state: "poked", clip: pokeClip };
  if (landUntil > t) return { state: "land", clip: landClip };
  if (asleep) return { state: "sleep", clip: null };
  if (danceAmount > 0.5) return { state: "dance", clip: danceClip };
  if (act.kind === "walk") return { state: "walk", clip: act.clip ? { ...act.clip, playbackRate: walkRate(act.speed) } : null };
  if (act.kind === "fidget") return { state: "fidget", clip: act.clip };
  return { state: "idle", clip: act.clip ?? behavior.stateClip("idle") };
}

/** Playback rate so the walk cycle roughly matches the window's speed across the screen. */
function walkRate(speedPx: number): number {
  const h = renderer3d?.debugCharacter?.height ?? 1.8;
  const pxPerMeter = (cssH * scaleFactor) / (1.3 * h);
  const naturalMps = 1.15;
  return Math.max(0.5, Math.min(1.6, speedPx / (pxPerMeter * naturalMps)));
}

// ---------- loop ----------
let lastTitle = 0;
function debugTitle(t: number) {
  // The title is never visible (no decorations, no taskbar entry), so it doubles as a
  // status line in every build; release builds have no other way to be inspected.
  if (!IN_TAURI || !physics || t - lastTitle < (import.meta.env.DEV ? 0.1 : 0.5)) return;
  lastTitle = t;
  const p = physics;
  const m = music;
  const cp = cursorInCanvas();
  const alpha = cp && renderer ? renderer.alphaAt(cp.x, cp.y) : -1;
  const probe = renderer3d ? renderer3d.debugProbe() : "2d";
  const title =
    `Robo Buddy | ${p.mode} y=${p.y.toFixed(0)} air=${p.airborne} yaw=${yaw.toFixed(2)} cur=${cursor.x},${cursor.y},${cursor.buttons}` +
    ` | pack=${pack?.id} state=${currentState} grab=${grabPart ?? '-'} act=${lastAct} clip=${lastClip} free=${lastFree} amt=${danceAmount.toFixed(2)} dance=${behavior.currentDance ?? "-"} sleep=${sleepAmount.toFixed(2)} idle=${(t - lastActivity).toFixed(0)}s ct=${settings.clickThrough} ign=${ignoringCursor} alpha=${alpha} probe=[${probe}] px=${p.x} canvas=${stage3d.width}x${stage3d.height} paused=${settings.paused} size=${settings.size} evt=${settingsEvents} boot=${bootStamp}` +
    (m ? ` | lvl=${m.level.toFixed(2)} gate=${m.gateLevel.toFixed(2)}/${m.threshold.toFixed(2)} bpm=${m.bpm.toFixed(0)} dance=${m.dancing} amt=${danceAmount.toFixed(2)} beats=${m.beats.toFixed(1)}` : "");
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
  updatePress(t);
  // Standing on the taskbar: sink the window by the camera's margin so the soles meet its edge.
  if (physics) physics.floorOverlap = settings.standOnTaskbar && renderer === renderer3d ? Math.round((renderer3d?.bottomMarginPx ?? 0) * scaleFactor) : 0;
  updateHead();
  updateLook(dt);

  // Activity: hovering over him, dragging, music, pokes. Silence for long enough = sleep.
  if (music?.dancing || physics?.mode === "held" || cursorInCanvas()) activity();
  if (music) {
    if (danceAmount > 0.5 && !dancedThisSession) {
      dancedThisSession = true;
      danceClip = behavior.chooseDance();
      behavior.interrupt(t);
      speak("dance");
    } else if (danceAmount < 0.1) dancedThisSession = false;
  }
  // Idle chatter from the generated lines, now and then, when nothing else is going on.
  if (t > nextChatter) {
    nextChatter = t + 240 + Math.random() * 300;
    if (!asleep && !paused && settings.bubblesEnabled && physics?.mode === "rest" && !talk.open && extraLines.idle?.length) bubble.say(extraLines.idle, 4, t);
  }
  const sleepAfter = settings.sleepAfterMin * 60;
  if (!asleep && sleepAfter > 0 && !paused && t - lastActivity > sleepAfter) {
    asleep = true;
    nextSnore = t + 1;
  }
  if (asleep && t > nextSnore) {
    speak("sleep", 2.2);
    nextSnore = t + 6 + Math.random() * 4;
  }
  sleepAmount += ((asleep ? 1 : 0) - sleepAmount) * (1 - Math.exp(-dt * (asleep ? 0.8 : 3)));

  // A poke starts one of the pack's poke clips for its duration, else a short procedural hop.
  if (pokePending) {
    pokePending = false;
    if (!paused) {
      pokeClip = renderer?.kind === "3d" ? behavior.stateClip("poked") : null;
      const d = pokeClip ? renderer!.clipDuration(pokeClip.name) : renderer?.hasClip("poked") ? renderer.clipDuration("poked") : 0.45;
      pokeUntil = t + Math.max(0.3, d);
    }
  }

  // Idle-time behaviour: variants, fidgets, wandering.
  const free =
    !paused && !asleep && !!physics && physics.mode === "rest" && !physics.airborne && danceAmount < 0.5 && pokeUntil <= t;
  const act = behavior.update({
    t,
    free,
    x: physics?.x ?? 0,
    w: physics?.w ?? 320,
    left: physics?.workArea.left ?? 0,
    right: physics?.workArea.right ?? 1920,
  });
  const resolved = resolveState(t, act);
  currentState = resolved.state;
  lastAct = act.kind;
  lastFree = free;
  lastClip = resolved.clip?.name ?? "-";
  let targetFacing = 0;
  if (currentState === "walk" && act.kind === "walk" && physics) {
    const dir = Math.sign(act.targetX - physics.x) || 1;
    targetFacing = (dir * Math.PI) / 2;
    const step = Math.min(Math.abs(act.targetX - physics.x), act.speed * settings.size * dt);
    physics.nudge(dir * step);
  }
  facing = targetFacing;

  if (renderer) {
    const input: FrameInput = {
      t,
      dt,
      state: currentState,
      clip: renderer?.kind === "3d" ? resolved.clip : null,
      facing,
      grab: currentState === "dragged" && grabPart ? { part: grabPart, vx: physics?.holdVelocityX ?? 0 } : null,
      danceAmount,
      sleepAmount,
      music,
      yaw,
      pitch,
      sincePoke,
      sinceLand,
      landStrength,
      airborne: physics?.airborne ?? false,
      vx: physics?.vx ?? 0,
      accelX: physics ? THREE.MathUtils.clamp(physics.accelX / (cssH * scaleFactor * 12), -1.5, 1.5) : 0,
      accelY: physics ? THREE.MathUtils.clamp(physics.accelY / (cssH * scaleFactor * 12), -1.5, 1.5) : 0,
      spin: physics?.spin ?? 0,
      talking: voice.speaking,
    };
    renderer.frame(input);
  }
  // While held, keep the point he is held by (a hand, the head) under the cursor.
  if (physics?.mode === "held" && renderer && grabPart) {
    const hp = renderer.holdPoint();
    if (hp) physics.steerHold(hp.x * scaleFactor, hp.y * scaleFactor, dt);
  }
  if (!paused || physics?.mode === "held" || physics?.airborne) physics?.step(dt);
  if (renderer) {
    const a = renderer.bubbleAnchor();
    bubble.update(t, a.x, a.y, cssW);
  }
  updateClickThrough();
  debugTitle(t);
}

let frameErrors = 0;
let frameSkip = 0;
function loop() {
  // Power saving: asleep or hidden, only every third frame is processed.
  const lazy = (asleep && sleepAmount > 0.99) || hiddenByFullscreen;
  if (lazy && frameSkip++ % 3 !== 0) {
    requestAnimationFrame(loop);
    return;
  }
  try {
    frame();
  } catch (err) {
    // One bad frame must not kill the buddy; log the first few and keep going.
    if (frameErrors++ < 5) reportError("frame", err);
  }
  requestAnimationFrame(loop);
}

if (import.meta.env.DEV) {
  Object.defineProperty(window, "__buddy", {
    get: () => ({
      renderer, renderer3d, physics, music, settings, danceAmount, yaw, pitch, cursor, currentState, frame, listPacks, THREE, behavior,
      /** Dev: play a clip as if it were a poke reaction. */
      play: (name: string) => {
        pokeClip = { name, loop: false };
        pokeUntil = clock.elapsedTime + Math.max(0.3, renderer?.clipDuration(name) ?? 0.5);
      },
    }),
  });
}

// The buddy window has no visible title, so use it as a crash log readable from outside.
function reportError(where: string, err: unknown) {
  console.error(where, err);
  const msg = err instanceof Error ? `${err.message} @ ${(err.stack ?? "").split(String.fromCharCode(10))[1]?.trim() ?? ""}` : String(err);
  if (IN_TAURI) getCurrentWindow().setTitle(`Robo Buddy | ERROR ${where}: ${msg}`.slice(0, 500)).catch(() => {});
}
window.addEventListener("error", (e) => reportError("window", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

boot().catch((err) => reportError("boot", err));
loop();
