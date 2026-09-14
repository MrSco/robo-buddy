import { Havoc, STRIKE_CONTACT, type StrikeKind, type AttackTarget, type HavocAction } from "./havoc";
import { SimulationClock } from "./simulation-clock";
import { ScreensaverDance } from "./screensaver-dance";
import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Music } from "./audio";
import { Behavior, type ClipChoice } from "./behavior";
import { effectiveManifest, invalidateLibrary, listLibrary } from "./library";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Bubble } from "./bubble";
import { ChatClient, TalkBox, Voice, defaultPersona, loadOrGeneratePhrases, type LineEvent, type Lines } from "./chat";
import { invalidatePersonalities, resolvePersonality, type ResolvedPersonality } from "./personality";
import type { MirrorPose } from "./mocap";
import { abilitiesPrompt, commandFromTool, extractTag, parseCommand, toolDefinitions, type Command } from "./commands";
import { LiveVoice } from "./live";
import { Sounds } from "./sound";
import { cursor, IN_TAURI, onKeys, onSurfaces, startInput } from "./input";
import { listPacks, resolvePack, validateManifest, type Manifest, type PackRef } from "./packs";
import { WindowPhysics } from "./physics";
import type { FrameInput, Renderer, StateName } from "./renderer";
import { Renderer2D } from "./renderer2d";
import { Renderer3D } from "./renderer3d";
import { DEFAULT_SETTINGS, beatLockSeconds, getSettings, lightingFor, onSettingsChanged, type Settings } from "./settings-store";

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
const live = new LiveVoice();
const liveMode = () => settings.talkMode === "live";
let personality: ResolvedPersonality | null = null;
const chat = new ChatClient(() => personality?.persona ?? manifest?.persona ?? defaultPersona(manifest?.name ?? "Buddy"));
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
/** When the current airborne stretch began; short hops keep the idle base instead of the flail. */
let airborneSince = -1;
let flailNow = false;
// Keyboard: a typing rate (keys per second, smoothed) and the last shortcut seen.
let typingRate = 0;
let typingAmount = 0;
let lastShortcutAt = -Infinity;
let keyEvents = 0;
// Webcam mirroring (M7): the settings window streams poses while "Mirror on the buddy" is on.
let mirrorOn = false;
// Chat commands: a forced dance, a commanded nap, and a quiet spell.
let forcedDanceUntil = -1;
let danceSuppressUntil = -1;
let commandedSleepUntil = -1;
// Screensaver: music only pulls him into an occasional dance break, not a whole set, so he
// spends most of it wrecking the desktop. Breaks begin only when he is on the floor.
const ssDance = new ScreensaverDance();
let quietUntil = -1;
let mirrorPose: MirrorPose | null = null;
let lastPoseAt = -Infinity;
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
/** When to say the going-to-sleep line, once per nap; Infinity once it has been said. */
let sleepLineAt = Infinity;
let dancedThisSession = false;
/** The screensaver is up: he roams and climbs instead of idling on the taskbar. */
let screensaverOn = false;
let hopCount = 0;
let punchCount = 0;
function attackClip(kind: StrikeKind) {
  const names = kind === "kick" ? ["Kick", "Kick_Front"] : kind === "throw" ? ["Throw", "Throw_Object"] : ["Punch_Cross", "Punch_Jab", "Sword_Attack"];
  return names.find(n => (renderer?.clipDuration(n) ?? 0) > 0);
}
const havoc = new Havoc(Math.random, kind => {const name=attackClip(kind);return name ? renderer!.clipDuration(name) : kind === "throw" ? 1.25 : .85;});
let timedPunch: { dir: number; contact: number; end: number; fired: boolean } | null = null;
let havocAction: HavocAction | null = null;
const attackTargets = new Map<number, AttackTarget[]>();
/**
 * He is running at a window to shove it, and the screensaver has been told so. Only then does
 * his speed move anything: told nothing, the page would knock a window loose every time he
 * walked through it or jumped at it, and it would be gone from under him before he could
 * grab it. That was why he never got on top of one.
 */
let barging = false;
/** While a punch plays he keeps facing what he hit, rather than snapping back to the front. */
let holdFacing = 0;
let holdFacingUntil = 0;

const bubble = new Bubble();
const sounds = new Sounds();
const behavior = new Behavior();
let pokeClip: ClipChoice | null = null;
let landClip: ClipChoice | null = null;
/** Latched when a jump starts: stateClip picks at random, and re-picking every frame would thrash. */
let jumpClip: ClipChoice | null = null;
let jumpKind: "up" | "off" | null = null;
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
    if (landStrength > 0.55) {
      speak("land");
      sounds.play("land");
    }
    // A hard landing plays the pack's landing clip (Jump Land by default) before idling.
    // If he came in tumbling (or really hard) he first lies limp for a moment, then gets up.
    const now = clock.elapsedTime;
    // No fidgets for a while after a landing; a drop followed by a random hop reads as glitchy.
    behavior.rest(now, 12);
    if (landStrength > 0.7 && renderer?.kind === "3d" && downUntil < now && landUntil < now) {
      const tumbled = Math.abs(renderer3d?.tumbleAngle ?? 0) > 0.25 || landStrength > 0.7;
      downUntil = tumbled ? now + 1.1 + Math.random() * 0.6 : -1;
      // Knocked down: a real getting-up clip when the pack has one; otherwise the landing crouch.
      landClip = (tumbled ? behavior.stateClip("getup") : null) ?? behavior.stateClip("land");
      const start = tumbled ? downUntil : now;
      if (landClip) landUntil = start + Math.max(0.4, renderer.clipDuration(landClip.name) * (tumbled ? 0.97 : 0.9));
    }
  };
  p.onBump = () => {
    // Head into the top of the screen: a squash, a thud and a word, then the fall does the rest.
    const now = clock.elapsedTime;
    sinceLand = 0;
    landStrength = 0.5;
    behavior.interrupt(now);
    behavior.rest(now, 12);
    sounds.play("bump");
    speak("bump");
  };
  // Walls and the top of the screen: a lighter, springier knock than the floor's thud.
  p.onBounce = () => sounds.play("bounce");
  p.onThrow = () => sounds.play("throw");
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
    await listen("talk", () => openTalk());
    await listen<{ on: boolean }>("mirror", (e) => {
      mirrorOn = e.payload.on;
      if (mirrorOn) activity();
    });
    await listen<MirrorPose>("pose", (e) => {
      mirrorPose = e.payload;
      lastPoseAt = clock.elapsedTime;
    });
    await listen<{ index: number; targets: AttackTarget[] }>("screensaver-targets", e => {
      if (screensaverOn) attackTargets.set(e.payload.index, e.payload.targets);
    });
    await onSurfaces((list) => {
      if (physics) physics.surfaces = list;
    });
    // Screensaver: nobody is watching a desk toy stand still, so he puts on a show.
    await listen<boolean>("screensaver", (e) => {
      screensaverOn = e.payload;
      attackTargets.clear();
      havocAction = null;
      timedPunch = null;
      behavior.energetic = e.payload;
      if (physics) physics.roam = e.payload;
      // A screensaver runs in an empty room; thuds and boings there are just noise.
      sounds.enabled = settings.soundsEnabled && (!e.payload || settings.screensaverSounds);
      // He IS the screensaver, so the hide-behind-fullscreen rule must not touch him now. A
      // backdrop .scr goes fullscreen as it starts and would otherwise hide him for the whole
      // show; reassert visibility here in case a fullscreen app hid him just before it began.
      void applyVisibility();
      if (e.payload) {
        // Start doing something at once rather than finishing the current doze.
        behavior.interrupt(clock.elapsedTime);
        asleep = false;
        commandedSleepUntil = -1;
        lastActivity = clock.elapsedTime;
        // Let him wreck things for a while before the first dance break.
        ssDance.reset(clock.elapsedTime);
      }
    });
    await onKeys((k) => {
      if (hiddenByFullscreen) return;
      keyEvents++;
      typingRate = typingRate * 0.6 + (k.presses / 0.25) * 0.4;
      if (k.presses > 0) activity();
      if (k.combo && clock.elapsedTime - lastShortcutAt > 15 && !settings.paused) {
        lastShortcutAt = clock.elapsedTime;
        sincePoke = 0;
        const lines = k.combo === "save" ? ["Saved. Nice.", "Ctrl+S, respect.", "Progress, locked in."] : ["Oops.", "Never happened.", "Undo. Classic."];
        if (settings.bubblesEnabled) bubble.say(lines, 2.5, clock.elapsedTime);
      }
    });
    await listen("personalities-changed", async () => {
      invalidatePersonalities();
      chat.reset();
      // An imported character's own persona lives in its manifest, which the settings window
      // may have just rewritten. Re-read those fields rather than reloading the whole model.
      if (pack && manifest) {
        try {
          const raw = (await (await fetch(pack.base + "manifest.json")).json()) as Manifest;
          manifest.persona = raw.persona;
          manifest.lines = raw.lines;
          manifest.llm = raw.llm;
        } catch {
          // Unreadable: keep the persona already loaded.
        }
      }
      if (pack) void refreshPhrases(pack.id);
    });
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
    if (s.chatEnabled !== prev.chatEnabled || s.chatGenerateLines !== prev.chatGenerateLines || s.chatEndpoint !== prev.chatEndpoint || s.chatModel !== prev.chatModel || s.personality !== prev.personality) {
      if (s.personality !== prev.personality) chat.reset();
      if (pack) void refreshPhrases(pack.id);
      if (!s.chatEnabled && talk.open) talk.hide();
    }
  });
}

/** The bundled character's manifest: the template imported models take their animations from. */
let referencePromise: Promise<Manifest | null> | null = null;
function referenceManifest(): Promise<Manifest | null> {
  referencePromise ??= (async () => {
    try {
      const ref = await resolvePack("rocco");
      return validateManifest(await (await fetch(ref.base + "manifest.json")).json());
    } catch {
      return null;
    }
  })();
  return referencePromise;
}

async function loadPack(id: string) {
  if (loading) return;
  loading = true;
  try {
    const ref = await resolvePack(id);
    const raw = await (await fetch(ref.base + "manifest.json")).json();
    const base = validateManifest(raw);
    // Every library clip is available to every 3D pack (an imported model borrows the bundled
    // character's animation sections wholesale); user roles decide where each clip is used.
    const reference = base.renderer === "3d" ? (await referenceManifest()) ?? undefined : undefined;
    const m = effectiveManifest(base, ref.bundled, reference, await listLibrary(reference), settings.animRoles ?? {});

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

    // The music analyser lives across packs; only the beat lock changes.
    if (!music) {
      music = new Music();
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
  const shouldHide = fullscreenActive && settings.hideWhenFullscreen && !settings.paused && !screensaverOn;
  if (shouldHide && !hiddenByFullscreen) {
    hiddenByFullscreen = true;
    clock.setPaused(true);
    sounds.enabled = false;
    if (!talk.open && !voice.speaking && !live.speaking) bubble.hide();
    await win.hide();
  } else if (!shouldHide && hiddenByFullscreen) {
    hiddenByFullscreen = false;
    clock.setPaused(false);
    sounds.enabled = settings.soundsEnabled && (!screensaverOn || settings.screensaverSounds);
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
    physics.gravityStrength = Math.max(0.25, Math.min(2, s.gravityStrength ?? 1));
    physics.bounciness = Math.max(0, Math.min(0.65, s.bounciness ?? 0.26));
    physics.throwStrength = Math.max(0.25, Math.min(2, s.throwStrength ?? 1));
    const phys = manifest?.reactions.physics ?? {};
    physics.opts.gravity = s.physicsEnabled && (phys.gravity ?? true);
    physics.opts.throwable = s.physicsEnabled && (phys.throwable ?? true);
    if (physics.opts.gravity && physics.mode === "rest") physics.mode = "falling";
  }
  if (music) music.lockSeconds = beatLockSeconds(s.musicBeatLock);
  sounds.enabled = !hiddenByFullscreen && s.soundsEnabled && (!screensaverOn || s.screensaverSounds);
  voice.enabled = s.chatVoice;
  voice.engine = s.ttsEngine === "piper" ? "piper" : "windows";
  behavior.opts = { wander: s.wanderEnabled, danceMode: s.danceMode };
  const set = pack ? s.idleSets?.[pack.id] : undefined;
  behavior.enabled = set ? new Set(set) : null;
  if (!s.bubblesEnabled) bubble.hide();
  ignoringCursor = null; // force the click-through mode to be re-applied
  void applyVisibility();
}

function speak(event: NonNullable<Manifest["lines"]> extends Partial<Record<infer K, string[]>> ? K : never, seconds = 2.5) {
  if (hiddenByFullscreen || !settings.bubblesEnabled || !manifest) return;
  bubble.say(linesFor(event), seconds, clock.elapsedTime);
}

/** The personality's bucket (or the pack's own lines) plus any generated ones for that event. */
function linesFor(event: LineEvent): string[] {
  const base = personality && personality.id !== "pack" ? personality.lines[event] ?? [] : manifest?.lines?.[event as keyof NonNullable<Manifest["lines"]>] ?? [];
  return [...base, ...(extraLines[event] ?? [])];
}

/** Persona, line bucket and model settings for the current character under the chosen profile. */
async function applyPersonality() {
  const name = manifest?.name ?? "Buddy";
  personality = await resolvePersonality(settings.personality, name, manifest?.persona, (manifest?.lines ?? {}) as Lines, manifest?.llm);
  chat.tuning = { temperature: personality.temperature, maxWords: personality.maxWords };
}

/** Generated bubble lines for the current pack, when talking is on (cached a week per pack). */
async function refreshPhrases(packId: string, force = false) {
  extraLines = {};
  nextChatter = Infinity;
  await applyPersonality();
  if (pack?.id !== packId) return;
  if (!IN_TAURI || !settings.chatEnabled || !settings.chatGenerateLines) return;
  try {
    const persona = personality?.persona ?? manifest?.persona ?? defaultPersona(manifest?.name ?? "Buddy");
    // Cache per pack, profile and persona text, so an edited persona regenerates its lines.
    let hash = 0;
    for (let i = 0; i < persona.length; i++) hash = (hash * 31 + persona.charCodeAt(i)) | 0;
    const lines = await loadOrGeneratePhrases(`${packId}__${personality?.id ?? "pack"}__${(hash >>> 0).toString(36)}`, persona, force);
    if (lines && pack?.id === packId) {
      extraLines = lines;
      nextChatter = clock.elapsedTime + 90 + Math.random() * 120;
    }
  } catch (err) {
    console.warn("phrases:", err);
  }
}

/** One line about what he is doing, so replies can refer to it. */
function chatContext(extra = ""): string {
  const doing = asleep ? "you were asleep" : currentState === "dance" ? `you are dancing${forcedDanceUntil > clock.elapsedTime ? "" : ` to music at ${Math.round(music?.bpm ?? 0)} bpm`}` : currentState === "dragged" ? "the user is holding you" : currentState === "walk" ? "you are strolling along the taskbar" : physics?.onSurface ? "you are standing on top of a window" : "you are standing on the taskbar";
  return `Right now ${doing}; local time ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Character pack: ${manifest?.name ?? "buddy"}.${extra ? ` ${extra}` : ""}\n${abilitiesPrompt(behavior.danceNames)}`;
}

/** Do what a chat line (or the model's action tag) asked. Returns a note for the model, or null if nothing happened. */
function runCommand(cmd: Command): string | null {
  const t = clock.elapsedTime;
  if (!physics) return null;
  switch (cmd.kind) {
    case "dance": {
      const pick = behavior.chooseDanceNamed(cmd.name);
      danceClip = pick;
      dancedThisSession = true; // keep the music code from re-rolling the choice
      forcedDanceUntil = t + Math.min(600, Math.max(5, cmd.seconds ?? 45));
      danceSuppressUntil = -1;
      behavior.interrupt(t);
      return `You just started dancing${pick ? ` the ${pick.name.replace(/_/g, " ")}` : ""}.`;
    }
    case "stop":
      forcedDanceUntil = -1;
      danceSuppressUntil = t + 120;
      behavior.interrupt(t);
      return "You stopped what you were doing.";
    case "sleep":
      asleep = true;
      sleepLineAt = t + 1; // armed here too, so every nap has one announcement and no more
      commandedSleepUntil = t + 300;
      forcedDanceUntil = -1;
      behavior.interrupt(t);
      return "You are dozing off now, as asked.";
    case "wake":
      commandedSleepUntil = -1;
      if (asleep) {
        asleep = false;
        sounds.play("wake");
      }
      return "You woke up.";
    case "come":
      if (IN_TAURI) invoke("bring_here").catch(() => {});
      return "You came over to the user's cursor.";
    case "jump":
      if (physics.mode === "rest") physics.hop(physics.y + physics.h * 0.07 - 220);
      return "You jumped.";
    case "climb": {
      const c = physics.climbable();
      if (c && behavior.startWalk(t, c.x, false, { hopTop: c.top })) return "You are heading off to climb a nearby window.";
      if (physics.onSurface) return "You are already up on a window.";
      return "There is no window within reach to climb.";
    }
    case "walk": {
      const b = physics.bounds;
      const target = Math.max(b.left, Math.min(b.right - physics.w, physics.x + cmd.dir * 420));
      behavior.startWalk(t, target);
      return `You are walking to the ${cmd.dir < 0 ? "left" : "right"}.`;
    }
    case "quiet":
      quietUntil = t + cmd.minutes * 60;
      nextChatter = Math.max(nextChatter, quietUntil);
      return `You will keep quiet for ${cmd.minutes} minutes: reply with a very short acknowledgement.`;
    case "play":
      return behavior.forceFidget(t, cmd.clip) ? `You are performing the ${cmd.clip.replace(/_/g, " ")} move.` : null;
  }
}

/** Start a Live voice session for the open talk box; failures land in the bubble. */
async function startLive() {
  if (live.state !== "off") return;
  try {
    const cap = settings.liveDailyMinutes;
    if (cap > 0) {
      const used = await invoke<number>("live_usage").catch(() => 0);
      if (used / 60 >= cap) {
        bubble.say([`Live voice is at today's ${cap} minute cap (Settings > Talk).`], 6, clock.elapsedTime, 1);
        return;
      }
    }
    bubble.say(["Connecting…"], 8, clock.elapsedTime, 1);
    const persona = personality?.persona ?? manifest?.persona ?? defaultPersona(manifest?.name ?? "Buddy");
    const name = manifest?.name ?? "Buddy";
    await live.connect({
      instructions:
        `${persona}\nYou are a small desktop buddy standing on the user's screen, talking out loud in a live conversation. ` +
        `Keep replies short and conversational, one or two sentences; no lists, no markdown. ` +
        `Delegate to the backend when the user asks you to do something (dance, climb, sleep, come over, walk, stop, be quiet) or asks a question that needs thought.`,
      backend: {
        model: settings.liveBackendModel || "gpt-5.6-luna",
        instructions: `${persona}\n${chatContext()}\nYou act through tools. When the user asks ${name} to do something a tool covers, call that tool, then reply in one short sentence. Never call a tool the user did not ask for.`,
        tools: toolDefinitions(behavior.danceNames),
      },
      voice: settings.liveVoice || undefined,
    });
    bubble.hideIf(1);
  } catch (err) {
    bubble.say([`Live voice: ${String(err).slice(0, 110)}`], 8, clock.elapsedTime, 1);
    if (IN_TAURI) invoke("append_log", { line: `live: ${String(err).slice(0, 300)}` }).catch(() => {});
  }
}
live.onMicLevel = (level) => talk.updateMicLevel(level);
live.onUser = (text, final) => {
  talk.touch();
  activity();
  // While he is hearing you, the bubble shows what came through, so you can see it landed.
  if (!final && text.trim()) bubble.listen(text.slice(-120), 2);
  else bubble.stopListening();
  if (final) talk.remember({ who: "you", text });
};
live.onHim = (text, final) => {
  talk.touch();
  const shown = text.length > 300 ? text.slice(-300) : text;
  bubble.say([shown], talk.open ? 600 : 12, clock.elapsedTime, 2);
  if (final) talk.remember({ who: "him", text });
};
live.onTool = async (call) => {
  const cmd = commandFromTool(call.name, call.args, behavior.danceNames);
  const note = cmd ? runCommand(cmd) : null;
  return note ?? "That is not something you can do.";
};
live.onStatus = (text) => bubble.say([text], 4, clock.elapsedTime, 1);
live.onClosed = (reason) => {
  bubble.stopListening();
  talk.updateMicLevel(0);
  if (reason !== "close_requested") bubble.say([`Live voice ended (${reason}).`], 5, clock.elapsedTime, 1);
  if (talk.open && liveMode()) talk.hide();
};

talk.onSend = async (text) => {
  activity();
  behavior.interrupt(clock.elapsedTime);
  if (liveMode()) {
    // Live voice: typed text goes into the same conversation; the reply comes back spoken.
    if (live.state !== "on") await startLive();
    if (!live.sendText(text)) bubble.say(["Live voice is not connected."], 4, clock.elapsedTime, 1);
    return;
  }
  // Replies outrank quips: a "This slaps" cannot wipe an answer, and while the strip is open
  // the answer stays until the next one (or the strip closes).
  bubble.say(["…"], 40, clock.elapsedTime, 2);
  // Plain commands act at once; the model is still asked so he can acknowledge in character.
  const local = parseCommand(text, behavior.danceNames, Object.keys(manifest?.clips ?? {}));
  const note = local ? runCommand(local) : null;
  try {
    const raw = await chat.ask(text, chatContext(note ?? ""));
    const tagged = extractTag(raw, behavior.danceNames);
    if (tagged.command && !local) runCommand(tagged.command);
    const reply = tagged.text || (note ? "On it." : raw);
    const words = reply.split(/\s+/).length;
    talk.remember({ who: "him", text: reply });
    bubble.say([reply], talk.open ? 600 : Math.min(24, 3 + words * 0.45), clock.elapsedTime, 2);
    if (settings.chatVoice) voice.say(reply);
  } catch (err) {
    bubble.say([`Can't talk right now: ${String(err).slice(0, 90)}`], 6, clock.elapsedTime, 1);
  }
};
talk.onStatus = (text) => bubble.say([text], 4, clock.elapsedTime, 1);
talk.onOpenChange = (open) => {
  ignoringCursor = null; // re-evaluate click-through now that the strip is (in)visible
  if (open && IN_TAURI) getCurrentWindow().setFocus().catch(() => {});
  if (open && liveMode()) void startLive();
  if (!open) {
    voice.stop();
    if (live.state !== "off") void live.close();
    bubble.hideIf(2);
  }
};
voice.onError = (msg) => bubble.say([`Voice: ${msg}`], 4, clock.elapsedTime, 1);
function openTalk() {
  if (!settings.chatEnabled) {
    bubble.say(["Turn on Talk in Settings first."], 3, clock.elapsedTime);
    return;
  }
  // Live voice: the mic is the session itself, and the button mutes it.
  talk.onMicToggle = liveMode()
    ? () => {
        live.setMuted(!live.muted);
        return live.muted;
      }
    : undefined;
  talk.micEnabled = liveMode() || !!settings.chatSttModel;
  talk.toggle();
}

/** Any interaction: resets the sleep timer and wakes him up. */
function activity() {
  lastActivity = clock.elapsedTime;
  // A commanded nap ignores passing mouse traffic; a poke or a grab still wakes him.
  if (asleep && clock.elapsedTime < commandedSleepUntil && physics?.mode !== "held" && sincePoke > 0.2) return;
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
    sounds.play("grab");
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
  if (physics?.mode === "hanging") return { state: "hang", clip: behavior.stateClip("hang") };
  if (physics?.mode === "mantling") {
    // Hang for the first part of the pull-up, then the landing crouch rises into the idle.
    const hangFirst = physics.mantleKind === "pull" && physics.mantleProgress < 0.45;
    return { state: "mantle", clip: hangFirst ? behavior.stateClip("hang") : (behavior.stateClip("land") ?? behavior.stateClip("idle")) };
  }
  if (havocAction) {
    const name = attackClip(havocAction.kind);
    flailNow = false;
    return { state: "fidget", clip: name ? { name, loop: false } : behavior.stateClip("idle") };
  }
  if (physics?.airborne) {
    if (airborneSince < 0) airborneSince = t;
    // A push-off of his own reads as a jump from the very first frame: the crouch and the
    // spring are the whole of it, and waiting to be sure he is airborne would miss them.
    if (physics.launch) {
      if (jumpKind !== physics.launch) {
        jumpKind = physics.launch;
        jumpClip = behavior.stateClip(physics.launch === "off" ? "jumpOff" : "jump");
      }
      if (jumpClip) {
        flailNow = false;
        return { state: "jump", clip: jumpClip };
      }
    }
    const long = t - airborneSince > 0.35;
    const fallClip = long ? behavior.stateClip("fall") : null;
    // The arm flail is only for packs with no falling clip at all; on a short hop or a bounce
    // the previous pose plus the limb springs is all that should move.
    flailNow = long && !fallClip;
    return { state: "fall", clip: fallClip };
  }
  if (!physics?.launch) jumpKind = null;
  // A bounce touches the floor for a frame; only a settled rest ends the airborne stretch,
  // otherwise the falling clip would flicker off and on across every bounce.
  if (physics?.mode === "rest") airborneSince = -1;
  if (pokeUntil > t) return { state: "poked", clip: pokeClip };
  if (mirrorOn && t - lastPoseAt < 1) return { state: "mirror", clip: behavior.stateClip("idle") };
  if (landUntil > t) return { state: "land", clip: landClip };
  // Something has to keep playing or the mixer falls to a T-pose, and with no clip the renderer
  // holds the last one: dozing off mid-stroll left the walk cycle looping under the slump, since
  // applySleep only touches the chest, neck, head and arms. A pack's own sleep clip poses him
  // outright; otherwise the idle is just a calm base for the procedural droop.
  if (asleep) {
    const sleepClip = behavior.stateClip("sleep");
    const idle = behavior.stateClip("idle");
    return { state: "sleep", clip: sleepClip ?? (idle ? { ...idle, base: true } : null) };
  }
  if (danceAmount > 0.5) return { state: "dance", clip: danceClip };
  if (typingAmount > 0.5 && t >= forcedDanceUntil) return { state: "typing", clip: behavior.stateClip("typing") ?? act.clip ?? behavior.stateClip("idle") };
  if (act.kind === "walk") return { state: "walk", clip: act.clip ? { ...act.clip, playbackRate: walkRate(act.speed, act.clip.naturalMps) } : null };
  if (act.kind === "fidget") return { state: "fidget", clip: act.clip };
  return { state: "idle", clip: act.clip ?? behavior.stateClip("idle") };
}

/**
 * Playback rate so a stride cycle roughly matches the window's speed across the screen. Which
 * cycle it is comes from the behaviour, which knows whether he is strolling, dashing or charging;
 * all this does is keep the feet from sliding, given how far that clip's own stride carries it.
 */
function walkRate(speedPx: number, naturalMps = 1.15): number {
  const h = renderer3d?.debugCharacter?.height ?? 1.8;
  const pxPerMeter = (cssH * scaleFactor) / (1.3 * h);
  return Math.max(0.5, Math.min(1.6, speedPx / (pxPerMeter * naturalMps)));
}

// ---------- loop ----------
let lastTitle = 0;
let loggedTpose = 0;
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
  if (renderer3d && renderer3d.tposeFrames !== loggedTpose) {
    loggedTpose = renderer3d.tposeFrames;
    invoke("append_log", { line: `tpose #${loggedTpose} ${renderer3d.tposeLast} mode=${p.mode} act=${lastAct} sinceLand=${sinceLand.toFixed(2)}` }).catch(() => {});
  }
  const title =
    `Robo Buddy | ${p.mode} y=${p.y.toFixed(0)} air=${p.airborne} yaw=${yaw.toFixed(2)} cur=${cursor.x},${cursor.y},${cursor.buttons}` +
    ` | pack=${pack?.id} state=${currentState} grab=${grabPart ?? '-'} talk=${talk.open} talking=${voice.speaking || live.speaking} live=${live.state}/${Math.round(live.seconds)}s/${live.lastReason} keys=${typingRate.toFixed(1)}/${typingAmount.toFixed(2)}/${keyEvents} sup=${physics?.support ?? '-'} surf=${physics?.surfaces.length ?? 0} ss=${screensaverOn ? 1 : 0} nrg=${behavior.energetic ? 1 : 0} climb=${physics?.climbable() ? 'y' : 'n'} chg=${physics?.chargeTarget() ? 'y' : 'n'} hops=${hopCount} pun=${punchCount} barge=${barging ? 1 : 0} snd=${sounds.last} head=${Math.round(p.headPx)} crouch=${Math.round(p.crouchPx)} act=${lastAct} clip=${lastClip} free=${lastFree} amt=${danceAmount.toFixed(2)} dance=${behavior.currentDance ?? "-"} sleep=${sleepAmount.toFixed(2)} idle=${(t - lastActivity).toFixed(0)}s ct=${settings.clickThrough} ign=${ignoringCursor} alpha=${alpha} probe=[${probe}] px=${p.x} canvas=${stage3d.width}x${stage3d.height} paused=${settings.paused} size=${settings.size} evt=${settingsEvents} boot=${bootStamp}` +
    (m ? ` | lvl=${m.level.toFixed(2)} lvlAvg=${m.gateLevel.toFixed(2)} lock=${m.lockSeconds.toFixed(1)}s bpm=${m.bpm.toFixed(0)} dance=${m.dancing} amt=${danceAmount.toFixed(2)} beats=${m.beats.toFixed(1)}` : "");
  getCurrentWindow().setTitle(title).catch(() => {});
}

const clock = new SimulationClock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  resize();

  const paused = settings.paused;
  if (music) {
    // His own voice through the speakers must not start (or stop) a dance.
    music.hold = voice.busy(1500) || live.speaking;
    music.update(dt, t);
    const musicOn = settings.musicEnabled && !paused && (manifest?.reactions.music?.enabled ?? true);
    const forced = t < forcedDanceUntil && physics?.mode === "rest" && !asleep;
    const suppressed = t < danceSuppressUntil;
    // In the screensaver he is on a rampage; music only tempts him into a short dance now and
    // then, and the rest of the time he ignores it and keeps smashing.
    const requested = forced || (musicOn && music.dancing && !suppressed);
    const ssDanceOk = !screensaverOn || ssDance.allows(t, requested, physics?.mode === "rest" && physics.support === null);
    // With every dance unticked (the built-in groove too) music does not move him at all.
    const target = (requested && ssDanceOk) && behavior.canDance && !physics?.airborne && physics?.mode !== "held" ? 1 : 0;
    danceAmount += (target - danceAmount) * (1 - Math.exp(-dt * (target ? 2.5 : 1.5)));
  }
  sincePoke += dt;
  sinceLand += dt;
  // Typing along: the rate decays between key bursts; a steady 3 keys/s counts as typing.
  typingRate *= Math.exp(-dt * 0.8);
  if (screensaverOn) lastActivity = t;
  const typingTarget = settings.keyboardEnabled && typingRate > 3 && physics?.mode === "rest" && !asleep && !talk.open ? 1 : 0;
  if (typingTarget && typingAmount < 0.5) behavior.interrupt(t);
  typingAmount += (typingTarget - typingAmount) * (1 - Math.exp(-dt * (typingTarget ? 3 : 0.7)));
  updatePress(t);
  // Standing on the taskbar: sink the window by the camera's margin so the soles meet its edge.
  // Standing on the taskbar: the window covers the taskbar band and the soles sit on its top edge.
  if (physics) physics.floorOverlap = settings.standOnTaskbar && renderer === renderer3d ? physics.taskbarHeight : 0;
  if (renderer3d) {
    renderer3d.groundPx = physics ? physics.groundOverlap / scaleFactor : 0;
    renderer3d.bubblePx = bubble.visibleHeight();
    renderer3d.crouchPx = physics ? physics.crouchPx / scaleFactor : 0;
    const want = lightingFor(settings, settings.character);
    if (renderer3d.lighting !== want) renderer3d.lighting = want;
  }
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
    if (!asleep && !paused && settings.bubblesEnabled && physics?.mode === "rest" && !talk.open && t >= quietUntil && extraLines.idle?.length) bubble.say(extraLines.idle, 4, t);
  }
  const sleepAfter = settings.sleepAfterMin * 60;
  if (!asleep && sleepAfter > 0 && !paused && t - lastActivity > sleepAfter) {
    asleep = true;
    sleepLineAt = t + 1; // a beat after his eyes close, not the same frame
  }
  // Once, as he drops off. The "sleep" lines are announcements ("Gonna rest my eyes"), not
  // snores, so the timer that repeated them every 6 to 10 seconds read as a stuck bubble; and
  // being told to be quiet has to quieten this too, the way it does the idle chatter above.
  if (asleep && t > sleepLineAt) {
    sleepLineAt = Infinity;
    if (t >= quietUntil && !talk.open) speak("sleep", 2.2);
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

  if (timedPunch) {
    if (!screensaverOn || paused || asleep || physics?.mode === "held" || danceAmount >= .5 || t >= timedPunch.end) timedPunch = null;
    else if (!timedPunch.fired && t >= timedPunch.contact) {
      timedPunch.fired=true; punchCount++; sounds.play("bump");
      void emit("buddy-strike", {kind:"punch",dir:timedPunch.dir}).catch(() => {});
    }
  }
  havocAction = havoc.update(t, !timedPunch && screensaverOn && !paused && !asleep && !!physics &&
    (physics.mode === "rest" || (physics.airborne && !!physics.launch)) && danceAmount < .5,
    settings.screensaverIntensity ?? 70, physics?.x ?? 0, physics?.y ?? 0, physics?.w ?? 320, physics?.h ?? 440,
    [...attackTargets.values()].flat(), physics?.airborne ?? false);
  if (havocAction?.jump && physics) physics.spring(havocAction.dir);
  if (havocAction?.impact) {
    punchCount++;
    sounds.play("bump");
    void emit("buddy-strike", { kind: havocAction.kind, dir: havocAction.dir }).catch(() => {});
  }
  // Idle-time behaviour: variants, fidgets, wandering.
  const free = !havocAction &&
    !paused && !asleep && !!physics && physics.mode === "rest" && !physics.airborne && danceAmount < 0.5 && pokeUntil <= t;
  const act = behavior.update({
    t,
    free,
    x: physics?.x ?? 0,
    w: physics?.w ?? 320,
    left: physics?.bounds.left ?? 0,
    right: physics?.bounds.right ?? 1920,
    climb: settings.surfacesEnabled && settings.wanderEnabled ? (physics?.climbable() ?? null) : null,
    // Only during the screensaver: something to run at flat out, whether or not he could ever
    // stand on it. Without this the charge and the punch never come up at all.
    charge: screensaverOn && settings.surfacesEnabled && settings.wanderEnabled ? (physics?.chargeTarget() ?? null) : null,
    onSurface: physics?.onSurface ?? false,
    support: physics?.support ?? null,
    deskLeft: physics?.deskBounds.left ?? 0,
    deskRight: physics?.deskBounds.right ?? 1920,
  });
  const resolved = resolveState(t, act);
  currentState = resolved.state;
  lastAct = act.kind;
  lastFree = free;
  lastClip = resolved.clip?.name ?? "-";
  let targetFacing = havocAction ? havocAction.dir * Math.PI / 2 : 0;
  if (currentState === "walk" && act.kind === "walk" && physics) {
    const dir = Math.sign(act.targetX - physics.x) || 1;
    targetFacing = (dir * Math.PI) / 2;
    const step = Math.min(Math.abs(act.targetX - physics.x), act.speed * settings.size * dt);
    physics.nudge(dir * step, act.beyond);
  }
  if (behavior.pendingHop !== null && physics) {
    physics.hop(behavior.pendingHop);
    behavior.pendingHop = null;
    hopCount++;
  }
  if (behavior.pendingLeave !== null && physics) {
    physics.leapOff(behavior.pendingLeave);
    behavior.pendingLeave = null;
  }
  if (behavior.pendingPunch !== null) {
    const dir = behavior.pendingPunch;
    behavior.pendingPunch = null;
    const duration = Math.max(.4, resolved.clip ? renderer?.clipDuration(resolved.clip.name) ?? .85 : .85);
    timedPunch = {dir, contact:t+duration*STRIKE_CONTACT, end:t+duration, fired:false};
    holdFacing = (dir * Math.PI) / 2;
    holdFacingUntil = t + duration;
  }
  if (!havocAction && t < holdFacingUntil) targetFacing = holdFacing;
  facing = targetFacing;
  const bargeNow = screensaverOn && !havocAction && !timedPunch && act.kind === "walk" && act.then === "barge";
  if (bargeNow !== barging) {
    barging = bargeNow;
    void invoke("buddy_barge", { on: barging }).catch(() => {});
  }

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
      talking: voice.speaking || live.speaking,
      flail: flailNow,
      mirror: currentState === "mirror" ? mirrorPose : null,
      attack: havocAction ? { start: havocAction.start, kind: havocAction.kind, procedural: !attackClip(havocAction.kind), progress: (t - havocAction.start) / havocAction.duration } : null,
    };
    renderer.frame(input);
  }
  // While held, keep the point he is held by (a hand, the head) under the cursor.
  if (physics?.mode === "held" && renderer && grabPart) {
    const hp = renderer.holdPoint();
    if (hp) physics.steerHold(hp.x * scaleFactor, hp.y * scaleFactor);
  }
  if (!paused || physics?.mode === "held" || physics?.airborne) physics?.step(dt);
  if (renderer) {
    const a = renderer.bubbleAnchor();
    bubble.update(t, a.x, a.y, cssW);
    // Where the top of his head is in the window right now, for the ceiling checks; and, while
    // he just stands there with no bubble zooming the fit out, how much window sits above his
    // head when upright, which tells the physics which windows he can stand on top of.
    if (physics && renderer === renderer3d) {
      physics.crownPx = a.y * scaleFactor;
      const plainIdle = currentState === "idle" && resolved.clip?.name === behavior.stateClip("idle")?.name;
      if (physics.mode === "rest" && physics.crouchPx === 0 && bubble.visibleHeight() === 0 && plainIdle && a.y > 0) physics.headPx = a.y * scaleFactor;
    }
  }
  updateClickThrough();
  debugTitle(t);
}

let frameErrors = 0;
let frameSkip = 0;
function loop() {
  if (hiddenByFullscreen) {
    clock.getDelta();
    // Conversations use their own audio/network callbacks and remain active.
    requestAnimationFrame(loop);
    return;
  }
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
