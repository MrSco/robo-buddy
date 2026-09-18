import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { findHumanoidBones, humanoidMatch, REQUIRED_BONES, type BoneName } from "./humanoid";
import { refreshSkins } from "./character";

if (typeof FileReader === "undefined") {
  (globalThis as unknown as { FileReader: unknown }).FileReader = class MockFileReader {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (this.onloadend) this.onloadend();
      });
    }
  };
}

export type PoseChoice = "a_pose" | "t_pose";

export interface BoneDef {
  name: string;
  parent?: string;
  head: THREE.Vector3;
  tail: THREE.Vector3;
  isLeft?: boolean;
  isRight?: boolean;
}

/** Check if a scene graph already has a skeleton with humanoid bones. */
/** Every character ends up this tall, in metres, whatever units it was authored in. */
export const TARGET_HEIGHT = 1.8;

export function isModelRigged(root: THREE.Object3D): boolean {
  let hasSkinned = false;
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton && sm.skeleton.bones.length >= 8) {
      hasSkinned = true;
    }
  });
  if (hasSkinned) return true;
  const bones = findHumanoidBones(root);
  return bones.size >= 8;
}

/** Check if the scene contains any 3D meshes with vertices. */
export function hasMeshGeometry(root: THREE.Object3D): boolean {
  let has = false;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && (m.geometry.getAttribute("position")?.count ?? 0) > 0) {
      has = true;
    }
  });
  return has;
}

/**
 * Bounding box from mesh geometry alone, ignoring stray bones, lights, cameras and empty helper
 * nodes. A skinned mesh is measured where its bones put it: the raw vertices can be a doll a few
 * centimetres tall that the armature scales up forty times, and a box around those would size the
 * skeleton for the doll.
 */
export function computeMeshBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let hasMeshes = false;
  const v = new THREE.Vector3();

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const pos = mesh.geometry.getAttribute("position");
      if (pos && pos.count > 0) {
        hasMeshes = true;
        const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
        if (skinned) skinned.skeleton.update();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos as THREE.BufferAttribute, i);
          if (skinned) skinned.applyBoneTransform(i, v);
          v.applyMatrix4(mesh.matrixWorld);
          box.expandByPoint(v);
        }
      }
    }
  });

  if (!hasMeshes || box.isEmpty()) {
    box.setFromObject(root);
  }
  return box;
}

/**
 * Turn the model Y-up if it was exported Z-up, bring it to TARGET_HEIGHT, and measure it. The same
 * path for every model: bounds come from the mesh (posed by its bones if it has any), never from a
 * box around the whole scene, which stray bones and helper nodes inflate. Idempotent, so it is safe
 * to call again on a model it has already handled.
 */
export function orientAndGetBounds(root: THREE.Object3D): {
  box: THREE.Box3;
  size: THREE.Vector3;
  center: THREE.Vector3;
} {
  const rigged = isModelRigged(root);
  const measure = () => {
    root.updateMatrixWorld(true);
    if (rigged) refreshSkins(root);
    const b = computeMeshBounds(root);
    const s = new THREE.Vector3();
    b.getSize(s);
    return { b, s };
  };
  let { b: box, s: size } = measure();

  // Which way is up. A skeleton says so directly; without one, a model much deeper than it is
  // tall was exported Z-up.
  const bones = rigged ? findHumanoidBones(root) : null;
  const hips = bones?.get("hips");
  const head = bones?.get("head");
  let up: THREE.Vector3;
  if (hips && head) {
    up = head.getWorldPosition(new THREE.Vector3()).sub(hips.getWorldPosition(new THREE.Vector3()));
  } else {
    up = size.z > size.y * 1.25 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  }
  if (Math.abs(up.z) > Math.abs(up.y)) {
    root.rotateX(up.z > 0 ? -Math.PI / 2 : Math.PI / 2);
    ({ b: box, s: size } = measure());
  }

  // Whatever units it came in, and whether it is a giant or a doll: every character is the same
  // height, so retargeting, physics and the window fit treat them all alike. A nudge either way
  // used to be left alone, and a 3.3 m model shipped at 3.3 m with a skeleton to match.
  if (size.y > 1e-6 && Math.abs(size.y - TARGET_HEIGHT) > 1e-3) {
    root.scale.multiplyScalar(TARGET_HEIGHT / size.y);
    ({ b: box, s: size } = measure());
  }

  const center = new THREE.Vector3();
  box.getCenter(center);
  return { box, size, center };
}

/** Shortest distance squared from point P to line segment (A, B). */
export function distToSegmentSq(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const abZ = b.z - a.z;
  const apX = p.x - a.x;
  const apY = p.y - a.y;
  const apZ = p.z - a.z;
  const abLenSq = abX * abX + abY * abY + abZ * abZ;
  if (abLenSq < 1e-8) {
    return apX * apX + apY * apY + apZ * apZ;
  }
  let t = (apX * abX + apY * abY + apZ * abZ) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  const qX = a.x + t * abX;
  const qY = a.y + t * abY;
  const qZ = a.z + t * abZ;
  const dx = p.x - qX;
  const dy = p.y - qY;
  const dz = p.z - qZ;
  return dx * dx + dy * dy + dz * dz;
}

export interface RigParams {
  pose?: PoseChoice;
  armAngleDeg?: number; // 0 for T-pose, 45 for A-pose
  shoulderWidth?: number; // multiplier, default 1.0
  armLength?: number; // multiplier, default 1.0
  hipHeight?: number; // multiplier, default 1.0
  legWidth?: number; // multiplier, default 1.0 (pelvis / hip width)
  kneeWidth?: number; // multiplier, default 1.0 (knee stance width)
  kneeHeight?: number; // multiplier, default 1.0 (knee joint height)
  ankleHeight?: number; // multiplier, default 1.0 (ankle height / shin length)
  footWidth?: number; // multiplier, default 1.0 (foot / ankle stance width)
  footForward?: number; // multiplier, default 1.0 (foot forward length)
  footAngleDeg?: number; // outward toe splay in degrees, default 0

  // Upper body heights
  shoulderHeight?: number; // multiplier, default 1.0
  neckHeight?: number; // multiplier, default 1.0
  headHeight?: number; // multiplier, default 1.0

  // Regional depth offsets (-1.0 to 1.0)
  headDepth?: number; // forward/back offset for head & neck
  spineDepth?: number; // forward/back offset for spine/chest/hips
  shoulderDepth?: number; // forward/back offset for shoulders & arms
  kneeDepth?: number; // forward/back offset for knees

  // Fingers option
  includeFingers?: boolean; // Generate 15 finger bones per hand (30 total)
  fingerLength?: number; // multiplier, default 1.0 (length scale of fingers)
  fingerSpread?: number; // multiplier, default 1.0 (lateral fan spread)
  thumbForward?: boolean; // true = thumb points forward (+Z), false = thumb points backward (-Z)
}

/**
 * Generate standard 22-joint Mixamo humanoid skeleton definition
 * aligned with the model's bounding box and landmarks.
 */
export function buildHumanoidBoneDefs(
  box: THREE.Box3,
  size: THREE.Vector3,
  center: THREE.Vector3,
  paramsOrPose: PoseChoice | RigParams = "a_pose",
): BoneDef[] {
  const params: RigParams = typeof paramsOrPose === "string" ? { pose: paramsOrPose } : (paramsOrPose ?? {});
  const pose = params.pose ?? "a_pose";
  const minY = box.min.y;
  const H = size.y;
  const y = (frac: number) => minY + H * frac;
  const cx = center.x;
  const cz = center.z;

  const hipMul = params.legWidth ?? 1.0;
  const kneeMul = params.kneeWidth ?? hipMul;
  const footMul = params.footWidth ?? kneeMul;

  const baseLegX = Math.max(0.04, size.x * 0.11);
  const hipX = baseLegX * hipMul;
  const kneeX = baseLegX * kneeMul;
  const footX = baseLegX * footMul;

  const footFwd = Math.max(0.04, size.z * 0.16 * (params.footForward ?? 1.0));
  const footAngleRad = ((params.footAngleDeg ?? 0) * Math.PI) / 180;
  const splaySin = Math.sin(footAngleRad);
  const splayCos = Math.cos(footAngleRad);
  const footMidD = footFwd * 0.6;
  const footEndD = footFwd;

  const hipFrac = 0.51 * (params.hipHeight ?? 1.0);
  const kneeFrac = 0.27 * (params.kneeHeight ?? 1.0);
  const ankleFrac = 0.07 * (params.ankleHeight ?? 1.0);
  const toeFrac = Math.max(0.01, ankleFrac * 0.43);
  const toeEndFrac = Math.max(0.005, ankleFrac * 0.15);
  const shoulderFrac = 0.74 * (params.shoulderHeight ?? 1.0);
  const neckFrac = 0.79 * (params.neckHeight ?? 1.0);
  const headFrac = 0.84 * (params.headHeight ?? 1.0);
  const headTopFrac = Math.min(0.99, headFrac + 0.14);

  const depthScale = size.z * 0.25;
  const headZ = cz + (params.headDepth ?? 0) * depthScale;
  const spineZ = cz + (params.spineDepth ?? 0) * depthScale;
  const shoulderZ = cz + (params.shoulderDepth ?? 0) * depthScale;
  const kneeZ = cz + (params.kneeDepth ?? 0) * depthScale;

  const defs: BoneDef[] = [
    // Spine column
    {
      name: "mixamorig:Hips",
      head: new THREE.Vector3(cx, y(hipFrac), spineZ),
      tail: new THREE.Vector3(cx, y(hipFrac + 0.06), spineZ),
    },
    {
      name: "mixamorig:Spine",
      parent: "mixamorig:Hips",
      head: new THREE.Vector3(cx, y(hipFrac + 0.06), spineZ),
      tail: new THREE.Vector3(cx, y(hipFrac + (neckFrac - hipFrac) * 0.4), spineZ),
    },
    {
      name: "mixamorig:Spine1",
      parent: "mixamorig:Spine",
      head: new THREE.Vector3(cx, y(hipFrac + (neckFrac - hipFrac) * 0.4), spineZ),
      tail: new THREE.Vector3(cx, y(hipFrac + (neckFrac - hipFrac) * 0.75), spineZ),
    },
    {
      name: "mixamorig:Spine2",
      parent: "mixamorig:Spine1",
      head: new THREE.Vector3(cx, y(hipFrac + (neckFrac - hipFrac) * 0.75), spineZ),
      tail: new THREE.Vector3(cx, y(neckFrac), headZ),
    },
    {
      name: "mixamorig:Neck",
      parent: "mixamorig:Spine2",
      head: new THREE.Vector3(cx, y(neckFrac), headZ),
      tail: new THREE.Vector3(cx, y(headFrac), headZ),
    },
    {
      name: "mixamorig:Head",
      parent: "mixamorig:Neck",
      head: new THREE.Vector3(cx, y(headFrac), headZ),
      tail: new THREE.Vector3(cx, y(headTopFrac), headZ),
    },

    // Left Leg (+X)
    {
      name: "mixamorig:LeftUpLeg",
      parent: "mixamorig:Hips",
      head: new THREE.Vector3(cx + hipX, y(hipFrac - 0.02), spineZ),
      tail: new THREE.Vector3(cx + kneeX, y(kneeFrac), kneeZ),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftLeg",
      parent: "mixamorig:LeftUpLeg",
      head: new THREE.Vector3(cx + kneeX, y(kneeFrac), kneeZ),
      tail: new THREE.Vector3(cx + footX, y(ankleFrac), cz),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftFoot",
      parent: "mixamorig:LeftLeg",
      head: new THREE.Vector3(cx + footX, y(ankleFrac), cz),
      tail: new THREE.Vector3(cx + footX + footMidD * splaySin, y(toeFrac), cz + footMidD * splayCos),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftToeBase",
      parent: "mixamorig:LeftFoot",
      head: new THREE.Vector3(cx + footX + footMidD * splaySin, y(toeFrac), cz + footMidD * splayCos),
      tail: new THREE.Vector3(cx + footX + footEndD * splaySin, y(toeEndFrac), cz + footEndD * splayCos),
      isLeft: true,
    },

    // Right Leg (-X)
    {
      name: "mixamorig:RightUpLeg",
      parent: "mixamorig:Hips",
      head: new THREE.Vector3(cx - hipX, y(hipFrac - 0.02), spineZ),
      tail: new THREE.Vector3(cx - kneeX, y(kneeFrac), kneeZ),
      isRight: true,
    },
    {
      name: "mixamorig:RightLeg",
      parent: "mixamorig:RightUpLeg",
      head: new THREE.Vector3(cx - kneeX, y(kneeFrac), kneeZ),
      tail: new THREE.Vector3(cx - footX, y(ankleFrac), cz),
      isRight: true,
    },
    {
      name: "mixamorig:RightFoot",
      parent: "mixamorig:RightLeg",
      head: new THREE.Vector3(cx - footX, y(ankleFrac), cz),
      tail: new THREE.Vector3(cx - footX - footMidD * splaySin, y(toeFrac), cz + footMidD * splayCos),
      isRight: true,
    },
    {
      name: "mixamorig:RightToeBase",
      parent: "mixamorig:RightFoot",
      head: new THREE.Vector3(cx - footX - footMidD * splaySin, y(toeFrac), cz + footMidD * splayCos),
      tail: new THREE.Vector3(cx - footX - footEndD * splaySin, y(toeEndFrac), cz + footEndD * splayCos),
      isRight: true,
    },
  ];

  // Arms: A-pose vs T-pose
  const shMul = params.shoulderWidth ?? 1.0;
  const armLenMul = params.armLength ?? 1.0;
  const shX = Math.max(0.06, size.x * 0.17 * shMul);

  const angleDeg = pose === "t_pose" ? 0 : (params.armAngleDeg ?? 45);
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const L_upper = Math.max(0.06, size.x * 0.16 * armLenMul);
  const L_lower = Math.max(0.06, size.x * 0.15 * armLenMul);
  const L_hand = Math.max(0.04, size.x * 0.08 * armLenMul);

  const shY = y(shoulderFrac);
  const elX = shX + cosA * L_upper;
  const elY = shY - sinA * L_upper;
  const wrX = elX + cosA * L_lower;
  const wrY = elY - sinA * L_lower;
  const hdX = wrX + cosA * L_hand;
  const hdY = wrY - sinA * L_hand;

  defs.push(
    // Left Arm (+X)
    {
      name: "mixamorig:LeftShoulder",
      parent: "mixamorig:Spine2",
      head: new THREE.Vector3(cx + shX * 0.25, y(neckFrac - 0.04), shoulderZ),
      tail: new THREE.Vector3(cx + shX, shY, shoulderZ),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftArm",
      parent: "mixamorig:LeftShoulder",
      head: new THREE.Vector3(cx + shX, shY, shoulderZ),
      tail: new THREE.Vector3(cx + elX, elY, shoulderZ),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftForeArm",
      parent: "mixamorig:LeftArm",
      head: new THREE.Vector3(cx + elX, elY, shoulderZ),
      tail: new THREE.Vector3(cx + wrX, wrY, shoulderZ),
      isLeft: true,
    },
    {
      name: "mixamorig:LeftHand",
      parent: "mixamorig:LeftForeArm",
      head: new THREE.Vector3(cx + wrX, wrY, shoulderZ),
      tail: new THREE.Vector3(cx + hdX, hdY, shoulderZ),
      isLeft: true,
    },
    // Right Arm (-X)
    {
      name: "mixamorig:RightShoulder",
      parent: "mixamorig:Spine2",
      head: new THREE.Vector3(cx - shX * 0.25, y(neckFrac - 0.04), shoulderZ),
      tail: new THREE.Vector3(cx - shX, shY, shoulderZ),
      isRight: true,
    },
    {
      name: "mixamorig:RightArm",
      parent: "mixamorig:RightShoulder",
      head: new THREE.Vector3(cx - shX, shY, shoulderZ),
      tail: new THREE.Vector3(cx - elX, elY, shoulderZ),
      isRight: true,
    },
    {
      name: "mixamorig:RightForeArm",
      parent: "mixamorig:RightArm",
      head: new THREE.Vector3(cx - elX, elY, shoulderZ),
      tail: new THREE.Vector3(cx - wrX, wrY, shoulderZ),
      isRight: true,
    },
    {
      name: "mixamorig:RightHand",
      parent: "mixamorig:RightForeArm",
      head: new THREE.Vector3(cx - wrX, wrY, shoulderZ),
      tail: new THREE.Vector3(cx - hdX, hdY, shoulderZ),
      isRight: true,
    },
  );

  if (params.includeFingers) {
    const fingerNames = ["Thumb", "Index", "Middle", "Ring", "Pinky"] as const;
    const fingerLenScale = {
      Thumb: 0.48,
      Index: 0.62,
      Middle: 0.70,
      Ring: 0.62,
      Pinky: 0.50,
    };
    const thumbSign = (params.thumbForward ?? true) ? 1 : -1;
    const spread = params.fingerSpread ?? 1.0;
    const lenMul = params.fingerLength ?? 1.0;

    // In standard bind pose, thumb points forward (+Z) and pinky points rear (-Z)
    const fingerZOffset = {
      Thumb: thumbSign * size.z * 0.035 * spread,
      Index: thumbSign * size.z * 0.014 * spread,
      Middle: 0,
      Ring: -thumbSign * size.z * 0.014 * spread,
      Pinky: -thumbSign * size.z * 0.035 * spread,
    };

    // Lateral fanning angle offset per finger
    const fingerFanAngles: Record<typeof fingerNames[number], number> = {
      Thumb: thumbSign * 0.22 * spread,
      Index: 0.10 * spread,
      Middle: 0,
      Ring: -0.10 * spread,
      Pinky: -0.22 * spread,
    };

    // Left fingers (+X)
    for (const f of fingerNames) {
      const totalLen = L_hand * fingerLenScale[f] * lenMul;
      const segLen = totalLen / 3;
      const fz = shoulderZ + fingerZOffset[f];
      const startFrac = f === "Thumb" ? 0.45 : 0.88;
      const baseX = wrX + (hdX - wrX) * startFrac;
      const baseY = wrY + (hdY - wrY) * startFrac;

      const fanAngle = fingerFanAngles[f];
      const curCosA = Math.cos(rad + fanAngle);
      const curSinA = Math.sin(rad + fanAngle);

      let p1 = new THREE.Vector3(cx + baseX, baseY, fz);
      let parent = "mixamorig:LeftHand";
      for (let s = 1; s <= 3; s++) {
        const p2 = new THREE.Vector3(
          p1.x + curCosA * segLen,
          p1.y - curSinA * segLen,
          fz,
        );
        const bName = `mixamorig:LeftHand${f}${s}`;
        defs.push({
          name: bName,
          parent,
          head: p1.clone(),
          tail: p2.clone(),
          isLeft: true,
        });
        parent = bName;
        p1 = p2;
      }
    }

    // Right fingers (-X)
    for (const f of fingerNames) {
      const totalLen = L_hand * fingerLenScale[f] * lenMul;
      const segLen = totalLen / 3;
      const fz = shoulderZ + fingerZOffset[f];
      const startFrac = f === "Thumb" ? 0.45 : 0.88;
      const baseX = wrX + (hdX - wrX) * startFrac;
      const baseY = wrY + (hdY - wrY) * startFrac;

      const fanAngle = fingerFanAngles[f];
      const curCosA = Math.cos(rad + fanAngle);
      const curSinA = Math.sin(rad + fanAngle);

      let p1 = new THREE.Vector3(cx - baseX, baseY, fz);
      let parent = "mixamorig:RightHand";
      for (let s = 1; s <= 3; s++) {
        const p2 = new THREE.Vector3(
          p1.x - curCosA * segLen,
          p1.y - curSinA * segLen,
          fz,
        );
        const bName = `mixamorig:RightHand${f}${s}`;
        defs.push({
          name: bName,
          parent,
          head: p1.clone(),
          tail: p2.clone(),
          isRight: true,
        });
        parent = bName;
        p1 = p2;
      }
    }
  }

  return defs;
}

export interface SkeletonContainment {
  insideCount: number;
  outsideCount: number;
  allInside: boolean;
  jointStatus: Map<string, boolean>;
}

/**
 * Validates whether each bone joint head coordinate is bounded inside the model's mesh geometry.
 * Uses bidirectional Z and lateral X raycast interval testing against the mesh surfaces.
 */
export function checkSkeletonContainment(root: THREE.Object3D | null | undefined, defs: BoneDef[]): SkeletonContainment {
  const jointStatus = new Map<string, boolean>();
  if (!root) {
    for (const d of defs) jointStatus.set(d.name, true);
    return { insideCount: defs.length, outsideCount: 0, allInside: true, jointStatus };
  }

  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry) {
      meshes.push(o as THREE.Mesh);
    }
  });

  if (meshes.length === 0) {
    for (const d of defs) jointStatus.set(d.name, true);
    return { insideCount: defs.length, outsideCount: 0, allInside: true, jointStatus };
  }

  // A question about the model as it stands, so nothing here turns or rescales it. The bounds
  // see through skinning, and so does the raycast: a skinned mesh resolves its triangles through
  // its bones, as long as its own bounding volumes are fresh, since the raycaster culls on those
  // first. Testing the raw geometry instead put every joint outside a doll-sized hull.
  const box = computeMeshBounds(root);
  const raycaster = new THREE.Raycaster();
  const dirZ = new THREE.Vector3(0, 0, 1);
  const dirX = new THREE.Vector3(1, 0, 0);

  let insideCount = 0;
  let outsideCount = 0;

  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) {
      sm.skeleton.update();
      sm.computeBoundingBox();
      sm.computeBoundingSphere();
    }
  });

  const prevSides = new Map<THREE.Material, THREE.Side>();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material) {
      const meshMat = (o as THREE.Mesh).material;
      const mats = Array.isArray(meshMat) ? meshMat : [meshMat];
      for (const m of mats) {
        if (!prevSides.has(m)) {
          prevSides.set(m, m.side);
          m.side = THREE.DoubleSide;
        }
      }
    }
  });

  try {
    for (const d of defs) {
      // Finger phalanges are tiny and shouldn't block the main containment badge
      const isFinger = /thumb|index|middle|ring|pinky/i.test(d.name);
      if (isFinger) {
        jointStatus.set(d.name, true);
        insideCount++;
        continue;
      }

      const p = d.head;

      // Tolerance margin outside bounding box
      const margin = Math.max(0.01, (box.max.y - box.min.y) * 0.02);
      if (
        p.x < box.min.x - margin ||
        p.x > box.max.x + margin ||
        p.y < box.min.y - margin ||
        p.y > box.max.y + margin ||
        p.z < box.min.z - margin ||
        p.z > box.max.z + margin
      ) {
        jointStatus.set(d.name, false);
        outsideCount++;
        continue;
      }

      // Cast ray through (p.x, p.y) along Z from front to back
      const originZ = new THREE.Vector3(p.x, p.y, box.min.z - 0.2);
      raycaster.set(originZ, dirZ);
      raycaster.near = 0;
      raycaster.far = (box.max.z - box.min.z) + 0.5;

      const hitsZ = raycaster.intersectObjects(meshes, true);
      let isInside = false;

      if (hitsZ.length > 0) {
        const zCoords = hitsZ.map((h) => h.point.z).sort((a, b) => a - b);
        const minZ = zCoords[0];
        const maxZ = zCoords[zCoords.length - 1];

        // Point must be within front-most and rear-most surface
        if (p.z >= minZ - 0.02 && p.z <= maxZ + 0.02) {
          // Even-odd intervals
          for (let i = 0; i < zCoords.length; i += 2) {
            const entry = zCoords[i];
            const exit = i + 1 < zCoords.length ? zCoords[i + 1] : maxZ;
            if (p.z >= entry - 0.015 && p.z <= exit + 0.015) {
              isInside = true;
              break;
            }
          }
          // Fallback for single or odd hits on non-watertight models: within span
          if (!isInside && p.z >= minZ && p.z <= maxZ) {
            isInside = true;
          }
        }
      } else {
        // Try X axis raycast if line along Z missed thin limbs
        const originX = new THREE.Vector3(box.min.x - 0.2, p.y, p.z);
        raycaster.set(originX, dirX);
        raycaster.near = 0;
        raycaster.far = (box.max.x - box.min.x) + 0.5;
        const hitsX = raycaster.intersectObjects(meshes, true);

        if (hitsX.length > 0) {
          const xCoords = hitsX.map((h) => h.point.x).sort((a, b) => a - b);
          const minX = xCoords[0];
          const maxX = xCoords[xCoords.length - 1];
          if (p.x >= minX - 0.02 && p.x <= maxX + 0.02) {
            isInside = true;
          }
        }
      }

      jointStatus.set(d.name, isInside);
      if (isInside) insideCount++;
      else outsideCount++;
    }
  } finally {
    for (const [m, side] of prevSides) {
      m.side = side;
    }
  }

  return {
    insideCount,
    outsideCount,
    allInside: outsideCount === 0,
    jointStatus,
  };
}

/**
 * Infer humanoid RigParams by analyzing the real bone positions of an already-rigged model.
 * Allows Skeleton Studio to resume editing an existing model without resetting to generic defaults.
 */
export function inferRigParamsFromSkeleton(root: THREE.Object3D): RigParams | null {
  const bones = findHumanoidBones(root);
  const hips = bones.get("hips");
  const head = bones.get("head");
  if (!hips || !head) return null;

  root.updateMatrixWorld(true);
  const { box, size, center } = orientAndGetBounds(root);
  const H = size.y;
  const minY = box.min.y;
  const cz = center.z;
  const depthScale = Math.max(0.05, size.z * 0.25);

  const wp = (b: THREE.Object3D) => {
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v;
  };

  const headPos = wp(head);
  const neck = bones.get("neck");
  const neckPos = neck ? wp(neck) : headPos.clone().setY(headPos.y - H * 0.05);

  const headFrac = (headPos.y - minY) / H;
  const neckFrac = (neckPos.y - minY) / H;
  const headHeight = Math.max(0.7, Math.min(1.3, headFrac / 0.84));
  const neckHeight = Math.max(0.7, Math.min(1.3, neckFrac / 0.79));
  const headDepth = Math.max(-1.0, Math.min(1.0, (headPos.z - cz) / depthScale));

  // Shoulders & Arms
  const lShoulder = bones.get("leftShoulder") ?? bones.get("rightShoulder");
  const lUpperArm = bones.get("leftUpperArm") ?? bones.get("rightUpperArm");
  const lLowerArm = bones.get("leftLowerArm") ?? bones.get("rightLowerArm");
  const lHand = bones.get("leftHand") ?? bones.get("rightHand");

  let shoulderHeight = 1.0;
  let shoulderWidth = 1.0;
  let shoulderDepth = 0;
  if (lShoulder) {
    const sPos = wp(lShoulder);
    const sFrac = (sPos.y - minY) / H;
    shoulderHeight = Math.max(0.7, Math.min(1.3, sFrac / 0.74));
    shoulderDepth = Math.max(-1.0, Math.min(1.0, (sPos.z - cz) / depthScale));
  }
  if (lUpperArm) {
    const uPos = wp(lUpperArm);
    const baseShX = Math.max(0.06, size.x * 0.17);
    shoulderWidth = Math.max(0.7, Math.min(1.4, Math.abs(uPos.x - center.x) / baseShX));
  }

  let pose: PoseChoice = "a_pose";
  let armAngleDeg = 45;
  let armLength = 1.0;
  if (lUpperArm && lLowerArm) {
    const uPos = wp(lUpperArm);
    const fPos = wp(lLowerArm);
    const armDir = fPos.clone().sub(uPos);
    const angleRad = Math.atan2(-armDir.y, Math.abs(armDir.x));
    const deg = Math.round((angleRad * 180) / Math.PI);
    if (deg <= 10) {
      pose = "t_pose";
      armAngleDeg = 0;
    } else {
      pose = "a_pose";
      armAngleDeg = Math.max(15, Math.min(75, deg));
    }

    const totLen = uPos.distanceTo(fPos) + (lHand ? fPos.distanceTo(wp(lHand)) : 0);
    const baseLen = Math.max(0.06, size.x * 0.16) + Math.max(0.06, size.x * 0.15) + (lHand ? Math.max(0.04, size.x * 0.08) : 0);
    armLength = Math.max(0.7, Math.min(1.3, totLen / (baseLen || 1)));
  }

  const hasFingers = Array.from(bones.keys()).some((k) => /thumb|index|middle|ring|little|pinky/i.test(k));

  // Hips & Spine
  const hipsPos = wp(hips);
  const hipFrac = (hipsPos.y - minY) / H;
  const hipHeight = Math.max(0.8, Math.min(1.2, hipFrac / 0.51));
  const spineDepth = Math.max(-1.0, Math.min(1.0, (hipsPos.z - cz) / depthScale));

  // Legs & Feet
  const lUpLeg = bones.get("leftUpperLeg") ?? bones.get("rightUpperLeg");
  const lLeg = bones.get("leftLowerLeg") ?? bones.get("rightLowerLeg");
  const lFoot = bones.get("leftFoot") ?? bones.get("rightFoot");
  const lToe = bones.get("leftToes") ?? bones.get("rightToes");
  const baseLegX = Math.max(0.04, size.x * 0.11);

  let legWidth = 1.0;
  if (lUpLeg) {
    legWidth = Math.max(0.6, Math.min(1.6, Math.abs(wp(lUpLeg).x - center.x) / baseLegX));
  }

  let kneeHeight = 1.0;
  let kneeWidth = 1.0;
  let kneeDepth = 0;
  if (lLeg) {
    const kPos = wp(lLeg);
    const kFrac = (kPos.y - minY) / H;
    kneeHeight = Math.max(0.7, Math.min(1.3, kFrac / 0.27));
    kneeWidth = Math.max(0.6, Math.min(1.6, Math.abs(kPos.x - center.x) / baseLegX));
    kneeDepth = Math.max(-1.0, Math.min(1.0, (kPos.z - cz) / depthScale));
  }

  let footWidth = 1.0;
  let footForward = 1.0;
  let footAngleDeg = 0;
  let ankleHeight = 1.0;
  if (lFoot) {
    const fPos = wp(lFoot);
    const fFrac = (fPos.y - minY) / H;
    ankleHeight = Math.max(0.2, Math.min(1.8, fFrac / 0.07));
    footWidth = Math.max(0.6, Math.min(1.6, Math.abs(fPos.x - center.x) / baseLegX));

    if (lToe) {
      const tPos = wp(lToe);
      const fwdDist = Math.max(0.01, tPos.z - fPos.z);
      const baseFootFwd = Math.max(0.04, size.z * 0.16 * 0.6);
      footForward = Math.max(0.5, Math.min(1.8, fwdDist / (baseFootFwd || 1)));

      const toeDir = tPos.clone().sub(fPos);
      const angle = Math.round((Math.atan2(toeDir.x, Math.max(0.001, toeDir.z)) * 180) / Math.PI);
      footAngleDeg = Math.max(-30, Math.min(45, angle));
    }
  }

  return {
    pose,
    armAngleDeg,
    shoulderWidth: Math.round(shoulderWidth * 100) / 100,
    armLength: Math.round(armLength * 100) / 100,
    hipHeight: Math.round(hipHeight * 100) / 100,
    legWidth: Math.round(legWidth * 100) / 100,
    kneeWidth: Math.round(kneeWidth * 100) / 100,
    kneeHeight: Math.round(kneeHeight * 100) / 100,
    ankleHeight: Math.round(ankleHeight * 100) / 100,
    footWidth: Math.round(footWidth * 100) / 100,
    footForward: Math.round(footForward * 100) / 100,
    footAngleDeg,
    shoulderHeight: Math.round(shoulderHeight * 100) / 100,
    neckHeight: Math.round(neckHeight * 100) / 100,
    headHeight: Math.round(headHeight * 100) / 100,
    headDepth: Math.round(headDepth * 100) / 100,
    spineDepth: Math.round(spineDepth * 100) / 100,
    shoulderDepth: Math.round(shoulderDepth * 100) / 100,
    kneeDepth: Math.round(kneeDepth * 100) / 100,
    includeFingers: hasFingers,
  };
}

/**
 * Creates the Three.js Bone hierarchy and Skeleton from bone definitions.
 */
/**
 * Which new bone each of an old skeleton's bones hands its vertices to, by humanoid role: the old
 * LeftHand, however it was spelt, feeds the new mixamorig:LeftHand. A bone with no role of its own
 * -- a twist bone, a finger when fingers are off, a prop -- follows its nearest ancestor that has
 * one, and anything above the hips follows the hips. Null when the old skeleton is not a humanoid
 * we can read, in which case the vertices are weighted from scratch.
 */
export function boneTransferMap(skeleton: THREE.Skeleton, defs: BoneDef[]): Int32Array | null {
  const targetByRole = new Map<BoneName, number>();
  defs.forEach((d, i) => {
    const role = humanoidMatch(d.name)?.bone;
    if (role !== undefined && !targetByRole.has(role)) targetByRole.set(role, i);
  });
  const roleOf = new Map<THREE.Object3D, BoneName>();
  for (const b of skeleton.bones) {
    const role = humanoidMatch(b.name)?.bone;
    if (role !== undefined) roleOf.set(b, role);
  }
  const found = new Set(roleOf.values());
  if (REQUIRED_BONES.some((r) => !found.has(r))) return null;
  const hips = targetByRole.get("hips") ?? 0;
  const map = new Int32Array(skeleton.bones.length);
  skeleton.bones.forEach((b, j) => {
    let idx: number | undefined;
    for (let o: THREE.Object3D | null = b; o && idx === undefined; o = o.parent) {
      const role = roleOf.get(o);
      if (role !== undefined) idx = targetByRole.get(role);
    }
    map[j] = idx ?? hips;
  });
  return map;
}

/**
 * Carry a mesh's skin weights over to a new skeleton through a bone map. Old bones that land on the
 * same new bone pool their weight; the four heaviest survive, renormalised. A vertex nothing was
 * weighted to goes wholly to bone 0, the hips, as a freshly weighted one would.
 */
export function transferSkinWeights(source: THREE.BufferGeometry, map: Int32Array, outIndex: Uint16Array, outWeight: Float32Array): void {
  const si = source.getAttribute("skinIndex");
  const sw = source.getAttribute("skinWeight");
  const idx = [0, 0, 0, 0];
  const wt = [0, 0, 0, 0];
  for (let i = 0; i < si.count; i++) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      const j = si.getComponent(i, k);
      if (w <= 0 || j < 0 || j >= map.length) continue;
      const t = map[j];
      let slot = -1;
      for (let m = 0; m < n; m++) if (idx[m] === t) { slot = m; break; }
      if (slot >= 0) {
        wt[slot] += w;
      } else {
        idx[n] = t;
        wt[n] = w;
        n++;
      }
    }
    // Heaviest first, then share out what is there.
    for (let a = 1; a < n; a++) {
      for (let b = a; b > 0 && wt[b] > wt[b - 1]; b--) {
        [wt[b], wt[b - 1]] = [wt[b - 1], wt[b]];
        [idx[b], idx[b - 1]] = [idx[b - 1], idx[b]];
      }
    }
    let total = 0;
    for (let m = 0; m < n; m++) total += wt[m];
    for (let k = 0; k < 4; k++) {
      if (k < n && total > 0) {
        outIndex[i * 4 + k] = idx[k];
        outWeight[i * 4 + k] = wt[k] / total;
      } else {
        outIndex[i * 4 + k] = 0;
        outWeight[i * 4 + k] = k === 0 && total <= 0 ? 1 : 0;
      }
    }
  }
}

export function createSkeleton(defs: BoneDef[]): {
  rootBone: THREE.Bone;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  boneMap: Map<string, THREE.Bone>;
} {
  const boneMap = new Map<string, THREE.Bone>();
  const bones: THREE.Bone[] = [];

  for (const d of defs) {
    const b = new THREE.Bone();
    b.name = d.name;
    boneMap.set(d.name, b);
    bones.push(b);
  }

  let rootBone: THREE.Bone | null = null;

  for (const d of defs) {
    const b = boneMap.get(d.name)!;
    if (d.parent) {
      const p = boneMap.get(d.parent);
      if (p) {
        p.add(b);
        const parentDef = defs.find((x) => x.name === d.parent)!;
        b.position.copy(d.head).sub(parentDef.head);
      }
    } else {
      rootBone = b;
      b.position.copy(d.head);
    }
  }

  if (!rootBone) {
    throw new Error("No root bone found in bone definitions");
  }

  const skeleton = new THREE.Skeleton(bones);
  return { rootBone, bones, skeleton, boneMap };
}

/**
 * Create an in-memory rigged character Group with skeleton and bound SkinnedMeshes.
 */
export function createRiggedGroup(root: THREE.Object3D, paramsOrPose: PoseChoice | RigParams = "a_pose"): {
  group: THREE.Group;
  skeleton: THREE.Skeleton;
  rootBone: THREE.Bone;
  defs: BoneDef[];
} {
  const { box, size, center } = orientAndGetBounds(root);
  const defs = buildHumanoidBoneDefs(box, size, center, paramsOrPose);
  const { rootBone, skeleton } = createSkeleton(defs);

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry) {
      meshes.push(o as THREE.Mesh);
    }
  });

  if (meshes.length === 0) {
    throw new Error("No mesh geometry found in model to auto-rig");
  }

  const params: RigParams = typeof paramsOrPose === "string" ? { pose: paramsOrPose } : (paramsOrPose ?? {});
  const H = size.y;
  const W = size.x;
  const minY = box.min.y;
  const y = (frac: number) => minY + H * frac;
  const neckFrac = 0.79 * (params.neckHeight ?? 1.0);
  const shMul = params.shoulderWidth ?? 1.0;
  const armLenMul = params.armLength ?? 1.0;
  const hipMul = params.legWidth ?? 1.0;
  const legMul = params.kneeWidth ?? hipMul;
  const footMul = params.footWidth ?? legMul;
  const hipFrac = 0.51 * (params.hipHeight ?? 1.0);
  const kneeFrac = 0.27 * (params.kneeHeight ?? 1.0);
  const shFrac = 0.74 * (params.shoulderHeight ?? 1.0);
  const headW = Math.max(0.04, size.x * 0.12);
  const headBoneIdx = defs.findIndex((d) => d.name === "mixamorig:Head");
  const neckBoneIdx = defs.findIndex((d) => d.name === "mixamorig:Neck");
  const shX = Math.max(0.06, size.x * 0.17 * shMul);
  const L_upper = Math.max(0.06, size.x * 0.16 * armLenMul);
  const sideMargin = size.x * 0.04;

  const exportScene = new THREE.Group();
  exportScene.name = "AutoRiggedCharacter";
  exportScene.add(rootBone);

  // Update bone hierarchy world matrices and precompute inverse bind matrices
  exportScene.updateMatrixWorld(true);
  rootBone.updateMatrixWorld(true);
  skeleton.calculateInverses();

  const worldVertex = new THREE.Vector3();

  // Define capsule radius per bone
  const boneRadii = defs.map((d) => {
    if (d.name.includes("Thumb") || d.name.includes("Index") || d.name.includes("Middle") || d.name.includes("Ring") || d.name.includes("Pinky")) {
      return Math.max(0.015, Math.min(W * 0.06, H * 0.035));
    }
    if (d.name.includes("Hand")) {
      return Math.max(0.04, Math.min(W * 0.16, H * 0.10));
    }
    if (d.name.includes("Arm") || d.name.includes("Shoulder")) {
      return Math.max(0.08, Math.min(W * 0.28, H * 0.18));
    }
    if (d.name.includes("Foot") || d.name.includes("Toe")) {
      return Math.max(0.04, Math.min(W * 0.18 * footMul, H * 0.12));
    }
    if (d.name.includes("Leg")) {
      return Math.max(0.08, Math.min(W * 0.28, H * 0.20));
    }
    if (d.name.includes("Head") || d.name.includes("Neck")) {
      return Math.max(0.08, Math.min(W * 0.35, H * 0.22));
    }
    if (d.name === "mixamorig:Hips") {
      return Math.max(0.08, Math.min(W * 0.35 * hipMul, H * 0.24));
    }
    // Spine, Spine1, Spine2
    return Math.max(0.08, Math.min(W * 0.35, H * 0.20));
  });

  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const geom = mesh.geometry.clone();

    // Identify if this mesh belongs to head, face, or hair
    const isHeadMesh =
      /head|hair|face|dread|mandible|jaw|beard|helmet|cap|predatorhead/i.test(mesh.name) ||
      (Array.isArray(mesh.material)
        ? mesh.material.some((m) => /head|hair|face|dread|mandible|jaw|beard|helmet|cap|predatorhead/i.test(m.name))
        : /head|hair|face|dread|mandible|jaw|beard|helmet|cap|predatorhead/i.test(mesh.material?.name || ""));

    // Bake the mesh into world space. A skinned mesh only reaches its real shape through its
    // bones -- the raw geometry can be a doll the armature scales up -- so pose every vertex
    // through the old skeleton first, then apply the object transform. Its old skin attributes
    // and normals go: the weights are computed afresh below and the normals recomputed.
    const skinnedSrc = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    if (skinnedSrc) {
      skinnedSrc.skeleton.update();
      const src = geom.getAttribute("position") as THREE.BufferAttribute;
      const p = new THREE.Vector3();
      for (let i = 0; i < src.count; i++) {
        p.fromBufferAttribute(src, i);
        skinnedSrc.applyBoneTransform(i, p);
        src.setXYZ(i, p.x, p.y, p.z);
      }
      src.needsUpdate = true;
      geom.deleteAttribute("skinIndex");
      geom.deleteAttribute("skinWeight");
      geom.deleteAttribute("normal");
    }
    geom.applyMatrix4(mesh.matrixWorld);
    if (!geom.getAttribute("normal")) {
      geom.computeVertexNormals();
    }

    const posAttr = geom.getAttribute("position");
    if (!posAttr) continue;

    const count = posAttr.count;
    const skinIndices = new Uint16Array(count * 4);
    const skinWeights = new Float32Array(count * 4);

    // Check if this entire mesh piece is a detached rigid prop/armor (e.g. helmet, cannon, blade)
    geom.computeBoundingBox();
    const meshBox = geom.boundingBox!;
    const meshSize = new THREE.Vector3();
    meshBox.getSize(meshSize);
    const meshCenterWorld = new THREE.Vector3();
    meshBox.getCenter(meshCenterWorld);

    // If an individual mesh object is small/isolated or named like a prop, bind rigidly to its nearest single bone
    const isRigidAttachment =
      count < 2500 && (meshSize.y < H * 0.28 || /helmet|blade|gun|armor|pad|skull|lamp|prop|caster|cannon/i.test(mesh.name));

    let dominantBoneIdx = -1;
    if (isRigidAttachment) {
      let bestDist = Infinity;
      for (let k = 0; k < defs.length; k++) {
        const d = distToSegmentSq(meshCenterWorld, defs[k].head, defs[k].tail);
        if (d < bestDist) {
          bestDist = d;
          dominantBoneIdx = k;
        }
      }
    }

    // A mesh that already had a humanoid skeleton keeps the weights its artist gave it, moved bone
    // for bone onto the new one: fingers, claws and knees deform as they always did, and only the
    // joints move. Weights are only worked out from distance when there is nothing to carry over.
    const transfer = skinnedSrc ? boneTransferMap(skinnedSrc.skeleton, defs) : null;
    if (transfer) {
      transferSkinWeights(mesh.geometry, transfer, skinIndices, skinWeights);
    } else for (let i = 0; i < count; i++) {
      if (isRigidAttachment && dominantBoneIdx >= 0) {
        skinIndices[i * 4] = dominantBoneIdx;
        skinWeights[i * 4] = 1.0;
        skinIndices[i * 4 + 1] = 0;
        skinWeights[i * 4 + 1] = 0;
        skinIndices[i * 4 + 2] = 0;
        skinWeights[i * 4 + 2] = 0;
        skinIndices[i * 4 + 3] = 0;
        skinWeights[i * 4 + 3] = 0;
        continue;
      }

      worldVertex.fromBufferAttribute(posAttr, i);

      // Fast check: Is this vertex part of the head/hair region?
      const isHeadVertex =
        isHeadMesh ||
        worldVertex.y > y(neckFrac) ||
        (worldVertex.y > y(shFrac - 0.05) &&
          Math.abs(worldVertex.x - center.x) < headW * 1.5 &&
          worldVertex.z < center.z - size.z * 0.05);

      // Strict Head Lock: For dedicated head/hair meshes (like Predator dreadlocks),
      // vertices above shoulder height should strictly bind to Head and Neck ONLY.
      if (isHeadMesh && worldVertex.y > y(shFrac - 0.08)) {
        let bestHeadBone = headBoneIdx;
        let bestHeadDistSq = Infinity;
        for (const idx of [neckBoneIdx, headBoneIdx]) {
          if (idx >= 0) {
            const d = defs[idx];
            const dSq = distToSegmentSq(worldVertex, d.head, d.tail);
            if (dSq < bestHeadDistSq) {
              bestHeadDistSq = dSq;
              bestHeadBone = idx;
            }
          }
        }
        if (worldVertex.y > y(neckFrac)) {
          skinIndices[i * 4] = headBoneIdx >= 0 ? headBoneIdx : bestHeadBone;
          skinWeights[i * 4] = 1.0;
          skinIndices[i * 4 + 1] = 0;
          skinWeights[i * 4 + 1] = 0;
          skinIndices[i * 4 + 2] = 0;
          skinWeights[i * 4 + 2] = 0;
          skinIndices[i * 4 + 3] = 0;
          skinWeights[i * 4 + 3] = 0;
          continue;
        } else {
          skinIndices[i * 4] = bestHeadBone;
          skinWeights[i * 4] = 1.0;
          skinIndices[i * 4 + 1] = 0;
          skinWeights[i * 4 + 1] = 0;
          skinIndices[i * 4 + 2] = 0;
          skinWeights[i * 4 + 2] = 0;
          skinIndices[i * 4 + 3] = 0;
          skinWeights[i * 4 + 3] = 0;
          continue;
        }
      }

      const candidates: Array<{ index: number; weight: number }> = [];
      let closestBone = -1;
      let minDistanceSq = Infinity;

      for (let k = 0; k < defs.length; k++) {
        const d = defs[k];
        const isArm = d.name.includes("Arm") || d.name.includes("ForeArm") || d.name.includes("Hand");
        const isHand = d.name === "mixamorig:LeftHand" || d.name === "mixamorig:RightHand";
        const isFinger = d.name.includes("Thumb") || d.name.includes("Index") || d.name.includes("Middle") || d.name.includes("Ring") || d.name.includes("Pinky");
        const isHeadBone = d.name === "mixamorig:Head" || d.name === "mixamorig:Neck";
        const isLeg = d.name.includes("Leg") || d.name.includes("Foot") || d.name.includes("Toe");
        const isSpine = d.name.includes("Spine");

        // Hard isolation: left limb bones never touch right side, and vice versa
        // Legs are strictly bilateral across the center line
        if (isLeg) {
          if (d.isLeft && worldVertex.x < center.x) continue;
          if (d.isRight && worldVertex.x > center.x) continue;
        } else {
          if (d.isLeft && worldVertex.x < center.x - sideMargin) continue;
          if (d.isRight && worldVertex.x > center.x + sideMargin) continue;
        }

        // Spine, Neck, Head, and Arm bones NEVER influence leg vertices below the hips
        if ((isSpine || isHeadBone || isArm) && worldVertex.y < y(hipFrac - 0.02)) {
          continue;
        }

        // Foot and Toe bones never reach above the knee
        const isFootOrToe = d.name.includes("Foot") || d.name.includes("Toe");
        if (isFootOrToe && worldVertex.y > y(kneeFrac)) {
          continue;
        }

        // Hand isolation: Hand bone should NOT influence forearm / wrist gauntlet vertices
        // that lie between the elbow and wrist.
        if (isHand) {
          if (d.isLeft && worldVertex.x < d.head.x - 0.02) continue;
          if (d.isRight && worldVertex.x > d.head.x + 0.02) continue;
        }

        // Head & Hair Isolation: Torso, shoulder, and arm bones NEVER touch head or hair geometry
        if (isHeadVertex && !isHeadBone) {
          continue;
        }

        // Non-head vertices should not bind to head bone
        if (!isHeadVertex && d.name === "mixamorig:Head" && worldVertex.y < y(neckFrac)) {
          continue;
        }

        // Torso isolation: arm bones should not bind to vertices near the torso center
        if (isArm && Math.abs(worldVertex.x - center.x) < W * 0.14 && worldVertex.y < d.head.y) {
          continue;
        }

        // Finger isolation: finger bones only bind near hands
        if (isFinger && Math.abs(worldVertex.x - center.x) < shX + L_upper * 0.35) {
          continue;
        }

        const dSq = distToSegmentSq(worldVertex, d.head, d.tail);
        if (dSq < minDistanceSq) {
          minDistanceSq = dSq;
          closestBone = k;
        }

        const R = boneRadii[k];
        const RSq = R * R;
        if (dSq < RSq) {
          const ratio = dSq / RSq;
          const w = (1 - ratio) * (1 - ratio) * (1 - ratio);
          candidates.push({ index: k, weight: w });
        }
      }

      if (candidates.length === 0) {
        skinIndices[i * 4] = closestBone >= 0 ? closestBone : 0;
        skinWeights[i * 4] = 1.0;
        skinIndices[i * 4 + 1] = 0;
        skinWeights[i * 4 + 1] = 0;
        skinIndices[i * 4 + 2] = 0;
        skinWeights[i * 4 + 2] = 0;
        skinIndices[i * 4 + 3] = 0;
        skinWeights[i * 4 + 3] = 0;
      } else {
        candidates.sort((a, b) => b.weight - a.weight);
        let total = 0;
        const topCount = Math.min(4, candidates.length);
        for (let j = 0; j < topCount; j++) total += candidates[j].weight;
        const inv = 1 / total;
        for (let j = 0; j < 4; j++) {
          if (j < topCount) {
            skinIndices[i * 4 + j] = candidates[j].index;
            skinWeights[i * 4 + j] = candidates[j].weight * inv;
          } else {
            skinIndices[i * 4 + j] = 0;
            skinWeights[i * 4 + j] = 0;
          }
        }
      }
    }

    geom.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

    // Ensure material is cleanly isolated and exported without unwanted translucency or depthWrite:false
    let exportMat: THREE.Material | THREE.Material[];
    if (Array.isArray(mesh.material)) {
      exportMat = mesh.material.map((m) => m.clone());
    } else if (mesh.material) {
      exportMat = mesh.material.clone();
    } else {
      exportMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    }
    const mats = Array.isArray(exportMat) ? exportMat : [exportMat];
    for (const m of mats) {
      if (m.opacity >= 0.99 && !(m as any).alphaMap) {
        m.transparent = false;
        m.depthWrite = true;
      }
    }

    const skinned = new THREE.SkinnedMesh(geom, exportMat);
    skinned.name = mesh.name || "SkinnedObject";
    skinned.position.set(0, 0, 0);
    skinned.quaternion.identity();
    skinned.scale.set(1, 1, 1);

    exportScene.add(skinned);
    skinned.updateMatrixWorld(true);
    skinned.bind(skeleton);
  }

  return { group: exportScene, skeleton, rootBone, defs };
}

/**
 * Auto-rig an unrigged scene graph into a Mixamo-compatible SkinnedMesh and export as GLB bytes.
 */
export async function autoRig(root: THREE.Object3D, paramsOrPose: PoseChoice | RigParams = "a_pose"): Promise<ArrayBuffer> {
  const { group } = createRiggedGroup(root, paramsOrPose);
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(group, { binary: true });
  if (glb instanceof ArrayBuffer) return glb;
  if (glb instanceof Uint8Array) return glb.buffer as ArrayBuffer;
  return new TextEncoder().encode(JSON.stringify(glb)).buffer as ArrayBuffer;
}
