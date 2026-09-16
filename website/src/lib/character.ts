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
  /** Required humanoid bones the model lacks (empty when fully rigged), for the rig report. */
  missingBones: BoneName[];
  /** How many humanoid bones were recognised, and by which naming scheme. */
  rigReport: string;
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
/**
 * Recompute every skinned mesh's bone matrices from the bones as they are now. three only does
 * this when it renders, so bounds taken before the first frame would still describe whatever
 * pose the file was saved in.
 */
export function refreshSkins(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && m.skeleton) {
      m.skeleton.update();
      m.computeBoundingBox();
    }
  });
}

/** An inverse bind matrix that is the identity or singular carries no bind pose at all. */
function degenerateInverse(m: THREE.Matrix4): boolean {
  const e = m.elements;
  let identity = true;
  for (let i = 0; i < 16; i++) {
    const want = i % 5 === 0 ? 1 : 0;
    if (Math.abs(e[i] - want) > 1e-6) {
      identity = false;
      break;
    }
  }
  return identity || Math.abs(m.determinant()) < 1e-12;
}

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
      // Joints nothing is weighted to sometimes ship an identity (or empty) inverse bind
      // matrix; placing them from it would drop them at the origin and swing their children
      // on a huge lever. They keep the pose the file gave them; children are still placed
      // relative to whatever they end up as.
      const bind = m.skeleton.boneInverses[i];
      if (degenerateInverse(bind)) {
        b.updateWorldMatrix(false, false);
        boneBox.expandByPoint(b.getWorldPosition(wp));
        continue;
      }
      saved.set(b, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
      target.copy(bind).invert().premultiply(m.matrixWorld);
      if (b.parent) target.premultiply(inv.copy(b.parent.matrixWorld).invert());
      target.decompose(b.position, b.quaternion, b.scale);
      b.updateWorldMatrix(false, false);
      boneBox.expandByPoint(b.getWorldPosition(wp));
    }
  });
  if (!done.size) return;
  refreshSkins(root);
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
    refreshSkins(root);
  }
}

/** Which naming scheme most of the recognised bones came from, for the rig report. */
function rigScheme(bones: Map<BoneName, THREE.Object3D>): string {
  const names = [...bones.values()].map((b) => b.name.toLowerCase());
  const n = names.length || 1;
  const count = (re: RegExp) => names.filter((x) => re.test(x)).length;
  if (count(/^mixamorig/) > n / 2) return "Mixamo";
  if (count(/^bip_/) > n / 2) return "Valve biped";
  if (count(/^(upperarm|lowerarm|thigh|calf|spine_0|clavicle)_[lr]/) > n / 2) return "Unreal";
  if (count(/^(hips|spine|neck|head|left|right)/) > n / 2) return "Mixamo-style names";
  return "generic names";
}

/**
 * Rods and cables skinned half to each of two bones that are not close relatives (hydraulic
 * pistons from the pelvis to the chest on a Source Filmmaker endoskeleton, say) skew into
 * spikes whenever those bones move apart, because the file relied on constraint helpers a
 * GLB does not carry. Each such vertex is given wholly to the nearer of its two bones, so a
 * rod stays straight and at worst slides off its far socket. Returns how many were changed.
 */
export let rodReport = "";
function reweightSpanningRods(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let changed = 0;
  const notes: string[] = [];
  const v = new THREE.Vector3();
  const near = (a: THREE.Object3D, b: THREE.Object3D) => {
    if (a === b || a.parent === b.parent) return true;
    for (let p = a.parent, i = 0; p && i < 2; p = p.parent, i++) if (p === b) return true;
    for (let p = b.parent, i = 0; p && i < 2; p = p.parent, i++) if (p === a) return true;
    return false;
  };
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton) return;
    const pos = m.geometry.getAttribute("position");
    const si = m.geometry.getAttribute("skinIndex");
    const sw = m.geometry.getAttribute("skinWeight") as THREE.BufferAttribute | undefined;
    if (!pos || !si || !sw) return;
    const bones = m.skeleton.bones;
    const bind = new THREE.Matrix4();
    const bindPos = bones.map((_, i) => {
      bind.copy(m.skeleton.boneInverses[i]).invert().premultiply(m.matrixWorld);
      return new THREE.Vector3().setFromMatrixPosition(bind);
    });
    // First pass: per pair of bones, how uniform the secondary weight is across the vertices
    // they share. Skin fades from one bone to the next; a rod or piston is a flat blend (the
    // same 0.5/0.5 or 0.67/0.33 on every vertex), whatever the bones' relation.
    const pairStats = new Map<string, { n: number; sum: number; sq: number }>();
    const top2 = (i: number): [number, number, number] => {
      let a = -1, b = -1, wa = 0, wb = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        const jn = si.getComponent(i, k);
        if (w > wa) { b = a; wb = wa; a = jn; wa = w; } else if (w > wb) { b = jn; wb = w; }
      }
      return [a, b, wb];
    };
    for (let i = 0; i < pos.count; i++) {
      const [a, b, wb] = top2(i);
      if (a < 0 || b < 0 || wb < 0.15) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const st = pairStats.get(key) ?? { n: 0, sum: 0, sq: 0 };
      st.n++;
      st.sum += wb;
      st.sq += wb * wb;
      pairStats.set(key, st);
    }
    const rigidPair = (a: number, b: number) => {
      const st = pairStats.get(a < b ? `${a}:${b}` : `${b}:${a}`);
      if (!st || st.n < 40) return false;
      const mean = st.sum / st.n;
      const sd = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean));
      return mean >= 0.2 && sd < 0.045;
    };
    // Second pass: which vertices are rod vertices, and which bone each would go to alone.
    const rod = new Uint8Array(pos.count);
    const alone = new Int32Array(pos.count).fill(-1);
    for (let i = 0; i < pos.count; i++) {
      const [a, b, wb] = top2(i);
      if (a < 0 || b < 0 || !bones[a] || !bones[b]) continue;
      const unrelated = wb >= 0.25 && !near(bones[a], bones[b]);
      if (!unrelated && !(wb >= 0.15 && rigidPair(a, b))) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      rod[i] = 1;
      alone[i] = v.distanceTo(bindPos[a]) <= v.distanceTo(bindPos[b]) ? a : b;
    }
    // Rods are usually their own little mesh islands (a piston with its end caps). Give each
    // such island wholly to the bone that already carries most of its weight, so the whole
    // piece stays rigid: splitting a rod vertex by vertex leaves a seam of triangles that
    // stretch into a thin spike when the bones part. Big welded islands are split per vertex.
    const give = (i: number, keep: number) => {
      let given = false;
      for (let k = 0; k < 4; k++) {
        const hit = !given && si.getComponent(i, k) === keep;
        sw.setComponent(i, k, hit ? 1 : 0);
        if (hit) given = true;
      }
      if (!given) {
        // The bone is not in this vertex's slots: put it in the first one.
        si.setComponent(i, 0, keep);
        sw.setComponent(i, 0, 1);
        for (let k = 1; k < 4; k++) sw.setComponent(i, k, 0);
        (si as THREE.BufferAttribute).needsUpdate = true;
      }
      changed++;
    };
    let touched = false;
    const index = m.geometry.index;
    if (index && pos.count < 400_000) {
      const parent = new Int32Array(pos.count);
      for (let i = 0; i < pos.count; i++) parent[i] = i;
      const find = (x: number) => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      for (let t = 0; t + 2 < index.count; t += 3) {
        const r0 = find(index.getX(t));
        parent[find(index.getX(t + 1))] = r0;
        parent[find(index.getX(t + 2))] = r0;
      }
      const size = new Map<number, number>();
      const hasRod = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        const r = find(i);
        size.set(r, (size.get(r) ?? 0) + 1);
        if (rod[i]) hasRod.add(r);
      }
      // Weight per bone within each rod-bearing small island.
      const tally = new Map<number, Map<number, number>>();
      for (let i = 0; i < pos.count; i++) {
        const r = find(i);
        if (!hasRod.has(r) || (size.get(r) ?? 0) > 600) continue;
        let tm = tally.get(r);
        if (!tm) tally.set(r, (tm = new Map()));
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w > 0) tm.set(si.getComponent(i, k), (tm.get(si.getComponent(i, k)) ?? 0) + w);
        }
      }
      const winner = new Map<number, number>();
      for (const [r, tm] of tally) {
        let best = -1, bw = -1;
        for (const [jn, w] of tm) if (w > bw) { bw = w; best = jn; }
        if (best >= 0) winner.set(r, best);
      }
      for (let i = 0; i < pos.count; i++) {
        const r = find(i);
        const w = winner.get(r);
        if (w !== undefined) {
          give(i, w);
          touched = true;
        } else if (rod[i]) {
          give(i, alone[i]);
          touched = true;
        }
      }
      // Stray weights: a vertex whose dominant bone agrees with none of its neighbours, while
      // they agree among themselves, is a file error (one chest vertex bound to a foot) and
      // draws a triangle right across the body when the two bones move apart. It takes the
      // neighbours' bone. Two passes catch a stray pair.
      const dominant = (i: number) => {
        let best = -1, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        return best;
      };
      const neighbours: Array<number[] | undefined> = new Array(pos.count);
      const link = (a: number, b: number) => { (neighbours[a] ??= []).push(b); (neighbours[b] ??= []).push(a); };
      for (let t = 0; t + 2 < index.count; t += 3) {
        const a = index.getX(t), b = index.getX(t + 1), cc = index.getX(t + 2);
        link(a, b); link(b, cc); link(cc, a);
      }
      for (let pass = 0; pass < 2; pass++) {
        const dom = new Int32Array(pos.count);
        for (let i = 0; i < pos.count; i++) dom[i] = dominant(i);
        for (let i = 0; i < pos.count; i++) {
          const nb = neighbours[i];
          if (!nb || nb.length < 2) continue;
          const votes = new Map<number, number>();
          let same = 0;
          for (const n of nb) {
            if (dom[n] === dom[i]) same++;
            else votes.set(dom[n], (votes.get(dom[n]) ?? 0) + 1);
          }
          if (same > 0) continue;
          let best = -1, bv = 0;
          for (const [jn, c] of votes) if (c > bv) { bv = c; best = jn; }
          // Three or more neighbours: four in five agreeing is enough; with only two, both must.
          const enough = nb.length >= 3 ? bv >= nb.length * 0.8 : bv === nb.length;
          if (best >= 0 && enough && !near(bones[best], bones[dom[i]])) {
            give(i, best);
            touched = true;
          }
        }
      }
    } else {
      for (let i = 0; i < pos.count; i++) if (rod[i]) { give(i, alone[i]); touched = true; }
    }
    if (touched) sw.needsUpdate = true;
  });
  rodReport = `${changed} rod vertices`;
  void notes;
  return changed;
}

export async function loadCharacter(pack: PackRef, manifest: Manifest): Promise<Character> {
  const model = await loadModel(pack.base + manifest.model);
  const { root, vrm } = model;
  if (!vrm) {
    restoreBindPose(root);
    const rods = reweightSpanningRods(root);
    if (rods) console.info(`${manifest.name}: ${rods} rod vertices re-weighted to a single bone`);
  }

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
  const scheme = vrm ? "VRM" : rigScheme(bones);
  const rigReport = bones.size ? `${bones.size} humanoid bones recognised (${scheme})${missing.length ? `; missing ${missing.join(", ")}: those parts will not animate` : ""}` : "no humanoid skeleton found: the model will not animate";

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
        let url = file;
        if (!url.startsWith("/")) {
          if (url.startsWith("clips/")) url = "/" + url;
          else url = pack.base + url;
        }
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
    missingBones: missing,
    rigReport,
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
    update(dt) {
      character.beginFrame(dt);
      vrm?.update(dt);
    },
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
