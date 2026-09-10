import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type { Manifest, PackRef } from "./packs";

/**
 * Renders a thumbnail for a character pack: a still of the model for 3D packs,
 * the first idle frame for 2D packs. Results are cached per pack id.
 */
const cache = new Map<string, Promise<string>>();
let renderer: THREE.WebGLRenderer | null = null;

const W = 160;
const H = 200;

function getRenderer() {
  if (!renderer) {
    const canvas = document.createElement("canvas");
    canvas.width = W * 2;
    canvas.height = H * 2;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  return renderer;
}

async function render3d(url: string): Promise<string> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  const root = vrm ? vrm.scene : gltf.scene;
  if (vrm) VRMUtils.rotateVRM0(vrm);
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
  });

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1.5, 3, 2.5);
  scene.add(key);
  scene.add(root);

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  // Frame the upper body: T-posed arms are wide, so aim for the torso and head.
  const fit = Math.max(size.y * 0.75, size.x * 0.45);
  const dist = fit / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(center.x, center.y + size.y * 0.15, center.z + dist);
  camera.lookAt(center.x, center.y + size.y * 0.15, center.z);

  const r = getRenderer();
  r.render(scene, camera);
  const data = r.domElement.toDataURL("image/png");
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) mat.dispose();
  });
  return data;
}

async function render2d(url: string): Promise<string> {
  const resp = await fetch(url);
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
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height) * 0.9;
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

export function previewFor(pack: PackRef, manifest: Manifest): Promise<string> {
  let p = cache.get(pack.id);
  if (!p) {
    const url = pack.base + manifest.model;
    p = manifest.renderer === "3d" ? render3d(url) : render2d(url);
    p.catch(() => cache.delete(pack.id));
    cache.set(pack.id, p);
  }
  return p;
}
