export type StrikeKind = "punch" | "kick" | "throw";
/**
 * How far through an attack clip the blow actually lands, as a fraction of its length.
 *
 * Halfway is where a strike is fully extended: the windup fills the first half and the recovery
 * the second, so the arm or leg is at its furthest at the midpoint whatever the clip's length.
 * That holds for the bundled strikes and should hold for any reasonable replacement, which is why
 * it is a fraction rather than a table of per-clip times. A throw is the exception: the object
 * leaves the hand after the arm has come round, later than a punch is extended.
 */
const CONTACT: Record<StrikeKind, number> = { punch: 0.5, kick: 0.5, throw: 0.62 };
export function contactFraction(kind: StrikeKind): number {
  return CONTACT[kind];
}
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
  /** Swings at thin air since he last had something within reach. */
  private missed = 0;
  /**
   * How many unanswered swings he is allowed before he has to go and find something. Without a
   * cap he plants himself wherever he happens to be, most visibly in the gap a window has been
   * knocked out of, and shadow-boxes there for the rest of the screensaver: an attack is chosen
   * whether or not anything is in range, and while one plays the travel scheduler is held off,
   * so he never gets far enough to find a new target.
   */
  private static readonly MAX_MISSED = 1;
  /** Of every `CYCLE` seconds, the first `TRAVEL` are left alone for walking, climbing and charging. */
  private static readonly CYCLE = 12;
  private static readonly TRAVEL = 4;
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
      this.missed = 0;
      this.next = t + 1;
      return null;
    }
    if (this.action) {
      if (t >= this.action.start + this.action.duration) {
        this.action = null;
        return null;
      }
      const impact = !this.fired && t >= this.action.start + this.action.duration * contactFraction(this.action.kind);
      if (impact) this.fired = true;
      return { ...this.action, jump: false, impact };
    }
    // Part of every cycle is reserved for uninterrupted travel.
    if (t < this.next || t % Havoc.CYCLE < Havoc.TRAVEL) return null;
    const power = Math.max(0, Math.min(100, intensity)) / 100;
    this.next = t + 1.5 + (1 - power) * 4 + this.random() * 1.8;
    const cx = x + w / 2;
    const nearby = targets.filter(
      (s) => Math.abs(s.x + s.w / 2 - cx) < s.w / 2 + w * 0.75 && s.y < y + h + 50 && s.y + s.h > y - h * 0.4,
    );
    const target = nearby.sort((a, b) => Math.abs(a.x + a.w / 2 - cx) - Math.abs(b.x + b.w / 2 - cx))[0];
    if (target) this.missed = 0;
    else if (this.missed >= Havoc.MAX_MISSED) {
      // He has already swung at nothing and there is still nothing there. Give the slot back to
      // the travel scheduler and wait a little, so he goes looking instead of rooting himself.
      this.missed = 0;
      this.next = t + 2.5 + this.random() * 2;
      return null;
    } else this.missed++;
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
