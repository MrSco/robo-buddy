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
const BOUNCE = 0.35;
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
  /** Smoothed window acceleration in px/s^2 (screen space, y down), for secondary motion. */
  accelX = 0;
  accelY = 0;
  /** Angular velocity handed to the renderer at release, rad/s (sign = spin direction). */
  spin = 0;
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

  /** Ease the grab offset so a window-space point ends up under the cursor (used to hold by a hand). */
  steerHold(pointX: number, pointY: number, dt: number) {
    if (this.mode !== "held") return;
    const k = Math.min(1, dt * 8);
    this.grabDx += (pointX - this.grabDx) * k;
    this.grabDy += (pointY - this.grabDy) * k;
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

  /** Horizontal range he may wander in: the window he stands on, else the work area. */
  get bounds() {
    const s = this.surfaceOf(this.support);
    return s ? { left: s.left, right: s.right } : { left: this.area.left, right: this.area.right };
  }

  private static readonly EDGE = 28;
  /** Where his hands are when he hangs by them: this fraction of the window height below its top. */
  private static readonly HAND = 0.07;
  private hangTimer = 0;
  private mantleT = 0;
  /** 0..1 through the pull-up. */
  mantleProgress = 0;

  /** Falling past a window's top edge within arm's reach: grab it and hang. */
  private tryGrab(): boolean {
    const cx = this.x + this.w / 2;
    const lo = this.y + this.h * 0.03;
    const hi = this.y + this.h * 0.42;
    for (let i = 0; i < this.surfaces.length; i++) {
      const s = this.surfaces[i];
      if (s.top < lo || s.top > hi) continue;
      if (cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE) continue;
      if (this.occluded(i, cx)) continue;
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
      if (rise < 40 || rise > 460) continue;
      const tx = Math.max(s.left + WindowPhysics.EDGE + 8, Math.min(s.right - WindowPhysics.EDGE - 8, cx));
      if (tx < b.left + this.w / 2 || tx > b.right - this.w / 2) continue; // must be able to walk there
      if (this.occluded(i, tx)) continue;
      const dist = Math.abs(tx - cx);
      if (dist > 900) continue;
      if (!best || dist < best.dist) best = { x: tx - this.w / 2, hwnd: s.hwnd, top: s.top, dist };
    }
    return best;
  }

  /** Jump from rest so his hands reach just above `top` (a window edge); tryGrab does the rest. */
  hop(top: number) {
    if (this.mode !== "rest") return;
    const rise = Math.max(60, this.y + this.h * WindowPhysics.HAND - top + 14);
    this.support = null;
    this.mode = "falling";
    this.vy = -Math.min(1900, Math.sqrt(2 * GRAVITY * rise));
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
      if (cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE) continue;
      const fy = s.top - this.h;
      if (fy < this.y - 4) continue; // its top edge is above his feet already
      if (this.occluded(i, cx)) continue; // that edge is hidden behind another window
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
      // Descending past a title bar within reach: grab it instead of falling on by.
      if (this.vy >= 0 && this.surfaces.length && this.tryGrab()) {
        this.apply();
        return;
      }
      const landing = this.landingFloor();
      const floor = landing.y;
      if (this.y >= floor) this.support = landing.hwnd;
      const left = this.area.left;
      const right = this.area.right - this.w;
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
      if (this.y < this.area.top) {
        this.y = this.area.top;
        this.vy = Math.abs(this.vy) * BOUNCE;
      }
      if (this.x < left) {
        this.x = left;
        this.vx = Math.abs(this.vx) * BOUNCE;
        this.spin = -this.spin * 0.8;
      } else if (this.x > right) {
        this.x = right;
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
          this.mantleT = 0;
        }
      } else {
        this.mantleT += dt;
        const p = Math.min(1, this.mantleT / 0.8);
        this.mantleProgress = p;
        const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const from = s.top - this.h * WindowPhysics.HAND;
        const to = s.top - this.h;
        this.y = from + (to - from) * ease;
        if (p >= 1) {
          this.mode = "rest";
          this.vy = 0;
        }
      }
    } else if (this.mode === "rest") {
      const s = this.surfaceOf(this.support);
      const cx = this.x + this.w / 2;
      const idx = s ? this.surfaces.indexOf(s) : -1;
      if (this.support !== null && (!s || cx < s.left + WindowPhysics.EDGE || cx > s.right - WindowPhysics.EDGE || this.occluded(idx, cx))) {
        // The window he stood on closed, minimised or slid away: fall to whatever is below.
        this.support = null;
        if (this.opts.gravity) this.mode = "falling";
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
