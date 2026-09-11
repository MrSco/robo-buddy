import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./input";

export interface AudioFeatures {
  rms: number;
  level: number;
  bass: number;
  mid: number;
  treble: number;
  onset: number;
  beat: boolean;
  bpm: number;
  silent: boolean;
}

/**
 * Smoothed music state plus a beat clock. `phase` runs 0..1 between beats,
 * resynchronised whenever the analyser reports a beat, and free-runs from the
 * BPM estimate in between so motion never stalls on a missed beat.
 */
export class Music {
  raw: AudioFeatures = { rms: 0, level: 0, bass: 0, mid: 0, treble: 0, onset: 0, beat: false, bpm: 0, silent: true };
  level = 0;
  bass = 0;
  mid = 0;
  treble = 0;
  bpm = 0;
  /** 0..1 progress through the current beat. */
  phase = 0;
  /** Total beats elapsed (fractional), for half- and double-time moves. */
  beats = 0;
  /** 1 on a beat, decaying to 0. */
  pulse = 0;
  dancing = false;
  /**
   * Slow average of the level (about a second) that the dance gate compares with the
   * threshold. The instantaneous level of real music swings around any threshold every
   * beat, which kept resetting the "loud for long enough" timer and he never started.
   */
  gateLevel = 0;
  /** While our own voice plays through the speakers, neither start nor stop dancing on it. */
  hold = false;
  /** When true, dancing also needs a stable tempo estimate. Filters game audio and speech. */
  requireTempo = false;
  private stableSince = -1;
  private lastBpmSample = 0;

  private aboveSince = -1;
  private belowSince = -1;
  private lastBeatAt = -1;
  private beatQueued = false;

  constructor(public threshold = 0.15) {}

  async start() {
    if (!IN_TAURI) {
      // Dev fallback in a plain browser: fake a 120 bpm groove so the dance can be seen.
      let t0 = performance.now();
      setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        this.raw = { rms: 0.3, level: 0.7, bass: 0.5 + 0.5 * Math.abs(Math.sin(t * Math.PI * 2)), mid: 0.5, treble: 0.4, onset: 0, beat: false, bpm: 120, silent: false };
        t0 = t0; // keep linter quiet
      }, 33);
      setInterval(() => (this.beatQueued = true), 500);
      return;
    }
    await listen<AudioFeatures>("audio", (e) => {
      this.raw = e.payload;
      if (e.payload.beat) this.beatQueued = true;
    });
  }

  update(dt: number, now: number) {
    const r = this.raw;
    const k = 1 - Math.exp(-dt * 12);
    this.level += (r.level - this.level) * k;
    this.bass += (r.bass - this.bass) * (1 - Math.exp(-dt * 20));
    this.mid += (r.mid - this.mid) * k;
    this.treble += (r.treble - this.treble) * k;
    if (r.bpm > 0) this.bpm = this.bpm === 0 ? r.bpm : this.bpm + (r.bpm - this.bpm) * 0.1;
    if (r.silent) this.bpm = 0;

    // Tempo stability: the raw estimate must stay within 4 bpm for 3 s.
    if (r.bpm > 0 && Math.abs(r.bpm - this.lastBpmSample) < 4) {
      if (this.stableSince < 0) this.stableSince = now;
    } else {
      this.stableSince = -1;
    }
    this.lastBpmSample = r.bpm;
    const tempoOk = !this.requireTempo || (this.stableSince >= 0 && now - this.stableSince > 3);

    // Dance state with hysteresis: starts once the average is over the threshold for half a
    // second, stops only after it sits well under it for two seconds (or on silence).
    this.gateLevel += (r.level - this.gateLevel) * (1 - Math.exp(-dt * 1.5));
    const gate = this.dancing ? this.threshold * 0.8 : this.threshold;
    if (this.hold) {
      this.aboveSince = -1;
      this.belowSince = -1;
    } else if (this.gateLevel > gate && !r.silent && tempoOk) {
      if (this.aboveSince < 0) this.aboveSince = now;
      this.belowSince = -1;
      if (!this.dancing && now - this.aboveSince > 0.5) this.dancing = true;
    } else {
      if (this.belowSince < 0) this.belowSince = now;
      this.aboveSince = -1;
      if (this.dancing && (now - this.belowSince > 2.0 || r.silent)) this.dancing = false;
    }

    // Beat clock.
    const bpm = this.bpm > 0 ? this.bpm : 110;
    const beatLen = 60 / bpm;
    if (this.beatQueued) {
      this.beatQueued = false;
      // Only resync if the beat is plausibly on the grid; otherwise treat it as a fill.
      const sinceLast = this.lastBeatAt < 0 ? Infinity : now - this.lastBeatAt;
      if (sinceLast > beatLen * 0.6) {
        this.lastBeatAt = now;
        this.beats = Math.round(this.beats);
        this.phase = 0;
        this.pulse = 1;
      }
    }
    const adv = dt / beatLen;
    this.phase += adv;
    this.beats += adv;
    if (this.phase >= 1) this.phase -= 1;
    this.pulse *= Math.exp(-dt * 8);
  }
}
