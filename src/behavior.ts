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
  /**
   * Only a resting base pose to keep the mixer off a T-pose, not the state's own animation, so
   * the procedural layer for that state still goes on top of it.
   */
  base?: boolean;
  /** Metres per second the clip's own stride covers, for matching playback to his real speed. */
  naturalMps?: number;
}

export type Activity =
  | { kind: "idle"; clip: ClipChoice | null }
  | { kind: "fidget"; clip: ClipChoice }
  | {
      kind: "walk";
      clip: ClipChoice | null;
      targetX: number;
      speed: number;
      /**
       * What to do on arrival: leap at the window edge and climb it, hit it, or barge straight
       * through it. Only a barge lets his speed shove the window; the other two need it to stay
       * put until he has hold of it.
       */
      then?: "hop" | "punch" | "barge";
      hopTop?: number;
      /** Which way he is facing when he lands the punch, -1 or 1. */
      punchDir?: number;
      beyond?: boolean;
    };

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
  /** A window edge he could climb from here (from the physics), and whether he is on one. */
  climb: { x: number; hwnd: number; top: number } | null;
  /**
   * Something to run at and leap at, even when standing on it is out of the question. Null
   * outside the screensaver. Required, not optional: as an optional field it was quietly never
   * passed, and the whole charge-and-punch behaviour sat dead behind it.
   */
  charge: { x: number; hwnd: number; top: number } | null;
  onSurface: boolean;
  /** The window he is standing on, or null; so roaming he does not fixate on re-climbing it. */
  support: number | null;
  /** The whole floor's edges (every screen while roaming), even when he is up on a window, so
   * he steps off toward the desk rather than off the outer edge of it into nothing. */
  deskLeft: number;
  deskRight: number;
}

const MIN_WANDER = 160;
/**
 * How far one stroll or one dash may take him. Every screen is his to walk, and picking a target
 * anywhere on it meant single walks the width of the desk: a minute of trudging in a straight
 * line, with nothing else happening. Held to about half a screen at a stroll and a screen at a
 * run, he crosses from monitor to monitor over several trips instead, and stops to do things
 * along the way.
 */
const MAX_STROLL = 1400;
const MAX_DASH = 2600;
/** A dash needs this much clear floor ahead of him to be worth breaking into a run for. */
const DASH_MIN = 700;

export class Behavior {
  private manifest: Manifest | null = null;
  private durations: (name: string) => number = () => 0;
  private activity: Activity = { kind: "idle", clip: null };
  private activityEnds = Infinity;
  private nextEvent = 0;
  private fidgetQueue: string[] = [];
  private danceChoice: string | null = null;
  opts: BehaviorOptions = { wander: true, danceMode: "random" };
  /** Enabled idle variants / fidget keys, or null for all. Fidget sequences are keyed by their joined names. */
  enabled: Set<string> | null = null;

  static fidgetKey(f: string | string[]): string {
    return Array.isArray(f) ? f.join("+") : f;
  }

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
    return { name, loop: def.loop ?? state !== "poked", beatsPerLoop: def.beatsPerLoop, playbackRate: def.playbackRate, naturalMps: def.naturalMps };
  }

  /**
   * A faster gait than the stroll: the clip and the speed it is meant to carry him at, or null
   * when this pack has no such clip. Speed and cycle come from the same place on purpose, so a
   * pack cannot ask to travel at a run and be drawn walking.
   */
  private gear(name: "run" | "sprint"): { clip: ClipChoice; speed: number } | null {
    const def = this.manifest?.states[name];
    const clip = this.stateClip(name);
    if (!def || !clip) return null;
    return { clip: { ...clip, loop: true }, speed: def.speed ?? 300 };
  }

  /** Called when a dance session starts: pick which dance to do this time. */
  /** Names of the dances this pack offers (clip names), for chat commands. */
  get danceNames(): string[] {
    return (this.manifest?.dances ?? []).map((d) => (typeof d === "string" ? d : d.clip)).filter((d) => d !== "procedural" && this.durations(d) > 0 && this.danceOn(d));
  }

  /**
   * Whether the user left this dance ticked. Dance keys in the enabled set are "dance:<name>";
   * a set saved before dances were listed there has none, and then every dance counts as on.
   */
  danceOn(name: string): boolean {
    if (!this.enabled) return true;
    let keyed = false;
    for (const k of this.enabled) if (k.startsWith("dance:")) { keyed = true; break; }
    return !keyed || this.enabled.has(`dance:${name}`);
  }

  /** The dances he may actually do: ticked clips he has, plus the built-in groove if ticked. */
  private get danceList(): string[] {
    return (this.manifest?.dances ?? [])
      .map((d) => (typeof d === "string" ? d : d.clip))
      .filter((d) => (d === "procedural" || this.durations(d) > 0) && this.danceOn(d));
  }

  /**
   * False when every dance, the built-in groove included, is unticked: music then leaves him
   * be. Packs with no dance list still dance: a 2D buddy bobs (or plays its dance clip), and a
   * 3D pack may name a single dance state instead of a list.
   */
  get canDance(): boolean {
    const m = this.manifest;
    if (!m) return false;
    if (m.renderer === "2d") return true;
    if (!(m.dances ?? []).length) return !!m.states.dance && this.durations(m.states.dance.clip) > 0;
    return this.danceList.length > 0;
  }

  /** A dance by name for a chat command; unknown or missing name = a random one. */
  chooseDanceNamed(name?: string): ClipChoice | null {
    const saved = this.opts.danceMode;
    this.opts = { ...this.opts, danceMode: name && this.danceNames.includes(name) ? name : "random" };
    const pick = this.chooseDance();
    this.opts = { ...this.opts, danceMode: saved };
    return pick;
  }

  /** Walk to an x (window left) now, optionally past the edge of what he stands on. */
  startWalk(t: number, targetX: number, beyond = false, then?: { hopTop: number }) {
    const walk = this.manifest?.states.walk;
    if (!walk || this.durations(walk.clip) <= 0) return false;
    const speed = walk.speed ?? 120;
    this.fidgetQueue = [];
    this.activity = { kind: "walk", clip: { name: walk.clip, loop: true }, targetX, speed, beyond, then: then ? "hop" : undefined, hopTop: then?.hopTop };
    this.activityEnds = t + 30;
    this.nextEvent = Infinity;
    return true;
  }

  /** Play one clip once, now (a chat "do the X"). */
  /**
   * Hold a clip, looping, until something else takes over. Re-issuing a one-shot instead let
   * him fall back to standing for a moment between repeats and then fade into the clip again,
   * which is a visible hitch every time round.
   */
  forceLoop(name: string) {
    const d = this.durations(name);
    if (d <= 0) return false;
    if (this.activity.kind === "fidget" && this.activity.clip.name === name && this.activity.clip.loop) return true;
    this.fidgetQueue = [];
    this.activity = { kind: "fidget", clip: { name, loop: true } };
    this.activityEnds = Infinity;
    this.nextEvent = Infinity;
    return true;
  }

  forceFidget(t: number, name: string) {
    const d = this.durations(name);
    if (d <= 0) return false;
    this.fidgetQueue = [];
    this.activity = { kind: "fidget", clip: { name, loop: false } };
    this.activityEnds = t + d;
    this.nextEvent = Infinity;
    return true;
  }

  /** Queue one or more fidget clips to play, transitioning immediately if idle. */
  queueFidget(name: string | string[], t?: number) {
    if (typeof t === "number" && typeof name === "string") {
      return this.forceFidget(t, name);
    }
    const list = Array.isArray(name) ? name : [name];
    this.fidgetQueue.push(...list);
    if (this.activity.kind === "idle") {
      this.activityEnds = 0;
    }
    return true;
  }

  chooseDance(): ClipChoice | null {
    const m = this.manifest;
    const list = this.danceList;
    let pick: string | null = null;
    // A named choice that is unticked (or missing) falls back to a random ticked one.
    if (this.opts.danceMode !== "random" && list.includes(this.opts.danceMode)) pick = this.opts.danceMode;
    else if (list.length) pick = list[Math.floor(Math.random() * list.length)];
    else if (!(m?.dances ?? []).length && m?.states.dance && this.durations(m.states.dance.clip) > 0) pick = m.states.dance.clip;
    else pick = null;
    this.danceChoice = pick;
    if (!pick || pick === "procedural") return null;
    const entry = (m?.dances ?? []).find((d) => typeof d !== "string" && d.clip === pick) as { clip: string; beatsPerLoop?: number } | undefined;
    // Without a stated beat count, assume the clip was choreographed near 120 bpm (two beats per second)
    // so it stays roughly on the music's tempo instead of racing.
    const beats = entry?.beatsPerLoop ?? (pick === m?.states.dance?.clip ? m?.states.dance?.beatsPerLoop : undefined) ?? Math.max(1, Math.round(this.durations(pick) * 2));
    return { name: pick, loop: true, beatsPerLoop: beats };
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

  /** Set when a walk that was heading for a climb arrives; main performs the hop. */
  pendingHop: number | null = null;
  /** Set to the direction (-1/1) he should leap off the window he is on; main performs the leap. */
  pendingLeave: number | null = null;
  /** Set to -1 or 1 the moment a punch lands, for whatever is on the receiving end. */
  pendingPunch: number | null = null;
  /** Clips that read as a hit, best first. Any character that has one can throw it. */
  private static readonly PUNCHES = ["Punch_Cross", "Punch_Jab", "Sword_Attack"];

  /** A punch clip this character actually has, or null. */
  private punchClip(): string | null {
    for (const n of Behavior.PUNCHES) if (this.durations(n) > 0) return n;
    return null;
  }

  /**
   * Screensaver mode: no one is watching a desk toy stand still, so he barely rests, walks
   * further and faster, climbs whatever he can reach and jumps for the sake of it.
   */
  energetic = false;
  /** Screensaver roaming: he marches this way across every screen, turning at the far ends. */
  private roamDir: 1 | -1 = 1;
  /** When he last climbed onto a window while roaming, so he is moved along before he settles. */
  private perchedSince = -1;
  private ordinaryPerchSince = -1;
  private ordinarySupport: number | null = null;
  /** The window he was last standing on, and when he stepped off it, so he does not turn round
   * and climb the very same one over and over instead of crossing to the next screen. */
  private lastPerchHwnd: number | null = null;
  private lastPerchAt = -Infinity;
  /** While travelling he runs to the far end climbing nothing, so he crosses to another screen
   * rather than orbiting one; between travels he knocks the windows about where he is. */
  private travelUntil = -Infinity;
  private nextTravel = 0;

  /** Seconds to wait before the next idea, squeezed hard while he is being energetic. */
  private gap(base: number, spread: number): number {
    const k = this.energetic ? 0.2 : 1;
    return (base + Math.random() * spread) * k;
  }

  /** Nothing scheduled for at least `seconds`; used after a landing so he does not fidget at once. */
  rest(t: number, seconds: number) {
    this.nextEvent = Math.max(this.nextEvent, t + seconds);
  }

  update(s: Status): Activity {
    const m = this.manifest;
    if (!m) return this.activity;

    // Random fidgets and short strolls must not leave him on a title bar indefinitely.
    // Count only uninterrupted, available time on the same window; never override a hold,
    // dance, sleep, pause, or disabled wandering.
    const ordinaryPerch = !this.energetic && s.free && s.onSurface && this.opts.wander;
    if (!ordinaryPerch || this.ordinarySupport !== s.support) this.ordinaryPerchSince = -1;
    this.ordinarySupport = ordinaryPerch ? s.support : null;
    if (ordinaryPerch) {
      if (this.ordinaryPerchSince < 0) this.ordinaryPerchSince = s.t;
      if (s.t - this.ordinaryPerchSince >= 45 && m.states.walk && this.durations(m.states.walk.clip) > 0) {
        this.pendingLeave = s.x + s.w / 2 < (s.deskLeft + s.deskRight) / 2 ? 1 : -1;
        this.activity = { kind: "idle", clip: this.stateClip("idle") };
        this.fidgetQueue = [];
        this.activityEnds = Infinity;
        this.nextEvent = s.t + this.gap(6, 10);
        this.ordinaryPerchSince = -1;
        return this.activity;
      }
    }

    // Roaming, he does not linger on any one window: note when he got up so he can be moved
    // along, remember which window it was so he does not climb straight back onto it, and now
    // and then set off across the desk so every screen gets its turn.
    if (this.energetic) {
      if (s.onSurface) {
        if (this.perchedSince < 0) this.perchedSince = s.t;
        if (s.support !== null) this.lastPerchHwnd = s.support;
      } else {
        if (this.perchedSince >= 0) this.lastPerchAt = s.t;
        this.perchedSince = -1;
        if (s.t > this.nextTravel) {
          this.travelUntil = s.t + 4;
          this.nextTravel = s.t + 12 + Math.random() * 6;
        }
      }
    } else {
      this.perchedSince = -1;
    }

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
      this.nextEvent = s.t + this.gap(8, 14);
    }
    if (this.activity.kind === "walk") {
      const arrived = Math.abs(s.x - this.activity.targetX) < 4;
      if (arrived && this.activity.then === "hop" && s.free) this.pendingHop = this.activity.hopTop ?? null;
      if (arrived && this.activity.then === "punch" && s.free) {
        const clip = this.punchClip();
        if (clip) {
          this.pendingPunch = this.activity.punchDir ?? 1;
          this.activity = { kind: "fidget", clip: { name: clip, loop: false } };
          this.activityEnds = s.t + this.durations(clip);
          this.nextEvent = Infinity;
          return this.activity;
        }
        // No punch clip on this character: leap at it instead, which he can always do.
        this.pendingHop = this.activity.hopTop ?? null;
      }
      if (arrived || !s.free) {
        this.activity = { kind: "idle", clip: this.stateClip("idle") };
        this.activityEnds = Infinity;
        this.nextEvent = s.t + this.gap(6, 10);
      }
      return this.activity;
    }
    if (!s.free) {
      // Never start anything while he is busy; just push the schedule back.
      if (this.activity.kind !== "idle") this.activity = { kind: "idle", clip: this.stateClip("idle") };
      this.nextEvent = Math.max(this.nextEvent, s.t + this.gap(4, 0));
      return this.activity;
    }
    if (s.t < this.nextEvent) return this.activity;

    // Time for something new.
    const on = (key: string) => !this.enabled || this.enabled.has(key);
    const variants = (m.idleVariants ?? []).filter((v) => this.durations(v) > 0 && on(v));
    const fidgets = (m.fidgets ?? []).filter((f) => (Array.isArray(f) ? f : [f]).every((c) => this.durations(c) > 0) && on(Behavior.fidgetKey(f)));
    const walk = m.states.walk;
    // Two different questions. Can he walk at all, and is there room here to wander about?
    // They were one test, which stranded him: standing on a window narrower than the wander
    // minimum, he could not walk, and walking is also how he steps back off the edge.
    const canWalk = this.opts.wander && !!walk && this.durations(walk.clip) > 0;
    const roomToWander = s.right - s.left - s.w > MIN_WANDER * 2;
    const options: Array<() => void> = [];
    if (variants.length && !this.energetic) {
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
    // The window he just stepped off, for a few seconds, so he does not spin round and climb or
    // charge it again the instant he lands and never gets anywhere.
    const stale = (hwnd: number) => this.energetic && hwnd === this.lastPerchHwnd && s.t - this.lastPerchAt < 4;
    // Just after a descent he is crossing the desk, so he climbs and charges nothing until he
    // has cleared the screen he was stuck on.
    const traveling = this.energetic && s.t < this.travelUntil;
    // Showing off: run at a window flat out. Only from the floor; up on a window his job is to
    // get off it, not to hop about on it. Crossing the desk he will still shoulder one out of
    // the way as he passes, just not stop to climb it: a barge leaves him running, so it cannot
    // strand him orbiting the same window, which is the whole reason travelling blocks the rest.
    if (canWalk && this.energetic && !s.onSurface && s.charge && !stale(s.charge.hwnd)) {
      const charge = s.charge;
      // Flat out at a window: his sprint if he has one. Without one this is the old multiplier on
      // the walk cycle, which is as fast as a stretched stroll can look before it skates.
      const gear = this.gear("sprint") ?? this.gear("run");
      const speed = gear?.speed ?? (walk!.speed ?? 120) * 2.6;
      const cycle = gear?.clip ?? { name: walk!.clip, loop: true };
      const dir = Math.sign(charge.x - s.x) || 1;
      const runAt = (then: "hop" | "punch" | "barge") => () => {
        this.activity = { kind: "walk", clip: cycle, targetX: charge.x, speed, then, hopTop: charge.top, punchDir: dir };
        this.activityEnds = s.t + Math.abs(charge.x - s.x) / speed + 2;
      };
      if (traveling) {
        for (let i = 0; i < 4; i++) options.push(runAt("barge"));
      } else {
        for (let i = 0; i < 2; i++) options.push(runAt("hop"));
        // Mostly he knocks the window clean away: a fist when he has the clip for it, a shoulder
        // barge either way. Weighted heavily, since sending windows flying is the point of it.
        const hit = this.punchClip() ? "punch" : "barge";
        for (let i = 0; i < 3; i++) options.push(runAt(hit));
        for (let i = 0; i < 4; i++) options.push(runAt("barge"));
      }
    }
    // He turns where he stands and drives a fist into the glass behind him, shattering the
    // desktop there. This, far more than the slow timer, is what tears the screen apart.
    if (this.energetic && !s.onSurface && !traveling && this.punchClip()) {
      const clip = this.punchClip()!;
      const punch = () => {
        this.pendingPunch = Math.random() < 0.5 ? -1 : 1;
        this.activity = { kind: "fidget", clip: { name: clip, loop: false } };
        this.activityEnds = s.t + this.durations(clip);
        this.nextEvent = Infinity;
      };
      for (let i = 0; i < 4; i++) options.push(punch);
    }
    if (canWalk && s.climb && !stale(s.climb.hwnd) && !traveling) {
      // A title bar within reach: stroll under it, jump, grab, pull himself up.
      const climb = s.climb;
      const speed = walk!.speed ?? 120;
      options.push(() => {
        this.activity = { kind: "walk", clip: { name: walk!.clip, loop: true }, targetX: climb.x, speed, then: "hop", hopTop: climb.top };
        this.activityEnds = s.t + Math.abs(climb.x - s.x) / speed + 2;
      });
      options.push(options[options.length - 1]); // twice as likely as any single other option
      // In the screensaver he climbs eagerly, but the roaming march below still has to lead, or
      // he clambers up the same window over and over and never crosses the desk.
      if (this.energetic) options.push(options[options.length - 1]);
    }
    // On the taskbar he wanders his own monitor; up on a window he steps off when it is too
    // narrow to stroll, or now and then. In the screensaver he does neither of these: he sweeps
    // the whole desk instead (below), so these only run when no one is being shown off to.
    if (canWalk && !this.energetic && s.onSurface && (!roomToWander || Math.random() < 0.35)) {
      // Been up here a while: walk off the edge and drop back down.
      const speed = walk!.speed ?? 120;
      const goLeft = s.x - s.left < s.right - (s.x + s.w);
      const target = goLeft ? s.left - s.w * 0.55 : s.right - s.w * 0.45;
      options.push(() => {
        this.activity = { kind: "walk", clip: { name: walk!.clip, loop: true }, targetX: target, speed, beyond: true };
        this.activityEnds = s.t + Math.abs(target - s.x) / speed + 2;
      });
    }
    if (canWalk && !this.energetic && roomToWander) {
      options.push(() => {
        const minX = s.left;
        const maxX = s.right - s.w;
        let target = s.x;
        for (let i = 0; i < 8 && Math.abs(target - s.x) < MIN_WANDER; i++) {
          target = s.x + (Math.random() * 2 - 1) * MAX_STROLL;
        }
        target = Math.max(minX, Math.min(maxX, target));
        const speed = walk!.speed ?? 120;
        this.activity = { kind: "walk", clip: { name: walk!.clip, loop: true }, targetX: target, speed };
        this.activityEnds = s.t + Math.abs(target - s.x) / speed + 1.5; // safety timeout
      });
    }
    // The same stroll taken flat out, so the run is part of ordinary life and not only the
    // screensaver's. He runs at the end of the floor he has most room in front of him: a run
    // needs somewhere to go, and over a step or two it just reads as a stumble. Never up on a
    // window, where the ground is a title bar a few pixels deep.
    const dashRoom = Math.max(s.x - s.left, s.right - s.w - s.x);
    const dashGear = this.gear("run");
    if (canWalk && dashGear && !this.energetic && !s.onSurface && dashRoom >= DASH_MIN) {
      const speed = dashGear.speed;
      options.push(() => {
        const minX = s.left;
        const maxX = s.right - s.w;
        // Toward whichever end he has more room in front of him, a screen's worth at most.
        const dir = s.x - minX > maxX - s.x ? -1 : 1;
        const reach = DASH_MIN + Math.random() * (MAX_DASH - DASH_MIN);
        const target = Math.max(minX, Math.min(maxX, s.x + dir * reach));
        this.activity = { kind: "walk", clip: dashGear.clip, targetX: target, speed };
        this.activityEnds = s.t + Math.abs(target - s.x) / speed + 1.5;
      });
    }
    // Screensaver: he settles on no window and no screen, both so the show keeps moving and so
    // no corner of the desk is left standing still long enough to burn in. Up on a window he
    // drops off the roaming edge, the sooner the longer he has been up; on the floor he marches
    // across every screen, turning round at the far ends. Charge and climb fire in between, so
    // he knocks a window or clambers onto one as he passes, then is moved along again.
    if (canWalk && this.energetic) {
      const clip = walk!.clip;
      // Turn round well before the far wall of the desk, or he inches into it a step at a time,
      // decision after decision, trying to walk off the edge and never getting anywhere.
      if (s.x <= s.deskLeft + 150) this.roamDir = 1;
      else if (s.x + s.w >= s.deskRight - 150) this.roamDir = -1;
      if (s.onSurface) {
        // Leap off toward the middle of the desk, never off its outer edge: on a window his
        // bounds are the window, so a blind step "left" off a far-left window walked him clean
        // off the end of the desk, and walking off any edge dropped him straight back onto the
        // same window a few pixels short of the brink. A real sideways leap toward the centre
        // clears the window outright and lands him on floor that exists.
        const deskMid = (s.deskLeft + s.deskRight) / 2;
        const dir = s.x + s.w / 2 < deskMid ? 1 : -1;
        const leap = () => {
          this.pendingLeave = dir;
          this.activity = { kind: "idle", clip: this.stateClip("idle") };
          this.activityEnds = Infinity;
          this.nextEvent = s.t + this.gap(2, 2);
        };
        // The longer he has been perched, the more surely he leaves rather than knocks about.
        const weight = s.t - this.perchedSince > 3 ? 8 : 3;
        for (let i = 0; i < weight; i++) options.push(leap);
      } else {
        const run = this.gear("run");
        const speed = run?.speed ?? (walk!.speed ?? 120) * 2.2;
        // A bounded stride in his roaming direction: about a monitor when travelling to the next
        // screen, a shorter hop otherwise. Never the whole desk at once, or one long march eats
        // the time he should be spending knocking windows about, and he pins himself at the far
        // wall trying to reach an end he is already at.
        const stride = traveling ? 2600 : 1200 * (0.7 + Math.random() * 0.6);
        const target = Math.max(s.left, Math.min(s.right - s.w, s.x + this.roamDir * stride));
        const sweep = () => {
          this.activity = { kind: "walk", clip: run?.clip ?? { name: clip, loop: true }, targetX: target, speed };
          this.activityEnds = s.t + Math.abs(target - s.x) / speed + 1.5;
        };
        // While travelling the sweep leads; otherwise it is just filler between window-knocks,
        // so it is light and the charges (above) dominate.
        for (let i = 0; i < (traveling ? 6 : 3); i++) options.push(sweep);
      }
    }
    if (options.length) {
      options[Math.floor(Math.random() * options.length)]();
      // The activity's end (or the walk's arrival) schedules the next event.
      this.nextEvent = Infinity;
      // A leap is the exception: it just launches him into the air with no arrival to wake him,
      // so without this he lands and sits idle on the window forever, never deciding to leave
      // again. Give him a fresh decision shortly after he comes down.
      if (this.pendingLeave !== null) this.nextEvent = s.t + this.gap(3, 3);
    } else this.nextEvent = s.t + 20;
    return this.activity;
  }
}
