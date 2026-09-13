import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { cursor, getWorkArea, getWorkAreas, IN_TAURI, onLeftRelease, type Surface, type WorkArea } from "./input";

/**
 * Moves the OS window itself: custom drag (so we can measure velocity), throw,
 * gravity and bouncing against the work area. All units are physical pixels.
 */
export type Mode = "rest" | "held" | "falling" | "hanging" | "mantling";

export interface PhysicsOptions {
  gravity: boolean;
  throwable: boolean;
}

const GRAVITY = 3200; // px/s^2
const THREE_CLAMP = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const BOUNCE = 0.26;
const FLOOR_FRICTION = 6; // 1/s
const SETTLE_SPEED = 40; // px/s

export class WindowPhysics {
  mode: Mode = "rest";
  x = 0;
  y = 0;
  w = 320;
  h = 440;
  vx = 0;
  vy = 0;
  /** Set by the caller: a release without meaningful movement counts as a poke. */
  onPoke?: () => void;
  /** Set by the caller: fired when the window hits the floor with some speed. */
  onLand?: (speed: number) => void;
  /** Set by the caller: he hit his head on the top of the screen pulling himself onto a window. */
  onBump?: () => void;
  /** Set by the caller: he hit the side or top of the screen at this speed (px/s). */
  onBounce?: (speed: number, side: "left" | "right" | "top") => void;
  /** Set by the caller: he was let go at this speed (px/s); slow drops do not count. */
  onThrow?: (speed: number) => void;
  /**
   * Physical px from the window's top edge down to the top of his head when he stands straight
   * (measured by the renderer). 0 until measured; a fifth of the window is assumed then.
   */
  headPx = 0;
  /** Physical px from the window's top edge down to the top of his head as posed right now. */
  crownPx = 0;
  /** Smoothed window acceleration in px/s^2 (screen space, y down), for secondary motion. */
  accelX = 0;
  accelY = 0;
  /** Angular velocity handed to the renderer at release, rad/s (sign = spin direction). */
  spin = 0;
  private launchKind: "up" | "off" | null = null;
  /**
   * Set while he is in the air under his own power, so the renderer can draw a jump instead of
   * a fall: "up" is a hop at a window edge, "off" a leap clean off one. Derived from the mode
   * rather than cleared on landing, so it ends on the very frame the flight does: a throw, a
   * shove, and letting go of a ledge he caught are all plain falling.
   */
  get launch(): "up" | "off" | null {
    return this.mode === "falling" ? this.launchKind : null;
  }
  private prevX = NaN;
  private prevY = NaN;
  private prevVx = 0;
  private prevVy = 0;

  private grabDx = 0;
  private grabDy = 0;
  private area: WorkArea = { left: 0, top: 0, right: 1920, bottom: 1040 };
  private areas: WorkArea[] = [];
  private samples: Array<{ t: number; x: number; y: number }> = [];
  private lastApplied = { x: NaN, y: NaN };
  private pending = false;
  private grabStart = { t: 0, x: 0, y: 0 };

  constructor(public opts: PhysicsOptions) {
    onLeftRelease(() => this.release());
  }

  async init() {
    if (!IN_TAURI) return;
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    this.x = pos.x;
    this.y = pos.y;
    this.w = size.width;
    this.h = size.height;
    this.area = await getWorkArea(this.x + this.w / 2, this.y + this.h / 2);
    await this.refreshAreas();
    if (this.opts.gravity) this.mode = "falling";
  }

  /** Cache every monitor's work area; monitors rarely change, so re-read every 30 s. */
  async refreshAreas() {
    try {
      this.areas = await getWorkAreas();
    } catch {
      this.areas = [];
    }
    setTimeout(() => void this.refreshAreas(), 30_000);
  }

  /** Synchronously pick the monitor containing a point (nearest by centre distance as a fallback). */
  private areaAt(x: number, y: number): WorkArea {
    if (!this.areas.length) return this.area;
    const inside = this.areas.find((a) => x >= a.left && x < a.right && y >= a.top && y < a.bottom);
    if (inside) return inside;
    let best = this.areas[0];
    let bestD = Infinity;
    for (const a of this.areas) {
      const cx = (a.left + a.right) / 2;
      const cy = (a.top + a.bottom) / 2;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** Pin the rendered window-space grip point to the cursor. */
  steerHold(pointX: number, pointY: number) {
    if (this.mode !== "held") return;
    // The animated grip is a constraint, not a spring. Any lag here lets the held point
    // bounce away from the cursor as the body, limbs, and camera move.
    this.grabDx = pointX;
    this.grabDy = pointY;
  }

  /** Cursor velocity while held, px/s, from the recent samples. */
  get holdVelocityX(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[Math.max(0, this.samples.length - 6)];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }

  grab() {
    this.mode = "held";
    this.support = null;
    this.spin = 0;
    this.vx = this.vy = 0;
    this.grabDx = cursor.x - this.x;
    this.grabDy = cursor.y - this.y;
    this.samples.length = 0;
    this.grabStart = { t: performance.now(), x: cursor.x, y: cursor.y };
  }

  private release() {
    if (this.mode !== "held") return;
    const now = performance.now();
    const moved = Math.hypot(cursor.x - this.grabStart.x, cursor.y - this.grabStart.y);
    if (moved < 6 && now - this.grabStart.t < 350) {
      this.onPoke?.();
    }
    // Velocity from the last ~80 ms of samples.
    const recent = this.samples.filter((s) => now - s.t < 80);
    if (this.opts.throwable && recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0) {
        this.vx = (b.x - a.x) / dt;
        this.vy = (b.y - a.y) / dt;
      }
    }
    // A fast sideways throw sets him tumbling; the renderer integrates and damps it.
    this.spin = this.opts.throwable ? THREE_CLAMP(-this.vx / 900, -6, 6) : 0;
    const flung = Math.hypot(this.vx, this.vy);
    if (this.opts.throwable && flung > 900) this.onThrow?.(flung);
    this.mode = this.opts.gravity ? "falling" : "rest";
    // Pick the monitor he was released over right now; the physics would otherwise clamp
    // him back into the old monitor's bounds while the async lookup was still in flight.
    this.area = this.areaAt(this.x + this.w / 2, this.y + this.h / 2);
    if (!this.areas.length) void getWorkArea(this.x + this.w / 2, this.y + this.h / 2).then((a) => (this.area = a));
  }

  /** Physical pixels the window may sink below the work area (the camera's margin under the soles). */
  floorOverlap = 0;
  /** Other windows he can land on, front to back; updated by the surfaces stream. */
  surfaces: Surface[] = [];
  /** The window he is standing on, or null for the taskbar. */
  support: number | null = null;

  private get taskbarFloor() {
    return this.area.bottom - this.h + this.floorOverlap;
  }

  private surfaceOf(hwnd: number | null) {
    return hwnd === null ? undefined : this.surfaces.find((s) => s.hwnd === hwnd);
  }

  /** Window y at rest: on the taskbar, or on the top edge of the window he stands on. */
  get floor() {
    const s = this.surfaceOf(this.support);
    return s ? s.top - this.h : this.taskbarFloor;
  }

  get onSurface() {
    return this.surfaceOf(this.support) !== undefined;
  }

  /** How far the window sinks into the taskbar right now (0 while standing on another window). */
  get groundOverlap() {
    return this.onSurface ? 0 : this.floorOverlap;
  }

  /**
   * Screensaver: he is putting on a show, so he reaches further, jumps higher and is easier to
   * knock about. Which screens are his is no longer part of it; every screen always is.
   */
  roam = false;

  /** Every monitor end to end; falls back to the current one before they load. */
  private get allScreens() {
    if (!this.areas.length) return { left: this.area.left, right: this.area.right };
    return {
      left: Math.min(...this.areas.map((a) => a.left)),
      right: Math.max(...this.areas.map((a) => a.right)),
    };
  }

  /**
   * Horizontal range he may wander in: the window he stands on, else the whole desk. One monitor
   * used to be his world unless the screensaver was up, which left him stuck on whichever screen
   * he happened to be on, and threw him back off its inner edges as if they were walls.
   */
  get bounds() {
    const s = this.surfaceOf(this.support);
    if (s) return { left: s.left, right: s.right };
    return this.allScreens;
  }

  /** The whole floor he may walk on, ignoring any window he happens to be standing on. Lets the
   * behaviour tell where the real edges are even from up on a window, so it does not walk him off
   * the end of the desk into nothing. */
  get deskBounds() {
    return this.allScreens;
  }

  private static readonly EDGE = 28;
  /** This much of the window (with his head in it) may poke above the screen before it counts. */
  private static readonly SLACK = 0.04;
  /** The most he can duck to fit under the top of the screen, as a fraction of the window height. */
  private static readonly CROUCH = 0.15;
  /** Windows he bumped his head on (hwnd to seconds); not grabbed again at once, not climbed for a while. */
  private bumped = new Map<number, number>();
  /** Seconds left in which the ceiling does not push him back down: he is falling away from it after a bump. */
  private ceilingFree = 0;
  /** Ignore the departed ledge until this leap has settled on the floor or another surface. */
  private departedSurface: number | null = null;
  /** The edge he last bumped on: others at the same height are left alone for a moment too. */
  private lastBump = { top: NaN, at: -Infinity };

  private justBumpedAt(top: number) {
    return Math.abs(top - this.lastBump.top) < 12 && performance.now() / 1000 - this.lastBump.at < 4;
  }

  /**
   * An edge worth trying even though he cannot stand up there: at least a bit below the top of
   * the screen, so the pull-up gets going before his head meets it. A maximised window's edge
   * hugs the top and is never grabbed.
   */
  private worthABump(s: Surface): boolean {
    // Roaming, his weight drags whatever he grabs down until there is room to stand, so even a
    // title bar hugging the top of the screen is worth getting hold of.
    const margin = this.roam ? 24 : this.h * 0.2;
    return s.top >= this.areaAt((s.left + s.right) / 2, s.top).top + margin;
  }

  private get headTop() {
    return this.headPx > 0 ? this.headPx : this.h * 0.2;
  }

  private get crownNow() {
    return this.crownPx > 0 ? this.crownPx : this.headTop;
  }

  /**
   * Whether standing on `s` keeps his head on screen (ducking allowed), and how far he would
   * have to duck for it, in physical px. The ceiling is the top of the monitor the edge is on.
   */
  private headroom(s: Surface): { fit: boolean; crouch: number } {
    const ceiling = this.areaAt((s.left + s.right) / 2, s.top).top;
    const over = ceiling - (s.top - this.h + this.headTop) - this.h * WindowPhysics.SLACK;
    if (over <= 0) return { fit: true, crouch: 0 };
    return { fit: over <= this.h * WindowPhysics.CROUCH, crouch: over };
  }

  /** How far he has to duck where he stands (or is pulling himself up to), physical px. */
  get crouchPx(): number {
    if (this.mode !== "rest" && this.mode !== "mantling") return 0;
    const s = this.surfaceOf(this.support);
    if (!s) return 0;
    return Math.min(this.headroom(s).crouch, this.h * WindowPhysics.CROUCH);
  }

  private bumpedRecently(hwnd: number, seconds: number) {
    const at = this.bumped.get(hwnd);
    return at !== undefined && performance.now() / 1000 - at < seconds;
  }

  /** Let go of the window he is climbing: his head met the top of the screen. */
  private bump(s: Surface) {
    this.bumped.set(s.hwnd, performance.now() / 1000);
    this.lastBump = { top: s.top, at: performance.now() / 1000 };
    this.support = null;
    this.mode = "falling";
    this.mantleProgress = 0;
    this.ceilingFree = 0.6;
    this.vy = 140;
    this.vx = (Math.random() < 0.5 ? -1 : 1) * 40;
    this.spin = 0;
    this.onBump?.();
  }
  /** Where his hands are when he hangs by them: this fraction of the window height below its top. */
  private static readonly HAND = 0.07;
  private hangTimer = 0;
  private mantleT = 0;
  private mantleFrom = 0;
  private mantleDur = 0.8;
  /** 0..1 through the pull-up. */
  mantleProgress = 0;
  /** "pull": hands on the edge, full pull-up. "step": the edge was near his feet, a quick hop up. */
  mantleKind: "pull" | "step" = "pull";

  /** Falling with a window's top edge between his chest and his feet: a quick step up onto it. */
  private tryStepUp(): boolean {
    const cx = this.x + this.w / 2;
    const lo = this.y + this.h * 0.42;
    const hi = this.y + this.h - 4;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.hwnd === this.departedSurface) continue;
      if (s.top < lo || s.top > hi) continue;
      if (cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE) continue;
      if (this.occluded(i, cx)) continue;
      if (!this.headroom(s).fit || this.bumpedRecently(s.hwnd, 4) || this.justBumpedAt(s.top)) continue;
      this.support = s.hwnd;
      this.mode = "mantling";
      this.mantleKind = "step";
      this.mantleT = 0;
      this.mantleFrom = this.y;
      this.mantleDur = 0.25 + (0.45 * (this.y - (s.top - this.h))) / this.h;
      this.vx = this.vy = this.spin = 0;
      return true;
    }
    return false;
  }

  /** Falling past a window's top edge within arm's reach: grab it and hang. */
  private tryGrab(): boolean {
    const cx = this.x + this.w / 2;
    const lo = this.y + this.h * 0.03;
    const hi = this.y + this.h * 0.42;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.hwnd === this.departedSurface) continue;
      if (s.top < lo || s.top > hi) continue;
      if (cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE) continue;
      if (this.occluded(i, cx)) continue;
      if (this.bumpedRecently(s.hwnd, 4) || this.justBumpedAt(s.top)) continue;
      if (!this.headroom(s).fit && !this.worthABump(s)) continue;
      this.support = s.hwnd;
      this.mode = "hanging";
      this.hangTimer = 0;
      this.vx = this.vy = this.spin = 0;
      this.y = s.top - this.h * WindowPhysics.HAND;
      return true;
    }
    return false;
  }

  /** A window edge he could climb from where he stands: walk under it, hop, grab, pull up. */
  climbable(): { x: number; hwnd: number; top: number } | null {
    if (this.mode !== "rest") return null;
    const cx = this.x + this.w / 2;
    const hands = this.y + this.h * WindowPhysics.HAND;
    const b = this.bounds;
    let best: { x: number; hwnd: number; top: number; dist: number } | null = null;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.hwnd === this.support) continue;
      const rise = hands - s.top; // how far above his hands the edge is
      // Roaming, he throws himself much higher: the point of the screensaver is the show.
      if (rise < 40 || rise > (this.roam ? 1000 : 460)) continue;
      const tx = Math.max(s.left + WindowPhysics.EDGE + 8, Math.min(s.right - WindowPhysics.EDGE - 8, cx));
      if (tx < b.left + this.w / 2 || tx > b.right - this.w / 2) continue; // must be able to walk there
      if (this.occluded(i, tx)) continue;
      // Too tall to stand on: he may still try once and bump his head, then leaves it alone.
      if (!this.headroom(s).fit && (this.bumpedRecently(s.hwnd, 600) || !this.worthABump(s))) continue;
      const dist = Math.abs(tx - cx);
      // On the taskbar he only bothers with what is close by. Roaming, the playground is every
      // monitor and there may be one window on it, so he will cross a screen to reach it: at
      // 900px he simply wandered away from the only thing there was to climb.
      if (dist > (this.roam ? 2400 : 900)) continue;
      if (!best || dist < best.dist) best = { x: tx - this.w / 2, hwnd: s.hwnd, top: s.top, dist };
    }
    return best;
  }

  /**
   * Something to charge at: the nearest window edge he can reach on foot, ignoring whether he
   * could ever stand on it. Most windows are far taller than he is, so standing on one would
   * put his head off the screen and `climbable` rightly refuses; he can still run at it and
   * knock it about, which is the point of the screensaver.
   */
  chargeTarget(): { x: number; hwnd: number; top: number } | null {
    if (this.mode !== "rest") return null;
    const cx = this.x + this.w / 2;
    const b = this.bounds;
    let best: { x: number; hwnd: number; top: number; dist: number } | null = null;
    for (const s of this.surfaces) {
      if (s.hwnd === this.support) continue;
      // Aim just inside the near edge: he arrives at the window rather than in its middle, but
      // far enough in that a grab is allowed at all, since grabbing is refused within EDGE of
      // either end. Aimed at the edge itself he could run at a window and never get hold of it.
      const inset = WindowPhysics.EDGE + 8;
      const near = cx < (s.left + s.right) / 2 ? Math.min(s.left + inset, s.right - inset) : Math.max(s.right - inset, s.left + inset);
      const tx = Math.max(b.left + this.w / 2, Math.min(b.right - this.w / 2, near));
      const dist = Math.abs(tx - cx);
      if (dist < 60 || dist > 2400) continue;
      if (!best || dist < best.dist) best = { x: tx - this.w / 2, hwnd: s.hwnd, top: s.top, dist };
    }
    return best;
  }

  /** Jump from rest at an edge: high enough to catch it with his hands, or to step onto it. */
  hop(top: number) {
    if (this.mode !== "rest") return;
    const handY = this.y + this.h * WindowPhysics.HAND;
    const feetY = this.y + this.h;
    // An edge above his hands is caught and mantled, so his hands are what has to clear it. An
    // edge below his hands is a ledge, and his feet are what has to clear it: a much bigger
    // jump. Measuring the wrong one left him doing a token 60px hop at knee-high windows and
    // landing back where he started, which is the "he jumps and bumps but never gets up there".
    const rise = top < handY ? Math.max(60, handY - top + 14) : Math.max(60, feetY - top + 24);
    this.support = null;
    this.mode = "falling";
    this.launchKind = "up";
    this.vy = -Math.min(this.roam ? 2600 : 1900, Math.sqrt(2 * GRAVITY * rise));
    this.vx = 0;
  }

  /** True when a window in front of `index` covers the spot on its top edge under his centre. */
  private occluded(index: number, cx: number): boolean {
    const s = this.surfaces[index];
    const py = s.top - 3;
    for (let j = 0; j < index; j++) {
      const o = this.surfaces[j];
      if (cx >= o.left && cx <= o.right && py >= o.top && py <= o.bottom) return true;
    }
    return false;
  }

  /** Where a fall from here ends: the first window top under his feet, else the taskbar. */
  private landingFloor(): { y: number; hwnd: number | null } {
    const cx = this.x + this.w / 2;
    let best = this.taskbarFloor;
    let hwnd: number | null = null;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.hwnd === this.departedSurface) continue;
      if (cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE) continue;
      const fy = s.top - this.h;
      if (fy < this.y - 4) continue; // its top edge is above his feet already
      if (this.occluded(i, cx)) continue; // that edge is hidden behind another window
      if (!this.headroom(s).fit) continue; // standing there would put his head off screen
      if (fy < best) {
        best = fy;
        hwnd = s.hwnd;
      }
    }
    return { y: best, hwnd };
  }

  /** Height of a bottom taskbar on the current monitor (0 when it is elsewhere), physical px. */
  get taskbarHeight() {
    return Math.max(0, (this.area.monitorBottom ?? this.area.bottom) - this.area.bottom);
  }

  get workArea() {
    return this.area;
  }

  /**
   * Leap clean off the window he stands on, toward `dir` (-1 left, 1 right), with a real sideways
   * launch. Walking off an edge drops him straight down and he lands back on the same window a
   * few pixels short of the brink; a leap arcs him well past it onto the floor (or the next
   * screen), which is how he finally gets off a window and crosses monitors. Roaming only.
   */
  leapOff(dir: number) {
    if (this.mode !== "rest") return;
    this.departedSurface = this.support;
    this.support = null;
    this.mode = "falling";
    this.launchKind = "off";
    this.vy = -600;
    this.vx = (dir >= 0 ? 1 : -1) * 1500;
    this.spin = 0;
  }

  /** Jump to a new spot (and work area) and let gravity settle him. */
  teleport(x: number, y: number, area: WorkArea) {
    this.area = area;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.mode = this.opts.gravity ? "falling" : "rest";
    if (!this.opts.gravity) this.y = this.floor;
    this.lastApplied = { x: NaN, y: NaN };
    this.apply();
  }

  /** Slide horizontally while resting on the floor (walking). Clamped to the work area. */
  nudge(dx: number, beyondEdge = false) {
    if (this.mode !== "rest") return;
    const b = this.bounds;
    // Walking off a window on purpose: the rest check drops him once his centre leaves it.
    const margin = beyondEdge ? this.w : 0;
    this.x = Math.max(b.left - margin, Math.min(b.right - this.w + margin, this.x + dx));
    // Crossing onto another monitor hands him that screen's floor, so he steps up or down onto
    // its taskbar rather than walking through the air at the old height.
    if (!this.onSurface) {
      const here = this.areaAt(this.x + this.w / 2, this.y + this.h / 2);
      if (here !== this.area) {
        this.area = here;
        this.y = this.floor;
      }
    }
    this.apply();
  }

  /** True while falling or bouncing above the floor. */
  get airborne() {
    return this.mode === "falling" && this.y < this.floor - 1;
  }

  /** Finite-difference acceleration of the window itself, whatever is moving it. */
  private trackAccel(dt: number) {
    if (dt <= 0) return;
    if (Number.isNaN(this.prevX)) {
      this.prevX = this.x;
      this.prevY = this.y;
      return;
    }
    const vx = (this.x - this.prevX) / dt;
    const vy = (this.y - this.prevY) / dt;
    const ax = (vx - this.prevVx) / dt;
    const ay = (vy - this.prevVy) / dt;
    const k = Math.min(1, dt * 14);
    this.accelX += (THREE_CLAMP(ax, -40000, 40000) - this.accelX) * k;
    this.accelY += (THREE_CLAMP(ay, -40000, 40000) - this.accelY) * k;
    this.prevVx = vx;
    this.prevVy = vy;
    this.prevX = this.x;
    this.prevY = this.y;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.05);
    this.trackAccel(dt);
    if (this.mode === "rest" || this.mode === "held") this.departedSurface = null;
    // Only a flight that began with a push-off is a jump. Catching a ledge on the way up ends
    // it, so letting go of that ledge later is an ordinary drop and is drawn as one.
    if (this.mode !== "falling") this.launchKind = null;
    if (this.mode === "held") {
      this.x = cursor.x - this.grabDx;
      this.y = cursor.y - this.grabDy;
      this.area = this.areaAt(this.x + this.w / 2, this.y + this.h / 2);
      // Never below the floor while held: grabbing a foot near the taskbar would otherwise
      // hang the rest of him off the bottom of the screen.
      if (this.y > this.taskbarFloor) this.y = this.taskbarFloor;
      this.samples.push({ t: performance.now(), x: this.x, y: this.y });
      if (this.samples.length > 12) this.samples.shift();
    } else if (this.mode === "falling") {
      this.vy += GRAVITY * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.area = this.areaAt(this.x + this.w / 2, this.y + this.h / 2);
      // Descending past a title bar within reach: grab it instead of falling on by.
      if (this.vy >= 0 && this.surfaces.length && (this.tryGrab() || this.tryStepUp())) {
        this.apply();
        return;
      }
      const landing = this.landingFloor();
      const floor = landing.y;
      if (this.y >= floor) this.support = landing.hwnd;
      // Only the far ends of the desk are walls. Bouncing him off a monitor's inner edge stopped
      // a throw dead at a seam that is not there to the eye.
      const flightBounds = this.allScreens;
      const left = flightBounds.left;
      const right = flightBounds.right - this.w;
      if (this.y >= floor) {
        this.y = floor;
        // Whatever spin he had ends at the first contact; the renderer springs him upright.
        this.spin = 0;
        // Slow arrivals settle at once; only a real fall bounces (and squashes more than once).
        if (Math.abs(this.vy) > 1100) {
          this.onLand?.(Math.abs(this.vy));
          this.vy = -this.vy * BOUNCE;
        } else {
          if (Math.abs(this.vy) > 120) this.onLand?.(Math.abs(this.vy));
          this.vy = 0;
        }
        this.vx *= Math.max(0, 1 - FLOOR_FRICTION * dt);
      }
      // The top of the screen stops his head, not the empty part of the window above it; right
      // after a head bump he is already past it and falling away, so it is left alone.
      this.ceilingFree = Math.max(0, this.ceilingFree - dt);
      if (this.ceilingFree <= 0 && this.y + this.crownNow < this.area.top) {
        this.y = this.area.top - this.crownNow;
        if (this.vy < -250) this.onBounce?.(-this.vy, "top");
        this.vy = Math.abs(this.vy) * BOUNCE;
      }
      if (this.x < left) {
        this.x = left;
        if (this.vx < -250) this.onBounce?.(-this.vx, "left");
        this.vx = Math.abs(this.vx) * BOUNCE;
        this.spin = -this.spin * 0.8;
      } else if (this.x > right) {
        this.x = right;
        if (this.vx > 250) this.onBounce?.(this.vx, "right");
        this.vx = -Math.abs(this.vx) * BOUNCE;
        this.spin = -this.spin * 0.8;
      }
      if (this.y === floor && Math.abs(this.vx) < SETTLE_SPEED && this.vy === 0) {
        this.vx = 0;
        this.spin = 0;
        this.mode = "rest";
      }
    } else if (this.mode === "hanging" || this.mode === "mantling") {
      const s = this.surfaceOf(this.support);
      if (!s) {
        // The window he hangs from is gone: drop.
        this.support = null;
        this.mode = "falling";
      } else if (this.mode === "hanging") {
        this.y = s.top - this.h * WindowPhysics.HAND; // hands stay on the edge even if it moves
        this.hangTimer += dt;
        if (this.hangTimer > 0.9) {
          this.mode = "mantling";
          this.mantleKind = "pull";
          this.mantleT = 0;
          this.mantleFrom = this.y;
          this.mantleDur = 0.8;
        }
      } else {
        this.mantleT += dt;
        const p = Math.min(1, this.mantleT / this.mantleDur);
        this.mantleProgress = p;
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const from = this.mantleFrom;
        const to = s.top - this.h;
        this.y = from + (to - from) * ease;
        // Not enough screen above the window: the moment his head (as posed, ducking and all)
        // reaches the top of the screen, it hits, and he lets go.
        const ceiling = this.areaAt((s.left + s.right) / 2, s.top).top;
        if (!this.headroom(s).fit && this.y + this.crownNow < ceiling - this.h * WindowPhysics.SLACK) {
          this.bump(s);
        } else if (p >= 1) {
          this.mode = "rest";
          this.vy = 0;
        }
      }
    } else if (this.mode === "rest") {
      const s = this.surfaceOf(this.support);
      const cx = this.x + this.w / 2;
      const idx = s ? this.surfaces.indexOf(s) : -1;
      if (this.support !== null && (!s || cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE || this.occluded(idx, cx))) {
        // He walked off an edge: carry him clear of it as he drops. Support falls away the moment
        // his centre reaches the brink, but his centre is still over the window's landing zone
        // then, so without a shove he drops straight down and lands right back on the same window
        // a few pixels short of the edge, over and over. A push in the way he was heading arcs
        // him past it onto whatever is beyond (the floor, the next screen).
        if (s && this.roam) {
          if (cx > s.right - WindowPhysics.EDGE) this.vx = Math.max(this.vx, 900);
          else if (cx < s.left + WindowPhysics.EDGE) this.vx = Math.min(this.vx, -900);
        }
        this.support = null;
        if (this.opts.gravity) this.mode = "falling";
      } else if (s && !this.headroom(s).fit && this.y + this.crownNow < this.areaAt((s.left + s.right) / 2, s.top).top - this.h * WindowPhysics.SLACK) {
        // The window he stands on was pushed up until even ducking cannot fit him: knocked off.
        this.bump(s);
      } else if (this.opts.gravity && this.y !== this.floor) {
        // The floor moved under him (his window moved, taskbar overlap toggled): follow it.
        this.y = this.floor;
      }
    }
    this.apply();
  }

  private apply() {
    if (!IN_TAURI || this.pending) return;
    const nx = Math.round(this.x);
    const ny = Math.round(this.y);
    if (nx === this.lastApplied.x && ny === this.lastApplied.y) return;
    this.lastApplied = { x: nx, y: ny };
    this.pending = true;
    getCurrentWindow()
      .setPosition(new PhysicalPosition(nx, ny))
      .catch(() => {})
      .finally(() => (this.pending = false));
  }
}
