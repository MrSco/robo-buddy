import * as THREE from "three";
import { loadCharacter, type Character } from "./character";
import { applyDance } from "./dance";
import type { Manifest, PackRef } from "./packs";
import { applyFlail, applyHeldByArm, applyHeldByLeg, applyIdle, applyLookAt, applySleep } from "./pose";
import type { FrameInput, GrabPart, Renderer, StateName } from "./renderer";

/** three.js renderer for GLB / VRM characters: clips via the mixer, procedural layers on top. */
let instances = 0;

export class Renderer3D implements Renderer {
  readonly kind = "3d" as const;
  readonly id = ++instances;
  /** Dev: number of render() calls. */
  renders = 0;
  private renderer: THREE.WebGLRenderer;
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  private scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private character: Character | null = null;
  private canvas: HTMLCanvasElement;
  private state: StateName | null = null;
  private playing: string | null = null;
  private facing = 0;
  private lean = 0;
  private pixel = new Uint8Array(4);
  private cssW = 320;
  private cssH = 440;
  private crown = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  /** Camera fit state: distance and look-at height, eased so zooming is smooth. */
  private fitDist = 0;
  private fitY = 0;
  /** Pendulum state while held: angle and angular velocity (radians). */
  private swing = 0;
  private swingVel = 0;
  private heldAmount = 0;
  private flipAmount = 0;
  private lastGrab: GrabPart | null = null;
  private baseCenter = new THREE.Vector3();
  private baseSize = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.gl = this.renderer.getContext();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1.5, 3, 2.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfdfff, 0.6);
    rim.position.set(-2, 2, -2);
    this.scene.add(rim);
  }

  async load(pack: PackRef, manifest: Manifest) {
    const next = await loadCharacter(pack, manifest);
    this.character?.dispose();
    this.character = next;
    this.scene.add(next.root);
    this.frameCharacter();
    this.state = null;
  }

  unload() {
    this.character?.dispose();
    this.character = null;
    this.state = null;
    this.renderer.clear();
  }

  private frameCharacter() {
    const c = this.character;
    if (!c) return;
    c.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c.root);
    box.getSize(this.baseSize);
    box.getCenter(this.baseCenter);
    this.fitDist = 0;
    this.fitCamera(0, 1);
  }

  /**
   * Fit the camera to the pose actually on screen: the standing height plus however far
   * the hands (or head) reach above it, so raised arms are never cut off. Eased per frame.
   */
  private fitCamera(dt: number, snap = 0) {
    const c = this.character;
    if (!c) return;
    const h = this.baseSize.y;
    const bottom = this.baseCenter.y - h / 2;
    let top = bottom + h;
    c.root.updateMatrixWorld(true);
    for (const n of ["head", "leftHand", "rightHand", "leftLowerArm", "rightLowerArm"] as const) {
      const b = c.bone(n);
      if (!b) continue;
      b.getWorldPosition(this.tmp);
      const y = this.tmp.y + (n === "head" ? h * 0.13 : h * 0.14);
      if (y > top) top = y;
    }
    // Keep the feet at a fixed margin above the window bottom; grow upward as needed.
    const extent = Math.max(h * 1.3, (top - bottom) * 1.14 + h * 0.08);
    const dist = extent / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const targetY = bottom - h * 0.06 + extent / 2;
    const k = snap ? 1 : 1 - Math.exp(-dt * 6);
    this.fitDist += (dist - this.fitDist) * k;
    this.fitY += (targetY - this.fitY) * k;
    this.camera.position.set(this.baseCenter.x, this.fitY, this.baseCenter.z + this.fitDist);
    this.camera.lookAt(this.baseCenter.x, this.fitY, this.baseCenter.z);
  }

  resize(w: number, h: number) {
    this.cssW = w;
    this.cssH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  hasClip(state: StateName) {
    const def = this.character?.manifest.states[state];
    return !!def && !!this.character?.hasClip(def.clip);
  }

  clipDuration(name: string) {
    return this.character?.clipDuration(name) ?? 0;
  }

  /** Switch clips whenever main.ts resolves a different one (or none) for this frame. */
  private syncClip(input: FrameInput) {
    const c = this.character!;
    const want = input.clip;
    const key = want ? want.name + "|" + input.state : null;
    if (key === this.playing && input.state === this.state) return;
    if (want && c.hasClip(want.name)) {
      c.play(want.name, {
        loop: want.loop,
        beatsPerLoop: want.beatsPerLoop,
        bpm: input.music?.bpm,
        playbackRate: want.playbackRate,
      });
    }
    // With no clip for this state the last clip keeps running as the base pose and the
    // procedural layers (flail, sleep, hold) go on top. Stopping it would leave a T-pose.
    this.playing = key;
    this.state = input.state;
  }

  frame(input: FrameInput) {
    const c = this.character;
    if (!c) return;
    const grab = input.state === "dragged" ? input.grab : null;
    if (grab) this.lastGrab = grab.part;
    const limbHold = !!grab && grab.part !== "head" && grab.part !== "torso";
    // Held by a limb: keep whatever clip was playing as the base and pose the limbs on top,
    // instead of switching to the two-handed hanging clip.
    this.syncClip(limbHold ? { ...input, clip: null } : input);
    c.beginFrame(input.dt);

    const root = c.root;
    root.position.y = 0;
    const clipDriven = input.clip !== null && !limbHold;

    // Procedural base pose for whatever the clip does not cover.
    if (input.airborne && !clipDriven) applyFlail(c, input.t);
    else applyIdle(c, input.t, 1 - input.danceAmount * 0.7);

    // Held by a limb: pose that limb toward the cursor and let the body hang from it.
    this.heldAmount += ((limbHold ? 1 : 0) - this.heldAmount) * Math.min(1, input.dt * 10);
    const upsideDown = grab?.part === "leftLeg" || grab?.part === "rightLeg";
    this.flipAmount += ((upsideDown ? 1 : 0) - this.flipAmount) * Math.min(1, input.dt * 6);
    if (this.heldAmount > 0.001 && this.lastGrab) {
      if (this.lastGrab === "leftArm" || this.lastGrab === "rightArm") {
        applyHeldByArm(c, this.lastGrab === "leftArm" ? "left" : "right", input.t, this.heldAmount);
      } else if (this.lastGrab === "leftLeg" || this.lastGrab === "rightLeg") {
        applyHeldByLeg(c, this.lastGrab === "leftLeg" ? "left" : "right", input.t, this.heldAmount);
      }
    }

    let nod = 0;
    let roll = 0;
    if (input.music && !(input.state === "dance" && clipDriven)) {
      ({ nod, roll } = applyDance(c, input.music, input.danceAmount));
    }

    // Poke: hop with the head thrown back, unless the pack has its own poked clip.
    let pokePitch = 0;
    if (input.sincePoke < 0.45 && !(input.state === "poked" && clipDriven)) {
      const p = input.sincePoke / 0.45;
      root.position.y += Math.sin(Math.PI * p) * 0.06;
      pokePitch = Math.sin(Math.PI * Math.min(1, p * 1.4)) * 0.45;
    }

    // Landing squash.
    let squash = 0;
    if (input.sinceLand < 0.3) {
      squash = Math.sin(Math.PI * (input.sinceLand / 0.3)) * 0.18 * input.landStrength;
    }
    root.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);

    // Lean into horizontal motion while airborne; pendulum swing while held.
    const targetLean = input.airborne ? THREE.MathUtils.clamp(-input.vx / 5000, -0.25, 0.25) : 0;
    this.lean += (targetLean - this.lean) * Math.min(1, input.dt * 12);
    if (grab) {
      // Dragging sideways pushes the body the other way; gravity pulls it back, damped.
      const drive = THREE.MathUtils.clamp(-grab.vx / 6000, -0.6, 0.6);
      const k = 18;
      const damping = 4;
      this.swingVel += (k * (drive - this.swing) - damping * this.swingVel) * input.dt;
      this.swing += this.swingVel * input.dt;
    } else {
      this.swingVel += (-30 * this.swing - 6 * this.swingVel) * input.dt;
      this.swing += this.swingVel * input.dt;
    }
    // Upside down when held by a leg: the whole body flips about the grab side.
    const flip = this.flipAmount * Math.PI * (this.lastGrab === "leftLeg" ? -1 : 1);
    root.rotation.z = this.lean + this.swing + flip;
    // Keep the feet on the floor when upright; when flipped, the pivot moves to the top.
    root.position.y += this.flipAmount * (this.baseSize.y * 0.98);
    // Turn to face along the floor while walking, back to the viewer otherwise.
    this.facing += (input.facing - this.facing) * Math.min(1, input.dt * 8);
    root.rotation.y = this.facing;

    const awake = 1 - input.sleepAmount;
    const lookScale = awake * (1 - Math.min(1, Math.abs(this.facing) / 1.2));
    applyLookAt(c, input.yaw * lookScale, (input.pitch + pokePitch + nod) * lookScale, roll * awake);
    if (!(input.state === "sleep" && clipDriven)) applySleep(c, input.t, input.sleepAmount);
    c.update(input.dt);
    this.fitCamera(input.dt);
    this.renderer.render(this.scene, this.camera);
    this.renders++;
  }

  /** Dev: raw RGBA at the centre of the drawing buffer plus the GL error state. */
  debugProbe(): string {
    const px = new Uint8Array(4);
    this.gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height * 0.55), 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    return `${Array.from(px).join(",")} err=${this.gl.getError()} lost=${this.gl.isContextLost()} inst=${this.id} renders=${this.renders} same=${this.gl === this.renderer.getContext()}`;
  }

  /** Screen-space positions of the bones that matter for grabbing. */
  private screenPos(b: THREE.Object3D | undefined): { x: number; y: number } | null {
    if (!b) return null;
    b.getWorldPosition(this.tmp).project(this.camera);
    return { x: ((this.tmp.x + 1) / 2) * this.cssW, y: ((1 - this.tmp.y) / 2) * this.cssH };
  }

  partAt(x: number, y: number): GrabPart | null {
    const c = this.character;
    if (!c) return null;
    c.root.updateMatrixWorld(true);
    const candidates: Array<[GrabPart, THREE.Object3D | undefined]> = [
      ["head", c.bone("head")],
      ["torso", c.bone("chest") ?? c.bone("spine")],
      ["torso", c.bone("hips")],
      ["leftArm", c.bone("leftHand")],
      ["leftArm", c.bone("leftLowerArm")],
      ["leftArm", c.bone("leftUpperArm")],
      ["rightArm", c.bone("rightHand")],
      ["rightArm", c.bone("rightLowerArm")],
      ["rightArm", c.bone("rightUpperArm")],
      ["leftLeg", c.bone("leftFoot")],
      ["leftLeg", c.bone("leftLowerLeg")],
      ["leftLeg", c.bone("leftUpperLeg")],
      ["rightLeg", c.bone("rightFoot")],
      ["rightLeg", c.bone("rightLowerLeg")],
      ["rightLeg", c.bone("rightUpperLeg")],
    ];
    let best: GrabPart | null = null;
    let bestD = Infinity;
    for (const [part, bone] of candidates) {
      const p = this.screenPos(bone);
      if (!p) continue;
      // The torso is wide; give it a little extra reach so clicks on the shirt count.
      const d = Math.hypot(p.x - x, p.y - y) * (part === "torso" ? 0.7 : 1);
      if (d < bestD) {
        bestD = d;
        best = part;
      }
    }
    return bestD < this.cssH * 0.35 ? best : null;
  }

  holdPoint(): { x: number; y: number } | null {
    const c = this.character;
    if (!c || !this.lastGrab) return null;
    c.root.updateMatrixWorld(true);
    switch (this.lastGrab) {
      case "leftArm":
        return this.screenPos(c.bone("leftHand"));
      case "rightArm":
        return this.screenPos(c.bone("rightHand"));
      case "leftLeg":
        return this.screenPos(c.bone("leftFoot"));
      case "rightLeg":
        return this.screenPos(c.bone("rightFoot"));
      case "head": {
        const p = this.screenPos(c.bone("head"));
        return p ? { x: p.x, y: p.y - this.cssH * 0.06 } : null;
      }
      default: {
        // Hanging by both hands: midway between them.
        const l = this.screenPos(c.bone("leftHand"));
        const r = this.screenPos(c.bone("rightHand"));
        return l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 } : null;
      }
    }
  }

  bubbleAnchor() {
    const c = this.character;
    const head = c?.bone("head");
    if (!c || !head) return { x: this.cssW / 2, y: this.cssH * 0.15 };
    // The head bone sits at the base of the skull; the crown is roughly 13% of the height above it.
    head.getWorldPosition(this.crown);
    this.crown.y += c.height * 0.13;
    this.crown.project(this.camera);
    return { x: ((this.crown.x + 1) / 2) * this.cssW, y: ((1 - this.crown.y) / 2) * this.cssH };
  }

  alphaAt(x: number, y: number): number {
    const ratio = this.renderer.getPixelRatio();
    const px = Math.floor(x * ratio);
    const py = Math.floor(this.canvas.height - y * ratio);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return 0;
    this.gl.readPixels(px, py, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel);
    return this.pixel[3];
  }

  /** Dev hook. */
  get debugCharacter() {
    return this.character;
  }
}
