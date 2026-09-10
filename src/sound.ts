import type { Manifest, PackRef } from "./packs";

type SoundEvent = keyof NonNullable<Manifest["sounds"]>;

/** Preloaded per-pack sound effects. Missing entries are simply silent. */
export class Sounds {
  private clips = new Map<SoundEvent, HTMLAudioElement>();
  enabled = true;
  volume = 0.6;

  load(pack: PackRef, manifest: Manifest) {
    this.clips.clear();
    for (const [event, file] of Object.entries(manifest.sounds ?? {}) as [SoundEvent, string][]) {
      const a = new Audio(pack.base + file);
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
