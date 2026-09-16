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
