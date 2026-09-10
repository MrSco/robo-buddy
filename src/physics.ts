import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { cursor, getWorkArea, IN_TAURI, onLeftRelease, type WorkArea } from "./input";

/**
 * Moves the OS window itself: custom drag (so we can measure velocity), throw,
 * gravity and bouncing against the work area. All units are physical pixels.
 */
export type Mode = "rest" | "held" | "falling";

export interface PhysicsOptions {
  gravity: boolean;
  throwable: boolean;
}

const GRAVITY = 3200; // px/s^2
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

  private grabDx = 0;
  private grabDy = 0;
  private area: WorkArea = { left: 0, top: 0, right: 1920, bottom: 1040 };
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
    if (this.opts.gravity) this.mode = "falling";
  }

  grab() {
    this.mode = "held";
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
    this.mode = this.opts.gravity ? "falling" : "rest";
    void getWorkArea(this.x + this.w / 2, this.y + this.h / 2).then((a) => (this.area = a));
  }

  get floor() {
    return this.area.bottom - this.h;
  }

  /** True while falling or bouncing above the floor. */
  get airborne() {
    return this.mode === "falling" && this.y < this.floor - 1;
  }

  step(dt: number) {
    dt = Math.min(dt, 0.05);
    if (this.mode === "held") {
      this.x = cursor.x - this.grabDx;
      this.y = cursor.y - this.grabDy;
      this.samples.push({ t: performance.now(), x: this.x, y: this.y });
      if (this.samples.length > 12) this.samples.shift();
    } else if (this.mode === "falling") {
      this.vy += GRAVITY * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      const floor = this.floor;
      const left = this.area.left;
      const right = this.area.right - this.w;
      if (this.y >= floor) {
        this.y = floor;
        if (Math.abs(this.vy) > 120) {
          this.onLand?.(Math.abs(this.vy));
          this.vy = -this.vy * BOUNCE;
        } else {
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
      } else if (this.x > right) {
        this.x = right;
        this.vx = -Math.abs(this.vx) * BOUNCE;
      }
      if (this.y === floor && Math.abs(this.vx) < SETTLE_SPEED && this.vy === 0) {
        this.vx = 0;
        this.mode = "rest";
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
