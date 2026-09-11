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

const aimA = new THREE.Vector3();
const aimB = new THREE.Vector3();
const aimQ = new THREE.Quaternion();
const aimW = new THREE.Quaternion();
const aimP = new THREE.Quaternion();
const identityQ = new THREE.Quaternion();

/**
 * Rotate `bone` so the direction toward `child` points along a world-space target,
 * blended by `amount`. Works from any base pose, unlike fixed angle offsets.
 */
export function aimBone(bone: THREE.Object3D | undefined, child: THREE.Object3D | undefined, target: THREE.Vector3, amount = 1) {
  if (!bone || !child || !bone.parent || amount <= 0.001) return;
  bone.updateMatrixWorld(true);
  bone.getWorldPosition(aimA);
  child.getWorldPosition(aimB);
  aimB.sub(aimA);
  if (aimB.lengthSq() < 1e-8) return;
  aimB.normalize();
  aimQ.setFromUnitVectors(aimB, target);
  if (amount < 1) aimQ.slerp(identityQ, 1 - amount);
  bone.getWorldQuaternion(aimW);
  aimW.premultiply(aimQ);
  bone.parent.getWorldQuaternion(aimP);
  bone.quaternion.copy(aimP.invert().multiply(aimW));
  bone.updateMatrixWorld(true);
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const tmpDir = new THREE.Vector3();

/** Held by one arm: that arm points straight up to the cursor, the body dangles below it. */
export function applyHeldByArm(c: Character, side: "left" | "right", t: number, amount: number) {
  if (amount <= 0.001) return;
  const L = side === "left";
  const upper = c.bone(L ? "leftUpperArm" : "rightUpperArm");
  const lower = c.bone(L ? "leftLowerArm" : "rightLowerArm");
  const hand = c.bone(L ? "leftHand" : "rightHand");
  const oUpper = c.bone(L ? "rightUpperArm" : "leftUpperArm");
  const oLower = c.bone(L ? "rightLowerArm" : "leftLowerArm");
  const oHand = c.bone(L ? "rightHand" : "leftHand");
  c.root.updateMatrixWorld(true);
  // Held arm straight up; the free arm hangs limp with a slow sway.
  aimBone(upper, lower, UP, amount);
  aimBone(lower, hand, UP, amount);
  tmpDir.set(Math.sin(t * 1.7) * 0.12 * (L ? -1 : 1), -1, 0).normalize();
  aimBone(oUpper, oLower, tmpDir, amount);
  aimBone(oLower, oHand, tmpDir, amount);
  // Legs dangle straight down, slightly apart.
  tmpDir.set(-0.08, -1, 0).normalize();
  aimBone(c.bone("leftUpperLeg"), c.bone("leftLowerLeg"), tmpDir, amount);
  aimBone(c.bone("leftLowerLeg"), c.bone("leftFoot"), tmpDir, amount);
  tmpDir.set(0.08, -1, 0).normalize();
  aimBone(c.bone("rightUpperLeg"), c.bone("rightLowerLeg"), tmpDir, amount);
  aimBone(c.bone("rightLowerLeg"), c.bone("rightFoot"), tmpDir, amount);
}

/**
 * Held by a leg. The renderer flips the whole body afterwards, so this is posed upright:
 * the held leg straight, the free leg bent, and the arms reaching up (down, once flipped).
 */
export function applyHeldByLeg(c: Character, side: "left" | "right", t: number, amount: number) {
  if (amount <= 0.001) return;
  const L = side === "left";
  c.root.updateMatrixWorld(true);
  const heldUpper = c.bone(L ? "leftUpperLeg" : "rightUpperLeg");
  const heldLower = c.bone(L ? "leftLowerLeg" : "rightLowerLeg");
  const heldFoot = c.bone(L ? "leftFoot" : "rightFoot");
  const freeUpper = c.bone(L ? "rightUpperLeg" : "leftUpperLeg");
  const freeLower = c.bone(L ? "rightLowerLeg" : "leftLowerLeg");
  const freeFoot = c.bone(L ? "rightFoot" : "leftFoot");
  aimBone(heldUpper, heldLower, DOWN, amount);
  aimBone(heldLower, heldFoot, DOWN, amount);
  // Free leg: thigh slightly forward and out, knee bent back.
  tmpDir.set(L ? 0.35 : -0.35, -0.85, 0.35).normalize();
  aimBone(freeUpper, freeLower, tmpDir, amount);
  tmpDir.set(L ? 0.2 : -0.2, -0.5, -0.85).normalize();
  aimBone(freeLower, freeFoot, tmpDir, amount);
  // Arms reach past the head with a lazy sway; after the flip they hang toward the floor.
  const sway = Math.sin(t * 1.9) * 0.1;
  tmpDir.set(0.25 + sway, 1, 0).normalize();
  aimBone(c.bone("leftUpperArm"), c.bone("leftLowerArm"), tmpDir, amount);
  aimBone(c.bone("leftLowerArm"), c.bone("leftHand"), tmpDir, amount);
  tmpDir.set(-0.25 + sway, 1, 0).normalize();
  aimBone(c.bone("rightUpperArm"), c.bone("rightLowerArm"), tmpDir, amount);
  aimBone(c.bone("rightLowerArm"), c.bone("rightHand"), tmpDir, amount);
}

const limpUp = new THREE.Vector3();

/**
 * Held by the head or the torso: everything below the grab point hangs. Arms straight down
 * with a lazy sway, legs down and slightly apart with the knees trailing back, head level.
 */
export function applyDangle(c: Character, t: number, amount: number) {
  if (amount <= 0.001) return;
  c.root.updateMatrixWorld(true);
  const sway = Math.sin(t * 1.6) * 0.08;
  tmpDir.set(-0.12 + sway, -1, -0.05).normalize();
  aimBone(c.bone("leftUpperArm"), c.bone("leftLowerArm"), tmpDir, amount);
  aimBone(c.bone("leftLowerArm"), c.bone("leftHand"), tmpDir, amount);
  tmpDir.set(0.12 + sway, -1, -0.05).normalize();
  aimBone(c.bone("rightUpperArm"), c.bone("rightLowerArm"), tmpDir, amount);
  aimBone(c.bone("rightLowerArm"), c.bone("rightHand"), tmpDir, amount);
  tmpDir.set(-0.08, -1, 0.05).normalize();
  aimBone(c.bone("leftUpperLeg"), c.bone("leftLowerLeg"), tmpDir, amount);
  tmpDir.set(-0.06, -1, -0.22).normalize();
  aimBone(c.bone("leftLowerLeg"), c.bone("leftFoot"), tmpDir, amount);
  tmpDir.set(0.08, -1, 0.05).normalize();
  aimBone(c.bone("rightUpperLeg"), c.bone("rightLowerLeg"), tmpDir, amount);
  tmpDir.set(0.06, -1, -0.22).normalize();
  aimBone(c.bone("rightLowerLeg"), c.bone("rightFoot"), tmpDir, amount);
}

/**
 * Knocked out on the floor: arms flop toward the ground, the head lolls. Applied over a
 * frozen clip pose, after look-at, blended by `amount`.
 */
export function applyLimp(c: Character, amount: number) {
  if (amount <= 0.001) return;
  c.root.updateMatrixWorld(true);
  tmpDir.set(-0.2, -1, 0.1).normalize();
  aimBone(c.bone("leftUpperArm"), c.bone("leftLowerArm"), tmpDir, amount * 0.9);
  aimBone(c.bone("leftLowerArm"), c.bone("leftHand"), tmpDir, amount * 0.7);
  tmpDir.set(0.2, -1, 0.1).normalize();
  aimBone(c.bone("rightUpperArm"), c.bone("rightLowerArm"), tmpDir, amount * 0.9);
  aimBone(c.bone("rightLowerArm"), c.bone("rightHand"), tmpDir, amount * 0.7);
  // Head: partway between "along the spine" and "toward the floor".
  const chest = c.bone("upperChest") ?? c.bone("chest") ?? c.bone("spine");
  const neck = c.bone("neck");
  const head = c.bone("head");
  if (chest && neck && head) {
    chest.getWorldPosition(aimA);
    neck.getWorldPosition(limpUp);
    limpUp.sub(aimA).normalize().addScaledVector(DOWN, 0.6).normalize();
    aimBone(neck, head, limpUp, amount * 0.7);
  }
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
