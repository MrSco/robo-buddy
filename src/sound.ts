import type { Manifest, PackRef } from "./packs";

type SoundEvent = keyof NonNullable<Manifest["sounds"]>;

/** Effects every character gets unless its pack ships its own for that event. */
const DEFAULT_SOUNDS: Partial<Record<SoundEvent, string>> = { poked: "/sounds/boing.wav", land: "/sounds/thud.wav" };

/** Preloaded per-pack sound effects, with the app's defaults behind them. */
export class Sounds {
  private clips = new Map<SoundEvent, HTMLAudioElement>();
  enabled = true;
  volume = 0.6;

  load(pack: PackRef, manifest: Manifest) {
    this.clips.clear();
    const files: Partial<Record<SoundEvent, string>> = { ...DEFAULT_SOUNDS };
    for (const [event, file] of Object.entries(manifest.sounds ?? {}) as [SoundEvent, string][]) files[event] = pack.base + file;
    for (const [event, url] of Object.entries(files) as [SoundEvent, string][]) {
      const a = new Audio(url);
      a.preload = "auto";
      this.clips.set(event, a);
    }
  }

  play(event: SoundEvent) {
    if (!this.enabled) return;
    const a = this.clips.get(event);
    if (!a) return;
    try {
      a.currentTime = 0;
      a.volume = this.volume;
      void a.play().catch(() => {});
    } catch {
      // autoplay policy or decode failure: stay silent
    }
  }
}
