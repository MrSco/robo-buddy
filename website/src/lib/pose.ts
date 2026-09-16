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

/**
 * Turn head (and a little of the neck/chest) toward a yaw/pitch in radians.
 * Positive yaw looks toward the viewer's right, positive pitch looks up.
 * Distributed smoothly across chest (15%), neck (25%), and head (60%) with zero sideways roll tilt.
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

/** A bounded procedural action overlay for kicks, punches, and throws. */
export function applyAttack(c: Character, kind: "punch" | "kick" | "throw", progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  const pulse = Math.sin(Math.PI * (p <= 0.8 ? p / 1.6 : 0.5 + (p - 0.8) * 2.5));
  if (kind === "kick") {
    poseLocal(c, c.bone("rightUpperLeg"), -1.15 * pulse, 0, 0);
    poseLocal(c, c.bone("rightLowerLeg"), 0.35 * pulse, 0, 0);
    poseLocal(c, c.bone("chest") ?? c.bone("spine"), 0.12 * pulse, 0, 0);
  } else if (kind === "throw") {
    poseLocal(c, c.bone("leftUpperArm"), -1.3 * pulse, 0, -0.8);
    poseLocal(c, c.bone("rightUpperArm"), -1.3 * pulse, 0, 0.8);
    poseLocal(c, c.bone("leftLowerArm"), -0.6 * pulse, 0, 0);
    poseLocal(c, c.bone("rightLowerArm"), -0.6 * pulse, 0, 0);
  } else {
    const arm = c.bone("rightUpperArm");
    if (arm) {
      poseLocal(c, arm, -1.1 * pulse, 0, 0.65);
      poseLocal(c, c.bone("rightLowerArm"), -0.3 * pulse, 0, 0);
    }
  }
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
export function aimBone(
  bone: THREE.Object3D | undefined,
  child: THREE.Object3D | undefined,
  target: THREE.Vector3,
  amount = 1
) {
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

/** Held by one arm: that arm points straight up to cursor, body dangles below it. */
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
  aimBone(upper, lower, UP, amount);
  aimBone(lower, hand, UP, amount);
  tmpDir.set(Math.sin(t * 1.7) * 0.12 * (L ? -1 : 1), -1, 0).normalize();
  aimBone(oUpper, oLower, tmpDir, amount);
  aimBone(oLower, oHand, tmpDir, amount);
  tmpDir.set(-0.08, -1, 0).normalize();
  aimBone(c.bone("leftUpperLeg"), c.bone("leftLowerLeg"), tmpDir, amount);
  aimBone(c.bone("leftLowerLeg"), c.bone("leftFoot"), tmpDir, amount);
  tmpDir.set(0.08, -1, 0).normalize();
  aimBone(c.bone("rightUpperLeg"), c.bone("rightLowerLeg"), tmpDir, amount);
  aimBone(c.bone("rightLowerLeg"), c.bone("rightFoot"), tmpDir, amount);
}

/**
 * Held by a leg: The body flips upside down with the held leg reaching up to the cursor,
 * the free leg dangling, and the arms reaching downward toward the floor.
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
  const sway = Math.sin(t * 1.4) * 0.08;
  tmpDir.set((L ? 0.45 : -0.45) + sway, 0.62, 0.5).normalize();
  aimBone(freeUpper, freeLower, tmpDir, amount);
  tmpDir.set((L ? 0.15 : -0.15) + sway, 0.92, 0.25).normalize();
  aimBone(freeLower, freeFoot, tmpDir, amount);
  const armSway = Math.sin(t * 1.9) * 0.1;
  tmpDir.set(0.25 + armSway, 1, 0).normalize();
  aimBone(c.bone("leftUpperArm"), c.bone("leftLowerArm"), tmpDir, amount);
  aimBone(c.bone("leftLowerArm"), c.bone("leftHand"), tmpDir, amount);
  tmpDir.set(-0.25 + armSway, 1, 0).normalize();
  aimBone(c.bone("rightUpperArm"), c.bone("rightLowerArm"), tmpDir, amount);
  aimBone(c.bone("rightLowerArm"), c.bone("rightHand"), tmpDir, amount);
}

/** Held by the head or torso: arms and legs hang limp beneath the grab point. */
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

const crouchAxis = new THREE.Vector3();
const crouchA = new THREE.Vector3();
const crouchB = new THREE.Vector3();

/**
 * Procedural duck/crouch with inverse kinematics knee bend: knees forward, hips down,
 * feet flat on the ground. Matches desktop crouch mechanics.
 */
export function applyCrouch(c: Character, drop: number) {
  if (drop <= 1e-5) return;
  const hip = c.bone("leftUpperLeg") ?? c.bone("rightUpperLeg");
  const foot = c.bone("leftFoot") ?? c.bone("rightFoot");
  if (!hip || !foot) return;
  for (const n of [
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
  ] as const) {
    const b = c.bone(n);
    if (b && !c.animatedBones.has(b)) resetBone(c, b);
  }
  c.root.updateMatrixWorld(true);
  hip.getWorldPosition(crouchA);
  foot.getWorldPosition(crouchB);
  const len = Math.max(1e-3, crouchA.y - crouchB.y);
  const a = Math.acos(THREE.MathUtils.clamp(1 - Math.min(drop, len * 0.45) / len, -1, 1));
  crouchAxis.set(1, 0, 0).applyQuaternion(c.root.quaternion).normalize();
  for (const side of ["left", "right"] as const) {
    rotateWorld(c.bone(`${side}UpperLeg`), crouchAxis, -a);
    rotateWorld(c.bone(`${side}LowerLeg`), crouchAxis, 2 * a);
    rotateWorld(c.bone(`${side}Foot`), crouchAxis, -a);
  }
  rotateWorld(c.bone("chest") ?? c.bone("spine"), crouchAxis, a * 0.3);
  c.root.position.y -= len * (1 - Math.cos(a));
}


