import type { Manifest } from "./packs";

/**
 * Decides what the buddy does with himself when nothing is happening: cycles idle
 * variants, plays the occasional fidget, and wanders along the floor. Pure logic;
 * main.ts feeds it time and status and applies what it returns.
 */

export interface ClipChoice {
  name: string;
  loop: boolean;
  beatsPerLoop?: number;
  playbackRate?: number;
}

export type Activity =
  | { kind: "idle"; clip: ClipChoice | null }
  | { kind: "fidget"; clip: ClipChoice }
  | { kind: "walk"; clip: ClipChoice | null; targetX: number; speed: number };

export interface BehaviorOptions {
  wander: boolean;
  /** "random" | "procedural" | a clip name from the manifest's dance list. */
  danceMode: string;
}

interface Status {
  t: number;
  /** He is on the floor, awake, not held, not dancing, not poked. */
  free: boolean;
  /** Current window x and width plus the work-area bounds, in physical pixels. */
  x: number;
  w: number;
  left: number;
  right: number;
}

const MIN_WANDER = 160;

export class Behavior {
  private manifest: Manifest | null = null;
  private durations: (name: string) => number = () => 0;
  private activity: Activity = { kind: "idle", clip: null };
  private activityEnds = Infinity;
  private nextEvent = 0;
  private fidgetQueue: string[] = [];
  private danceChoice: string | null = null;
  opts: BehaviorOptions = { wander: true, danceMode: "random" };

  setPack(manifest: Manifest, durations: (name: string) => number, t: number) {
    this.manifest = manifest;
    this.durations = durations;
    this.activity = { kind: "idle", clip: this.stateClip("idle") };
    this.activityEnds = Infinity;
    this.nextEvent = t + 6 + Math.random() * 8;
    this.danceChoice = null;
  }

  /** The manifest's default clip for a state, or null when it has none. */
  stateClip(state: string): ClipChoice | null {
    const def = this.manifest?.states[state];
    if (!def) return null;
    const names = def.clips?.length ? def.clips : [def.clip];
    const name = names[Math.floor(Math.random() * names.length)];
    if (!name || this.durations(name) <= 0) return null;
    return { name, loop: def.loop ?? state !== "poked", beatsPerLoop: def.beatsPerLoop, playbackRate: def.playbackRate };
  }

  /** Called when a dance session starts: pick which dance to do this time. */
  chooseDance(): ClipChoice | null {
    const m = this.manifest;
    const list = (m?.dances ?? []).filter((d) => d === "procedural" || this.durations(d) > 0);
    let pick: string | null = null;
    if (this.opts.danceMode === "procedural") pick = "procedural";
    else if (this.opts.danceMode !== "random" && list.includes(this.opts.danceMode)) pick = this.opts.danceMode;
    else if (list.length) pick = list[Math.floor(Math.random() * list.length)];
    else pick = m?.states.dance ? m.states.dance.clip : "procedural";
    this.danceChoice = pick;
    if (!pick || pick === "procedural") return null;
    const def = m?.states.dance;
    return { name: pick, loop: true, beatsPerLoop: def?.beatsPerLoop ?? 2 };
  }

  get currentDance() {
    return this.danceChoice;
  }

  /** Interrupt whatever he was doing (poke, grab, music). */
  interrupt(t: number) {
    if (this.activity.kind !== "idle") this.activity = { kind: "idle", clip: this.stateClip("idle") };
    this.activityEnds = Infinity;
    this.fidgetQueue = [];
    this.nextEvent = t + 5 + Math.random() * 8;
  }

  update(s: Status): Activity {
    const m = this.manifest;
    if (!m) return this.activity;

    // Finish timed activities.
    if (s.t >= this.activityEnds) {
      if (this.fidgetQueue.length) {
        const next = this.fidgetQueue.shift()!;
        this.activity = { kind: "fidget", clip: { name: next, loop: false } };
        this.activityEnds = s.t + this.durations(next);
        return this.activity;
      }
      this.activity = { kind: "idle", clip: this.stateClip("idle") };
      this.activityEnds = Infinity;
      this.nextEvent = s.t + 8 + Math.random() * 14;
    }
    if (this.activity.kind === "walk") {
      const arrived = Math.abs(s.x - this.activity.targetX) < 4;
      if (arrived || !s.free) {
        this.activity = { kind: "idle", clip: this.stateClip("idle") };
        this.activityEnds = Infinity;
        this.nextEvent = s.t + 6 + Math.random() * 10;
      }
      return this.activity;
    }
    if (!s.free) {
      // Never start anything while he is busy; just push the schedule back.
      if (this.activity.kind !== "idle") this.activity = { kind: "idle", clip: this.stateClip("idle") };
      this.nextEvent = Math.max(this.nextEvent, s.t + 4);
      return this.activity;
    }
    if (s.t < this.nextEvent) return this.activity;

    // Time for something new.
    const variants = (m.idleVariants ?? []).filter((v) => this.durations(v) > 0);
    const fidgets = (m.fidgets ?? []).filter((f) => (Array.isArray(f) ? f : [f]).every((c) => this.durations(c) > 0));
    const walk = m.states.walk;
    const canWalk = this.opts.wander && !!walk && this.durations(walk.clip) > 0 && s.right - s.left - s.w > MIN_WANDER * 2;
    const options: Array<() => void> = [];
    if (variants.length) {
      options.push(() => {
        const v = variants[Math.floor(Math.random() * variants.length)];
        this.activity = { kind: "idle", clip: { name: v, loop: true } };
        this.activityEnds = s.t + 10 + Math.random() * 15;
      });
    }
    if (fidgets.length) {
      options.push(() => {
        const f = fidgets[Math.floor(Math.random() * fidgets.length)];
        const seq = Array.isArray(f) ? [...f] : [f];
        const first = seq.shift()!;
        this.fidgetQueue = seq;
        this.activity = { kind: "fidget", clip: { name: first, loop: false } };
        this.activityEnds = s.t + this.durations(first);
      });
    }
    if (canWalk) {
      options.push(() => {
        const minX = s.left;
        const maxX = s.right - s.w;
        let target = s.x;
        for (let i = 0; i < 8 && Math.abs(target - s.x) < MIN_WANDER; i++) {
          target = minX + Math.random() * (maxX - minX);
        }
        target = Math.max(minX, Math.min(maxX, target));
        const speed = walk!.speed ?? 120;
        this.activity = { kind: "walk", clip: { name: walk!.clip, loop: true }, targetX: target, speed };
        this.activityEnds = s.t + Math.abs(target - s.x) / speed + 1.5; // safety timeout
      });
    }
    if (options.length) {
      options[Math.floor(Math.random() * options.length)]();
      // The activity's end (or the walk's arrival) schedules the next event.
      this.nextEvent = Infinity;
    } else this.nextEvent = s.t + 20;
    return this.activity;
  }
}
