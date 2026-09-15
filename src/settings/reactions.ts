import { listen } from "@tauri-apps/api/event";
import { Behavior } from "../behavior";
import type { AudioFeatures } from "../audio";
import { beatLockSeconds, type Settings } from "../settings-store";
import type { Manifest } from "../packs";
import { $, type SettingsContext, type TabModule } from "./types";

export class ReactionsTab implements TabModule {
  private ctx!: SettingsContext;
  private els = {
    paused: $<HTMLInputElement>("paused"),
    mouse: $<HTMLInputElement>("mouse"),
    physics: $<HTMLInputElement>("physics"),
    gravityStrength: $<HTMLInputElement>("gravity-strength"),
    bounciness: $<HTMLInputElement>("bounciness"),
    throwStrength: $<HTMLInputElement>("throw-strength"),
    physicsReset: $<HTMLButtonElement>("physics-reset"),
    ssIntensity: $<HTMLInputElement>("ss-intensity"),
    music: $<HTMLInputElement>("music"),
    sensitivity: $<HTMLInputElement>("sensitivity"),
    sensOut: $<HTMLOutputElement>("sens-out"),
    meterFill: $<HTMLDivElement>("meter-fill"),
    meterTxt: $<HTMLSpanElement>("meter-txt"),
    meterBpm: $<HTMLSpanElement>("meter-bpm"),
    sounds: $<HTMLInputElement>("sounds"),
    bubbles: $<HTMLInputElement>("bubbles"),
    sleep: $<HTMLSelectElement>("sleep"),
    dance: $<HTMLSelectElement>("dance"),
    wander: $<HTMLInputElement>("wander"),
    keyboard: $<HTMLInputElement>("keyboard"),
    surfaces: $<HTMLInputElement>("surfaces"),
    idleset: $<HTMLDivElement>("idleset"),
  };

  init(ctx: SettingsContext): void {
    this.ctx = ctx;

    this.els.paused.addEventListener("change", () => ctx.commit({ paused: this.els.paused.checked }));
    this.els.mouse.addEventListener("change", () => ctx.commit({ mouseEnabled: this.els.mouse.checked }));
    this.els.physics.addEventListener("change", () => ctx.commit({ physicsEnabled: this.els.physics.checked }));
    this.els.music.addEventListener("change", () => ctx.commit({ musicEnabled: this.els.music.checked }));

    this.els.sensitivity.addEventListener("input", () => {
      this.els.sensOut.value = this.beatLockLabel(Number(this.els.sensitivity.value));
    });
    this.els.sensitivity.addEventListener("change", () => ctx.commit({ musicBeatLock: Number(this.els.sensitivity.value) }));

    this.els.sounds.addEventListener("change", () => ctx.commit({ soundsEnabled: this.els.sounds.checked }));
    this.els.bubbles.addEventListener("change", () => ctx.commit({ bubblesEnabled: this.els.bubbles.checked }));
    this.els.sleep.addEventListener("change", () => ctx.commit({ sleepAfterMin: Number(this.els.sleep.value) }));
    this.els.dance.addEventListener("change", () => ctx.commit({ danceMode: this.els.dance.value }));
    this.els.wander.addEventListener("change", () => ctx.commit({ wanderEnabled: this.els.wander.checked }));
    this.els.keyboard.addEventListener("change", () => ctx.commit({ keyboardEnabled: this.els.keyboard.checked }));
    this.els.surfaces.addEventListener("change", () => ctx.commit({ surfacesEnabled: this.els.surfaces.checked }));

    for (const [element, key] of [
      [this.els.gravityStrength, "gravityStrength"],
      [this.els.bounciness, "bounciness"],
      [this.els.throwStrength, "throwStrength"],
      [this.els.ssIntensity, "screensaverIntensity"],
    ] as const) {
      element.addEventListener("input", () => this.renderPhysicsLabels());
      element.addEventListener("change", () => void ctx.commit({ [key]: Number(element.value) }));
    }

    this.els.physicsReset.addEventListener("click", () =>
      void ctx.commit({ gravityStrength: 1, bounciness: 0.26, throwStrength: 1 })
    );

    this.startMeter();
  }

  render(settings: Settings): void {
    this.els.paused.checked = settings.paused;
    this.els.mouse.checked = settings.mouseEnabled;
    this.els.physics.checked = settings.physicsEnabled;
    this.els.gravityStrength.value = String(settings.gravityStrength ?? 1);
    this.els.bounciness.value = String(settings.bounciness ?? 0.26);
    this.els.throwStrength.value = String(settings.throwStrength ?? 1);
    this.els.ssIntensity.value = String(settings.screensaverIntensity ?? 70);
    this.renderPhysicsLabels();

    this.els.music.checked = settings.musicEnabled;
    this.els.sensitivity.value = String(settings.musicBeatLock);
    this.els.sensOut.value = this.beatLockLabel(settings.musicBeatLock);

    this.els.sounds.checked = settings.soundsEnabled;
    this.els.bubbles.checked = settings.bubblesEnabled;

    const opts = Array.from(this.els.sleep.options).map((o) => Number(o.value));
    const nearest = opts.reduce((a, b) =>
      Math.abs(b - settings.sleepAfterMin) < Math.abs(a - settings.sleepAfterMin) ? b : a
    );
    this.els.sleep.value = String(nearest);

    this.els.wander.checked = settings.wanderEnabled;
    this.els.keyboard.checked = settings.keyboardEnabled;
    this.els.surfaces.checked = settings.surfacesEnabled;
  }

  renderPhysicsLabels(): void {
    $<HTMLOutputElement>("gravity-out").value = `${Math.round(Number(this.els.gravityStrength.value) * 100)}%`;
    $<HTMLOutputElement>("bounce-out").value = `${Math.round(Number(this.els.bounciness.value) * 100)}%`;
    $<HTMLOutputElement>("throw-out").value = `${Math.round(Number(this.els.throwStrength.value) * 100)}%`;
    $<HTMLOutputElement>("ss-intensity-out").value = `${this.els.ssIntensity.value}%`;
  }

  beatLockLabel(lock: number): string {
    return `after ${beatLockSeconds(lock).toFixed(1)} s`;
  }

  renderIdleSet(m: Manifest): void {
    this.els.idleset.innerHTML = "";
    const settings = this.ctx.getSettings();
    const enabled = new Set(settings.idleSets?.[settings.character] ?? []);
    const hasSet = !!settings.idleSets?.[settings.character];
    const danceKeyed = [...enabled].some((k) => k.startsWith("dance:"));
    const danceKeys = this.danceKeysOf(m);
    const entries: Array<{ key: string; label: string }> = [
      ...(m.idleVariants ?? []).map((v) => ({ key: v, label: `idle: ${v}` })),
      ...(m.fidgets ?? []).map((f) => ({
        key: Behavior.fidgetKey(f),
        label: `fidget: ${Behavior.fidgetKey(f).replace(/\+/g, " → ")}`,
      })),
      ...danceKeys.map((k) => ({
        key: k,
        label: `dance: ${k === "dance:procedural" ? "Built-in groove" : k.slice(6).replace(/_/g, " ")}`,
      })),
    ];
    if (!entries.length) {
      this.els.idleset.textContent = "This character has no idle variations.";
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
        if (![...current].some((k) => k.startsWith("dance:"))) for (const k of danceKeys) current.add(k);
        if (input.checked) current.add(e.key);
        else current.delete(e.key);
        void this.ctx
          .commit({ idleSets: { ...settings.idleSets, [settings.character]: [...current] } })
          .then(() => this.renderDanceChoices(m));
      });
      label.append(input, document.createTextNode(" " + e.label));
      this.els.idleset.appendChild(label);
    }
  }

  danceKeysOf(m: Manifest): string[] {
    return (m.dances ?? []).map((d) => `dance:${typeof d === "string" ? d : d.clip}`);
  }

  danceTicked(key: string): boolean {
    const settings = this.ctx.getSettings();
    const set = settings.idleSets?.[settings.character];
    if (!set || !set.some((k) => k.startsWith("dance:"))) return true;
    return set.includes(key);
  }

  renderDanceChoices(m: Manifest): void {
    const all = (m.dances ?? []).map((d) => (typeof d === "string" ? d : d.clip));
    const names = all.filter((d) => d !== "procedural" && this.danceTicked(`dance:${d}`));
    const dances = ["random", ...names, ...(all.includes("procedural") && this.danceTicked("dance:procedural") ? ["procedural"] : [])];
    this.els.dance.innerHTML = "";
    for (const d of dances) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d === "random" ? "Random each time" : d === "procedural" ? "Built-in groove" : d.replace(/_/g, " ");
      this.els.dance.appendChild(opt);
    }
    const settings = this.ctx.getSettings();
    this.els.dance.value = dances.includes(settings.danceMode) ? settings.danceMode : "random";
  }

  startMeter(): void {
    let level = 0;
    let silent = true;
    let last = performance.now();
    listen<AudioFeatures>("audio", (e) => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      silent = e.payload.silent;
      level += (e.payload.level - level) * (1 - Math.exp(-dt * 1.5));
      const bpmNow = e.payload.bpm;
      const on = !silent && bpmNow > 0;
      this.els.meterFill.style.width = `${Math.round(Math.min(1, level) * 100)}%`;
      this.els.meterFill.classList.toggle("on", on);
      this.els.meterTxt.textContent = silent ? "silent" : on ? "beat found" : "no beat";
      const bpm = Math.round(bpmNow);
      this.els.meterBpm.textContent = bpm > 0 ? `${bpm} bpm` : "— bpm";
    }).catch(() => {
      this.els.meterTxt.textContent = "";
      this.els.meterBpm.textContent = "";
    });
  }
}
