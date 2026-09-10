import * as THREE from "three";
import { loadCharacter, type Character } from "./character";
import { applyDance } from "./dance";
import type { Manifest, PackRef } from "./packs";
import { applyFlail, applyIdle, applyLookAt } from "./pose";
import type { FrameInput, Renderer, StateName } from "./renderer";

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
  private lean = 0;
  private pixel = new Uint8Array(4);

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
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const height = size.y * 1.12;
    const dist = height / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(center.x, center.y + size.y * 0.02, center.z + dist);
    this.camera.lookAt(center.x, center.y, center.z);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  hasClip(state: StateName) {
    const def = this.character?.manifest.states[state];
    return !!def && !!this.character?.hasClip(def.clip);
  }

  clipDuration(state: StateName) {
    const def = this.character?.manifest.states[state];
    return def ? (this.character?.clipDuration(def.clip) ?? 0) : 0;
  }

  private enterState(state: StateName, input: FrameInput) {
    const c = this.character!;
    const def = c.manifest.states[state];
    if (def && c.hasClip(def.clip)) {
      c.play(def.clip, {
        loop: def.loop ?? state !== "poked",
        beatsPerLoop: def.beatsPerLoop,
        bpm: input.music?.bpm,
        playbackRate: def.playbackRate,
      });
    } else {
      c.stop();
    }
    this.state = state;
  }

  frame(input: FrameInput) {
    const c = this.character;
    if (!c) return;
    if (input.state !== this.state) this.enterState(input.state, input);
    c.beginFrame(input.dt);

    const root = c.root;
    root.position.y = 0;

    // Procedural base pose for whatever the clip does not cover.
    if (input.airborne && !this.hasClip("fall")) applyFlail(c, input.t);
    else applyIdle(c, input.t, 1 - input.danceAmount * 0.7);

    let nod = 0;
    let roll = 0;
    if (input.music && !this.hasClip("dance")) {
      ({ nod, roll } = applyDance(c, input.music, input.danceAmount));
    }

    // Poke: hop with the head thrown back, unless the pack has its own poked clip.
    let pokePitch = 0;
    if (input.sincePoke < 0.45 && !this.hasClip("poked")) {
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

    // Lean into horizontal motion while airborne.
    const targetLean = input.airborne ? THREE.MathUtils.clamp(-input.vx / 5000, -0.25, 0.25) : 0;
    this.lean += (targetLean - this.lean) * Math.min(1, input.dt * 12);
    root.rotation.z = this.lean;

    applyLookAt(c, input.yaw, input.pitch + pokePitch + nod, roll);
    c.update(input.dt);
    this.renderer.render(this.scene, this.camera);
    this.renders++;
  }

  /** Dev: raw RGBA at the centre of the drawing buffer plus the GL error state. */
  debugProbe(): string {
    const px = new Uint8Array(4);
    this.gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height * 0.55), 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    return `${Array.from(px).join(",")} err=${this.gl.getError()} lost=${this.gl.isContextLost()} inst=${this.id} renders=${this.renders} same=${this.gl === this.renderer.getContext()}`;
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
