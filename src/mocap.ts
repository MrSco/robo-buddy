/**
 * Webcam motion capture. MediaPipe gives 33 body landmarks; this turns them into world-space
 * rotation deltas (relative to a T-pose) for the canonical rig's humanoid bones, which the
 * same delta method the clip retargeter uses then puts on any character. Recorded frames
 * become an ordinary clip on the canonical rig, exported as GLB into the user's library.
 */
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { BoneName } from "./humanoid";
import { R180, R180_INV, worldOf, type Rig } from "./retarget";

/** Bones a pose carries, in payload order. */
export const MIRROR_BONES: BoneName[] = [
  "hips", "chest", "head",
  "leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm",
  "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
];

/** One captured pose: world rotation deltas per MIRROR_BONES (x,y,z,w each) and a hips height offset (canonical metres). */
export interface MirrorPose {
  d: number[];
  hy: number;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

// MediaPipe pose landmark indices.
const LM = { nose: 0, lEar: 7, rEar: 8, lSho: 11, rSho: 12, lElb: 13, rElb: 14, lWri: 15, rWri: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28 } as const;

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
  /** T-pose world direction (bone to child) of each limb bone on the canonical rig. */
  private tDir = new Map<BoneName, THREE.Vector3>();
  private tBasisInv = new THREE.Matrix4();
  private filters: OneEuro[] = [];
  private calibLeg = 0;
  private last: MirrorPose | null = null;

  constructor(private canon: Rig) {
    const world = worldOf(canon, canon.rest);
    const pairs: Array<[BoneName, BoneName]> = [
      ["leftUpperArm", "leftLowerArm"], ["leftLowerArm", "leftHand"],
      ["rightUpperArm", "rightLowerArm"], ["rightLowerArm", "rightHand"],
      ["leftUpperLeg", "leftLowerLeg"], ["leftLowerLeg", "leftFoot"],
      ["rightUpperLeg", "rightLowerLeg"], ["rightLowerLeg", "rightFoot"],
    ];
    for (const [a, b] of pairs) {
      const oa = canon.bones.get(a);
      const ob = canon.bones.get(b);
      if (!oa || !ob) continue;
      this.tDir.set(a, world.get(ob)!.p.clone().sub(world.get(oa)!.p).normalize());
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
  }

  /** `world`: 33 MediaPipe world landmarks (metres, hip-centred). `vis`: per-landmark visibility 0..1. */
  solve(world: Landmark[], vis: number[] | undefined, t: number): MirrorPose | null {
    if (world.length < 29) return this.last;
    // Into three.js space, mirrored: x flips (mirror), y up, z toward the viewer.
    const p: THREE.Vector3[] = [];
    for (let i = 0; i < 33; i++) {
      const l = world[i];
      p.push(new THREE.Vector3(this.filters[i * 3].filter(-l.x, t), this.filters[i * 3 + 1].filter(-l.y, t), this.filters[i * 3 + 2].filter(-l.z, t)));
    }
    const ok = (i: number) => !vis || (vis[i] ?? 1) > 0.45;
    const d: number[] = new Array(MIRROR_BONES.length * 4).fill(0);
    const put = (name: BoneName, q: THREE.Quaternion) => {
      const i = MIRROR_BONES.indexOf(name);
      d[i * 4] = q.x;
      d[i * 4 + 1] = q.y;
      d[i * 4 + 2] = q.z;
      d[i * 4 + 3] = q.w;
    };
    for (let i = 0; i < MIRROR_BONES.length; i++) d[i * 4 + 3] = 1; // identity by default

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
      // Tilt the head basis a little toward the nose so looking down/up reads.
      const fwd = p[LM.nose].clone().sub(midEar);
      up.addScaledVector(fwd, 0.35);
      put("head", basis(right, up));
    }
    const limb = (name: BoneName, from: number, to: number) => {
      if (!ok(from) || !ok(to)) return;
      const dir = p[to].clone().sub(p[from]);
      if (dir.lengthSq() < 1e-6) return;
      const rest = this.tDir.get(name);
      if (!rest) return;
      qTmp.setFromUnitVectors(rest, dir.normalize());
      put(name, qTmp.clone());
    };
    limb("rightUpperArm", LM.lSho, LM.lElb);
    limb("rightLowerArm", LM.lElb, LM.lWri);
    limb("leftUpperArm", LM.rSho, LM.rElb);
    limb("leftLowerArm", LM.rElb, LM.rWri);
    limb("rightUpperLeg", LM.lHip, LM.lKnee);
    limb("rightLowerLeg", LM.lKnee, LM.lAnk);
    limb("leftUpperLeg", LM.rHip, LM.rKnee);
    limb("leftLowerLeg", LM.rKnee, LM.rAnk);

    // Hips height from the vertical hip-to-ankle span, relative to the first frames.
    let hy = 0;
    if (ok(LM.lAnk) && ok(LM.rAnk)) {
      const midAnk = p[LM.lAnk].clone().add(p[LM.rAnk]).multiplyScalar(0.5);
      const leg = midHip.y - midAnk.y;
      if (this.calibLeg <= 0) this.calibLeg = leg;
      else this.calibLeg = Math.max(this.calibLeg, leg); // standing tall is the reference
      if (this.calibLeg > 0.2) hy = ((leg - this.calibLeg) / this.calibLeg) * this.canon.hipHeight;
    }
    this.last = { d, hy };
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
      if (b) index.set(b, i);
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
    this.frames.push({ t: t - this.start, pose: { d: pose.d.slice(), hy: pose.hy } });
  }

  /** A clip on the canonical rig, sampled at 30 fps; loops cleanly by easing the ends together. */
  toClip(canon: Rig, name: string, loop: boolean): THREE.AnimationClip | null {
    if (this.frames.length < 6) return null;
    const applier = new MirrorApplier(canon);
    const fps = 30;
    const duration = this.frames[this.frames.length - 1].t;
    const n = Math.max(2, Math.round(duration * fps) + 1);
    const times = new Float32Array(n);
    const bones = MIRROR_BONES.map((b) => canon.bones.get(b)).filter((b): b is THREE.Object3D => !!b);
    const rot = new Map<THREE.Object3D, Float32Array>();
    for (const b of bones) rot.set(b, new Float32Array(n * 4));
    const hips = canon.bones.get("hips");
    const hipsPos = hips ? new Float32Array(n * 3) : null;
    // Reset the canonical rig to rest before sampling.
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
      // Blend the tail into the head over the last half second so loops do not snap.
      let pose = this.frames[k].pose;
      if (loop && duration > 2 && duration - t < 0.5) {
        const a = 1 - (duration - t) / 0.5;
        const head = this.frames[0].pose;
        pose = { d: pose.d.map((v, j) => v * (1 - a) + head.d[j] * a), hy: pose.hy * (1 - a) + head.hy * a };
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
