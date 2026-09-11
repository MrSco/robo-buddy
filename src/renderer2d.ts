import type { Manifest, PackRef } from "./packs";
import type { FrameInput, Renderer, StateName } from "./renderer";

interface Clip {
  frames: ImageBitmap[];
  /** Per-frame durations in seconds. */
  durations: number[];
  total: number;
  loop: boolean;
  beatsPerLoop?: number;
  playbackRate: number;
  then?: string;
}

const TAU = Math.PI * 2;

/**
 * Frame-stepped 2D renderer for animated WebP / GIF / APNG / PNG (via the browser's
 * ImageDecoder) and PNG sprite sheets. Draws the current frame with transforms that
 * mirror the 3D reactions: bob and squash on the beat, hop on poke, lean when thrown.
 */
export class Renderer2D implements Renderer {
  readonly kind = "2d" as const;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private clips = new Map<string, Clip>();
  private current: { state: StateName; clip: Clip; time: number } | null = null;
  private dpr = Math.min(window.devicePixelRatio, 2);
  private lean = 0;
  private facing = 1;
  private crownY = 0.15;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
  }

  async load(pack: PackRef, manifest: Manifest) {
    const next = new Map<string, Clip>();
    await Promise.all(
      Object.entries(manifest.states).map(async ([state, def]) => {
        next.set(state, await this.loadClip(pack.base, def));
      }),
    );
    if (!next.has("idle")) throw new Error("2D pack needs an idle clip");
    this.unload();
    this.clips = next;
  }

  unload() {
    for (const clip of this.clips.values()) for (const f of clip.frames) f.close();
    this.clips = new Map();
    this.current = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private async loadClip(base: string, def: Manifest["states"][string]): Promise<Clip> {
    const playbackRate = def.playbackRate ?? 1;
    if (def.sheet) {
      // PNG sprite sheet laid out left to right, wrapping into rows of equal-size cells.
      const img = await createImageBitmap(await (await fetch(base + def.sheet)).blob());
      const count = def.frames ?? 1;
      const fps = def.fps ?? 12;
      const cols = Math.max(1, Math.round(img.width / (img.height / Math.ceil(count / Math.round(img.width / img.height)))));
      const cellW = Math.floor(img.width / cols);
      const cellH = cellW; // square cells by convention
      const frames: ImageBitmap[] = [];
      for (let i = 0; i < count; i++) {
        const sx = (i % cols) * cellW;
        const sy = Math.floor(i / cols) * cellH;
        frames.push(await createImageBitmap(img, sx, sy, cellW, cellH));
      }
      const durations = frames.map(() => 1 / fps);
      return { frames, durations, total: count / fps, loop: def.loop ?? true, beatsPerLoop: def.beatsPerLoop, playbackRate, then: def.then };
    }
    const resp = await fetch(base + def.clip);
    const type = resp.headers.get("content-type") ?? "";
    const mime = type.split(";")[0] || guessMime(def.clip);
    const Decoder = (window as unknown as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
    if (!Decoder) throw new Error("ImageDecoder API unavailable");
    const decoder = new Decoder({ data: await resp.arrayBuffer(), type: mime });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const count = track?.frameCount ?? 1;
    const frames: ImageBitmap[] = [];
    const durations: number[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      frames.push(await createImageBitmap(image));
      // duration is in microseconds; fall back to 12 fps when absent.
      durations.push(image.duration ? image.duration / 1e6 : 1 / 12);
      image.close();
    }
    decoder.close();
    const total = durations.reduce((a, b) => a + b, 0);
    return { frames, durations, total, loop: def.loop ?? true, beatsPerLoop: def.beatsPerLoop, playbackRate, then: def.then };
  }

  resize(w: number, h: number) {
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
  }

  hasClip(state: StateName) {
    return this.clips.has(state);
  }

  clipDuration(name: string) {
    return this.clips.get(name)?.total ?? 0;
  }

  private select(state: StateName): boolean {
    const clip = this.clips.get(state) ?? this.clips.get("idle");
    if (!clip) return false;
    if (this.current?.clip !== clip) this.current = { state, clip, time: 0 };
    return true;
  }

  frame(input: FrameInput) {
    if (!this.select(input.state)) return;
    const cur = this.current!;
    const clip = cur.clip;

    // Advance the clip. Beat-synced loops run so one loop spans N beats.
    let rate = clip.playbackRate;
    if (clip.beatsPerLoop && input.music && input.music.bpm > 0) {
      const wanted = (clip.beatsPerLoop * 60) / input.music.bpm;
      rate = clip.total / wanted;
    }
    // Asleep without a sleep clip: the idle loop crawls.
    if (input.sleepAmount > 0 && cur.state !== "sleep" && !this.clips.has("sleep")) rate *= 1 - 0.7 * input.sleepAmount;
    cur.time += input.dt * rate;
    if (clip.loop) cur.time %= clip.total;
    else cur.time = Math.min(cur.time, clip.total - 1e-4);

    let acc = 0;
    let idx = 0;
    for (; idx < clip.durations.length - 1; idx++) {
      acc += clip.durations[idx];
      if (cur.time < acc) break;
    }
    const img = clip.frames[idx];

    // Transforms shared with the 3D reactions.
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    let bob = 0;
    let squashX = 1;
    let squashY = 1;
    if (input.music && input.danceAmount > 0.001 && !this.clips.has("dance")) {
      const a = input.danceAmount;
      const dip = (1 - Math.cos(input.music.phase * TAU)) * 0.5;
      bob = -0.05 * (1 - dip) * a;
      squashY = 1 - 0.06 * (1 - dip) * a;
      squashX = 1 + 0.04 * (1 - dip) * a;
    }
    if (input.sincePoke < 0.45 && !this.clips.has("poked")) {
      bob += Math.sin(Math.PI * (input.sincePoke / 0.45)) * 0.12;
    }
    if (input.sinceLand < 0.3) {
      const s = Math.sin(Math.PI * (input.sinceLand / 0.3)) * 0.2 * input.landStrength;
      squashY *= 1 - s;
      squashX *= 1 + s * 0.6;
    }
    const targetLean = input.airborne ? Math.max(-0.35, Math.min(0.35, -input.vx / 4000)) : 0;
    this.lean += (targetLean - this.lean) * Math.min(1, input.dt * 12);
    // Face the cursor by flipping horizontally once it is clearly to one side.
    if (Math.abs(input.yaw) > 0.25) this.facing = input.yaw > 0 ? 1 : -1;

    // Fit the image to the stage, anchored at the bottom centre.
    const scale = Math.min(W / img.width, H / img.height) * 0.8;
    const dw = img.width * scale;
    const dh = img.height * scale;
    const cx = W / 2;
    const feetY = H * 0.97 + bob * H;
    this.crownY = (feetY - dh * squashY) / H;
    ctx.translate(cx, feetY);
    ctx.rotate(this.lean + 0.1 * input.sleepAmount);
    ctx.scale(squashX * this.facing, squashY);
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  partAt() {
    return null;
  }

  holdPoint() {
    return null;
  }

  bubbleAnchor() {
    return { x: this.canvas.width / this.dpr / 2, y: (this.crownY * this.canvas.height) / this.dpr };
  }

  alphaAt(x: number, y: number): number {
    const px = Math.floor(x * this.dpr);
    const py = Math.floor(y * this.dpr);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return 0;
    return this.ctx.getImageData(px, py, 1, 1).data[3];
  }

}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "gif" ? "image/gif" : ext === "png" || ext === "apng" ? "image/png" : "image/webp";
}
