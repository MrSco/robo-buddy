import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listPacks, type Manifest, type PackRef } from "./packs";
import { LivePreview, thumbnailFor } from "./preview";
import { Behavior } from "./behavior";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import type { AudioFeatures } from "./audio";
import { listLibrary, invalidateLibrary, ROLES, type LibraryClip } from "./library";
import { getSettings, onSettingsChanged, setSettings, type ClickThroughMode, type Settings } from "./settings-store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  character: $<HTMLSelectElement>("character"),
  import: $<HTMLButtonElement>("import"),
  bring: $<HTMLButtonElement>("bring"),
  size: $<HTMLInputElement>("size"),
  sizeOut: $<HTMLOutputElement>("size-out"),
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
  const m = await manifestFor(pack);
  try {
    await getLive().show(pack, m);
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
    els.library.append(name, role, play);
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
  const entries: Array<{ key: string; label: string }> = [
    ...(m.idleVariants ?? []).map((v) => ({ key: v, label: `idle: ${v}` })),
    ...(m.fidgets ?? []).map((f) => ({ key: Behavior.fidgetKey(f), label: `fidget: ${Behavior.fidgetKey(f).replace(/\+/g, " → ")}` })),
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
    input.checked = hasSet ? enabled.has(e.key) : true;
    input.addEventListener("change", () => {
      const current = new Set(settings.idleSets?.[settings.character] ?? entries.map((x) => x.key));
      if (input.checked) current.add(e.key);
      else current.delete(e.key);
      void commit({ idleSets: { ...settings.idleSets, [settings.character]: [...current] } });
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

async function updatePackDetails() {
  const pack = packs.find((p) => p.id === settings.character) ?? packs[0];
  if (!pack) return;
  const m = await manifestFor(pack);
  // Dance choices for this pack.
  const names = (m.dances ?? []).map((d) => (typeof d === "string" ? d : d.clip)).filter((d) => d !== "procedural");
  const dances = ["random", ...names, "procedural"];
  els.dance.innerHTML = "";
  for (const d of dances) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d === "random" ? "Random each time" : d === "procedural" ? "Built-in groove" : d.replace(/_/g, " ");
    els.dance.appendChild(opt);
  }
  els.dance.value = dances.includes(settings.danceMode) ? settings.danceMode : "random";
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
  els.paused.checked = settings.paused;
  els.mouse.checked = settings.mouseEnabled;
  els.physics.checked = settings.physicsEnabled;
  els.music.checked = settings.musicEnabled;
  els.sensitivity.value = String(sliderFromThreshold(settings.musicThreshold));
  els.sensOut.value = `${Math.round(sliderFromThreshold(settings.musicThreshold) * 100)}%`;
  els.tempo.checked = settings.requireTempo;
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

/** Play buttons by clip name, so the one previewing can show a stop glyph. */
const playButtons = new Map<string, HTMLButtonElement>();

async function main() {
  startMeter();
  getLive().onPreviewChange = (name) => {
    for (const [clip, btn] of playButtons) btn.textContent = clip === name ? "■" : "▶";
  };
  settings = await getSettings();
  try {
    settings.autostart = await isEnabled();
  } catch {
    // plugin unavailable in the browser
  }
  await refreshPacks();
  render();

  els.character.addEventListener("change", () => commit({ character: els.character.value }));
  els.size.addEventListener("input", () => {
    els.sizeOut.value = `${Math.round(Number(els.size.value) * 100)}%`;
  });
  els.size.addEventListener("change", () => commit({ size: Number(els.size.value) }));
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
        { name: "3D models", extensions: ["glb", "vrm", "gltf"] },
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
