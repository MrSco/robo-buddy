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
   * Slow average of the level, about a second. Nothing is decided by it any more; it is kept
   * because the settings meter and the debug line both show it.
   */
  gateLevel = 0;
  /** While our own voice or sound effects play through the speakers, neither start nor stop dancing on it. */
  hold = false;
  /**
   * Seconds a tempo must hold steady before he starts. This, not loudness, is what decides:
   * a beat is a beat whether the music is loud or barely audible, and quiet tracks used to leave
   * him standing still. Longer is stricter and keeps him from moving to whatever rhythm happens to
   * be in background noise.
   */
  lockSeconds = 3;
  private stableSince = -1;
  private lastBpmSample = 0;

  private belowSince = -1;
  private lastBeatAt = -1;
  private beatQueued = false;


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

    // Tempo stability: the raw estimate has to stay within 4 bpm for as long as the lock asks.
    if (r.bpm > 0 && Math.abs(r.bpm - this.lastBpmSample) < 4) {
      if (this.stableSince < 0) this.stableSince = now;
    } else {
      this.stableSince = -1;
    }
    this.lastBpmSample = r.bpm;

    // While holding, Buddy's own audio must not build up or keep a tempo lock.
    if (this.hold && !this.dancing) {
      this.stableSince = -1;
    }

    const hasBeat = !r.silent && r.bpm > 0;
    const locked = !this.hold && hasBeat && this.stableSince >= 0 && now - this.stableSince > this.lockSeconds;

    // Kept for the meter and the debug line only; how loud it is no longer decides anything.
    this.gateLevel += (r.level - this.gateLevel) * (1 - Math.exp(-dt * 1.5));
    // Committing to a dance asks for a tempo that has held steady; staying in one only asks that
    // there is still a beat. Demanding the full lock throughout dropped him mid-song: one estimate
    // jumping more than 4 bpm resets the stability timer, and waiting out another few seconds of
    // lock outlasts the stop delay, so he fell back to idling between dances until it re-locked.
    // He stops once the beat has been gone a couple of seconds, or at once on real silence, so a
    // gap between tracks does not drop him instantly.
    if (this.hold) {
      if (this.dancing) this.belowSince = -1;
    } else if (this.dancing ? hasBeat : locked) {
      this.belowSince = -1;
      this.dancing = true;
    } else {
      if (this.belowSince < 0) this.belowSince = now;
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
