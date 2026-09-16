import type { Manifest, PackRef } from "./packs";

export type SoundEvent = keyof NonNullable<Manifest["sounds"]>;

/** Default realistic physical foley sounds with multi-sample variations per event. */
export const DEFAULT_SOUNDS: Record<SoundEvent, string[]> = {
  poked: ["/sounds/poke1.wav", "/sounds/poke2.wav"],
  land: ["/sounds/thud1.wav", "/sounds/thud2.wav", "/sounds/thud3.wav"],
  bump: ["/sounds/bump1.wav", "/sounds/bump2.wav", "/sounds/bump3.wav"],
  bounce: ["/sounds/bounce1.wav", "/sounds/bounce2.wav"],
  grab: ["/sounds/grab1.wav", "/sounds/grab2.wav"],
  throw: ["/sounds/throw1.wav", "/sounds/throw2.wav"],
  footstep: ["/sounds/step1.wav", "/sounds/step2.wav", "/sounds/step3.wav"],
  jump: ["/sounds/jump1.wav", "/sounds/jump2.wav"],
  wake: ["/sounds/wake1.wav", "/sounds/wake2.wav"],
  sleep: ["/sounds/sleep1.wav", "/sounds/sleep2.wav"],
  bubble: ["/sounds/bubble1.wav", "/sounds/bubble2.wav"],
  greet: ["/sounds/greet1.wav", "/sounds/greet2.wav"],
};

/**
 * Web Audio API playback engine with multi-sample variation pools,
 * micro-pitch jitter, dynamic velocity scaling, and master volume control.
 */
export class Sounds {
  private ctx: AudioContext | null = null;
  private bufferCache = new Map<string, Promise<AudioBuffer | null>>();
  private pools = new Map<SoundEvent, (AudioBuffer | null)[]>();
  private lastSampleIndex = new Map<SoundEvent, number>();

  private active = true;
  get enabled() {
    return this.active;
  }
  set enabled(value: boolean) {
    this.active = value;
  }

  volume = 0.6;
  footstepsEnabled = true;

  private busyUntil = -Infinity;
  private lastPlayedAt = -Infinity;

  /** True while a sound effect is playing or within `graceMs` after it ends. */
  busy(graceMs = 1500): boolean {
    if (!this.enabled) return false;
    const now = performance.now();
    return now <= this.busyUntil + graceMs || now - this.lastPlayedAt <= graceMs;
  }

  /** Dev: the last few events played, newest last, for the status line. */
  last = "-";
  private history: string[] = [];

  private getContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private async loadBuffer(url: string): Promise<AudioBuffer | null> {
    const ctx = this.getContext();
    if (!ctx) return null;
    const cached = this.bufferCache.get(url);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arrayBuf = await res.arrayBuffer();
        return await ctx.decodeAudioData(arrayBuf);
      } catch {
        return null;
      }
    })();
    this.bufferCache.set(url, promise);
    return promise;
  }

  load(pack: PackRef, manifest: Manifest) {
    this.pools.clear();
    this.lastSampleIndex.clear();

    for (const [evt, defaultFiles] of Object.entries(DEFAULT_SOUNDS) as [SoundEvent, string[]][]) {
      let urls: string[] = defaultFiles;
      const custom = manifest.sounds?.[evt];
      if (custom) {
        if (Array.isArray(custom)) {
          urls = custom.map((f) => pack.base + f);
        } else {
          urls = [pack.base + custom];
        }
      }

      const slot: (AudioBuffer | null)[] = new Array(urls.length).fill(null);
      this.pools.set(evt, slot);

      urls.forEach((url, idx) => {
        void this.loadBuffer(url).then((buf) => {
          slot[idx] = buf;
        });
      });
    }
  }

  play(event: SoundEvent, intensity = 1) {
    if (!this.enabled) return;
    if (event === "footstep" && !this.footstepsEnabled) return;

    this.history.push(event);
    if (this.history.length > 4) this.history.shift();
    this.last = this.history.join(">");
    this.lastPlayedAt = performance.now();
    this.busyUntil = Math.max(this.busyUntil, this.lastPlayedAt + 150);

    const ctx = this.getContext();
    if (!ctx) return;

    const pool = this.pools.get(event);
    if (!pool || pool.length === 0) return;

    // Pick only loaded buffers
    const readyIndices = pool
      .map((buf, i) => (buf !== null ? i : -1))
      .filter((i) => i >= 0);
    if (readyIndices.length === 0) return;

    // Pick variation avoiding immediate repeat if multiple are available
    let chosenIndex: number;
    const lastIdx = this.lastSampleIndex.get(event);
    if (readyIndices.length > 1 && lastIdx !== undefined) {
      const candidates = readyIndices.filter((i) => i !== lastIdx);
      chosenIndex = candidates[Math.floor(Math.random() * candidates.length)];
    } else {
      chosenIndex = readyIndices[Math.floor(Math.random() * readyIndices.length)];
    }
    this.lastSampleIndex.set(event, chosenIndex);

    const buffer = pool[chosenIndex];
    if (!buffer) return;

    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // Micro-pitch jitter: ±4%
      const playbackRate = 1 + (Math.random() * 2 - 1) * 0.04;
      source.playbackRate.value = playbackRate;

      if (buffer.duration > 0) {
        const durationMs = (buffer.duration / Math.max(0.1, playbackRate)) * 1000;
        this.busyUntil = Math.max(this.busyUntil, performance.now() + durationMs);
      }

      const gainNode = ctx.createGain();
      const clampedIntensity = Math.max(0.1, Math.min(1.5, intensity));
      gainNode.gain.value = Math.max(0, Math.min(1.0, this.volume * clampedIntensity));

      if (event === "land" && intensity < 0.6) {
        // Lowpass filter for soft landings to make them feel muffled/damped
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 1200 + intensity * 4000;
        source.connect(filter);
        filter.connect(gainNode);
      } else {
        source.connect(gainNode);
      }

      gainNode.connect(ctx.destination);
      source.start(0);
    } catch {
      // Autoplay restriction or audio device error: stay silent
    }
  }
}
