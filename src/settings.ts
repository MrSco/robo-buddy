import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { listPacks } from "./packs";
import { getSettings, onSettingsChanged, setSettings, type ClickThroughMode, type Settings } from "./settings-store";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  character: $<HTMLSelectElement>("character"),
  import: $<HTMLButtonElement>("import"),
  size: $<HTMLInputElement>("size"),
  sizeOut: $<HTMLOutputElement>("size-out"),
  paused: $<HTMLInputElement>("paused"),
  mouse: $<HTMLInputElement>("mouse"),
  physics: $<HTMLInputElement>("physics"),
  music: $<HTMLInputElement>("music"),
  sensitivity: $<HTMLInputElement>("sensitivity"),
  sensOut: $<HTMLOutputElement>("sens-out"),
  tempo: $<HTMLInputElement>("tempo"),
  clickthrough: $<HTMLSelectElement>("clickthrough"),
  autostart: $<HTMLInputElement>("autostart"),
  sounds: $<HTMLInputElement>("sounds"),
  bubbles: $<HTMLInputElement>("bubbles"),
  sleep: $<HTMLSelectElement>("sleep"),
  status: $<HTMLParagraphElement>("status"),
};

let settings: Settings;
let applying = false;

// Sensitivity slider maps 0..1 to threshold 0.5..0.03 (higher slider = more sensitive).
const thresholdFromSlider = (v: number) => 0.5 - v * 0.47;
const sliderFromThreshold = (t: number) => Math.min(1, Math.max(0, (0.5 - t) / 0.47));

async function refreshPacks() {
  const packs = await listPacks();
  els.character.innerHTML = "";
  for (const p of packs) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.bundled ? p.name : `${p.name} (imported)`;
    els.character.appendChild(opt);
  }
  els.character.value = settings.character;
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
  applying = false;
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

async function main() {
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
