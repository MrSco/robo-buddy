import type { StrikeKind } from "./havoc";
export const MAX_DEBRIS = 48;
export const MAX_DEBRIS_PIXELS = 2500000;
export interface Shard {
  id: number;
  img: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  age: number;
  touched: number;
  asleep: boolean;
  fade: number;
}
/** Bounded, sleeping bodies; attack targets are never added to climbable surfaces. */
export class Debris {
  bodies: Shard[] = [];
  private serial = 0;
  get pixels() {
    return this.bodies.reduce((n, b) => n + b.img.width * b.img.height, 0);
  }
  add(body: Omit<Shard, "id" | "age" | "touched" | "asleep" | "fade">) {
    const pixels = body.img.width * body.img.height;
    if (pixels > MAX_DEBRIS_PIXELS) {
      body.img.width = body.img.height = 1;
      return;
    }
    while (this.bodies.length >= MAX_DEBRIS || this.pixels + pixels > MAX_DEBRIS_PIXELS) {
      const old = this.bodies.reduce((a, b) => (b.age - b.touched > a.age - a.touched ? b : a));
      this.remove(old);
    }
    this.bodies.push({ ...body, id: ++this.serial, age: 0, touched: 0, asleep: false, fade: 1 });
  }
  private remove(b: Shard) {
    this.bodies.splice(this.bodies.indexOf(b), 1);
    b.img.width = b.img.height = 1;
    for (const other of this.bodies) other.asleep = false;
  }
  clear() {
    for (const b of [...this.bodies]) this.remove(b);
  }
  strike(x: number, y: number, dir: number, kind: StrikeKind, reach: number) {
    const hit = this.bodies
      .filter((b) => b.fade > 0.3 && Math.abs(b.x - x) < b.w / 2 + reach && Math.abs(b.y - y) < b.h / 2 + reach)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    if (!hit) return false;
    hit.vx = dir * (kind === "throw" ? 1700 : kind === "kick" ? 1400 : 1000);
    hit.vy = kind === "throw" ? -1200 : kind === "kick" ? -500 : -650;
    hit.spin = dir * (kind === "throw" ? 6 : 3);
    hit.touched = hit.age;
    hit.fade = 1;
    // Wake the pile so pieces supported by the kicked shard fall into the gap.
    for (const b of this.bodies) b.asleep = false;
    return true;
  }
  /**
   * Fade every piece at the same rate, for the end of the cycle when the whole desk is coming
   * apart at once. Left to the usual rule each piece fades on its own age, so the ones made
   * last hung about long after the rest had gone.
   */
  fadeAll(dt: number, seconds: number) {
    if (seconds <= 0) return;
    for (const b of [...this.bodies]) {
      b.fade -= dt / seconds;
      if (b.fade <= 0) this.remove(b);
    }
  }
  step(dt: number, width: number, height: number) {
    dt = Math.max(0, Math.min(0.05, dt));
    for (const b of [...this.bodies]) {
      b.age += dt;
      const old = b.age - b.touched;
      if (old > 35 || (this.bodies.length > 38 && old > 8)) b.fade -= dt / 3;
      if (b.fade <= 0) {
        this.remove(b);
        continue;
      }
      if (b.asleep) continue;
      const prevBottom = b.y + b.h / 2;
      b.vy = Math.min(2400, b.vy + 1900 * dt);
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.spin * dt;
      let floor = height;
      if (b.vy >= 0)
        for (const other of this.bodies) {
          if (other === b || !other.asleep || other.fade < 0.5) continue;
          const top = other.y - other.h * 0.3;
          if (top >= height - 230 && prevBottom <= top + 12 && Math.abs(b.x - other.x) < (b.w + other.w) * 0.3)
            floor = Math.min(floor, top);
        }
      if (b.y + b.h / 2 >= floor && b.vy >= 0) {
        b.y = floor - b.h / 2;
        b.vy = -b.vy * 0.22;
        b.vx *= Math.max(0, 1 - 8 * dt);
        b.spin *= 0.65;
        if (Math.abs(b.vy) < 32 && Math.abs(b.vx) < 25) {
          b.vx = b.vy = b.spin = 0;
          b.asleep = true;
        }
      }
      if (b.x < b.w * 0.2) {
        b.x = b.w * 0.2;
        b.vx = Math.abs(b.vx) * 0.3;
      }
      if (b.x > width - b.w * 0.2) {
        b.x = width - b.w * 0.2;
        b.vx = -Math.abs(b.vx) * 0.3;
      }
    }
  }
  draw(ctx: CanvasRenderingContext2D) {
    for (const b of this.bodies) {
      ctx.save();
      ctx.globalAlpha = b.fade;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      ctx.drawImage(b.img, -b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
  }
}
