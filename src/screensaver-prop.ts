import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * A three-dimensional thing he shares the screen with. The chair at the end of a screensaver
 * cycle is the first; anything else he comes to use belongs here too.
 *
 * It renders into a canvas of its own which the screensaver then composites, because that page
 * draws in two dimensions and the buddy lives in a separate window on top of it. That does mean
 * he passes in front of a prop rather than between its arms. Putting the prop in his own scene
 * would fix that and cost the ability to show it before he arrives, since his window is only
 * ever where he is.
 *
 * A prop does not move, so it is drawn once and kept until the size it is wanted at changes.
 */
export class Prop {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(24, 1, 0.01, 100);
  /** Height of the model in its own units, for scaling it against the character. */
  readonly aspect: number;
  private drawnAt = "";

  private constructor(root: THREE.Object3D) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const env = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.scene.add(root);

    // Centred on its own bounds and stood on the origin, so the rest of this can work in
    // fractions of its height without knowing anything about how the model was authored.
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const scale = 1 / Math.max(size.y, 1e-6);
    root.scale.setScalar(scale);
    root.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
    this.aspect = size.x / size.y;

    // Front on and a little above, so the seat reads as a seat rather than as a wall.
    //
    // Viewed from behind -Z, because a model authored in Blender faces that way once exported:
    // the exporter maps Blender's forward axis to glTF's -Z. Sitting the camera on +Z instead
    // showed the back of the chair, which is a featureless slab of leather.
    const dist = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.position.set(0, 0.52, -dist * 1.08);
    this.camera.lookAt(0, 0.46, 0);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1.2, 2.2, -1.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.8);
    fill.position.set(-1.6, 0.8, -1.2);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  }

  static async load(url: string): Promise<Prop | null> {
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      return new Prop(gltf.scene);
    } catch {
      // No prop is not a failure: the cycle simply ends without one.
      return null;
    }
  }

  /** The prop drawn at this height in pixels; the canvas is reused until the height changes. */
  render(height: number): HTMLCanvasElement {
    const h = Math.max(2, Math.round(height));
    const w = Math.max(2, Math.round(h * this.aspect * 1.25));
    const key = `${w}x${h}`;
    if (key !== this.drawnAt) {
      this.drawnAt = key;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
    }
    return this.renderer.domElement;
  }
}
