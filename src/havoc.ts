export const STRIKE_CONTACT = 0.8;
export type StrikeKind = "punch" | "kick" | "throw";
export interface AttackTarget {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  debris: boolean;
}
export interface HavocAction {
  kind: StrikeKind;
  dir: number;
  start: number;
  duration: number;
  jump: boolean;
  impact: boolean;
}
/** Timed attacks augment roaming rather than replacing the travel scheduler. */
export class Havoc {
  private next = 0;
  private action: HavocAction | null = null;
  private fired = false;
  constructor(
    private random = Math.random,
    private durationFor: (kind: StrikeKind) => number = (kind) => (kind === "throw" ? 1.25 : 0.85),
  ) {}
  update(
    t: number,
    available: boolean,
    intensity: number,
    x: number,
    y: number,
    w: number,
    h: number,
    targets: AttackTarget[],
    airborne: boolean,
  ): HavocAction | null {
    if (!available) {
      this.action = null;
      this.next = t + 1;
      return null;
    }
    if (this.action) {
      if (t >= this.action.start + this.action.duration) {
        this.action = null;
        return null;
      }
      const impact = !this.fired && t >= this.action.start + this.action.duration * STRIKE_CONTACT;
      if (impact) this.fired = true;
      return { ...this.action, jump: false, impact };
    }
    // Three seconds out of every fourteen are reserved for uninterrupted travel.
    if (t < this.next || t % 14 < 3) return null;
    const power = Math.max(0, Math.min(100, intensity)) / 100;
    this.next = t + 1.5 + (1 - power) * 4 + this.random() * 1.8;
    const cx = x + w / 2;
    const nearby = targets.filter(
      (s) => Math.abs(s.x + s.w / 2 - cx) < s.w / 2 + w * 0.75 && s.y < y + h + 50 && s.y + s.h > y - h * 0.4,
    );
    const target = nearby.sort((a, b) => Math.abs(a.x + a.w / 2 - cx) - Math.abs(b.x + b.w / 2 - cx))[0];
    const dir = target ? Math.sign(target.x + target.w / 2 - cx) || 1 : this.random() < 0.5 ? -1 : 1;
    const low = target && target.y > y + h * 0.6;
    const kind: StrikeKind = target?.debris
      ? this.random() < 0.45
        ? "throw"
        : low
          ? "kick"
          : "punch"
      : low
        ? "kick"
        : "punch";
    this.action = {
      kind,
      dir,
      start: t,
      duration: Math.max(0.4, Math.min(4, this.durationFor(kind))),
      jump: !airborne && !low && this.random() < 0.55,
      impact: false,
    };
    this.fired = false;
    return { ...this.action };
  }
}
