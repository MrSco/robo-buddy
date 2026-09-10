import type { Character } from "./character";
import type { Music } from "./audio";
import { resetBone, rotateWorld, WORLD_X, WORLD_Y, WORLD_Z } from "./pose";

export interface DanceOut {
  /** Extra head pitch (negative = nod down). */
  nod: number;
  /** Extra head roll. */
  roll: number;
}

const DANCE_ONLY_BONES = ["hips", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg"] as const;

const TAU = Math.PI * 2;

/**
 * Procedural groove layered on top of the idle pose. Everything is scaled by
 * `amount` (0..1) so it can fade in and out, and by the music level so quiet
 * passages are subtler. Returns the head nod to feed into the look-at.
 */
export function applyDance(c: Character, m: Music, amount: number): DanceOut {
  // Idle resets arms and chest each frame; these are ours to reset or they accumulate.
  for (const n of DANCE_ONLY_BONES) resetBone(c, c.bone(n));
  if (amount <= 0.001) return { nod: 0, roll: 0 };
  const a = amount * (0.55 + 0.45 * m.level);
  const phase = m.phase; // 0..1 within the beat
  const half = m.beats * 0.5; // half-time cycle for side-to-side moves
  const bassKick = m.bass * m.bass;

  // Bounce: dip on the beat, rise before the next one.
  const dip = (1 - Math.cos(phase * TAU)) * 0.5; // 0 at beat, 1 mid-beat
  c.root.position.y = -0.06 * a * (1 - dip) - 0.02 * a * bassKick;

  // Torso: sway side to side at half time, twist against it, lean back on bass.
  const sway = Math.sin(half * TAU) * 0.12 * a;
  const twist = Math.sin(half * TAU + Math.PI / 2) * 0.18 * a;
  const chest = c.bone("chest") ?? c.bone("spine");
  c.root.updateMatrixWorld(true);
  rotateWorld(chest, WORLD_Z, sway);
  rotateWorld(chest, WORLD_Y, twist);
  rotateWorld(chest, WORLD_X, -0.06 * a * bassKick);
  const hips = c.bone("hips");
  rotateWorld(hips, WORLD_Z, -sway * 0.5);
  rotateWorld(hips, WORLD_Y, -twist * 0.4);

  // Arms, designed for a front camera: upper arms out at ~45 degrees below horizontal,
  // forearms folded up so the fists sit near shoulder height, and each beat raises one side.
  const pump = Math.sin(m.beats * TAU * 0.5); // -1..1, alternates every beat
  const lift = 0.25 * a + 0.15 * a * m.bass;
  const raise = 0.28 * a * pump;
  rotateWorld(c.bone("leftUpperArm"), WORLD_Z, lift + raise);
  rotateWorld(c.bone("rightUpperArm"), WORLD_Z, -(lift - raise));
  // Slight forward angle so the folded forearms do not clip the torso.
  rotateWorld(c.bone("leftUpperArm"), WORLD_X, -0.25 * a);
  rotateWorld(c.bone("rightUpperArm"), WORLD_X, -0.25 * a);
  const fold = 1.7 * a + 0.25 * a * m.pulse;
  rotateWorld(c.bone("leftLowerArm"), WORLD_Z, fold + raise * 0.5);
  rotateWorld(c.bone("rightLowerArm"), WORLD_Z, -(fold - raise * 0.5));

  // Knees: slight bend that deepens on the dip so the bounce reads as legs, not a slide.
  const knee = (0.12 + 0.18 * (1 - dip)) * a;
  rotateWorld(c.bone("leftUpperLeg"), WORLD_X, -knee);
  rotateWorld(c.bone("rightUpperLeg"), WORLD_X, -knee);
  rotateWorld(c.bone("leftLowerLeg"), WORLD_X, knee * 2);
  rotateWorld(c.bone("rightLowerLeg"), WORLD_X, knee * 2);

  // Head nod on the pulse, with a little side bob at half time. Applied by the look-at.
  return {
    nod: -0.35 * a * m.pulse - 0.08 * a,
    roll: Math.sin(half * TAU) * 0.08 * a,
  };
}
