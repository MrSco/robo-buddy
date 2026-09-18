import { PreviewLoading } from "./preview-loading";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadCharacter, refreshSkins, type Character } from "./character";
import type { Manifest, PackRef } from "./packs";
import { applyIdle } from "./pose";
import { MirrorApplier, type MirrorPose } from "./mocap";
import { canonicalRig } from "./retarget";

/**
 * Live animated preview of a character pack for the settings window: the model plays
 * its idle clip in a small viewport. The same scene produces still thumbnails for the
 * gallery, so one WebGL context serves everything.
 */
const thumbCache = new Map<string, Promise<string>>();

export class LivePreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private character: Character | null = null;
  /** Rig report of the character last shown (3D only). */
  rigReport = "";
  private clock = new THREE.Clock();
  private raf = 0;
  private token = 0;
  private clipToken = 0;
  private loading: PreviewLoading;
  private img: HTMLImageElement | null = null;
  /** Latest webcam pose to show instead of the idle, or null. */
  mirror: MirrorPose | null = null;
  private applier: MirrorApplier | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.loading = new PreviewLoading(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.4);
    this.key.position.set(1.5, 3, 2.5);
    this.scene.add(this.key);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.lighting = 1;
    this.resize();
  }

  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private lightLevel = 1;
  /** Light and reflection strength; 1 is the designed look. */
  get lighting() {
    return this.lightLevel;
  }
  set lighting(v: number) {
    this.lightLevel = v;
    this.hemi.intensity = 1.6 * v;
    this.key.intensity = 1.4 * v;
    this.scene.environmentIntensity = 0.7 * v;
  }

  resize() {
    const w = this.canvas.clientWidth || 200;
    const h = this.canvas.clientHeight || 260;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Claim the loading overlay before the caller starts fetching. A preview begins with work
   * that happens before `show` is reached, and without this the overlay only appeared for the
   * tail of it, which reads as the window having hung and then thought better of it.
   */
  beginLoading() {
    return this.loading.begin();
  }

  /** Release an overlay claimed by `beginLoading`; ignored once something newer owns it. */
  finishLoading(ticket: number, error?: unknown) {
    this.loading.finish(ticket, error);
  }

  /** Show a pack. 3D packs animate; 2D packs show their first frame as an image. */
  async show(pack: PackRef, manifest: Manifest) {
    this.stop();
    const token = this.token;
    const ticket = this.loading.begin();
    let failure: unknown;
    try {
    if (manifest.renderer !== "3d") {
      const src = await thumbnail2d(pack, manifest);
      if (token !== this.token) return;
      this.showImage(src);
      return;
    }
    const c = await loadCharacter(pack, manifest);
    if (token !== this.token) {
      c.dispose();
      return;
    }
    this.character = c;
    this.rigReport = c.rigReport;
    this.scene.add(c.root);
    this.frame(c);
    const idle = manifest.states.idle?.clip;
    if (idle && c.hasClip(idle)) c.play(idle, { loop: true, fade: 0 });
    this.hideImage();
    this.clock.start();
    const loop = () => {
      if (token !== this.token) return;
      const dt = Math.min(this.clock.getDelta(), 0.1);
      c.beginFrame(dt);
      applyIdle(c, this.clock.elapsedTime, 1);
      if (this.mirror) {
        if (!this.applier) void canonicalRig().then((r) => (this.applier = new MirrorApplier(r)));
        else this.applier.apply(c.rig, this.mirror, 1);
      }
      c.update(dt);
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    } catch (error) { failure = error; throw error; }
    finally { if (token === this.token) this.loading.finish(ticket, failure); }
  }

  /** Name of the library clip being previewed, or null while the idle plays. */
  previewing: string | null = null;
  onPreviewChange?: (name: string | null) => void;
  private revertTimer = 0;

  /** Back to the pack's idle clip. */
  stopPreview() {
    ++this.clipToken;
    this.loading.cancel();
    clearTimeout(this.revertTimer);
    const c = this.character;
    this.previewing = null;
    this.onPreviewChange?.(null);
    if (!c) return;
    const idle = c.manifest.states.idle?.clip;
    if (idle && c.hasClip(idle)) c.play(idle, { loop: true });
  }

  /**
   * Play a library clip on the character currently shown (3D only). One-shots play once,
   * loops play for a few seconds, then the idle comes back; a second click stops it early.
   */
  async playClip(name: string, url: string) {
    const c = this.character;
    if (!c) return;
    if (this.previewing === name) {
      this.stopPreview();
      return;
    }
    const clipToken = ++this.clipToken;
    const ticket = this.loading.begin();
    let failure: unknown;
    try {
    if (!c.hasClip(name)) {
      const { loadModel } = await import("./character");
      const { buildRig, canonicalRig, hasOwnSkeleton } = await import("./retarget");
      const extra = await loadModel(url);
      const first = extra.animations[0];
      if (!first) throw new Error("This file contains no animation.");
      if (c !== this.character || clipToken !== this.clipToken) return;
      const source = hasOwnSkeleton(extra.root) ? buildRig(extra.root) : await canonicalRig();
      if (c !== this.character || clipToken !== this.clipToken) return;
      c.addClip(name, first, source);
    }
    if (c !== this.character || clipToken !== this.clipToken) return;
    clearTimeout(this.revertTimer);
    c.play(name, { loop: true });
    this.previewing = name;
    this.onPreviewChange?.(name);
    const seconds = Math.min(12, Math.max(2.5, c.clipDuration(name) * 2));
    this.revertTimer = window.setTimeout(() => {
      if (this.previewing === name) this.stopPreview();
    }, seconds * 1000);
    } catch (error) { failure = error; throw error; }
    finally { this.loading.finish(ticket, failure); }
  }

  /** Render one posed frame of a character (idle clip advanced a little) and return a PNG. */
  renderOnce(c: Character): string {
    this.scene.add(c.root);
    this.frame(c);
    c.beginFrame(0.4);
    applyIdle(c, 0, 1);
    c.update(0);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement.toDataURL("image/png");
    this.scene.remove(c.root);
    return src;
  }

  private frame(c: Character) {
    refreshSkins(c.root);
    const box = new THREE.Box3().setFromObject(c.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // The rest pose is a T-pose, so frame on height only and ignore the arm span.
    const dist = (size.y * 1.15) / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(center.x, center.y + size.y * 0.02, center.z + dist);
    this.camera.lookAt(center.x, center.y, center.z);
  }

  private showImage(src: string) {
    if (!this.img) {
      this.img = document.createElement("img");
      this.img.className = "preview-2d";
      this.canvas.insertAdjacentElement("afterend", this.img);
    }
    this.img.src = src;
    this.img.hidden = false;
    this.canvas.hidden = true;
  }

  private hideImage() {
    if (this.img) this.img.hidden = true;
    this.canvas.hidden = false;
  }

  stop() {
    ++this.token;
    this.previewing = null;
    this.onPreviewChange?.(null);
    ++this.clipToken;
    clearTimeout(this.revertTimer);
    this.loading.cancel();
    this.hideImage();
    cancelAnimationFrame(this.raf);
    if (this.character) {
      this.scene.remove(this.character.root);
      this.character.dispose();
      this.character = null;
    }
    this.renderer.clear();
  }
}

async function thumbnail2d(pack: PackRef, manifest: Manifest): Promise<string> {
  const resp = await fetch(pack.base + manifest.model);
  const Decoder = (window as unknown as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
  let bitmap: ImageBitmap;
  if (Decoder) {
    const decoder = new Decoder({ data: await resp.arrayBuffer(), type: resp.headers.get("content-type")?.split(";")[0] || "image/webp" });
    await decoder.tracks.ready;
    const { image } = await decoder.decode({ frameIndex: 0 });
    bitmap = await createImageBitmap(image);
    image.close();
    decoder.close();
  } else {
    bitmap = await createImageBitmap(await resp.blob());
  }
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height) * 0.9;
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

/** Still thumbnail for the gallery, posed by the pack's idle clip so the arms are down. */
export function thumbnailFor(pack: PackRef, manifest: Manifest, preview: LivePreview): Promise<string> {
  let p = thumbCache.get(pack.id);
  if (!p) {
    p = (async () => {
      if (manifest.renderer !== "3d") return thumbnail2d(pack, manifest);
      const c = await loadCharacter(pack, manifest);
      const idle = manifest.states.idle?.clip;
      if (idle && c.hasClip(idle)) c.play(idle, { loop: true, fade: 0 });
      const src = preview.renderOnce(c);
      c.dispose();
      return src;
    })();
    p.catch(() => thumbCache.delete(pack.id));
    thumbCache.set(pack.id, p);
  }
  return p;
}

/** Clear cached gallery thumbnail(s) so updated models or rigs re-render their thumbnail. */
export function invalidateThumbnail(id?: string): void {
  if (id) thumbCache.delete(id);
  else thumbCache.clear();
}
