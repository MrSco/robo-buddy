import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import type { Manifest, PackRef } from "./packs";

export type BoneName = VRMHumanBoneName;
export type { Manifest } from "./packs";

export interface PlayOptions {
  loop: boolean;
  fade?: number;
  /** Stretch the clip so one loop spans this many beats at the given bpm. */
  beatsPerLoop?: number;
  bpm?: number;
  playbackRate?: number;
}

/** One character on stage, regardless of whether it came from a VRM or a plain GLB. */
export interface Character {
  manifest: Manifest;
  root: THREE.Object3D;
  vrm?: VRM;
  /** Humanoid bones keyed by VRM names; works for VRM and Mixamo rigs alike. */
  bone(name: BoneName): THREE.Object3D | undefined;
  /**
   * Per-frame base rotations that procedural layers reset to before adding their own.
   * Equals the T-pose rest when no clip is playing, otherwise the clip's output for this frame.
   */
  rest: Map<THREE.Object3D, THREE.Quaternion>;
  /** Bones written by the currently playing clip; procedural idle leaves these alone. */
  animatedBones: Set<THREE.Object3D>;
  height: number;
  /** Advance the animation mixer and refresh `rest`. Call once per frame before posing. */
  beginFrame(dt: number): void;
  hasClip(name: string): boolean;
  clipDuration(name: string): number;
  play(name: string, opts: PlayOptions): void;
  stop(fade?: number): void;
  /** Elapsed seconds of the current action, for one-shot completion checks. */
  clipTime(): number;
  update(dt: number): void;
  dispose(): void;
}

// Mixamo bone name -> VRM humanoid name. Mirrors scripts/glb_to_vrm.py.
const MIXAMO_TO_VRM: Record<string, BoneName> = {
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

function stripMixamo(name: string): string {
  return name.replace(/^mixamorig:?/, "");
}

function makeLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return loader;
}

/**
 * Rewrite a clip's track targets so they address this character's bones.
 * Source nodes may be Mixamo-named (with or without the prefix) or VRM-named.
 */
function retargetClip(clip: THREE.AnimationClip, bones: Map<BoneName, THREE.Object3D>): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const nodeName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const vrmName = (MIXAMO_TO_VRM[stripMixamo(nodeName)] ?? nodeName) as BoneName;
    const target = bones.get(vrmName);
    if (!target) continue;
    // Only rotations retarget safely across rigs. Root translation would fight the window physics.
    if (prop !== "quaternion") continue;
    const t = track.clone();
    t.name = `${target.uuid}.${prop}`;
    tracks.push(t);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export async function loadCharacter(pack: PackRef, manifest: Manifest): Promise<Character> {
  const loader = makeLoader();
  const gltf: GLTF = await loader.loadAsync(pack.base + manifest.model);

  const vrm = gltf.userData.vrm as VRM | undefined;
  const root = vrm ? vrm.scene : gltf.scene;

  if (vrm) {
    VRMUtils.removeUnnecessaryVertices(root);
    VRMUtils.combineSkeletons(root);
    VRMUtils.rotateVRM0(vrm);
    vrm.humanoid.autoUpdateHumanBones = false;
  }

  const bones = new Map<BoneName, THREE.Object3D>();
  if (vrm) {
    for (const name of Object.keys(vrm.humanoid.humanBones) as BoneName[]) {
      const node = vrm.humanoid.getRawBoneNode(name);
      if (node) bones.set(name, node);
    }
  } else {
    root.traverse((o) => {
      const vrmName = MIXAMO_TO_VRM[stripMixamo(o.name)];
      if (vrmName && !bones.has(vrmName)) bones.set(vrmName, o);
    });
  }

  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
  });

  // Give every bone a stable uuid-based name lookup for retargeted tracks.
  const byUuid = new Map<string, THREE.Object3D>();
  for (const b of bones.values()) byUuid.set(b.uuid, b);

  const restPose = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const b of bones.values()) restPose.set(b, b.quaternion.clone());
  const rest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const [b, q] of restPose) rest.set(b, q.clone());

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const height = box.getSize(new THREE.Vector3()).y;

  // Clips: embedded in the model, plus any external files named in the manifest.
  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) clips.set(clip.name, retargetClip(clip, bones));
  for (const [name, file] of Object.entries(manifest.clips ?? {})) {
    try {
      const extra = await loader.loadAsync(pack.base + file);
      const first = extra.animations[0];
      if (first) clips.set(name, retargetClip(first, bones));
    } catch (err) {
      console.warn(`clip "${name}" failed to load from ${file}`, err);
    }
  }

  const mixer = new THREE.AnimationMixer(root);
  let current: THREE.AnimationAction | null = null;
  const animatedBones = new Set<THREE.Object3D>();

  function actionFor(name: string): THREE.AnimationAction | null {
    const clip = clips.get(name);
    if (!clip) return null;
    return mixer.clipAction(clip, root);
  }

  const character: Character = {
    manifest,
    root,
    vrm,
    rest,
    animatedBones,
    height,
    bone: (name) => bones.get(name),
    hasClip: (name) => clips.has(name),
    clipDuration: (name) => clips.get(name)?.duration ?? 0,
    play(name, opts) {
      const action = actionFor(name);
      if (!action) return;
      const fade = opts.fade ?? 0.25;
      if (current && current !== action) current.fadeOut(fade);
      action.reset();
      action.enabled = true;
      action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !opts.loop;
      let scale = opts.playbackRate ?? 1;
      if (opts.beatsPerLoop && opts.bpm && opts.bpm > 0) {
        const wanted = (opts.beatsPerLoop * 60) / opts.bpm;
        scale = action.getClip().duration / wanted;
      }
      action.timeScale = scale;
      action.fadeIn(fade).play();
      current = action;
      animatedBones.clear();
      for (const track of action.getClip().tracks) {
        const b = byUuid.get(track.name.split(".")[0]);
        if (b) animatedBones.add(b);
      }
    },
    stop(fade = 0.25) {
      if (current) current.fadeOut(fade);
      current = null;
      animatedBones.clear();
    },
    clipTime: () => current?.time ?? 0,
    beginFrame(dt) {
      // Start from the T-pose, let the mixer overwrite what it animates, then snapshot as the base.
      for (const [b, q] of restPose) b.quaternion.copy(q);
      mixer.update(dt);
      for (const [b, q] of rest) q.copy(b.quaternion);
      if (current && !current.isRunning() && current.getEffectiveWeight() === 0) {
        current = null;
        animatedBones.clear();
      }
    },
    update: (dt) => vrm?.update(dt),
    dispose() {
      mixer.stopAllAction();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      });
      root.removeFromParent();
    },
  };
  return character;
}
