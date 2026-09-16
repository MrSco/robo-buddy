import * as THREE from "three";
import type { BoneName, Character } from "./character";
import { rotateWorld, WORLD_X, WORLD_Z } from "./pose";

/**
 * Secondary motion: every dangling chain (arms, legs, head) is a damped pendulum driven by
 * how Buddy accelerates. Drag him sideways and the limbs lag behind and swing back;
 * throw him and they trail the flight like a real desktop ragdoll.
 */
interface Chain {
  root: BoneName;
  mid: BoneName;
  /** Which arm/leg this is, so a held limb can be excluded. */
  part: "leftArm" | "rightArm" | "leftLeg" | "rightLeg" | "head";
  /** Angle and angular velocity about the screen Z axis (sideways swing). */
  z: number;
  zv: number;
  /** Forward/back swing about X. */
  x: number;
  xv: number;
  /** How strongly acceleration drives this chain. */
  gain: number;
  /** Spring stiffness and damping. */
  k: number;
  c: number;
}

const CHAINS: Array<Omit<Chain, "z" | "zv" | "x" | "xv">> = [
  { root: "leftUpperArm", mid: "leftLowerArm", part: "leftArm", gain: 1.0, k: 30, c: 4.5 },
  { root: "rightUpperArm", mid: "rightLowerArm", part: "rightArm", gain: 1.0, k: 30, c: 4.5 },
  { root: "leftUpperLeg", mid: "leftLowerLeg", part: "leftLeg", gain: 0.7, k: 40, c: 5 },
  { root: "rightUpperLeg", mid: "rightLowerLeg", part: "rightLeg", gain: 0.7, k: 40, c: 5 },
  { root: "neck", mid: "head", part: "head", gain: 0.5, k: 60, c: 7 },
];

export class LimbSprings {
  private chains: Chain[] = CHAINS.map((c) => ({ ...c, z: 0, zv: 0, x: 0, xv: 0 }));
  /** Random per-chain phase so the limbs do not move in lockstep. */
  private phase = this.chains.map((_, i) => i * 1.7);

  /**
   * @param ax horizontal acceleration, normalised (~+-1 for hard yank)
   * @param ay vertical acceleration, normalised, positive = downwards
   * @param amount 0..1 blend; 0 skips everything
   * @param exclude limb currently rigid (held by the cursor)
   */
  update(c: Character, dt: number, t: number, ax: number, ay: number, amount: number, exclude: Chain["part"] | null) {
    if (amount <= 0.001) {
      // Let the springs settle silently so re-engaging does not start with a jolt.
      for (const ch of this.chains) {
        ch.zv += (-ch.k * ch.z - ch.c * ch.zv) * dt;
        ch.z += ch.zv * dt;
        ch.xv += (-ch.k * ch.x - ch.c * ch.xv) * dt;
        ch.x += ch.xv * dt;
      }
      return;
    }
    c.root.updateMatrixWorld(true);
    this.chains.forEach((ch, i) => {
      // Acceleration to the right throws the limb to the left, and vice versa.
      const driveZ = -ax * ch.gain * 1.4;
      // Falling (positive ay) lifts limbs up and out; being jerked upward pulls them down.
      const driveX = -ay * ch.gain * 0.8 + Math.sin(t * 2.3 + this.phase[i]) * 0.03;
      ch.zv += (ch.k * (driveZ - ch.z) - ch.c * ch.zv) * dt;
      ch.z += ch.zv * dt;
      ch.xv += (ch.k * (driveX - ch.x) - ch.c * ch.xv) * dt;
      ch.x += ch.xv * dt;
      ch.z = THREE.MathUtils.clamp(ch.z, -1.2, 1.2);
      ch.x = THREE.MathUtils.clamp(ch.x, -1.0, 1.0);
      if (ch.part === exclude) return;
      const root = c.bone(ch.root);
      const mid = c.bone(ch.mid);
      // The lower segment follows with a lag, which reads as a whip.
      rotateWorld(root, WORLD_Z, ch.z * amount);
      rotateWorld(mid, WORLD_Z, ch.z * 0.6 * amount);
      rotateWorld(root, WORLD_X, ch.x * amount);
      rotateWorld(mid, WORLD_X, ch.x * 0.5 * amount);
    });
  }
}
