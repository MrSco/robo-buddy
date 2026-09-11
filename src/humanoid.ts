import type * as THREE from "three";
import type { VRMHumanBoneName } from "@pixiv/three-vrm";

export type BoneName = VRMHumanBoneName;

/** Mixamo bone name -> VRM humanoid name. */
export const MIXAMO_TO_VRM: Record<string, BoneName> = {
  Hips: "hips",
  Spine: "spine",
  Spine1: "chest",
  Spine2: "upperChest",
  Neck: "neck",
  Head: "head",
  LeftShoulder: "leftShoulder",
  LeftArm: "leftUpperArm",
  LeftForeArm: "leftLowerArm",
  LeftHand: "leftHand",
  RightShoulder: "rightShoulder",
  RightArm: "rightUpperArm",
  RightForeArm: "rightLowerArm",
  RightHand: "rightHand",
  LeftUpLeg: "leftUpperLeg",
  LeftLeg: "leftLowerLeg",
  LeftFoot: "leftFoot",
  LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg",
  RightLeg: "rightLowerLeg",
  RightFoot: "rightFoot",
  RightToeBase: "rightToes",
};
for (const side of ["Left", "Right"] as const) {
  const s = side.toLowerCase();
  MIXAMO_TO_VRM[`${side}HandThumb1`] = `${s}ThumbMetacarpal` as BoneName;
  MIXAMO_TO_VRM[`${side}HandThumb2`] = `${s}ThumbProximal` as BoneName;
  MIXAMO_TO_VRM[`${side}HandThumb3`] = `${s}ThumbDistal` as BoneName;
  for (const finger of ["Index", "Middle", "Ring", "Pinky"] as const) {
    const f = finger === "Pinky" ? "Little" : finger;
    MIXAMO_TO_VRM[`${side}Hand${finger}1`] = `${s}${f}Proximal` as BoneName;
    MIXAMO_TO_VRM[`${side}Hand${finger}2`] = `${s}${f}Intermediate` as BoneName;
    MIXAMO_TO_VRM[`${side}Hand${finger}3`] = `${s}${f}Distal` as BoneName;
  }
}

/** Unreal mannequin / Quaternius names -> VRM humanoid name. */
export const UE_TO_VRM: Record<string, BoneName> = {
  pelvis: "hips",
  spine_01: "spine",
  spine_02: "chest",
  spine_03: "upperChest",
  neck_01: "neck",
  head: "head",
  Head: "head",
};
for (const [s, S] of [["l", "left"], ["r", "right"]] as const) {
  UE_TO_VRM[`clavicle_${s}`] = `${S}Shoulder` as BoneName;
  UE_TO_VRM[`upperarm_${s}`] = `${S}UpperArm` as BoneName;
  UE_TO_VRM[`lowerarm_${s}`] = `${S}LowerArm` as BoneName;
  UE_TO_VRM[`hand_${s}`] = `${S}Hand` as BoneName;
  UE_TO_VRM[`thigh_${s}`] = `${S}UpperLeg` as BoneName;
  UE_TO_VRM[`calf_${s}`] = `${S}LowerLeg` as BoneName;
  UE_TO_VRM[`foot_${s}`] = `${S}Foot` as BoneName;
  UE_TO_VRM[`ball_${s}`] = `${S}Toes` as BoneName;
  for (const [src, dst] of [["thumb", "Thumb"], ["index", "Index"], ["middle", "Middle"], ["ring", "Ring"], ["pinky", "Little"]] as const) {
    const parts = dst === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"];
    for (let k = 1; k <= 3; k++) UE_TO_VRM[`${src}_0${k}_${s}`] = `${S}${dst}${parts[k - 1]}` as BoneName;
  }
}

/** Common Blender / generic names (Rigify, Unity humanoid style). */
export const GENERIC_TO_VRM: Record<string, BoneName> = {
  hips: "hips", pelvis: "hips", spine: "spine", spine1: "chest", chest: "chest", spine2: "upperChest", upperchest: "upperChest",
  neck: "neck", head: "head",
  leftshoulder: "leftShoulder", leftupperarm: "leftUpperArm", leftlowerarm: "leftLowerArm", lefthand: "leftHand",
  rightshoulder: "rightShoulder", rightupperarm: "rightUpperArm", rightlowerarm: "rightLowerArm", righthand: "rightHand",
  leftupperleg: "leftUpperLeg", leftlowerleg: "leftLowerLeg", leftfoot: "leftFoot", lefttoes: "leftToes",
  rightupperleg: "rightUpperLeg", rightlowerleg: "rightLowerLeg", rightfoot: "rightFoot", righttoes: "rightToes",
  "upper_arm.l": "leftUpperArm", "forearm.l": "leftLowerArm", "hand.l": "leftHand", "shoulder.l": "leftShoulder",
  "upper_arm.r": "rightUpperArm", "forearm.r": "rightLowerArm", "hand.r": "rightHand", "shoulder.r": "rightShoulder",
  "thigh.l": "leftUpperLeg", "shin.l": "leftLowerLeg", "foot.l": "leftFoot", "toe.l": "leftToes",
  "thigh.r": "rightUpperLeg", "shin.r": "rightLowerLeg", "foot.r": "rightFoot", "toe.r": "rightToes",
};

export function stripMixamo(name: string): string {
  return name.replace(/^mixamorig:?/i, "");
}

/** Resolve any supported bone name to the VRM humanoid name, or undefined. */
export function humanoidNameOf(nodeName: string): BoneName | undefined {
  const bare = stripMixamo(nodeName.trim());
  return (
    MIXAMO_TO_VRM[bare] ??
    UE_TO_VRM[bare] ??
    GENERIC_TO_VRM[bare.toLowerCase()] ??
    GENERIC_TO_VRM[bare.toLowerCase().replace(/[\s_-]/g, "")] ??
    undefined
  );
}

/** Walk a scene graph and collect humanoid bones by any supported naming scheme. */
export function findHumanoidBones(root: THREE.Object3D): Map<BoneName, THREE.Object3D> {
  const bones = new Map<BoneName, THREE.Object3D>();
  root.traverse((o) => {
    const name = humanoidNameOf(o.name);
    if (name && !bones.has(name)) bones.set(name, o);
  });
  return bones;
}

export const REQUIRED_BONES: BoneName[] = [
  "hips", "spine", "head", "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
  "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
];

export function missingBones(bones: Map<BoneName, THREE.Object3D>): BoneName[] {
  return REQUIRED_BONES.filter((b) => !bones.has(b));
}
