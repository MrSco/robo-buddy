import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { findHumanoidBones, humanoidNameOf, type BoneName } from "./humanoid";

/**
 * Runtime humanoid retargeting. A clip is expressed, per humanoid bone, as the
 * world-space rotation change relative to the source rig's T-pose; applying that
 * change to the target rig's T-pose gives the same motion on any humanoid skeleton.
 * Hip translation is transferred as a world offset scaled by hip height.
 *
 * This is the TypeScript port of scripts/retarget_clips.py, generalised so any rig
 * (Mixamo, Unreal, VRM, generic Blender) can be source or target, and A-posed rigs are
 * straightened into a T-pose reference first.
 */

interface TRS {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

export interface Rig {
  root: THREE.Object3D;
  bones: Map<BoneName, THREE.Object3D>;
  /** Every node under root, parents before children. */
  order: THREE.Object3D[];
  /** Rest-pose local transforms. */
  rest: Map<THREE.Object3D, TRS>;
  /** T-pose reference world rotation per node (arms and legs straightened). */
  refWorld: Map<THREE.Object3D, THREE.Quaternion>;
  refHipsPos: THREE.Vector3;
  /** Hips height above the feet in the reference pose, in the rig's own units. */
  hipHeight: number;
  /** True when the model's left side is at -X, i.e. it faces -Z. */
  flipped: boolean;
}

const R180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const R180_INV = R180.clone().invert();

function orderOf(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => out.push(o));
  return out; // traverse is depth-first from the root, so parents precede children
}

function localOf(o: THREE.Object3D): TRS {
  return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
}

/** World TRS for every node given a set of local transforms. */
function worldOf(rig: Rig, local: Map<THREE.Object3D, TRS>): Map<THREE.Object3D, TRS> {
  const out = new Map<THREE.Object3D, TRS>();
  const tmp = new THREE.Vector3();
  for (const o of rig.order) {
    const l = local.get(o) ?? localOf(o);
    const parent = o === rig.root ? null : o.parent;
    const pw = parent ? out.get(parent) : null;
    if (!pw) {
      out.set(o, { p: l.p.clone(), q: l.q.clone(), s: l.s.clone() });
    } else {
      tmp.copy(l.p).multiply(pw.s).applyQuaternion(pw.q).add(pw.p);
      out.set(o, { p: tmp.clone(), q: pw.q.clone().multiply(l.q).normalize(), s: pw.s.clone().multiply(l.s) });
    }
  }
  return out;
}

/**
 * Build a rig description. Straightens the limbs into a T-pose for the reference so
 * A-posed models (VRoid, many Blender exports) retarget correctly.
 */
export function buildRig(root: THREE.Object3D, bones?: Map<BoneName, THREE.Object3D>): Rig {
  const b = bones ?? findHumanoidBones(root);
  const order = orderOf(root);
  const rest = new Map<THREE.Object3D, TRS>();
  for (const o of order) rest.set(o, localOf(o));
  const rig: Rig = {
    root,
    bones: b,
    order,
    rest,
    refWorld: new Map(),
    refHipsPos: new THREE.Vector3(),
    hipHeight: 1,
    flipped: false,
  };

  // Facing: the left arm should be at +X when the model faces the viewer (+Z).
  let world = worldOf(rig, rest);
  const la = b.get("leftUpperArm");
  const ra = b.get("rightUpperArm");
  if (la && ra) rig.flipped = world.get(la)!.p.x < world.get(ra)!.p.x;
  const lx = rig.flipped ? -1 : 1;

  // Straighten limbs on a copy of the rest pose.
  const local = new Map<THREE.Object3D, TRS>();
  for (const [o, t] of rest) local.set(o, { p: t.p.clone(), q: t.q.clone(), s: t.s.clone() });
  const chains: Array<[BoneName, BoneName, THREE.Vector3]> = [
    ["leftUpperArm", "leftLowerArm", new THREE.Vector3(lx, 0, 0)],
    ["leftLowerArm", "leftHand", new THREE.Vector3(lx, 0, 0)],
    ["rightUpperArm", "rightLowerArm", new THREE.Vector3(-lx, 0, 0)],
    ["rightLowerArm", "rightHand", new THREE.Vector3(-lx, 0, 0)],
    ["leftUpperLeg", "leftLowerLeg", new THREE.Vector3(0, -1, 0)],
    ["leftLowerLeg", "leftFoot", new THREE.Vector3(0, -1, 0)],
    ["rightUpperLeg", "rightLowerLeg", new THREE.Vector3(0, -1, 0)],
    ["rightLowerLeg", "rightFoot", new THREE.Vector3(0, -1, 0)],
  ];
  const dir = new THREE.Vector3();
  const fix = new THREE.Quaternion();
  for (const [from, to, target] of chains) {
    const a = b.get(from);
    const c = b.get(to);
    if (!a || !c) continue;
    world = worldOf(rig, local);
    dir.copy(world.get(c)!.p).sub(world.get(a)!.p).normalize();
    if (dir.lengthSq() < 0.5 || dir.dot(target) > 0.999) continue;
    fix.setFromUnitVectors(dir, target);
    const wq = fix.multiply(world.get(a)!.q).normalize();
    const parent = a === root ? null : a.parent;
    const pq = parent ? world.get(parent)!.q : new THREE.Quaternion();
    local.get(a)!.q.copy(pq.clone().invert().multiply(wq));
  }
  world = worldOf(rig, local);
  for (const o of order) rig.refWorld.set(o, world.get(o)!.q.clone());

  const hips = b.get("hips");
  if (hips) {
    rig.refHipsPos.copy(world.get(hips)!.p);
    let ground = Infinity;
    for (const n of ["leftFoot", "rightFoot", "leftToes", "rightToes"] as const) {
      const f = b.get(n);
      if (f) ground = Math.min(ground, world.get(f)!.p.y);
    }
    if (!Number.isFinite(ground)) ground = rig.refHipsPos.y - 1;
    rig.hipHeight = Math.max(1e-3, rig.refHipsPos.y - ground);
  }
  return rig;
}

/** Map a clip's track node names onto a rig's nodes (by humanoid name) so a mixer can drive it. */
function bindTracks(clip: THREE.AnimationClip, rig: Rig): THREE.AnimationClip {
  const byName = new Map<string, THREE.Object3D>();
  for (const o of rig.order) byName.set(o.name, o);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const nodeName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    let node = byName.get(nodeName);
    if (!node) {
      const h = humanoidNameOf(nodeName);
      if (h) node = rig.bones.get(h);
    }
    if (!node) continue;
    if (prop !== "quaternion" && !(prop === "position" && node === rig.bones.get("hips"))) continue;
    const t = track.clone();
    t.name = `${node.uuid}.${prop}`;
    tracks.push(t);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Retarget `clip` (authored for `src`) onto `dst`. Returns a clip whose tracks address
 * the destination bones by uuid. Both rigs may be any supported humanoid skeleton.
 */
export function retargetClip(clip: THREE.AnimationClip, src: Rig, dst: Rig, fps = 30): THREE.AnimationClip {
  const bound = bindTracks(clip, src);
  const mixer = new THREE.AnimationMixer(src.root);
  const action = mixer.clipAction(bound);
  action.play();

  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const mapped: Array<[THREE.Object3D, THREE.Object3D]> = []; // [dstBone, srcBone]
  for (const [name, d] of dst.bones) {
    const s = src.bones.get(name);
    if (s) mapped.push([d, s]);
  }
  const rotOut = new Map<THREE.Object3D, Float32Array>();
  for (const [d] of mapped) rotOut.set(d, new Float32Array(frames * 4));
  const dstHips = dst.bones.get("hips");
  const srcHips = src.bones.get("hips");
  const hipsOut = dstHips && srcHips ? new Float32Array(frames * 3) : null;
  const ratio = dst.hipHeight / src.hipHeight;
  const flip = src.flipped !== dst.flipped;

  // Reset the source rig to rest so untracked bones do not carry stale state.
  for (const [o, t] of src.rest) {
    o.position.copy(t.p);
    o.quaternion.copy(t.q);
    o.scale.copy(t.s);
  }

  const delta = new THREE.Quaternion();
  const w = new THREE.Quaternion();
  const off = new THREE.Vector3();
  const prevQ = new Map<THREE.Object3D, THREE.Quaternion>();
  for (let i = 0; i < frames; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = t;
    mixer.setTime(t);
    const local = new Map<THREE.Object3D, TRS>();
    for (const o of src.order) local.set(o, localOf(o));
    const srcWorld = worldOf(src, local);

    // Walk the destination hierarchy, parents first, composing world rotations as we go.
    const dstWorldQ = new Map<THREE.Object3D, THREE.Quaternion>();
    const dstWorldP = new Map<THREE.Object3D, THREE.Vector3>();
    const dstWorldS = new Map<THREE.Object3D, THREE.Vector3>();
    const srcOf = new Map(mapped);
    for (const o of dst.order) {
      const r = dst.rest.get(o)!;
      const parent = o === dst.root ? null : o.parent;
      const pq = parent ? dstWorldQ.get(parent)! : new THREE.Quaternion();
      const pp = parent ? dstWorldP.get(parent)! : new THREE.Vector3();
      const ps = parent ? dstWorldS.get(parent)! : new THREE.Vector3(1, 1, 1);
      const s = srcOf.get(o);
      let localQ = r.q;
      let localP = r.p;
      if (s) {
        // delta = srcWorld * inv(srcRef); conjugate by a half turn when the rigs face opposite ways.
        delta.copy(srcWorld.get(s)!.q).multiply(src.refWorld.get(s)!.clone().invert());
        if (flip) delta.premultiply(R180).multiply(R180_INV);
        w.copy(delta).multiply(dst.refWorld.get(o)!).normalize();
        localQ = pq.clone().invert().multiply(w).normalize();
        const prev = prevQ.get(o);
        if (prev && prev.dot(localQ) < 0) localQ.set(-localQ.x, -localQ.y, -localQ.z, -localQ.w);
        prevQ.set(o, localQ.clone());
        const arr = rotOut.get(o)!;
        arr.set([localQ.x, localQ.y, localQ.z, localQ.w], i * 4);
        if (o === dstHips && hipsOut && srcHips) {
          off.copy(srcWorld.get(srcHips)!.p).sub(src.refHipsPos);
          if (flip) off.applyQuaternion(R180);
          off.multiplyScalar(ratio);
          off.applyQuaternion(pq.clone().invert()).divide(ps);
          localP = r.p.clone().add(off);
          hipsOut.set([localP.x, localP.y, localP.z], i * 3);
        }
      }
      dstWorldQ.set(o, pq.clone().multiply(localQ).normalize());
      dstWorldP.set(o, localP.clone().multiply(ps).applyQuaternion(pq).add(pp));
      dstWorldS.set(o, ps.clone().multiply(r.s));
    }
  }
  mixer.stopAllAction();
  mixer.uncacheClip(bound);
  for (const [o, t] of src.rest) {
    o.position.copy(t.p);
    o.quaternion.copy(t.q);
    o.scale.copy(t.s);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [d, arr] of rotOut) tracks.push(new THREE.QuaternionKeyframeTrack(`${d.uuid}.quaternion`, times, arr));
  if (hipsOut && dstHips) tracks.push(new THREE.VectorKeyframeTrack(`${dstHips.uuid}.position`, times, hipsOut));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** The canonical source rig every library clip is authored for (Rocco's Mixamo skeleton). */
let canonical: Promise<Rig> | null = null;
export function canonicalRig(): Promise<Rig> {
  if (!canonical) {
    canonical = new GLTFLoader().loadAsync("/clips/canonical.glb").then((g) => buildRig(g.scene));
  }
  return canonical;
}

/** True when a clip file carries its own skeleton hierarchy (e.g. a converted FBX), false for flat library clips. */
export function hasOwnSkeleton(root: THREE.Object3D): boolean {
  const bones = findHumanoidBones(root);
  const hips = bones.get("hips");
  const spine = bones.get("spine");
  return !!hips && !!spine && spine.parent === hips;
}
