import * as THREE from "three";
import type { Character } from "./character";

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const parentQ = new THREE.Quaternion();
const axisLocal = new THREE.Vector3();
export const WORLD_X = new THREE.Vector3(1, 0, 0);
export const WORLD_Y = new THREE.Vector3(0, 1, 0);
export const WORLD_Z = new THREE.Vector3(0, 0, 1);

export function resetBone(c: Character, b: THREE.Object3D | undefined) {
  if (!b) return;
  const base = c.rest.get(b);
  if (base) b.quaternion.copy(base);
}

/** Rotate a bone about a world-space axis, independent of the rig's local bone axes. */
export function rotateWorld(b: THREE.Object3D | undefined, axis: THREE.Vector3, angle: number) {
  if (!b || !b.parent || angle === 0) return;
  b.parent.getWorldQuaternion(parentQ);
  axisLocal.copy(axis).applyQuaternion(parentQ.invert()).normalize();
  tmpQ.setFromAxisAngle(axisLocal, angle);
  b.quaternion.premultiply(tmpQ);
  b.updateMatrixWorld(true);
}

export function poseLocal(c: Character, b: THREE.Object3D | undefined, x: number, y: number, z: number) {
  if (!b) return;
  const base = c.rest.get(b);
  if (!base) return;
  tmpQ.setFromEuler(tmpE.set(x, y, z));
  b.quaternion.copy(base).multiply(tmpQ);
}

/** Procedural standing idle: arms down from T-pose, breathing, gentle sway. */
export function applyIdle(c: Character, t: number, intensity = 1) {
  const breathe = Math.sin(t * 1.6) * 0.02 * intensity;
  const sway = Math.sin(t * 0.7) * 0.04 * intensity;

  const chest = c.bone("chest") ?? c.bone("spine");
  poseLocal(c, chest, breathe * 0.6, sway * 0.5, 0);

  c.root.updateMatrixWorld(true);
  for (const n of ["leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"] as const) {
    resetBone(c, c.bone(n));
  }
  // Arms a clip is driving already have a pose; only drop the ones still in T-pose.
  const free = (n: "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm") => {
    const b = c.bone(n);
    return b && !c.animatedBones.has(b) ? b : undefined;
  };
  const drop = 1.25 + breathe; // ~72 degrees: arms hang slightly out from the body
  rotateWorld(free("leftUpperArm"), WORLD_Z, -drop);
  rotateWorld(free("rightUpperArm"), WORLD_Z, drop);
  rotateWorld(free("leftLowerArm"), WORLD_X, -0.2);
  rotateWorld(free("rightLowerArm"), WORLD_X, -0.2);
}

/** Arms up and flailing, used while airborne. */
export function applyFlail(c: Character, t: number) {
  c.root.updateMatrixWorld(true);
  for (const n of ["leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"] as const) {
    resetBone(c, c.bone(n));
  }
  const wave = Math.sin(t * 14) * 0.35;
  rotateWorld(c.bone("leftUpperArm"), WORLD_Z, 0.9 + wave);
  rotateWorld(c.bone("rightUpperArm"), WORLD_Z, -0.9 - wave);
  rotateWorld(c.bone("leftLowerArm"), WORLD_Z, 0.5);
  rotateWorld(c.bone("rightLowerArm"), WORLD_Z, -0.5);
}

/**
 * Turn head (and a little of the neck/chest) toward a yaw/pitch in radians.
 * Positive yaw looks toward the viewer's right, positive pitch looks up.
 */
export function applyLookAt(c: Character, yaw: number, pitch: number, roll = 0) {
  const head = c.bone("head");
  const neck = c.bone("neck");
  const chest = c.bone("upperChest") ?? c.bone("chest");
  // Every bone touched here must be reset first, or the rotation accumulates frame over frame.
  resetBone(c, head);
  resetBone(c, neck);
  resetBone(c, chest);
  c.root.updateMatrixWorld(true);
  rotateWorld(chest, WORLD_Y, yaw * 0.15);
  rotateWorld(neck, WORLD_Y, yaw * 0.25);
  rotateWorld(neck, WORLD_X, -pitch * 0.25);
  rotateWorld(head, WORLD_Y, yaw * 0.6);
  rotateWorld(head, WORLD_X, -pitch * 0.6);
  rotateWorld(head, WORLD_Z, roll);
}

/**
 * Asleep on the feet: slumped chest, head dropped forward, slow deep breathing.
 * `amount` blends it over the idle pose so falling asleep and waking are gradual.
 */
export function applySleep(c: Character, t: number, amount: number) {
  if (amount <= 0.001) return;
  const breathe = Math.sin(t * 0.9) * 0.03 * amount;
  const chest = c.bone("chest") ?? c.bone("spine");
  c.root.updateMatrixWorld(true);
  rotateWorld(chest, WORLD_X, 0.18 * amount + breathe);
  rotateWorld(c.bone("neck"), WORLD_X, 0.25 * amount);
  rotateWorld(c.bone("head"), WORLD_X, 0.45 * amount);
  rotateWorld(c.bone("head"), WORLD_Z, 0.12 * amount);
  // Arms hang a little looser.
  rotateWorld(c.bone("leftUpperArm"), WORLD_Z, -0.12 * amount);
  rotateWorld(c.bone("rightUpperArm"), WORLD_Z, 0.12 * amount);
}
