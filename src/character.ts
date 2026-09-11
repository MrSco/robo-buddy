import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { findHumanoidBones, humanoidNameOf, missingBones, type BoneName } from "./humanoid";
import type { Manifest, PackRef } from "./packs";
import { buildRig, canonicalRig, hasOwnSkeleton, retargetClip, type Rig } from "./retarget";

export type { BoneName } from "./humanoid";
export type { Manifest } from "./packs";

export interface PlayOptions {
  loop: boolean;
  fade?: number;
  /** Stretch the clip so one loop spans this many beats at the given bpm. */
  beatsPerLoop?: number;
  bpm?: number;
  playbackRate?: number;
}

/** One character on stage, regardless of file format or skeleton naming. */
export interface Character {
  manifest: Manifest;
  root: THREE.Object3D;
  vrm?: VRM;
  rig: Rig;
  /** Humanoid bones keyed by VRM names; works for any supported rig. */
  bone(name: BoneName): THREE.Object3D | undefined;
  /**
   * Per-frame base rotations that procedural layers reset to before adding their own.
   * Equals the rest pose when no clip is playing, otherwise the clip's output for this frame.
   */
  rest: Map<THREE.Object3D, THREE.Quaternion>;
  /** Bones written by the currently playing clip; procedural idle leaves these alone. */
  animatedBones: Set<THREE.Object3D>;
  /** Height in metres after unit normalisation. */
  height: number;
  beginFrame(dt: number): void;
  hasClip(name: string): boolean;
  clipDuration(name: string): number;
  /** Add a clip authored for another rig (or this one); retargeted on the fly. */
  addClip(name: string, clip: THREE.AnimationClip, source: Rig | "self"): void;
  play(name: string, opts: PlayOptions): void;
  stop(fade?: number): void;
  clipTime(): number;
  update(dt: number): void;
  dispose(): void;
}

export interface LoadedModel {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  vrm?: VRM;
}

function isFbx(url: string) {
  return /\.fbx(\?|$)/i.test(url);
}

/** Load a GLB, glTF, VRM or FBX file into a scene graph plus any embedded animations. */
export async function loadModel(url: string): Promise<LoadedModel> {
  if (isFbx(url)) {
    const loader = new FBXLoader();
    const group = await loader.loadAsync(url);
    return { root: group, animations: group.animations ?? [] };
  }
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  return { root: vrm ? vrm.scene : gltf.scene, animations: gltf.animations, vrm };
}

/**
 * Bring a model into metres and Y-up: FBX and some exports arrive in centimetres and/or
 * Z-up (Blender, Unreal). Uses the humanoid bones when available so a wide T-pose cannot
 * be mistaken for the up axis.
 */
function normaliseUnits(root: THREE.Object3D, bones: Map<BoneName, THREE.Object3D>): number {
  root.updateMatrixWorld(true);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const hips = bones.get("hips");
  const head = bones.get("head");
  let up: THREE.Vector3;
  if (hips && head) {
    up = head.getWorldPosition(a).sub(hips.getWorldPosition(b));
  } else {
    const size = new THREE.Box3().setFromObject(root).getSize(a);
    up = size.z > size.y * 1.5 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  }
  if (Math.abs(up.z) > Math.abs(up.y)) {
    // Z-up: rotate so +Z becomes +Y (or -Z if the model is upside down).
    root.rotateX(up.z > 0 ? -Math.PI / 2 : Math.PI / 2);
    root.updateMatrixWorld(true);
  }
  const box = new THREE.Box3().setFromObject(root);
  let height = box.getSize(a).y;
  if (height > 20) {
    root.scale.multiplyScalar(0.01);
  } else if (height > 0 && height < 0.2) {
    root.scale.multiplyScalar(100);
  }
  root.updateMatrixWorld(true);
  height = new THREE.Box3().setFromObject(root).getSize(a).y;
  return height;
}

/** Rewrite a clip's track names so they address this character's bones (same-rig clips only). */
function bindToSelf(clip: THREE.AnimationClip, bones: Map<BoneName, THREE.Object3D>, root: THREE.Object3D): THREE.AnimationClip {
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => byName.set(o.name, o));
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const nodeName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    let target = byName.get(nodeName);
    if (!target) {
      const h = humanoidNameOf(nodeName);
      if (h) target = bones.get(h);
    }
    if (!target) continue;
    if (prop !== "quaternion" && !(prop === "position" && target === bones.get("hips"))) continue;
    const t = track.clone();
    t.name = `${target.uuid}.${prop}`;
    tracks.push(t);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Put every skinned bone back into the pose the mesh was bound in. Some exporters (Sketchfab
 * among them) store the first frame of an animation as the node transforms instead, which
 * would leave the "rest" pose bent and every retargeted clip skewed by that bend.
 */
function restoreBindPose(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const done = new Set<THREE.Object3D>();
  const inv = new THREE.Matrix4();
  const target = new THREE.Matrix4();
  const depthOf = (o: THREE.Object3D) => {
    let d = 0;
    for (let p = o.parent; p; p = p.parent) d++;
    return d;
  };
  const saved = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  const wp = new THREE.Vector3();
  const meshBox = new THREE.Box3().setFromObject(root);
  const boneBox = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton) return;
    // Parents first, so each bone's local transform is taken against an already restored parent.
    // The inverse bind matrices are relative to the mesh's own frame (the GLTF loader binds with
    // the identity), so a joint's world matrix at bind time is the mesh's world matrix times the
    // inverse of its inverse bind matrix.
    const bones = m.skeleton.bones.map((b, i) => ({ b, i, depth: depthOf(b) })).sort((a, b) => a.depth - b.depth);
    for (const { b, i } of bones) {
      if (done.has(b)) continue;
      done.add(b);
      saved.set(b, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
      target.copy(m.skeleton.boneInverses[i]).invert().premultiply(m.matrixWorld);
      if (b.parent) target.premultiply(inv.copy(b.parent.matrixWorld).invert());
      target.decompose(b.position, b.quaternion, b.scale);
      b.updateWorldMatrix(false, false);
      boneBox.expandByPoint(b.getWorldPosition(wp));
    }
  });
  if (!done.size) return;
  // Sanity: the restored skeleton must sit where the mesh is. If the file's matrices follow some
  // other convention the bones would land far away; then the node pose is kept as it was.
  const mh = meshBox.getSize(new THREE.Vector3()).y;
  const bh = boneBox.getSize(new THREE.Vector3()).y;
  const off = boneBox.getCenter(new THREE.Vector3()).distanceTo(meshBox.getCenter(new THREE.Vector3()));
  if (!(bh > mh * 0.4 && bh < mh * 1.5 && off < mh)) {
    console.warn(`bind pose restore skipped: bones span ${bh.toFixed(2)} vs mesh ${mh.toFixed(2)}, ${off.toFixed(2)} apart`);
    for (const [b, t] of saved) {
      b.position.copy(t.p);
      b.quaternion.copy(t.q);
      b.scale.copy(t.s);
    }
    root.updateMatrixWorld(true);
  }
}

export async function loadCharacter(pack: PackRef, manifest: Manifest): Promise<Character> {
  const model = await loadModel(pack.base + manifest.model);
  const { root, vrm } = model;
  if (!vrm) restoreBindPose(root);

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
    for (const [k, v] of findHumanoidBones(root)) bones.set(k, v);
  }
  const missing = missingBones(bones);
  if (missing.length) console.warn(`${manifest.name}: no humanoid bones for ${missing.join(", ")}; clips will not fully apply`);

  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
  });
  const height = normaliseUnits(root, bones);
  const rig = buildRig(root, bones);

  const byUuid = new Map<string, THREE.Object3D>();
  for (const b of bones.values()) byUuid.set(b.uuid, b);

  const restPose = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const b of bones.values()) restPose.set(b, b.quaternion.clone());
  const rest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const [b, q] of restPose) rest.set(b, q.clone());

  // Clips are retargeted lazily on first use: with a large library, fitting every clip to
  // this rig up front would add seconds to startup. `pending` holds the source until then.
  const clips = new Map<string, THREE.AnimationClip>();
  const pending = new Map<string, { clip: THREE.AnimationClip; source: Rig | "self" }>();
  const durations = new Map<string, number>();
  const mixer = new THREE.AnimationMixer(root);
  let current: THREE.AnimationAction | null = null;
  const animatedBones = new Set<THREE.Object3D>();

  const addClip = (name: string, clip: THREE.AnimationClip, source: Rig | "self") => {
    pending.set(name, { clip, source });
    durations.set(name, clip.duration);
    clips.delete(name);
  };
  const materialise = (name: string): THREE.AnimationClip | undefined => {
    const ready = clips.get(name);
    if (ready) return ready;
    const p = pending.get(name);
    if (!p) return undefined;
    const bound = p.source === "self" ? bindToSelf(p.clip, bones, root) : retargetClip(p.clip, p.source, rig);
    bound.name = name;
    clips.set(name, bound);
    pending.delete(name);
    return bound;
  };

  // Clips embedded in the model file are already authored for this skeleton.
  for (const clip of model.animations) addClip(clip.name, clip, "self");

  // External clip files, fetched in parallel. Flat library clips come from the canonical rig;
  // files that carry their own skeleton (converted FBX, other rigs) are retargeted from it.
  const canon = canonicalRig();
  await Promise.all(
    Object.entries(manifest.clips ?? {}).map(async ([name, file]) => {
      try {
        const url = file.startsWith("/") ? file : pack.base + file;
        const extra = await loadModel(url);
        const first = extra.animations[0];
        if (!first) return;
        const source = hasOwnSkeleton(extra.root) ? buildRig(extra.root) : await canon;
        addClip(name, first, source);
      } catch (err) {
        console.warn(`clip "${name}" failed to load from ${file}`, err);
      }
    }),
  );

  function actionFor(name: string): THREE.AnimationAction | null {
    const clip = materialise(name);
    if (!clip) return null;
    return mixer.clipAction(clip, root);
  }

  const character: Character = {
    manifest,
    root,
    vrm,
    rig,
    rest,
    animatedBones,
    height,
    bone: (name) => bones.get(name),
    hasClip: (name) => clips.has(name) || pending.has(name),
    clipDuration: (name) => durations.get(name) ?? 0,
    addClip,
    play(name, opts) {
      const action = actionFor(name);
      if (!action) return;
      const fade = opts.fade ?? 0.25;
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
      // Weights must always sum to one, or the mixer blends toward the rest T-pose.
      const prevWeight = current && current !== action ? current.getEffectiveWeight() : 0;
      if (current && current !== action && prevWeight > 0.01 && fade > 0) {
        current.fadeOut(fade);
        action.fadeIn(fade).play();
      } else {
        if (current && current !== action) current.stop();
        action.setEffectiveWeight(1);
        action.play();
      }
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
      // The mixer only writes a bone when its value changed since the previous update, so
      // animated bones must start each frame from their previous mixer output, not the
      // T-pose: at a loop wrap the last and first keyframes match and the write is skipped,
      // which showed a one-frame T-pose. Unanimated bones do go back to rest.
      for (const [b, q] of restPose) {
        if (animatedBones.has(b)) b.quaternion.copy(rest.get(b) ?? q);
        else b.quaternion.copy(q);
      }
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
