/**
 * Camera side of motion capture, for the settings window: a webcam stream, MediaPipe pose
 * tracking on it, a wire skeleton drawn over the video, and MirrorPose frames handed to
 * whoever listens (the live preview, the buddy through an event, the recorder).
 */
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { PoseSolver, type Landmark, type MirrorPose } from "./mocap";
import { canonicalRig } from "./retarget";

const BONES: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [7, 8], [0, 7], [0, 8], [27, 31], [28, 32],
];

export class Capture {
  private landmarker: PoseLandmarker | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private solver: PoseSolver | null = null;
  private fpsAt = 0;
  private fpsCount = 0;
  fps = 0;
  running = false;
  tracking = false;
  onPose?: (pose: MirrorPose, t: number) => void;
  onStatus?: (text: string) => void;

  constructor(private video: HTMLVideoElement, private overlay: HTMLCanvasElement) {}

  async start() {
    if (this.running) return;
    this.onStatus?.("Loading the pose model…");
    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/mediapipe/pose_landmarker_lite.task", delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
    if (!this.solver) this.solver = new PoseSolver(await canonicalRig());
    this.solver.reset();
    this.onStatus?.("Opening the camera…");
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.onStatus?.("Camera on. Stand back so your whole body is in frame.");
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  stop() {
    this.running = false;
    this.tracking = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this.onStatus?.("Camera off.");
  }

  private tick() {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    let res: PoseLandmarkerResult;
    try {
      res = this.landmarker.detectForVideo(v, now);
    } catch {
      return;
    }
    this.fpsCount++;
    if (now - this.fpsAt > 1000) {
      this.fps = this.fpsCount;
      this.fpsCount = 0;
      this.fpsAt = now;
    }
    const lm = res.landmarks[0];
    const world = res.worldLandmarks[0];
    this.draw(lm);
    this.tracking = !!lm;
    if (!lm || !world || !this.solver) return;
    const vis = lm.map((l) => l.visibility ?? 1);
    const pose = this.solver.solve(world as Landmark[], vis, now / 1000);
    if (pose) this.onPose?.(pose, now / 1000);
  }

  /** Wire skeleton over the (mirrored) video. */
  private draw(lm: Landmark[] | undefined) {
    const c = this.overlay;
    const v = this.video;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth || 640;
      c.height = v.videoHeight || 480;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!lm) return;
    const X = (l: Landmark) => l.x * c.width;
    const Y = (l: Landmark) => l.y * c.height;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(91, 156, 255, 0.9)";
    ctx.lineCap = "round";
    for (const [a, b] of BONES) {
      const pa = lm[a];
      const pb = lm[b];
      if (!pa || !pb || (pa.visibility ?? 1) < 0.4 || (pb.visibility ?? 1) < 0.4) continue;
      ctx.beginPath();
      ctx.moveTo(X(pa), Y(pa));
      ctx.lineTo(X(pb), Y(pb));
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      const l = lm[i];
      if (!l || (l.visibility ?? 1) < 0.4) continue;
      ctx.beginPath();
      ctx.arc(X(l), Y(l), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
