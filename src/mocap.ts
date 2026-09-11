/**
 * Webcam motion capture. MediaPipe gives 33 body landmarks (and 21 per hand); this turns them
 * into world-space rotation deltas (relative to a T-pose) for the canonical rig's humanoid
 * bones, which the same delta method the clip retargeter uses then puts on any character.
 * Recorded frames become an ordinary clip on the canonical rig, exported as GLB.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { BoneName } from "./humanoid";
import { R180, R180_INV, worldOf, type Rig } from "./retarget";

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"] as const;
const FINGER_PARTS = (f: string) => (f === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"]);

/** Bones a pose carries, in payload order: body first, then hands and fingers. */
export const MIRROR_BONES: BoneName[] = [
  "hips", "chest", "head",
  "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
  "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
  "leftHand", "rightHand",
  ...(["left", "right"] as const).flatMap((s) => FINGERS.flatMap((f) => FINGER_PARTS(f).map((p) => `${s}${f}${p}` as BoneName))),
];
/** Index of the first hand bone in MIRROR_BONES; everything from here on comes from hand tracking. */
export const HAND_START = 11;

/**
 * One captured pose: world rotation deltas per MIRROR_BONES (x,y,z,w each), a mask saying which
 * bones were actually seen (1) or should be left as the clip has them (0), and a hips height
 * offset in canonical metres.
 */
export interface MirrorPose {
  d: number[];
  m: number[];
  hy: number;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface HandInput {
  /** "Left" or "Right" as reported for the raw (unmirrored) webcam frame. */
  label: string;
  world: Landmark[];
}

// MediaPipe pose landmark indices.
const LM = { nose: 0, lEar: 7, rEar: 8, lSho: 11, rSho: 12, lElb: 13, rElb: 14, lWri: 15, rWri: 16, lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28 } as const;

// Hand landmark segments per finger: [from, to] indices, in FINGER_PARTS order.
const HAND_SEGMENTS: Record<(typeof FINGERS)[number], Array<[number, number]>> = {
  Thumb: [[1, 2], [2, 3], [3, 4]],
  Index: [[5, 6], [6, 7], [7, 8]],
  Middle: [[9, 10], [10, 11], [11, 12]],
  Ring: [[13, 14], [14, 15], [15, 16]],
  Little: [[17, 18], [18, 19], [19, 20]],
};

/** One Euro filter: smooth when still, responsive when moving. */
class OneEuro {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = -1;
  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1) {}
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x: number, t: number): number {
    if (this.tPrev < 0) {
      this.tPrev = t;
      this.xPrev = x;
      return x;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const dx = (x - this.xPrev) / dt;
    const ad = this.alpha(this.dCutoff, dt);
    const dxHat = ad * dx + (1 - ad) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const mT = new THREE.Matrix4();
const mTarget = new THREE.Matrix4();
const qTmp = new THREE.Quaternion();

/**
 * Landmarks to a MirrorPose. The subject is mirrored: their left side drives the
 * character's right, so raising your left hand raises the hand on your left of the screen.
 */
export class PoseSolver {
  /** T-pose world direction (bone to child, or to the end node) on the canonical rig. */
  private tDir = new Map<BoneName, THREE.Vector3>();
  private tBasisInv = new THREE.Matrix4();
  private filters: OneEuro[] = [];
  private handFilters = new Map<string, OneEuro[]>();
  private calibLeg = 0;
  private last: MirrorPose | null = null;

  constructor(private canon: Rig) {
    const world = worldOf(canon, canon.rest);
    const dirTo = (a: BoneName, target: THREE.Object3D | undefined) => {
      const oa = canon.bones.get(a);
      if (!oa || !target) return;
      const pa = world.get(oa)?.p;
      const pb = world.get(target)?.p;
      if (!pa || !pb) return;
      const d = pb.clone().sub(pa);
      if (d.lengthSq() > 1e-8) this.tDir.set(a, d.normalize());
    };
    const pairs: Array<[BoneName, BoneName]> = [
      ["leftUpperArm", "leftLowerArm"], ["leftLowerArm", "leftHand"],
      ["rightUpperArm", "rightLowerArm"], ["rightLowerArm", "rightHand"],
      ["leftUpperLeg", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"],
      ["rightUpperLeg", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"],
    ];
    for (const [a, b] of pairs) dirTo(a, canon.bones.get(b));
    // Hands point along the middle finger; fingers along their next segment (the tip is an end node).
    for (const side of ["left", "right"] as const) {
      dirTo(`${side}Hand` as BoneName, canon.bones.get(`${side}MiddleProximal` as BoneName) ?? canon.bones.get(`${side}Hand` as BoneName)?.children[0]);
      for (const f of FINGERS) {
        const parts = FINGER_PARTS(f);
        for (let i = 0; i < parts.length; i++) {
          const name = `${side}${f}${parts[i]}` as BoneName;
          const next = i + 1 < parts.length ? canon.bones.get(`${side}${f}${parts[i + 1]}` as BoneName) : canon.bones.get(name)?.children[0];
          dirTo(name, next);
        }
      }
    }
    // T-pose body basis: character right, up, forward in world space.
    const rx = canon.flipped ? 1 : -1;
    mT.makeBasis(new THREE.Vector3(rx, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, canon.flipped ? -1 : 1));
    this.tBasisInv.copy(mT).invert();
    for (let i = 0; i < 33 * 3; i++) this.filters.push(new OneEuro());
  }

  reset() {
    this.calibLeg = 0;
    this.last = null;
    this.filters = this.filters.map(() => new OneEuro());
    this.handFilters.clear();
  }

  /**
   * `world`: 33 MediaPipe world landmarks (metres, hip-centred). `vis`: per-landmark visibility.
   * `hands`: hand world landmarks with their handedness labels, or none.
   */
  solve(world: Landmark[], vis: number[] | undefined, hands: HandInput[], t: number): MirrorPose | null {
    if (world.length < 29) return this.last;
    const p: THREE.Vector3[] = [];
    for (let i = 0; i < 33; i++) {
      const l = world[i];
      p.push(new THREE.Vector3(this.filters[i * 3].filter(-l.x, t), this.filters[i * 3 + 1].filter(-l.y, t), this.filters[i * 3 + 2].filter(-l.z, t)));
    }
    const ok = (i: number) => !vis || (vis[i] ?? 1) > 0.45;
    const n = MIRROR_BONES.length;
    const d: number[] = new Array(n * 4).fill(0);
    const m: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) d[i * 4 + 3] = 1;
    const put = (name: BoneName, q: THREE.Quaternion) => {
      const i = MIRROR_BONES.indexOf(name);
      if (i < 0) return;
      d[i * 4] = q.x;
      d[i * 4 + 1] = q.y;
      d[i * 4 + 2] = q.z;
      d[i * 4 + 3] = q.w;
      m[i] = 1;
    };

    // Mirrored side mapping: the character's right is the subject's left.
    const cRightSho = p[LM.lSho], cLeftSho = p[LM.rSho];
    const cRightHip = p[LM.lHip], cLeftHip = p[LM.rHip];
    const midSho = tmpA.copy(cRightSho).add(cLeftSho).multiplyScalar(0.5).clone();
    const midHip = tmpB.copy(cRightHip).add(cLeftHip).multiplyScalar(0.5).clone();

    const basis = (right: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion => {
      const U = up.clone().normalize();
      const F = new THREE.Vector3().crossVectors(U, right).normalize();
      const R = new THREE.Vector3().crossVectors(F, U).normalize();
      mTarget.makeBasis(R, U, F);
      mTarget.multiply(this.tBasisInv);
      return new THREE.Quaternion().setFromRotationMatrix(mTarget).normalize();
    };
    if (ok(LM.lSho) && ok(LM.rSho) && ok(LM.lHip) && ok(LM.rHip)) {
      const up = tmpC.copy(midSho).sub(midHip);
      put("hips", basis(cRightHip.clone().sub(cLeftHip), up));
      put("chest", basis(cRightSho.clone().sub(cLeftSho), up));
    }
    if (ok(LM.lEar) && ok(LM.rEar)) {
      const midEar = p[LM.lEar].clone().add(p[LM.rEar]).multiplyScalar(0.5);
      const up = midEar.clone().sub(midSho);
      const right = p[LM.lEar].clone().sub(p[LM.rEar]);
      const fwd = p[LM.nose].clone().sub(midEar);
      up.addScaledVector(fwd, 0.35);
      put("head", basis(right, up));
    }
    const aim = (name: BoneName, dir: THREE.Vector3) => {
      if (dir.lengthSq() < 1e-6) return;
      const rest = this.tDir.get(name);
      if (!rest) return;
      qTmp.setFromUnitVectors(rest, dir.normalize());
      put(name, qTmp.clone());
    };
    const limb = (name: BoneName, from: number, to: number) => {
      if (!ok(from) || !ok(to)) return;
      aim(name, p[to].clone().sub(p[from]));
    };
    limb("rightUpperArm", LM.lSho, LM.lElb);
    limb("rightLowerArm", LM.lElb, LM.lWri);
    limb("leftUpperArm", LM.rSho, LM.rElb);
    limb("leftLowerArm", LM.rElb, LM.rWri);
    limb("rightUpperLeg", LM.lHip, LM.lKnee);
    limb("rightLowerLeg", LM.lKnee, LM.lAnk);
    limb("leftUpperLeg", LM.rHip, LM.rKnee);
    limb("leftLowerLeg", LM.rKnee, LM.rAnk);
    // Hands point from the wrist toward the knuckles (index and pinky midpoint).
    if (ok(LM.lWri) && ok(LM.lIndex) && ok(LM.lPinky)) aim("rightHand", p[LM.lIndex].clone().add(p[LM.lPinky]).multiplyScalar(0.5).sub(p[LM.lWri]));
    if (ok(LM.rWri) && ok(LM.rIndex) && ok(LM.rPinky)) aim("leftHand", p[LM.rIndex].clone().add(p[LM.rPinky]).multiplyScalar(0.5).sub(p[LM.rWri]));

    // Fingers from the hand tracker. The label is reported for a mirrored image, and the feed is
    // not mirrored, so "Left" is the subject's right hand, which drives the character's left.
    for (const hand of hands) {
      if (hand.world.length < 21) continue;
      const side = hand.label.toLowerCase().startsWith("l") ? "left" : "right";
      let filt = this.handFilters.get(side);
      if (!filt) {
        filt = [];
        for (let i = 0; i < 21 * 3; i++) filt.push(new OneEuro(2.5, 0.05));
        this.handFilters.set(side, filt);
      }
      const hp: THREE.Vector3[] = hand.world.map((l, i) => new THREE.Vector3(filt![i * 3].filter(-l.x, t), filt![i * 3 + 1].filter(-l.y, t), filt![i * 3 + 2].filter(-l.z, t)));
      for (const f of FINGERS) {
        const parts = FINGER_PARTS(f);
        HAND_SEGMENTS[f].forEach(([a, b], i) => aim(`${side}${f}${parts[i]}` as BoneName, hp[b].clone().sub(hp[a])));
      }
    }

    // Hips height from the vertical hip-to-ankle span, relative to the tallest stance seen.
    let hy = 0;
    if (ok(LM.lAnk) && ok(LM.rAnk)) {
      const midAnk = p[LM.lAnk].clone().add(p[LM.rAnk]).multiplyScalar(0.5);
      const leg = midHip.y - midAnk.y;
      if (this.calibLeg <= 0) this.calibLeg = leg;
      else this.calibLeg = Math.max(this.calibLeg, leg);
      if (this.calibLeg > 0.2) hy = ((leg - this.calibLeg) / this.calibLeg) * this.canon.hipHeight;
    }
    this.last = { d, m, hy };
    return this.last;
  }
}

/** Puts a MirrorPose on any rig: absolute world rotations from the deltas, then local. */
export class MirrorApplier {
  private delta = new THREE.Quaternion();
  private w = new THREE.Quaternion();
  private local = new THREE.Quaternion();
  private worldQ = new Map<THREE.Object3D, THREE.Quaternion>();
  private scale = new THREE.Vector3();

  constructor(private canon: Rig) {}

  apply(rig: Rig, pose: MirrorPose, amount = 1) {
    const flip = this.canon.flipped !== rig.flipped;
    const index = new Map<THREE.Object3D, number>();
    MIRROR_BONES.forEach((n, i) => {
      const b = rig.bones.get(n);
      if (b && (pose.m?.[i] ?? 1)) index.set(b, i);
    });
    this.worldQ.clear();
    for (const o of rig.order) {
      const parent = o === rig.root ? null : o.parent;
      const pq = parent ? this.worldQ.get(parent) : undefined;
      const i = index.get(o);
      if (i !== undefined) {
        this.delta.set(pose.d[i * 4], pose.d[i * 4 + 1], pose.d[i * 4 + 2], pose.d[i * 4 + 3]);
        if (flip) this.delta.premultiply(R180).multiply(R180_INV);
        this.w.copy(this.delta).multiply(rig.refWorld.get(o)!).normalize();
        if (pq) this.local.copy(pq).invert().multiply(this.w);
        else this.local.copy(this.w);
        if (amount >= 1) o.quaternion.copy(this.local);
        else o.quaternion.slerp(this.local, amount);
      }
      const wq = pq ? pq.clone().multiply(o.quaternion) : o.quaternion.clone();
      this.worldQ.set(o, wq.normalize());
    }
    const hips = rig.bones.get("hips");
    if (hips && hips.parent) {
      const r = rig.rest.get(hips)!;
      hips.parent.getWorldScale(this.scale);
      const ratio = rig.hipHeight / this.canon.hipHeight;
      const dy = (pose.hy * ratio) / Math.max(1e-6, this.scale.y);
      hips.position.y = r.p.y + dy * amount;
    }
  }
}

/** Ease a pose toward a target pose (normalised lerp per bone); keeps the buddy smooth between frames. */
export function easePose(current: MirrorPose | null, target: MirrorPose, k: number): MirrorPose {
  if (!current || current.d.length !== target.d.length) return { d: target.d.slice(), m: target.m.slice(), hy: target.hy };
  const n = target.m.length;
  const d = current.d;
  for (let i = 0; i < n; i++) {
    if (!target.m[i]) continue;
    if (!current.m[i]) {
      for (let j = 0; j < 4; j++) d[i * 4 + j] = target.d[i * 4 + j];
      continue;
    }
    // Shortest path: flip the target if the quaternions point away from each other.
    let dot = 0;
    for (let j = 0; j < 4; j++) dot += d[i * 4 + j] * target.d[i * 4 + j];
    const s = dot < 0 ? -1 : 1;
    let len = 0;
    for (let j = 0; j < 4; j++) {
      d[i * 4 + j] += (s * target.d[i * 4 + j] - d[i * 4 + j]) * k;
      len += d[i * 4 + j] * d[i * 4 + j];
    }
    len = Math.sqrt(len) || 1;
    for (let j = 0; j < 4; j++) d[i * 4 + j] /= len;
  }
  current.m = target.m.slice();
  current.hy += (target.hy - current.hy) * k;
  return current;
}

/** Frames captured at the camera rate, turned into a clip on the canonical rig. */
export class PoseRecorder {
  private frames: Array<{ t: number; pose: MirrorPose }> = [];
  private start = -1;

  get seconds() {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }
  get count() {
    return this.frames.length;
  }

  begin() {
    this.frames = [];
    this.start = -1;
  }

  push(pose: MirrorPose, t: number) {
    if (this.start < 0) this.start = t;
    this.frames.push({ t: t - this.start, pose: { d: pose.d.slice(), m: pose.m.slice(), hy: pose.hy } });
  }

  /** A clip on the canonical rig, sampled at 30 fps; loops cleanly by easing the ends together. */
  toClip(canon: Rig, name: string, loop: boolean): THREE.AnimationClip | null {
    if (this.frames.length < 6) return null;
    const applier = new MirrorApplier(canon);
    const fps = 30;
    const duration = this.frames[this.frames.length - 1].t;
    const n = Math.max(2, Math.round(duration * fps) + 1);
    const times = new Float32Array(n);
    // Only bones the tracker actually saw at some point get a track.
    const seen = new Set<number>();
    for (const f of this.frames) f.pose.m.forEach((v, i) => v && seen.add(i));
    const bones = MIRROR_BONES.map((b, i) => (seen.has(i) ? canon.bones.get(b) : undefined)).filter((b): b is THREE.Object3D => !!b);
    const rot = new Map<THREE.Object3D, Float32Array>();
    for (const b of bones) rot.set(b, new Float32Array(n * 4));
    const hips = canon.bones.get("hips");
    const hipsPos = hips ? new Float32Array(n * 3) : null;
    for (const [o, t] of canon.rest) {
      o.position.copy(t.p);
      o.quaternion.copy(t.q);
      o.scale.copy(t.s);
    }
    let k = 0;
    const prev = new Map<THREE.Object3D, THREE.Quaternion>();
    for (let i = 0; i < n; i++) {
      const t = Math.min(duration, i / fps);
      times[i] = t;
      while (k < this.frames.length - 1 && this.frames[k + 1].t <= t) k++;
      let pose = this.frames[k].pose;
      if (loop && duration > 2 && duration - t < 0.5) {
        const a = 1 - (duration - t) / 0.5;
        const head = this.frames[0].pose;
        pose = { d: pose.d.map((v, j) => v * (1 - a) + head.d[j] * a), m: pose.m.map((v, j) => v | head.m[j]), hy: pose.hy * (1 - a) + head.hy * a };
      }
      applier.apply(canon, pose, 1);
      for (const b of bones) {
        const q = b.quaternion.clone();
        const p = prev.get(b);
        if (p && p.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prev.set(b, q);
        rot.get(b)!.set([q.x, q.y, q.z, q.w], i * 4);
      }
      if (hips && hipsPos) hipsPos.set([hips.position.x, hips.position.y, hips.position.z], i * 3);
    }
    for (const [o, t] of canon.rest) {
      o.position.copy(t.p);
      o.quaternion.copy(t.q);
      o.scale.copy(t.s);
    }
    const tracks: THREE.KeyframeTrack[] = [];
    for (const [b, arr] of rot) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, arr));
    if (hips && hipsPos) tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, hipsPos));
    return new THREE.AnimationClip(name, duration, tracks);
  }
}

/** Binary glTF of the canonical rig carrying one clip, for the user's clip folder. */
export async function exportClipGlb(canon: Rig, clip: THREE.AnimationClip): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const out = await exporter.parseAsync(canon.root, { binary: true, animations: [clip] });
  if (out instanceof ArrayBuffer) return out;
  return new TextEncoder().encode(JSON.stringify(out)).buffer as ArrayBuffer;
}
