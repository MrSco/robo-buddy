import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listPacks, type Manifest, type PackRef } from "./packs";
import { LivePreview, thumbnailFor } from "./preview";
import { Behavior } from "./behavior";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import type { AudioFeatures } from "./audio";
import { effectiveManifest, listLibrary, invalidateLibrary, ROLES, type LibraryClip } from "./library";
import { getSettings, onSettingsChanged, setSettings, type ClickThroughMode, type Settings } from "./settings-store";
import { listPersonalities, loadUserPersonalities, saveUserPersonalities, slugFor, type Personality } from "./personality";
import { emit, listen as listenEvent } from "@tauri-apps/api/event";
import { Capture } from "./capture";
import { PoseRecorder, exportClipGlb } from "./mocap";
import { canonicalRig } from "./retarget";
import { defaultPersona, type LineEvent } from "./chat";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  character: $<HTMLSelectElement>("character"),
  import: $<HTMLButtonElement>("import"),
  removePack: $<HTMLButtonElement>("remove-pack"),
  openCharacters: $<HTMLButtonElement>("open-characters"),
  openClips: $<HTMLButtonElement>("open-clips"),
  piperDelete: $<HTMLButtonElement>("piper-delete"),
  bring: $<HTMLButtonElement>("bring"),
  size: $<HTMLInputElement>("size"),
  sizeOut: $<HTMLOutputElement>("size-out"),
  lighting: $<HTMLInputElement>("lighting"),
  lightOut: $<HTMLOutputElement>("light-out"),
  paused: $<HTMLInputElement>("paused"),
  mouse: $<HTMLInputElement>("mouse"),
  physics: $<HTMLInputElement>("physics"),
  music: $<HTMLInputElement>("music"),
  sensitivity: $<HTMLInputElement>("sensitivity"),
  sensOut: $<HTMLOutputElement>("sens-out"),
  meterFill: $<HTMLDivElement>("meter-fill"),
  meterMark: $<HTMLDivElement>("meter-mark"),
  meterTxt: $<HTMLSpanElement>("meter-txt"),
  tempo: $<HTMLInputElement>("tempo"),
  clickthrough: $<HTMLSelectElement>("clickthrough"),
  autostart: $<HTMLInputElement>("autostart"),
  taskbar: $<HTMLInputElement>("taskbar"),
  keyboard: $<HTMLInputElement>("keyboard"),
  surfaces: $<HTMLInputElement>("surfaces"),
  sounds: $<HTMLInputElement>("sounds"),
  bubbles: $<HTMLInputElement>("bubbles"),
  sleep: $<HTMLSelectElement>("sleep"),
  dance: $<HTMLSelectElement>("dance"),
  wander: $<HTMLInputElement>("wander"),
  live: $<HTMLCanvasElement>("live"),
  gallery: $<HTMLDivElement>("gallery"),
  idleset: $<HTMLDivElement>("idleset"),
  fullscreen: $<HTMLInputElement>("fullscreen"),
  dropzone: $<HTMLDivElement>("dropzone"),
  libsearch: $<HTMLInputElement>("libsearch"),
  libsource: $<HTMLSelectElement>("libsource"),
  library: $<HTMLDivElement>("library"),
  status: $<HTMLParagraphElement>("status"),
  chatEnabled: $<HTMLInputElement>("chat-enabled"),
  talkFields: $<HTMLDivElement>("talk-fields"),
  chatProvider: $<HTMLSelectElement>("chat-provider"),
  chatEndpoint: $<HTMLInputElement>("chat-endpoint"),
  chatModel: $<HTMLInputElement>("chat-model"),
  chatStt: $<HTMLInputElement>("chat-stt"),
  chatKey: $<HTMLInputElement>("chat-key"),
  chatKeyHint: $<HTMLSpanElement>("chat-keyhint"),
  chatSaveKey: $<HTMLButtonElement>("chat-savekey"),
  chatKeyStatus: $<HTMLParagraphElement>("chat-keystatus"),
  chatVoice: $<HTMLInputElement>("chat-voice"),
  chatLines: $<HTMLInputElement>("chat-lines"),
  chatCap: $<HTMLInputElement>("chat-cap"),
  chatTest: $<HTMLButtonElement>("chat-test"),
  chatTestStatus: $<HTMLParagraphElement>("chat-teststatus"),
  personality: $<HTMLSelectElement>("personality"),
  personalityHint: $<HTMLParagraphElement>("personality-hint"),
  chatSttEndpoint: $<HTMLInputElement>("chat-stt-endpoint"),
  ttsEngine: $<HTMLSelectElement>("tts-engine"),
  talkMode: $<HTMLSelectElement>("talk-mode"),
  liveFields: $<HTMLDivElement>("live-fields"),
  pipelineFields: $<HTMLDivElement>("pipeline-fields"),
  liveKey: $<HTMLInputElement>("live-key"),
  liveSaveKey: $<HTMLButtonElement>("live-savekey"),
  liveKeyStatus: $<HTMLSpanElement>("live-keystatus"),
  liveBackend: $<HTMLInputElement>("live-backend"),
  liveVoice: $<HTMLInputElement>("live-voice"),
  liveMinutes: $<HTMLInputElement>("live-minutes"),
  liveUsage: $<HTMLParagraphElement>("live-usage"),
  piperFields: $<HTMLDivElement>("piper-fields"),
  piperExe: $<HTMLInputElement>("piper-exe"),
  piperVoice: $<HTMLSelectElement>("piper-voice"),
  piperVoicePath: $<HTMLInputElement>("piper-voice-path"),
  piperStatus: $<HTMLSpanElement>("piper-status"),
  piperInstall: $<HTMLButtonElement>("piper-install"),
  piperOpen: $<HTMLButtonElement>("piper-open"),
  piperAdd: $<HTMLSelectElement>("piper-add"),
  piperDownload: $<HTMLButtonElement>("piper-download"),
  piperAddStatus: $<HTMLParagraphElement>("piper-addstatus"),
  chatModels: $<HTMLDataListElement>("chat-models"),
  chatModelsRefresh: $<HTMLButtonElement>("chat-models-refresh"),
  chatModelsStatus: $<HTMLParagraphElement>("chat-models-status"),
  sttModels: $<HTMLDataListElement>("stt-models"),
  tabs: $<HTMLElement>("tabs"),
  cam: $<HTMLVideoElement>("cam"),
  camOverlay: $<HTMLCanvasElement>("cam-overlay"),
  camEmpty: $<HTMLDivElement>("cam-empty"),
  camStart: $<HTMLButtonElement>("cam-start"),
  camMirror: $<HTMLInputElement>("cam-mirror"),
  camHands: $<HTMLInputElement>("cam-hands"),
  camStatus: $<HTMLSpanElement>("cam-status"),
  camRecord: $<HTMLButtonElement>("cam-record"),
  camRecStatus: $<HTMLSpanElement>("cam-rec-status"),
  camName: $<HTMLInputElement>("cam-name"),
  camRole: $<HTMLSelectElement>("cam-role"),
  camLoop: $<HTMLInputElement>("cam-loop"),
  camSave: $<HTMLButtonElement>("cam-save"),
  camSaveStatus: $<HTMLParagraphElement>("cam-save-status"),
  personalityEdit: $<HTMLButtonElement>("personality-edit"),
  pedit: $<HTMLDivElement>("pedit"),
  peName: $<HTMLInputElement>("pe-name"),
  peTemp: $<HTMLInputElement>("pe-temp"),
  peWords: $<HTMLInputElement>("pe-words"),
  peDesc: $<HTMLInputElement>("pe-desc"),
  pePersona: $<HTMLTextAreaElement>("pe-persona"),
  peLines: $<HTMLDivElement>("pe-lines"),
  peSave: $<HTMLButtonElement>("pe-save"),
  peSaveAs: $<HTMLButtonElement>("pe-saveas"),
  peDelete: $<HTMLButtonElement>("pe-delete"),
  peClose: $<HTMLButtonElement>("pe-close"),
  peStatus: $<HTMLSpanElement>("pe-status"),
};

let settings: Settings;
let applying = false;
let packs: PackRef[] = [];
const manifests = new Map<string, Manifest>();
let live: LivePreview | null = null;
/** Pack currently shown in the live preview (may differ from the active character). */
let previewing: string | null = null;

function getLive() {
  if (!live) live = new LivePreview(els.live);
  return live;
}

async function previewPack(id: string) {
  const pack = packs.find((p) => p.id === id);
  if (!pack) return;
  previewing = id;
  for (const b of els.gallery.querySelectorAll("button")) b.classList.toggle("previewing", b.dataset.id === id);
  els.removePack.hidden = pack.bundled;
  els.removePack.textContent = `Remove "${pack.name}"`;
  const m = await manifestFor(pack);
  try {
    await getLive().show(pack, m);
    if (m.renderer === "3d") status(`Rig: ${getLive().rigReport}`);
  } catch (err) {
    status(`Preview failed: ${err}`);
  }
}

async function renderGallery() {
  els.gallery.innerHTML = "";
  for (const p of packs) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = p.id;
    b.title = p.name;
    b.classList.toggle("selected", p.id === settings.character);
    const label = document.createElement("span");
    label.textContent = p.name;
    b.appendChild(label);
    b.addEventListener("click", () => {
      // First click previews, a click on the previewed pack makes it the buddy.
      if (previewing === p.id && settings.character !== p.id) {
        void commit({ character: p.id });
        for (const x of els.gallery.querySelectorAll("button")) x.classList.toggle("selected", x.dataset.id === p.id);
        void updatePackDetails();
      } else void previewPack(p.id);
    });
    els.gallery.appendChild(b);
  }
  // Thumbnails load one at a time through the shared preview context.
  for (const p of packs) {
    try {
      const m = await manifestFor(p);
      const src = await thumbnailFor(p, m, getLive());
      const b = els.gallery.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(p.id)}"]`);
      if (b) b.style.backgroundImage = `url(${src})`;
    } catch {
      // leave the placeholder
    }
  }
  // Thumbnails borrowed the live canvas; show the active pack in it now.
  await previewPack(settings.character);
}

let libraryClips: LibraryClip[] = [];

async function renderLibrary() {
  const ref = packs.find((p) => p.id === "rocco");
  const refManifest = ref ? await manifestFor(ref) : undefined;
  libraryClips = await listLibrary(refManifest);
  const q = els.libsearch.value.trim().toLowerCase();
  const src = els.libsource.value;
  els.library.innerHTML = "";
  for (const c of libraryClips) {
    if (src && c.source !== src) continue;
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const name = document.createElement("div");
    name.className = "name";
    name.title = c.name;
    name.textContent = c.name.replace(/_/g, " ");
    const tag = document.createElement("span");
    tag.className = "src";
    tag.textContent = c.source === "user" ? "mine" : c.source;
    name.appendChild(tag);
    const role = document.createElement("select");
    for (const r of ROLES) {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r === "off" ? "not used" : r;
      role.appendChild(o);
    }
    role.value = settings.animRoles?.[c.name] ?? c.defaultRole;
    role.addEventListener("change", () => {
      const roles = { ...(settings.animRoles ?? {}) };
      if (role.value === c.defaultRole) delete roles[c.name];
      else roles[c.name] = role.value;
      void commit({ animRoles: roles });
    });
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "▶";
    play.title = "Preview on the selected character (click again to stop)";
    play.addEventListener("click", () => void getLive().playClip(c.name, c.url));
    playButtons.set(c.name, play);
    const card = document.createElement("div");
    card.className = "clip";
    card.dataset.clip = c.name;
    card.append(name, role, play);
    if (c.source === "user" && c.file) {
      card.classList.add("mine");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "🗑";
      del.title = "Delete this clip from your library";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete the clip "${c.name}"? This removes the file.`)) return;
        try {
          if (getLive().previewing === c.name) getLive().stopPreview();
          await invoke("delete_user_clip", { file: c.file });
          const roles = { ...(settings.animRoles ?? {}) };
          delete roles[c.name];
          invalidateLibrary();
          await commit({ animRoles: roles });
          await renderLibrary();
          status(`Deleted "${c.name}".`);
        } catch (err) {
          status(`Could not delete: ${err}`);
        }
      });
      card.appendChild(del);
    }
    els.library.appendChild(card);
  }
}

async function importFile(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  try {
    status(`Importing ${path.split(/[\\/]/).pop()}…`);
    const staged = await invoke<string>("stage_dropped", { source: path });
    let kind: "model" | "clip" = "model";
    if (["glb", "gltf", "fbx"].includes(ext)) {
      const { loadModel } = await import("./character");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const probe = await loadModel(convertFileSrc(staged));
      let hasMesh = false;
      probe.root.traverse((o) => {
        if ((o as { isMesh?: boolean }).isMesh) hasMesh = true;
      });
      kind = hasMesh ? "model" : probe.animations.length ? "clip" : "model";
    } else if (!["webp", "gif", "png", "apng", "vrm"].includes(ext)) {
      status(`Unsupported file type .${ext}`);
      return;
    }
    const result = await invoke<{ kind: string; id?: string; name: string }>("finalize_import", { staged, kind, name: null });
    invalidateLibrary();
    if (result.kind === "model" && result.id) {
      await refreshPacks();
      await commit({ character: result.id });
      status(`Imported "${result.name}".`);
    } else {
      await renderLibrary();
      status(`Added animation "${result.name}". Pick a role for it below.`);
    }
  } catch (err) {
    status(`Import failed: ${err}`);
  }
}

function renderIdleSet(m: Manifest) {
  els.idleset.innerHTML = "";
  const enabled = new Set(settings.idleSets?.[settings.character] ?? []);
  const hasSet = !!settings.idleSets?.[settings.character];
  // Dances joined this list later: a saved set without any "dance:" key means all dances are on.
  const danceKeyed = [...enabled].some((k) => k.startsWith("dance:"));
  const danceKeys = danceKeysOf(m);
  const entries: Array<{ key: string; label: string }> = [
    ...(m.idleVariants ?? []).map((v) => ({ key: v, label: `idle: ${v}` })),
    ...(m.fidgets ?? []).map((f) => ({ key: Behavior.fidgetKey(f), label: `fidget: ${Behavior.fidgetKey(f).replace(/\+/g, " → ")}` })),
    ...danceKeys.map((k) => ({ key: k, label: `dance: ${k === "dance:procedural" ? "Built-in groove" : k.slice(6).replace(/_/g, " ")}` })),
  ];
  if (!entries.length) {
    els.idleset.textContent = "This character has no idle variations.";
    return;
  }
  for (const e of entries) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    const isDance = e.key.startsWith("dance:");
    input.checked = hasSet && (!isDance || danceKeyed) ? enabled.has(e.key) : true;
    input.addEventListener("change", () => {
      const current = new Set(settings.idleSets?.[settings.character] ?? entries.map((x) => x.key));
      // First dance toggle on an older set: write every dance in explicitly, then apply the change.
      if (![...current].some((k) => k.startsWith("dance:"))) for (const k of danceKeys) current.add(k);
      if (input.checked) current.add(e.key);
      else current.delete(e.key);
      void commit({ idleSets: { ...settings.idleSets, [settings.character]: [...current] } }).then(() => renderDanceChoices(m));
    });
    label.append(input, document.createTextNode(" " + e.label));
    els.idleset.appendChild(label);
  }
}

async function manifestFor(pack: PackRef): Promise<Manifest> {
  let m = manifests.get(pack.id);
  if (!m) {
    m = (await (await fetch(pack.base + "manifest.json")).json()) as Manifest;
    manifests.set(pack.id, m);
  }
  return m;
}

let currentManifest: Manifest | null = null;

/** "dance:<clip>" keys for every dance a manifest offers, the built-in groove included. */
function danceKeysOf(m: Manifest): string[] {
  return (m.dances ?? []).map((d) => `dance:${typeof d === "string" ? d : d.clip}`);
}

/** Whether a dance is ticked in the idle set (all are, until a set lists any dance). */
function danceTicked(key: string): boolean {
  const set = settings.idleSets?.[settings.character];
  if (!set || !set.some((k) => k.startsWith("dance:"))) return true;
  return set.includes(key);
}

/** The Dance dropdown: random, the ticked clips, and the built-in groove if ticked. */
function renderDanceChoices(m: Manifest) {
  const all = (m.dances ?? []).map((d) => (typeof d === "string" ? d : d.clip));
  const names = all.filter((d) => d !== "procedural" && danceTicked(`dance:${d}`));
  const dances = ["random", ...names, ...(all.includes("procedural") && danceTicked("dance:procedural") ? ["procedural"] : [])];
  els.dance.innerHTML = "";
  for (const d of dances) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d === "random" ? "Random each time" : d === "procedural" ? "Built-in groove" : d.replace(/_/g, " ");
    els.dance.appendChild(opt);
  }
  els.dance.value = dances.includes(settings.danceMode) ? settings.danceMode : "random";
}

/** The manifest the buddy runs with: reference defaults for imports, plus the library and the user's roles. */
async function runningManifestFor(pack: PackRef): Promise<Manifest> {
  const base = await manifestFor(pack);
  if (base.renderer !== "3d") return base;
  const ref = packs.find((p) => p.id === "rocco");
  const reference = ref ? await manifestFor(ref) : undefined;
  return effectiveManifest(base, pack.bundled, reference, await listLibrary(reference), settings.animRoles ?? {});
}

async function updatePackDetails() {
  const pack = packs.find((p) => p.id === settings.character) ?? packs[0];
  if (!pack) return;
  const m = await runningManifestFor(pack);
  currentManifest = m;
  renderDanceChoices(m);
  renderIdleSet(m);
}

// Sensitivity slider maps 0..1 to threshold 0.5..0.03 (higher slider = more sensitive).
const thresholdFromSlider = (v: number) => 0.5 - v * 0.47;
const sliderFromThreshold = (t: number) => Math.min(1, Math.max(0, (0.5 - t) / 0.47));

async function refreshPacks() {
  packs = await listPacks();
  els.character.innerHTML = "";
  for (const p of packs) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.bundled ? p.name : `${p.name} (imported)`;
    els.character.appendChild(opt);
  }
  els.character.value = settings.character;
  void renderGallery();
}

function render() {
  applying = true;
  els.character.value = settings.character;
  els.size.value = String(settings.size);
  els.sizeOut.value = `${Math.round(settings.size * 100)}%`;
  els.lighting.value = String(settings.lighting ?? 1);
  els.lightOut.value = `${Math.round((settings.lighting ?? 1) * 100)}%`;
  if (live) live.lighting = settings.lighting ?? 1;
  els.paused.checked = settings.paused;
  els.mouse.checked = settings.mouseEnabled;
  els.physics.checked = settings.physicsEnabled;
  els.music.checked = settings.musicEnabled;
  els.sensitivity.value = String(sliderFromThreshold(settings.musicThreshold));
  els.sensOut.value = `${Math.round(sliderFromThreshold(settings.musicThreshold) * 100)}%`;
  els.tempo.checked = settings.requireTempo;
  els.chatEnabled.checked = settings.chatEnabled;
  els.talkFields.classList.toggle("off", !settings.chatEnabled);
  els.chatProvider.value = settings.chatProvider;
  els.chatEndpoint.value = settings.chatEndpoint;
  els.chatModel.value = settings.chatModel;
  els.chatStt.value = settings.chatSttModel;
  els.chatVoice.checked = settings.chatVoice;
  els.chatLines.checked = settings.chatGenerateLines;
  els.chatCap.value = String(settings.chatDailyCap);
  els.chatSttEndpoint.value = settings.chatSttEndpoint;
  els.ttsEngine.value = settings.ttsEngine;
  els.piperFields.hidden = settings.ttsEngine !== "piper";
  els.talkMode.value = settings.talkMode === "live" ? "live" : "pipeline";
  els.liveFields.hidden = settings.talkMode !== "live";
  els.pipelineFields.classList.toggle("dim", settings.talkMode === "live");
  els.liveBackend.value = settings.liveBackendModel;
  els.liveVoice.value = settings.liveVoice;
  els.liveMinutes.value = String(settings.liveDailyMinutes);
  if (settings.talkMode === "live") void refreshLiveStatus();
  els.piperExe.value = settings.piperExe;
  els.piperVoicePath.value = settings.piperVoice;
  if (els.piperVoice.options.length) els.piperVoice.value = settings.piperVoice;
  if (els.personality.options.length) {
    els.personality.value = settings.personality;
    els.personalityHint.textContent = els.personality.selectedOptions[0]?.dataset.desc ?? "";
  }
  els.chatKeyHint.textContent = PROVIDERS[settings.chatProvider]?.keyHint ?? "for your endpoint";
  els.clickthrough.value = settings.clickThrough;
  els.autostart.checked = settings.autostart;
  els.sounds.checked = settings.soundsEnabled;
  els.bubbles.checked = settings.bubblesEnabled;
  // Snap to the nearest offered option (the stored value may be anything).
  const opts = Array.from(els.sleep.options).map((o) => Number(o.value));
  const nearest = opts.reduce((a, b) => (Math.abs(b - settings.sleepAfterMin) < Math.abs(a - settings.sleepAfterMin) ? b : a));
  els.sleep.value = String(nearest);
  els.wander.checked = settings.wanderEnabled;
  els.fullscreen.checked = settings.hideWhenFullscreen;
  els.taskbar.checked = settings.standOnTaskbar;
  els.keyboard.checked = settings.keyboardEnabled;
  els.surfaces.checked = settings.surfacesEnabled;
  applying = false;
  void updatePackDetails();
  void renderLibrary();
}

async function commit(patch: Partial<Settings>) {
  if (applying) return;
  settings = { ...settings, ...patch };
  await setSettings(settings);
}

function status(msg: string) {
  els.status.textContent = msg;
  if (msg) setTimeout(() => (els.status.textContent === msg ? (els.status.textContent = "") : null), 4000);
}

/** Live music meter: the same slow average the buddy's dance gate uses, against the slider's threshold. */
function startMeter() {
  let level = 0;
  let silent = true;
  let last = performance.now();
  listen<AudioFeatures>("audio", (e) => {
    const now = performance.now();
    const dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    silent = e.payload.silent;
    level += (e.payload.level - level) * (1 - Math.exp(-dt * 1.5));
    const threshold = thresholdFromSlider(Number(els.sensitivity.value));
    const on = !silent && level > threshold;
    els.meterFill.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
    els.meterFill.classList.toggle("on", on);
    els.meterMark.style.left = `${Math.round(threshold * 100)}%`;
    els.meterTxt.textContent = silent ? "silent" : on ? "dancing" : "too quiet";
  }).catch(() => {
    els.meterTxt.textContent = "";
  });
}

/** Provider presets: any OpenAI-compatible endpoint works; these fill in the usual values. */
const PROVIDERS: Record<string, { endpoint: string; model: string; stt: string; keyHint: string }> = {
  groq: { endpoint: "https://api.groq.com/openai/v1", model: "groq/compound", stt: "whisper-large-v3-turbo", keyHint: "free at console.groq.com/keys" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", stt: "", keyHint: "free at aistudio.google.com/apikey" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", stt: "whisper-1", keyHint: "platform.openai.com/api-keys" },
  ollama: { endpoint: "http://localhost:11434/v1", model: "llama3.2", stt: "", keyHint: "not needed" },
  custom: { endpoint: "", model: "", stt: "", keyHint: "for your endpoint" },
};

interface PiperStatus {
  root: string;
  exe: string | null;
  voices: Array<{ name: string; path: string }>;
  catalogue: Array<{ id: string; label: string }>;
}

/** Managed Piper: where it is, which voices are installed, what can be downloaded. */
async function refreshPiper() {
  let st: PiperStatus;
  try {
    st = await invoke<PiperStatus>("piper_status");
  } catch (err) {
    els.piperStatus.textContent = `Piper: ${err}`;
    return;
  }
  const managed = !!st.exe;
  const custom = settings.piperExe && st.exe !== settings.piperExe && settings.piperExe.trim() !== "";
  els.piperStatus.textContent = managed
    ? `Piper is installed${custom ? " (using your own piper.exe instead)" : ""}.`
    : settings.piperExe
      ? "Using your own piper.exe."
      : "Piper is not installed yet.";
  els.piperInstall.hidden = managed;
  els.piperInstall.disabled = false;
  if (managed && !settings.piperExe) {
    await commit({ piperExe: st.exe! });
    els.piperExe.value = st.exe!;
  }
  els.piperVoice.innerHTML = "";
  if (!st.voices.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "no voices yet: download one below or drop .onnx files in the folder";
    els.piperVoice.appendChild(o);
  }
  for (const v of st.voices) {
    const o = document.createElement("option");
    o.value = v.path;
    o.textContent = v.name;
    els.piperVoice.appendChild(o);
  }
  if (settings.piperVoice && !st.voices.some((v) => v.path === settings.piperVoice)) {
    const o = document.createElement("option");
    o.value = settings.piperVoice;
    o.textContent = `${settings.piperVoice.split(/[\\/]/).pop()} (custom path)`;
    els.piperVoice.appendChild(o);
  }
  if (settings.piperVoice) els.piperVoice.value = settings.piperVoice;
  else if (st.voices.length) {
    // Nothing chosen yet: take the first installed voice.
    els.piperVoice.value = st.voices[0].path;
    els.piperVoicePath.value = st.voices[0].path;
    await commit({ piperVoice: st.voices[0].path });
  }
  els.piperAdd.innerHTML = "";
  for (const c of st.catalogue) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = st.voices.some((v) => v.name === c.id) ? `${c.label} (installed)` : c.label;
    els.piperAdd.appendChild(o);
  }
}

/** Model ids from the endpoint into the pick lists; whisper-ish ones also go to the speech list. */
async function refreshModels() {
  els.chatModelsStatus.textContent = "Fetching models…";
  try {
    const ids = await invoke<string[]>("list_models");
    els.chatModels.innerHTML = "";
    els.sttModels.innerHTML = "";
    for (const id of ids) {
      const o = document.createElement("option");
      o.value = id;
      (/whisper|transcri|speech/i.test(id) ? els.sttModels : els.chatModels).appendChild(o);
    }
    els.chatModelsStatus.textContent = ids.length ? `${ids.length} models available; click the box to pick one.` : "The endpoint listed no models.";
  } catch (err) {
    els.chatModelsStatus.textContent = `Could not list models: ${err}`;
  }
}

function wireTabs() {
  const buttons = Array.from(els.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]"));
  const pages = Array.from(document.querySelectorAll<HTMLElement>(".page[data-page]"));
  const show = (name: string) => {
    for (const b of buttons) b.classList.toggle("active", b.dataset.tab === name);
    for (const p of pages) p.hidden = p.dataset.page !== name;
    // Voices dropped into the folder while the window sat hidden show up on the next visit.
    if (name === "talk" && settings?.ttsEngine === "piper") void refreshPiper();
    // One WebGL preview, shown on the Character page and beside the animation list.
    const home = document.getElementById(name === "library" ? "preview-lib" : name === "capture" ? "preview-cap" : "preview-char");
    const from = els.live.parentElement;
    if (home && from && from !== home) {
      // The canvas and, for a 2D character, its still image travel together.
      while (from.firstChild) home.appendChild(from.firstChild);
    }
    try {
      localStorage.setItem("settings-tab", name);
    } catch {
      /* no storage */
    }
  };
  for (const b of buttons) b.addEventListener("click", () => show(b.dataset.tab!));
  let initial = "character";
  try {
    initial = localStorage.getItem("settings-tab") ?? initial;
  } catch {
    /* no storage */
  }
  if (!pages.some((p) => p.dataset.page === initial)) initial = "character";
  show(initial);
}

async function refreshKeyStatus() {
  try {
    const has = await invoke<boolean>("has_chat_key");
    const used = await invoke<number>("chat_usage");
    els.chatKeyStatus.textContent = (has ? "A key is saved." : "No key saved.") + (used ? ` ${used} requests today.` : "");
  } catch {
    els.chatKeyStatus.textContent = "";
  }
}

async function refreshLiveStatus() {
  try {
    const has = await invoke<boolean>("has_live_key");
    const secs = await invoke<number>("live_usage");
    els.liveKeyStatus.textContent = has ? "a key is saved" : "no key saved";
    els.liveUsage.textContent = secs > 0 ? `${(secs / 60).toFixed(1)} minutes of Live voice used today.` : "No Live voice used today.";
  } catch {
    els.liveKeyStatus.textContent = "";
  }
}

function wireLive() {
  els.talkMode.addEventListener("change", () => {
    const live = els.talkMode.value === "live";
    els.liveFields.hidden = !live;
    els.pipelineFields.classList.toggle("dim", live);
    void commit({ talkMode: live ? "live" : "pipeline" });
    if (live) void refreshLiveStatus();
  });
  els.liveBackend.addEventListener("change", () => void commit({ liveBackendModel: els.liveBackend.value.trim() || "gpt-5.6-luna" }));
  els.liveVoice.addEventListener("change", () => void commit({ liveVoice: els.liveVoice.value.trim() }));
  els.liveMinutes.addEventListener("change", () => void commit({ liveDailyMinutes: Math.max(0, Math.round(Number(els.liveMinutes.value) || 0)) }));
  els.liveSaveKey.addEventListener("click", async () => {
    try {
      await invoke("set_live_key", { key: els.liveKey.value });
      els.liveKey.value = "";
      await refreshLiveStatus();
      els.liveKeyStatus.textContent = "key saved";
    } catch (err) {
      els.liveKeyStatus.textContent = `could not save: ${err}`;
    }
  });
  els.liveKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.liveSaveKey.click();
  });
  if (settings?.talkMode === "live") void refreshLiveStatus();
}

function wireTalk() {
  wireLive();
  els.chatEnabled.addEventListener("change", () => {
    els.talkFields.classList.toggle("off", !els.chatEnabled.checked);
    void commit({ chatEnabled: els.chatEnabled.checked });
  });
  els.chatProvider.addEventListener("change", () => {
    const p = PROVIDERS[els.chatProvider.value];
    if (p && els.chatProvider.value !== "custom") {
      els.chatEndpoint.value = p.endpoint;
      els.chatModel.value = p.model;
      els.chatStt.value = p.stt;
    }
    els.chatKeyHint.textContent = p?.keyHint ?? "";
    void commit({ chatProvider: els.chatProvider.value, chatEndpoint: els.chatEndpoint.value.trim(), chatModel: els.chatModel.value.trim(), chatSttModel: els.chatStt.value.trim() }).then(() => refreshModels());
  });
  els.chatEndpoint.addEventListener("change", () => void commit({ chatEndpoint: els.chatEndpoint.value.trim() }));
  els.chatModel.addEventListener("change", () => void commit({ chatModel: els.chatModel.value.trim() }));
  els.chatStt.addEventListener("change", () => void commit({ chatSttModel: els.chatStt.value.trim() }));
  els.chatVoice.addEventListener("change", () => void commit({ chatVoice: els.chatVoice.checked }));
  els.chatLines.addEventListener("change", () => void commit({ chatGenerateLines: els.chatLines.checked }));
  els.chatCap.addEventListener("change", () => void commit({ chatDailyCap: Math.max(0, Math.round(Number(els.chatCap.value) || 0)) }));
  els.chatSttEndpoint.addEventListener("change", () => void commit({ chatSttEndpoint: els.chatSttEndpoint.value.trim() }));
  els.ttsEngine.addEventListener("change", () => {
    els.piperFields.hidden = els.ttsEngine.value !== "piper";
    void commit({ ttsEngine: els.ttsEngine.value });
    if (els.ttsEngine.value === "piper") void refreshPiper();
  });
  els.piperExe.addEventListener("change", () => void commit({ piperExe: els.piperExe.value.trim().replace(/^"|"$/g, "") }));
  els.piperVoicePath.addEventListener("change", () => void commit({ piperVoice: els.piperVoicePath.value.trim().replace(/^"|"$/g, "") }));
  els.piperVoice.addEventListener("change", () => {
    els.piperVoicePath.value = els.piperVoice.value;
    void commit({ piperVoice: els.piperVoice.value });
  });
  els.piperInstall.addEventListener("click", async () => {
    els.piperInstall.disabled = true;
    els.piperStatus.textContent = "Downloading Piper (22 MB)…";
    try {
      const exe = await invoke<string>("piper_install");
      await commit({ piperExe: exe });
      els.piperExe.value = exe;
      await refreshPiper();
    } catch (err) {
      els.piperStatus.textContent = `Install failed: ${err}`;
      els.piperInstall.disabled = false;
    }
  });
  els.piperOpen.addEventListener("click", () => void invoke("piper_open_voices").catch(() => {}));
  els.piperDownload.addEventListener("click", async () => {
    const id = els.piperAdd.value;
    if (!id) return;
    els.piperDownload.disabled = true;
    els.piperAddStatus.textContent = `Downloading ${id}… (about 60 MB)`;
    try {
      const path = await invoke<string>("piper_download_voice", { id });
      await commit({ piperVoice: path });
      els.piperAddStatus.textContent = `Added ${id} and selected it.`;
      await refreshPiper();
    } catch (err) {
      els.piperAddStatus.textContent = `Download failed: ${err}`;
    } finally {
      els.piperDownload.disabled = false;
    }
  });
  els.chatModelsRefresh.addEventListener("click", () => void refreshModels());
  els.personality.addEventListener("change", () => {
    els.personalityHint.textContent = els.personality.selectedOptions[0]?.dataset.desc ?? "";
    void commit({ personality: els.personality.value });
  });
  void fillPersonalities();
  wirePersonalityEditor();
  els.chatSaveKey.addEventListener("click", async () => {
    try {
      await invoke("set_chat_key", { key: els.chatKey.value });
      els.chatKey.value = "";
      await refreshKeyStatus();
      els.chatKeyStatus.textContent = "Key saved. " + els.chatKeyStatus.textContent;
      void refreshModels();
    } catch (err) {
      els.chatKeyStatus.textContent = `Could not save the key: ${err}`;
    }
  });
  els.chatKey.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.chatSaveKey.click();
  });
  els.chatTest.addEventListener("click", async () => {
    els.chatTestStatus.textContent = "Asking…";
    els.chatTest.disabled = true;
    try {
      const reply = await invoke<string>("chat_complete", {
        messages: [
          { role: "system", content: "You are a desktop buddy. Reply with one short, friendly sentence." },
          { role: "user", content: "Say hi and tell me you can hear me." },
        ],
        maxTokens: 60,
      });
      els.chatTestStatus.textContent = `He says: ${reply}`;
    } catch (err) {
      els.chatTestStatus.textContent = `Failed: ${err}`;
    } finally {
      els.chatTest.disabled = false;
      void refreshKeyStatus();
    }
  });
  void refreshKeyStatus();
}

// ---------- webcam capture ----------
let capture: Capture | null = null;
const recorder = new PoseRecorder();
let recording = false;
let lastRecorded: { seconds: number } | null = null;
let poseSeq = 0;

function showTab(name: string) {
  els.tabs.querySelector<HTMLButtonElement>(`button[data-tab="${name}"]`)?.click();
}

async function startCamera() {
  if (!capture) {
    capture = new Capture(els.cam, els.camOverlay);
    capture.hands = els.camHands.checked;
    capture.onStatus = (t) => (els.camStatus.textContent = t);
    capture.onPose = (pose, t) => {
      getLive().mirror = pose;
      if (recording) {
        recorder.push(pose, t);
        els.camRecStatus.textContent = `Recording… ${recorder.seconds.toFixed(1)} s`;
      }
      if (els.camMirror.checked) void emit("pose", pose).catch(() => {});
      if ((poseSeq++ & 31) === 0 && capture) els.camStatus.textContent = `Tracking at ${capture.fps} fps${capture.hands ? `, ${capture.handsSeen} hand${capture.handsSeen === 1 ? "" : "s"}` : ""}.`;
    };
  }
  try {
    await capture.start();
    els.camEmpty.hidden = true;
    els.camStart.textContent = "Stop camera";
    els.camRecord.disabled = false;
  } catch (err) {
    els.camStatus.textContent = `Camera failed: ${String(err).slice(0, 120)}`;
  }
}

function stopCamera() {
  capture?.stop();
  if (recording) toggleRecording();
  getLive().mirror = null;
  els.camEmpty.hidden = false;
  els.camStart.textContent = "Start camera";
  els.camRecord.disabled = true;
  if (els.camMirror.checked) {
    els.camMirror.checked = false;
    void emit("mirror", { on: false }).catch(() => {});
  }
}

function toggleRecording() {
  recording = !recording;
  if (recording) {
    recorder.begin();
    els.camRecord.textContent = "■ Stop";
    els.camRecStatus.textContent = "Recording… 0.0 s";
    els.camSave.disabled = true;
  } else {
    els.camRecord.textContent = "● Record";
    lastRecorded = { seconds: recorder.seconds };
    els.camRecStatus.textContent = recorder.count > 5 ? `${recorder.seconds.toFixed(1)} s captured (${recorder.count} frames).` : "Too short; try again.";
    els.camSave.disabled = recorder.count <= 5;
  }
}

async function saveRecording() {
  if (!lastRecorded || recorder.count <= 5) return;
  const name = (els.camName.value.trim() || `capture-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`).replace(/[^A-Za-z0-9_-]+/g, "_");
  els.camSave.disabled = true;
  els.camSaveStatus.textContent = "Building the clip…";
  try {
    const canon = await canonicalRig();
    const clip = recorder.toClip(canon, name, els.camLoop.checked);
    if (!clip) throw new Error("not enough frames");
    const glb = await exportClipGlb(canon, clip);
    const saved = await invoke<string>("save_user_clip", new Uint8Array(glb), { headers: { "x-clip-name": name } });
    invalidateLibrary();
    const role = els.camRole.value;
    if (role !== "off") await commit({ animRoles: { ...(settings.animRoles ?? {}), [saved]: role } });
    await renderLibrary();
    els.camSaveStatus.textContent = `Saved "${saved}" (${lastRecorded.seconds.toFixed(1)} s)${role !== "off" ? ` as ${role}` : ""}. It is on the Animations tab now.`;
    els.camName.value = "";
  } catch (err) {
    els.camSaveStatus.textContent = `Could not save: ${String(err).slice(0, 120)}`;
    els.camSave.disabled = false;
  }
}

function wireCapture() {
  els.camStart.addEventListener("click", () => (capture?.running ? stopCamera() : void startCamera()));
  els.camMirror.addEventListener("change", () => void emit("mirror", { on: els.camMirror.checked }).catch(() => {}));
  els.camHands.addEventListener("change", () => {
    if (capture) capture.hands = els.camHands.checked;
  });
  els.camRecord.addEventListener("click", toggleRecording);
  els.camSave.addEventListener("click", () => void saveRecording());
  // Right-click > Copy me: open here with the camera on and mirroring.
  void listen("capture", async () => {
    showTab("capture");
    await startCamera();
    if (capture?.running && !els.camMirror.checked) {
      els.camMirror.checked = true;
      void emit("mirror", { on: true }).catch(() => {});
    }
  });
  // Hiding the window (its close button hides it) stops the camera too. WebView2 does not
  // reliably fire visibilitychange for a hidden window, so Rust also sends an event.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && capture?.running) stopCamera();
  });
  void listenEvent("settings-hidden", () => {
    if (capture?.running) stopCamera();
  });
  // Leaving the tab stops the camera; a webcam light should never stay on unnoticed.
  els.tabs.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    if (b && b.dataset.tab !== "capture" && capture?.running) stopCamera();
  });
}

const LINE_EVENTS: Array<[LineEvent, string]> = [
  ["greet", "On start"],
  ["poked", "When poked"],
  ["idle", "Idle remarks"],
  ["dance", "Music starts"],
  ["land", "After a landing"],
  ["sleep", "Falling asleep"],
  ["wake", "Waking up"],
];

let profiles: Personality[] = [];

async function fillPersonalities() {
  profiles = await listPersonalities();
  els.personality.innerHTML = "";
  for (const p of profiles) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.user ? `${p.name} (yours)` : p.name;
    o.dataset.desc = p.description ?? "";
    els.personality.appendChild(o);
  }
  els.personality.value = settings?.personality ?? "pack";
  if (!els.personality.value) els.personality.value = "pack";
  els.personalityHint.textContent = els.personality.selectedOptions[0]?.dataset.desc ?? "";
}

/** Read the editor into a profile object. */
function editorToProfile(id: string): Personality {
  const lines: Partial<Record<LineEvent, string[]>> = {};
  for (const [key] of LINE_EVENTS) {
    const ta = document.getElementById(`pe-line-${key}`) as HTMLTextAreaElement | null;
    const arr = (ta?.value ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (arr.length) lines[key] = arr;
  }
  return {
    id,
    name: els.peName.value.trim() || "Untitled",
    description: els.peDesc.value.trim() || undefined,
    persona: els.pePersona.value.trim() || undefined,
    lines: Object.keys(lines).length ? lines : undefined,
    llm: { temperature: Number(els.peTemp.value) || 0.9, maxWords: Number(els.peWords.value) || 35 },
  };
}

function showEditor(p: Personality) {
  els.pedit.hidden = false;
  const editable = !!p.user;
  // "As the character" shows what the current pack actually uses, so it can be copied and tweaked.
  const packName = currentManifest?.name ?? "Buddy";
  const persona = p.persona ?? (p.id === "pack" ? currentManifest?.persona ?? defaultPersona(packName) : "");
  const lines = p.lines ?? (p.id === "pack" ? ((currentManifest?.lines ?? {}) as Personality["lines"]) : undefined);
  els.peName.value = p.id === "pack" ? `${packName} (as the character)` : p.name;
  els.peDesc.value = p.description ?? "";
  els.pePersona.value = persona;
  els.peTemp.value = String(p.llm?.temperature ?? 0.9);
  els.peWords.value = String(p.llm?.maxWords ?? 35);
  for (const el of [els.peName, els.peDesc, els.pePersona, els.peTemp, els.peWords]) el.readOnly = !editable;
  els.peLines.innerHTML = "";
  for (const [key, label] of LINE_EVENTS) {
    const l = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = label;
    const ta = document.createElement("textarea");
    ta.id = `pe-line-${key}`;
    ta.value = (lines?.[key] ?? []).join("\n");
    ta.readOnly = !editable;
    l.append(span, ta);
    els.peLines.appendChild(l);
  }
  els.peSave.disabled = !editable;
  els.peDelete.disabled = !editable;
  els.peSaveAs.textContent = editable ? "Save as new" : "Copy to a new profile";
  els.peStatus.textContent = editable ? "" : "Built in and read-only. Copy it to a new profile to change anything.";
}

function wirePersonalityEditor() {
  els.personalityEdit.addEventListener("click", () => {
    if (!els.pedit.hidden) {
      els.pedit.hidden = true;
      return;
    }
    const p = profiles.find((x) => x.id === els.personality.value);
    if (p) showEditor(p);
  });
  els.peClose.addEventListener("click", () => (els.pedit.hidden = true));
  const persist = async (list: Personality[], select?: string) => {
    await saveUserPersonalities(list);
    await fillPersonalities();
    if (select) {
      els.personality.value = select;
      els.personalityHint.textContent = els.personality.selectedOptions[0]?.dataset.desc ?? "";
      await commit({ personality: select });
    }
    await emit("personalities-changed").catch(() => {});
  };
  els.peSaveAs.addEventListener("click", async () => {
    const users = await loadUserPersonalities();
    const baseName = els.peName.value.replace(/\s*\(as the character\)\s*$/i, "").trim() || "profile";
    els.peName.value = baseName;
    const id = slugFor(baseName, profiles.map((p) => p.id));
    const p = editorToProfile(id);
    await persist([...users, p], id);
    showEditor({ ...p, user: true });
    els.peStatus.textContent = `Saved as "${p.name}" and selected.`;
  });
  els.peSave.addEventListener("click", async () => {
    const id = els.personality.value;
    const users = await loadUserPersonalities();
    if (!users.some((u) => u.id === id)) return;
    const p = editorToProfile(id);
    await persist(users.map((u) => (u.id === id ? p : u)), id);
    showEditor({ ...p, user: true });
    els.peStatus.textContent = "Saved.";
  });
  els.peDelete.addEventListener("click", async () => {
    const id = els.personality.value;
    const users = await loadUserPersonalities();
    if (!users.some((u) => u.id === id)) return;
    await persist(users.filter((u) => u.id !== id), "pack");
    els.pedit.hidden = true;
  });
}

/** Play buttons by clip name, so the one previewing can show a stop glyph. */
const playButtons = new Map<string, HTMLButtonElement>();

function wireManagement() {
  els.openCharacters.addEventListener("click", () => void invoke("open_user_folder", { kind: "characters" }).catch(() => {}));
  els.openClips.addEventListener("click", () => void invoke("open_user_folder", { kind: "clips" }).catch(() => {}));
  els.removePack.addEventListener("click", async () => {
    const pack = packs.find((p) => p.id === previewing);
    if (!pack || pack.bundled) return;
    if (!confirm(`Remove "${pack.name}"? Its files are deleted from your characters folder.`)) return;
    try {
      await invoke("delete_user_pack", { id: pack.id });
      if (settings.character === pack.id) await commit({ character: "rocco" });
      els.removePack.hidden = true;
      await refreshPacks();
      await updatePackDetails();
      status(`Removed "${pack.name}".`);
    } catch (err) {
      status(`Could not remove: ${err}`);
    }
  });
  els.piperDelete.addEventListener("click", async () => {
    const path = els.piperVoice.value;
    const name = els.piperVoice.selectedOptions[0]?.textContent ?? path;
    if (!path) return;
    if (!confirm(`Delete the voice "${name}"?`)) return;
    try {
      await invoke("piper_delete_voice", { path });
      if (settings.piperVoice === path) await commit({ piperVoice: "" });
      els.piperAddStatus.textContent = `Deleted ${name}.`;
      await refreshPiper();
    } catch (err) {
      els.piperAddStatus.textContent = `Could not delete: ${err}`;
    }
  });
}

async function main() {
  wireTabs();
  wireCapture();
  wireManagement();
  startMeter();
  wireTalk();
  getLive().onPreviewChange = (name) => {
    for (const [clip, btn] of playButtons) {
      btn.textContent = clip === name ? "■" : "▶";
      btn.closest(".clip")?.classList.toggle("previewing", clip === name);
    }
  };
  settings = await getSettings();
  try {
    settings.autostart = await isEnabled();
  } catch {
    // plugin unavailable in the browser
  }
  await refreshPacks();
  render();
  void refreshPiper();
  void refreshModels();


  els.character.addEventListener("change", () => commit({ character: els.character.value }));
  els.size.addEventListener("input", () => {
    els.sizeOut.value = `${Math.round(Number(els.size.value) * 100)}%`;
  });
  els.size.addEventListener("change", () => commit({ size: Number(els.size.value) }));
  els.lighting.addEventListener("input", () => {
    els.lightOut.value = `${Math.round(Number(els.lighting.value) * 100)}%`;
    getLive().lighting = Number(els.lighting.value);
  });
  els.lighting.addEventListener("change", () => commit({ lighting: Number(els.lighting.value) }));
  els.paused.addEventListener("change", () => commit({ paused: els.paused.checked }));
  els.mouse.addEventListener("change", () => commit({ mouseEnabled: els.mouse.checked }));
  els.physics.addEventListener("change", () => commit({ physicsEnabled: els.physics.checked }));
  els.music.addEventListener("change", () => commit({ musicEnabled: els.music.checked }));
  els.sensitivity.addEventListener("input", () => {
    els.sensOut.value = `${Math.round(Number(els.sensitivity.value) * 100)}%`;
  });
  els.sensitivity.addEventListener("change", () => commit({ musicThreshold: thresholdFromSlider(Number(els.sensitivity.value)) }));
  els.tempo.addEventListener("change", () => commit({ requireTempo: els.tempo.checked }));
  els.sounds.addEventListener("change", () => commit({ soundsEnabled: els.sounds.checked }));
  els.bubbles.addEventListener("change", () => commit({ bubblesEnabled: els.bubbles.checked }));
  els.sleep.addEventListener("change", () => commit({ sleepAfterMin: Number(els.sleep.value) }));
  els.dance.addEventListener("change", () => commit({ danceMode: els.dance.value }));
  els.wander.addEventListener("change", () => commit({ wanderEnabled: els.wander.checked }));
  els.fullscreen.addEventListener("change", () => commit({ hideWhenFullscreen: els.fullscreen.checked }));
  els.taskbar.addEventListener("change", () => commit({ standOnTaskbar: els.taskbar.checked }));
  els.keyboard.addEventListener("change", () => commit({ keyboardEnabled: els.keyboard.checked }));
  els.surfaces.addEventListener("change", () => commit({ surfacesEnabled: els.surfaces.checked }));
  els.libsearch.addEventListener("input", () => void renderLibrary());
  els.libsource.addEventListener("change", () => void renderLibrary());
  try {
    await getCurrentWebview().onDragDropEvent(async (e) => {
      els.dropzone.classList.toggle("over", e.payload.type === "enter" || e.payload.type === "over");
      if (e.payload.type !== "drop") return;
      for (const path of e.payload.paths) await importFile(path);
    });
  } catch {
    // not in Tauri
  }
  els.clickthrough.addEventListener("change", () => commit({ clickThrough: els.clickthrough.value as ClickThroughMode }));
  els.autostart.addEventListener("change", async () => {
    try {
      if (els.autostart.checked) await enable();
      else await disable();
      await commit({ autostart: els.autostart.checked });
      status(els.autostart.checked ? "Robo Buddy will start with Windows." : "Autostart disabled.");
    } catch (err) {
      status(`Could not change autostart: ${err}`);
      els.autostart.checked = !els.autostart.checked;
    }
  });

  els.bring.addEventListener("click", () => invoke("bring_here").catch((err) => status(`Could not move him: ${err}`)));

  els.import.addEventListener("click", async () => {
    const file = await open({
      multiple: false,
      directory: false,
      title: "Choose a character model",
      filters: [
        { name: "3D models", extensions: ["glb", "vrm", "gltf", "fbx"] },
        { name: "Animated images", extensions: ["webp", "gif", "png", "apng"] },
      ],
    });
    if (!file) return;
    try {
      const pack = await invoke<{ id: string; name: string }>("import_pack", { source: file, name: null });
      await refreshPacks();
      await commit({ character: pack.id });
      els.character.value = pack.id;
      status(`Imported "${pack.name}".`);
    } catch (err) {
      status(`Import failed: ${err}`);
    }
  });

  // Packs may have been added on disk while the window was hidden.
  window.addEventListener("focus", () => refreshPacks().catch(() => {}));

  // Keep in sync with changes made elsewhere (tray toggles, the buddy window).
  await onSettingsChanged((s) => {
    settings = s;
    render();
  });
}

main().catch((err) => status(`Settings failed to load: ${err}`));
