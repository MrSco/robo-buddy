import { applyAttack } from "./pose";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadCharacter, refreshSkins, rodReport, type BoneName, type Character } from "./character";
import { applyDance } from "./dance";
import type { Manifest, PackRef } from "./packs";
import { applyCrouch, applyDangle, applyFlail, applyHeldByArm, applyHeldByLeg, applyIdle, applyLimp, applyLookAt, applySleep } from "./pose";
import { LimbSprings } from "./secondary";
import { MirrorApplier, easePose, type MirrorPose } from "./mocap";
import { canonicalRig } from "./retarget";
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
  private fitX = 0;
  /** CSS pixels reserved under the soles (the taskbar band the window overlaps). */
  groundPx = 0;
  /** CSS pixels a showing speech bubble needs above the head; the fit zooms out to make room. */
  bubblePx = 0;
  /** CSS pixels he must duck so his head stays under the top of the screen (the physics decides). */
  crouchPx = 0;
  private crouchU = 0;
  /** Dev: frames where both arms were straight out sideways, and when it last happened. */
  tposeFrames = 0;
  tposeLast = "";
  /** Pendulum state while held: angle and angular velocity (radians). */
  private swing = 0;
  private swingVel = 0;
  /**
   * How far above his feet the cursor has hold of him, while it has hold of his head or his
   * body. The swing turns the whole model about its own origin, which sits at his feet, so
   * without this the one point the cursor is holding is the one that travels furthest: grab
   * him by the chest, drag sideways, and his chest slid out from under the pointer while his
   * feet stayed put. A grip on a limb does not need it, because the held limb is re-aimed at
   * the cursor and a leg hold already moves the pivot to the top.
   */
  private gripPivot = 0;
  /**
   * 0..1 while the cursor has him by the head or the body, used to hold the chest still.
   * The idle breathes and sways the chest every frame, and while he hangs from a grip that is
   * the very part under the cursor, so a body grab looked loose however well the window
   * tracked. A limb grab hid it, because the held limb is re-aimed over the top of the idle.
   */
  private gripStill = 0;
  private heldAmount = 0;
  private flipAmount = 0;
  private springs = new LimbSprings();
  private springAmount = 0;
  private tumble = 0;
  private tumbleVel = 0;
  private downAmount = 0;
  private talkAmount = 0;
  private mirrorAmount = 0;
  private mirrorApplier: MirrorApplier | null = null;
  /** The pose actually shown: eased toward the latest frame so 30 fps input looks smooth at 60. */
  private mirrorShown: MirrorPose | null = null;
  /** Which side he lies on while knocked down (+1 / -1), chosen when he goes down. */
  private lieSide = 0;

  /** Current body rotation from a throw, radians; used to decide whether a landing knocks him down. */
  get tumbleAngle() {
    return this.tumble;
  }
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

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.4);
    this.key.position.set(1.5, 3, 2.5);
    this.scene.add(this.key);
    this.rim = new THREE.DirectionalLight(0xbfdfff, 0.6);
    this.rim.position.set(-2, 2, -2);
    this.scene.add(this.rim);
    // A neutral room to reflect: metals and glossy paint are black without something to mirror.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.lighting = 1;
  }

  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private rim: THREE.DirectionalLight;
  private lightLevel = 1;
  /** Light and reflection strength; 1 is the designed look. */
  get lighting() {
    return this.lightLevel;
  }
  set lighting(v: number) {
    this.lightLevel = v;
    this.hemi.intensity = 1.6 * v;
    this.key.intensity = 1.4 * v;
    this.rim.intensity = 0.6 * v;
    this.scene.environmentIntensity = 0.7 * v;
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
    refreshSkins(c.root);
    const box = new THREE.Box3().setFromObject(c.root);
    box.getSize(this.baseSize);
    box.getCenter(this.baseCenter);
    this.fitDist = 0;
    this.fitX = this.baseCenter.x;
    this.fitCamera(0, 1);
  }

  /** Bones that bound the body, with a padding (fraction of height) for the flesh around each joint. */
  private static readonly FIT_BONES: Array<[BoneName, number]> = [
    ["head", 0.15], ["neck", 0.08], ["hips", 0.12], ["spine", 0.1], ["chest", 0.12], ["upperChest", 0.12],
    ["leftShoulder", 0.08], ["rightShoulder", 0.08], ["leftUpperArm", 0.08], ["rightUpperArm", 0.08],
    ["leftLowerArm", 0.07], ["rightLowerArm", 0.07], ["leftHand", 0.11], ["rightHand", 0.11],
    ["leftUpperLeg", 0.1], ["rightUpperLeg", 0.1], ["leftLowerLeg", 0.08], ["rightLowerLeg", 0.08],
    ["leftFoot", 0.09], ["rightFoot", 0.09], ["leftToes", 0.06], ["rightToes", 0.06],
  ];

  /**
   * Fit the camera to the pose every frame: the bounds of every bone (padded) must fit the
   * window in both axes, allowing for how far the nearest part leans toward the camera. The
   * feet keep a fixed margin at the bottom and he never zooms in past standing height. Zooms
   * out almost instantly so nothing is ever clipped, and back in gently.
   */
  private fitCamera(dt: number, snap = 0) {
    const c = this.character;
    if (!c) return;
    // Held by the head or the body: the frame stays where it was. This re-centres on his
    // outline every frame, so a body swinging inside the window drags the frame after it and
    // the very point the cursor has hold of slides away, however still the body is being held.
    // A limb hold does not need it, because the held limb is re-aimed at the cursor regardless.
    if (!snap && this.gripStill > 0.5) return;
    const h = this.baseSize.y;
    const floor = this.baseCenter.y - h / 2;
    c.root.updateMatrixWorld(true);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = floor;
    let maxY = floor + h * 0.5;
    let front = -Infinity;
    // Lowest joint without padding: nothing hangs below the soles when he stands, so padding
    // the feet would just float him above the taskbar.
    let lowest = floor;
    for (const [name, pad] of Renderer3D.FIT_BONES) {
      const b = c.bone(name);
      if (!b) continue;
      b.getWorldPosition(this.tmp);
      const p = h * pad;
      if (this.tmp.x - p < minX) minX = this.tmp.x - p;
      if (this.tmp.x + p > maxX) maxX = this.tmp.x + p;
      if (this.tmp.y < lowest) lowest = this.tmp.y;
      if (this.tmp.y - p < minY) minY = this.tmp.y - p;
      if (this.tmp.y + p > maxY) maxY = this.tmp.y + p;
      if (this.tmp.z + p > front) front = this.tmp.z + p;
    }
    if (!Number.isFinite(minX)) {
      minX = this.baseCenter.x - this.baseSize.x / 2;
      maxX = this.baseCenter.x + this.baseSize.x / 2;
      maxY = floor + h;
      front = this.baseCenter.z + this.baseSize.z / 2;
    }
    // Standing: two percent of his height under the soles. Tumbling or lying: the lowest
    // joint plus a little, so a shoulder on the floor is still inside the window.
    // The soles rest `groundPx` above the window's bottom edge (on the taskbar's top edge).
    const groundUnits = (this.groundPx * (2 * Math.max(this.fitDist, 0.05) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) / this.cssH;
    const y0 = Math.min(floor - h * 0.01, lowest - h * 0.03) - groundUnits;
    void minY;
    const unitsPerPx = (2 * Math.max(this.fitDist, 0.05) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.cssH;
    const bubbleUnits = this.bubblePx > 0 ? (this.bubblePx + 16) * unitsPerPx : 0;
    const y1 = Math.max(maxY + h * 0.1 + bubbleUnits, y0 + h * 1.3);
    const halfV = (y1 - y0) / 2;
    const cx = (minX + maxX) / 2;
    const halfH = (maxX - minX) / 2 + h * 0.05;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanH = tanV * (this.cssW / this.cssH);
    // Anything closer to the camera than the standing body's front needs the camera further back.
    const depth = Math.max(0, front - (this.baseCenter.z + this.baseSize.z / 2));
    const dist = Math.max(halfV / tanV, halfH / tanH) + depth;
    // Whatever pushed the camera back, the bottom of the view stays just under his feet;
    // the extra room goes above him, not below.
    const cy = y0 + dist * tanV;
    const k = snap ? 1 : 1 - Math.exp(-dt * (dist > this.fitDist ? 20 : 3));
    this.fitDist += (dist - this.fitDist) * k;
    const kc = snap ? 1 : 1 - Math.exp(-dt * 6);
    this.fitY += (cy - this.fitY) * kc;
    this.fitX += (cx - this.fitX) * kc;
    this.camera.position.set(this.fitX, this.fitY, this.baseCenter.z + this.fitDist);
    this.camera.lookAt(this.fitX, this.fitY, this.baseCenter.z);
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

  private idleClipName() {
    return this.character?.manifest.states.idle?.clip ?? "";
  }

  /** Switch clips whenever main.ts resolves a different one (or none) for this frame. */
  private syncClip(input: FrameInput) {
    const c = this.character!;
    const want = input.clip;
    const key = want ? want.name + "|" + input.state + "|" + (input.attack?.start ?? "") : null;
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
    const gripTarget = grab && !limbHold ? this.baseSize.y * (grab.part === "head" ? 0.92 : 0.6) : 0;
    this.gripPivot += (gripTarget - this.gripPivot) * Math.min(1, input.dt * 10);
    this.gripStill += ((grab && !limbHold ? 1 : 0) - this.gripStill) * Math.min(1, input.dt * 10);
    const down = input.state === "down";
    // Held by a limb the hanging clip still gives the body its slack base; the held limb and
    // the free ones are re-aimed on top of it, so the dance never keeps going in his hands.
    this.syncClip(input);
    // Knocked down: the clip freezes where it was and the limp pose is laid over it.
    c.beginFrame(down ? 0 : input.dt);

    const root = c.root;
    root.position.y = 0;
    // Hold poses aim limbs at world directions, so they must be computed in the unrotated
    // frame: last frame's flip/tumble/swing would otherwise fold the body over itself.
    root.rotation.z = 0;
    const clipDriven = input.clip !== null && !limbHold;
    // No music moves while he is in the air, in the user's hand or on the floor.
    const calm = input.state === "dragged" || input.airborne || input.state === "land" || down || input.state === "hang" || input.state === "mantle";

    // Procedural base pose for whatever the clip does not cover.
    if (input.airborne && !clipDriven && !down && input.flail) applyFlail(c, input.t);
    // Held by the head or the body he hangs dead from the grip rather than breathing in it.
    // The arms still drop, which that pose does regardless of this, and the dangle re-aims them.
    else applyIdle(c, input.t, (calm ? 1 : 1 - input.danceAmount * 0.7) * (1 - this.gripStill));

    // Held: the body hangs from whatever part the cursor has. A pack that names its own held
    // clip keeps it for head and torso holds; otherwise everything dangles procedurally.
    const packHeldClip = !!grab && !limbHold && input.clip !== null && input.clip.name !== this.idleClipName();
    const wantHold = !!grab && !packHeldClip;
    this.heldAmount += ((wantHold ? 1 : 0) - this.heldAmount) * Math.min(1, input.dt * 10);
    const upsideDown = grab?.part === "leftLeg" || grab?.part === "rightLeg";
    this.flipAmount += ((upsideDown ? 1 : 0) - this.flipAmount) * Math.min(1, input.dt * 6);
    if (this.heldAmount > 0.001 && this.lastGrab) {
      if (this.lastGrab === "leftArm" || this.lastGrab === "rightArm") {
        applyHeldByArm(c, this.lastGrab === "leftArm" ? "left" : "right", input.t, this.heldAmount);
      } else if (this.lastGrab === "leftLeg" || this.lastGrab === "rightLeg") {
        applyHeldByLeg(c, this.lastGrab === "leftLeg" ? "left" : "right", input.t, this.heldAmount);
      } else {
        applyDangle(c, input.t, this.heldAmount);
      }
    }

    let nod = 0;
    let roll = 0;
    // The procedural groove only layers over the plain idle; a crouch, fidget or the texting
    // clip would otherwise bob and shuffle along with it while the music level rises.
    const plainBase = !input.clip || input.clip.name === this.idleClipName();
    if (input.music && !calm && plainBase && !(input.state === "dance" && clipDriven)) {
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
    // Tumble while airborne after a throw; knocked down he flops onto his side and lies
    // there; otherwise the spring pulls him upright again.
    const wrap = (a: number) => ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.downAmount += ((down ? 1 : 0) - this.downAmount) * Math.min(1, input.dt * (down ? 5 : 3));
    if (down && this.lieSide === 0) {
      this.lieSide = Math.abs(this.tumble) > 0.25 ? Math.sign(this.tumble) : Math.sign(input.vx) || (Math.random() < 0.5 ? -1 : 1);
    }
    if (!down) this.lieSide = 0;
    if (input.airborne && Math.abs(input.spin) > 0.01 && !down) {
      this.tumbleVel += (input.spin - this.tumbleVel) * Math.min(1, input.dt * 4);
      this.tumble += this.tumbleVel * input.dt;
    } else if (down) {
      // Fall over to the nearest side, softly, and stay there.
      const err = wrap(this.lieSide * Math.PI * 0.5 - this.tumble);
      this.tumbleVel += (22 * err - 7 * this.tumbleVel) * input.dt;
      this.tumble = wrap(this.tumble + this.tumbleVel * input.dt);
    } else {
      // Shortest way back to upright (or to the flip target).
      this.tumble = wrap(this.tumble);
      this.tumbleVel += (-40 * this.tumble - 9 * this.tumbleVel) * input.dt;
      this.tumble += this.tumbleVel * input.dt;
      if (Math.abs(this.tumble) < 0.002 && Math.abs(this.tumbleVel) < 0.01) this.tumble = this.tumbleVel = 0;
    }
    // Upside down when held by a leg: the whole body flips about the grab side.
    const flip = this.flipAmount * Math.PI * (this.lastGrab === "leftLeg" ? -1 : 1);
    root.rotation.z = this.lean + this.swing + flip + this.tumble;
    // Tumbling about the feet would swing him off screen; offset so the spin is about the
    // middle, and keep whichever point is lowest resting on the floor line, so lying on his
    // side he is actually on the ground rather than hovering at standing-centre height.
    root.position.x = 0;
    if (Math.abs(this.tumble) > 0.001) {
      const half = this.baseSize.y * 0.5;
      const thick = this.baseSize.y * 0.16;
      const centreY = half * Math.abs(Math.cos(this.tumble)) + thick * Math.abs(Math.sin(this.tumble));
      root.position.y += centreY - half * Math.cos(this.tumble);
      root.position.x = half * Math.sin(this.tumble);
    }
    // Keep the feet on the floor when upright; when flipped, the pivot moves to the top.
    root.position.y += this.flipAmount * (this.baseSize.y * 0.98);
    // Swing about the point being held rather than about his feet, so what the cursor has hold
    // of stays under the cursor and the rest of him is what swings.
    if (this.gripPivot > 0.001) {
      root.position.x += this.gripPivot * Math.sin(root.rotation.z);
      root.position.y += this.gripPivot * (1 - Math.cos(root.rotation.z));
    }
    // Turn to face along the floor while walking, back to the viewer otherwise.
    this.facing += (input.facing - this.facing) * Math.min(1, input.dt * 8);
    root.rotation.y = this.facing;

    // Copying the webcam: the captured pose replaces the clip's limbs, torso and head.
    this.mirrorAmount += ((input.mirror ? 1 : 0) - this.mirrorAmount) * Math.min(1, input.dt * 8);
    if (input.mirror) {
      if (!this.mirrorApplier) void canonicalRig().then((r) => (this.mirrorApplier = new MirrorApplier(r)));
      else {
        this.mirrorShown = easePose(this.mirrorShown, input.mirror, Math.min(1, 1 - Math.exp(-input.dt * 22)));
        this.mirrorApplier.apply(c.rig, this.mirrorShown, this.mirrorAmount);
      }
    } else this.mirrorShown = null;
    const awake = 1 - input.sleepAmount;
    const lookScale = awake * (1 - Math.min(1, Math.abs(this.facing) / 1.2)) * (1 - this.downAmount);
    // Talking: quick little nods, like someone chatting.
    this.talkAmount += ((input.talking ? 1 : 0) - this.talkAmount) * Math.min(1, input.dt * 6);
    if (this.talkAmount > 0.001) nod += (Math.sin(input.t * 9) * 0.05 + Math.sin(input.t * 2.3) * 0.03) * this.talkAmount;
    if (this.mirrorAmount < 0.5) applyLookAt(c, input.yaw * lookScale, (input.pitch + pokePitch + nod) * lookScale, roll * awake);
    // Secondary motion while held, airborne or down: limbs lag behind the window's acceleration.
    // After look-at, which resets the head and neck each frame, so the head spring survives.
    const wantSprings = (input.state === "dragged" || input.airborne || input.state === "land" || down || input.state === "hang") && !input.mirror;
    this.springAmount += ((wantSprings ? 1 : 0) - this.springAmount) * Math.min(1, input.dt * (wantSprings ? 8 : 3));
    // Whatever he is held by is pinned, the head included. Holding him by the head used to
    // leave the neck spring running, so the one point welded to the cursor was the one that
    // wobbled, while a limb grab pinned cleanly. The torso has no spring of its own: what hangs
    // off it is the dangle pose and the other chains, which is the ragdoll doing its job.
    const rigid = grab && grab.part !== "torso" ? grab.part : null;
    this.springs.update(c, input.dt, input.t, input.accelX, input.accelY, this.springAmount, rigid);
    applyLimp(c, this.downAmount);
    // Ducking under the top of the screen, eased so it reads as him bending, not snapping.
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const crouchTarget = (this.crouchPx * 2 * Math.max(this.fitDist, 0.05) * tanV) / this.cssH;
    this.crouchU += (crouchTarget - this.crouchU) * Math.min(1, input.dt * 6);
    if (this.crouchU > 1e-4) applyCrouch(c, this.crouchU);
    // A pack with a sleep clip of its own poses him; a clip flagged as a base is only there to
    // keep the mixer weighted, so the slump still goes over it.
    const posedAsleep = input.state === "sleep" && clipDriven && !input.clip?.base;
    if (!posedAsleep) applySleep(c, input.t, input.sleepAmount);
    if (input.attack?.procedural) applyAttack(c, input.attack.kind, input.attack.progress);
    c.update(input.dt);
    this.detectTpose(c, input);
    this.fitCamera(input.dt);
    this.renderer.render(this.scene, this.camera);
    this.renders++;
  }

  /** Dev: the rest pose showing through looks like a T: both upper arms straight out sideways. */
  private detectTpose(c: Character, input: FrameInput) {
    if (Math.abs(this.tumble) > 0.3 || this.flipAmount > 0.1) return;
    const out = (upper: THREE.Object3D | undefined, lower: THREE.Object3D | undefined) => {
      if (!upper || !lower) return false;
      upper.getWorldPosition(this.tmp);
      const b = lower.getWorldPosition(new THREE.Vector3()).sub(this.tmp).normalize();
      return Math.abs(b.y) < 0.25 && Math.abs(b.x) > 0.9;
    };
    c.root.updateMatrixWorld(true);
    if (out(c.bone("leftUpperArm"), c.bone("leftLowerArm")) && out(c.bone("rightUpperArm"), c.bone("rightLowerArm"))) {
      this.tposeFrames++;
      this.tposeLast = `${input.state}/${input.clip?.name ?? "-"}@${input.t.toFixed(1)}`;
    }
  }

  /** Dev: raw RGBA at the centre of the drawing buffer plus the GL error state. */
  /**
   * Dev: sampled skinned vertices whose distance to the bone they follow most has grown the
   * most since the bind pose. Rigid skinning keeps that distance; growth means the vertex is
   * being pulled between bones that have parted, which is what a spike is.
   */
  private spikeBase = new WeakMap<THREE.SkinnedMesh, Array<{ i: number; bone: number; d0: number }>>();
  private spikeReport(): string {
    const c = this.character;
    if (!c) return "";
    const v = new THREE.Vector3();
    const bp = new THREE.Vector3();
    const bind = new THREE.Matrix4();
    const worst: Array<{ name: string; d: number }> = [];
    c.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.skeleton) return;
      const pos = m.geometry.getAttribute("position");
      const si = m.geometry.getAttribute("skinIndex");
      const sw = m.geometry.getAttribute("skinWeight");
      if (!pos || !si || !sw) return;
      let base = this.spikeBase.get(m);
      if (!base) {
        base = [];
        for (let i = 0; i < pos.count; i += 40) {
          let best = 0;
          let bw = -1;
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            if (w > bw) {
              bw = w;
              best = si.getComponent(i, k);
            }
          }
          if (!m.skeleton.bones[best]) continue;
          // Bind-pose distance: raw geometry in world against the bone's bind placement.
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          bind.copy(m.skeleton.boneInverses[best]).invert().premultiply(m.matrixWorld);
          bp.setFromMatrixPosition(bind);
          base.push({ i, bone: best, d0: v.distanceTo(bp) });
        }
        this.spikeBase.set(m, base);
      }
      for (const e of base) {
        m.getVertexPosition(e.i, v);
        v.applyMatrix4(m.matrixWorld);
        m.skeleton.bones[e.bone].getWorldPosition(bp);
        const d = (v.distanceTo(bp) - e.d0) / Math.max(1e-3, c.height);
        if (worst.length < 3 || d > worst[worst.length - 1].d) {
          worst.push({ name: m.skeleton.bones[e.bone].name, d });
          worst.sort((a, b) => b.d - a.d);
          if (worst.length > 3) worst.pop();
        }
      }
    });
    // Triangle stretch: edges that grew most since bind, with the dominant bone at each end.
    const e0 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const stretched: Array<{ label: string; r: number }> = [];
    c.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.skeleton || !m.geometry.index) return;
      const pos = m.geometry.getAttribute("position");
      const si = m.geometry.getAttribute("skinIndex");
      const sw = m.geometry.getAttribute("skinWeight");
      const idx = m.geometry.index;
      const topBone = (i: number) => {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        return m.skeleton.bones[best]?.name ?? "?";
      };
      for (let t = 0; t + 2 < idx.count; t += 3 * 7) {
        const ia = idx.getX(t), ib = idx.getX(t + 1);
        e0.fromBufferAttribute(pos, ia); e1.fromBufferAttribute(pos, ib);
        const bindLen = e0.distanceTo(e1);
        if (bindLen < 1e-6) continue;
        m.getVertexPosition(ia, e0); m.getVertexPosition(ib, e1);
        const r = e0.distanceTo(e1) / bindLen;
        if (r > 2 && (stretched.length < 3 || r > stretched[stretched.length - 1].r)) {
          stretched.push({ label: `${topBone(ia)}>${topBone(ib)}`, r });
          stretched.sort((a, b) => b.r - a.r);
          if (stretched.length > 3) stretched.pop();
        }
      }
    });
    return worst.map((w) => `${w.name}:${w.d.toFixed(2)}`).join(",") + " edges=" + stretched.map((s) => `${s.label}x${s.r.toFixed(0)}`).join(",");
  }
  private probeCalls = 0;
  private lastSpike = "";

  debugProbe(): string {
    if (this.probeCalls++ % 10 === 0) this.lastSpike = this.spikeReport();
    const px = new Uint8Array(4);
    this.gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height * 0.55), 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    const c = this.character;
    const v = (o: THREE.Object3D | undefined) => (o ? o.getWorldPosition(this.tmp).toArray().map((n) => n.toFixed(2)).join("/") : "-");
    const geo = c ? `hips=${v(c.bone("hips"))} head=${v(c.bone("head"))} base=${this.baseCenter.toArray().map((n) => n.toFixed(2)).join("/")} size=${this.baseSize.toArray().map((n) => n.toFixed(2)).join("/")} fit=${this.fitDist.toFixed(2)}/${this.fitY.toFixed(2)} rootScale=${c.root.scale.x.toFixed(3)}` : "";
    return `${Array.from(px).join(",")} err=${this.gl.getError()} lost=${this.gl.isContextLost()} inst=${this.id} renders=${this.renders} same=${this.gl === this.renderer.getContext()} tpose=${this.tposeFrames}:${this.tposeLast} ${geo} spike=${this.lastSpike} rods=[${rodReport}]`;
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
