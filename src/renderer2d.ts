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
 * ImageDecoder) and PNG sprite sheets. Draws the current frame with a puppet layer that
 * mirrors the 3D reactions on a flat picture: breathing, leaning toward the cursor, a set
 * of dance moves on the beat, a hop and a wobble on poke, squash and wobble on landing,
 * tumbling when thrown, swinging when held, stretching when hanging. The image is drawn
 * as horizontal strips so its top can bend over while the feet stay put.
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
  /** Puppet layer: a bend of the top of the image (fraction of its height), sprung so it wobbles. */
  private bend = 0;
  private bendVel = 0;
  /** Pendulum swing while held, driven by how the cursor moves. */
  private swing = 0;
  private swingVel = 0;
  /** Tumble angle after a throw; springs back upright on the ground. */
  private tumble = 0;
  /** Smoothed side-step for the shuffle move, in fractions of the stage width. */
  private shift = 0;
  private prevPoke = Infinity;
  private prevLand = Infinity;
  private facingBlend = 1;

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

    // Puppet layer targets for this frame.
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = input.t;
    const dt = input.dt;
    const held = input.state === "dragged";
    const hanging = input.state === "hang" || input.state === "mantle";
    const awake = 1 - input.sleepAmount;

    let bob = 0;
    let squashX = 1;
    let squashY = 1;
    let rot = 0;
    let bendTarget = 0;
    let shiftTarget = 0;
    let stretch = 1;

    // Breathing and a slow sway; deeper and slower asleep.
    const breathe = Math.sin(t * (1.6 - 0.7 * input.sleepAmount)) * (0.012 + 0.02 * input.sleepAmount);
    squashY *= 1 + breathe;
    squashX *= 1 - breathe * 0.5;
    bendTarget += Math.sin(t * 0.7) * 0.015 * awake;
    // Asleep: slumps over a little.
    bendTarget += -0.06 * input.sleepAmount;
    rot += 0.08 * input.sleepAmount;
    // Leaning toward whatever he is looking at, and tiny nods while he talks.
    if (!held && !input.airborne) bendTarget += Math.max(-0.5, Math.min(0.5, input.yaw)) * 0.06 * awake;
    if (input.talking) {
      bob += Math.sin(t * 9) * 0.008;
      bendTarget += Math.sin(t * 2.3) * 0.02;
    }

    // Dancing without a dance clip: a move per eight beats, all on the music's phase.
    if (input.music && input.danceAmount > 0.001 && !this.clips.has("dance") && !held && !input.airborne) {
      const a = input.danceAmount;
      const m = input.music;
      const beat = m.beats + m.phase; // continuous beat count
      const dip = (1 - Math.cos(m.phase * TAU)) * 0.5; // 0 on the beat, 1 between beats
      const move = Math.floor(m.beats / 8) % 4;
      const half = Math.sin(beat * Math.PI); // -1..1 over two beats
      if (move === 0) {
        // Bounce: down into the beat, up between.
        bob += -0.06 * (1 - dip) * a;
        squashY *= 1 - 0.07 * (1 - dip) * a;
        squashX *= 1 + 0.05 * (1 - dip) * a;
      } else if (move === 1) {
        // Sway: the top swings side to side, the base leans against it.
        bendTarget += 0.16 * half * a;
        rot += -0.07 * half * a;
        bob += -0.02 * (1 - dip) * a;
      } else if (move === 2) {
        // Shuffle: side-steps with a tilt into each step and a little hop.
        shiftTarget += 0.06 * half * a;
        rot += 0.1 * Math.sin(beat * Math.PI + Math.PI / 2) * a;
        bob += -0.03 * (1 - dip) * a;
      } else {
        // Twist: turns to face the other way every beat, squeezing through the turn.
        this.facing = Math.floor(beat) % 2 === 0 ? 1 : -1;
        squashX *= 1 - 0.15 * (1 - dip) * a;
        bob += -0.025 * (1 - dip) * a;
        bendTarget += 0.05 * half * a;
      }
    } else if (input.music && input.danceAmount > 0.001 && this.clips.has("dance")) {
      // A pack with its own dance loop only gets a hint of bounce on top.
      const dip = (1 - Math.cos(input.music.phase * TAU)) * 0.5;
      bob += -0.02 * (1 - dip) * input.danceAmount;
    }

    // Poke: a hop, and a shake that ripples up the body.
    if (input.sincePoke < 0.45 && !this.clips.has("poked")) bob += Math.sin(Math.PI * (input.sincePoke / 0.45)) * 0.12;
    if (input.sincePoke < this.prevPoke && input.sincePoke < 0.1) this.bendVel += (this.facing > 0 ? 1 : -1) * 2.2;
    this.prevPoke = input.sincePoke;
    // Landing: squash, and the top keeps going for a moment.
    if (input.sinceLand < 0.3) {
      const sq = Math.sin(Math.PI * (input.sinceLand / 0.3)) * 0.2 * input.landStrength;
      squashY *= 1 - sq;
      squashX *= 1 + sq * 0.6;
    }
    if (input.sinceLand < this.prevLand && input.sinceLand < 0.1) this.bendVel += 2.5 * input.landStrength * (Math.random() < 0.5 ? -1 : 1);
    this.prevLand = input.sinceLand;

    // Thrown: lean into the motion and tumble with the spin; upright again on the ground.
    const targetLean = input.airborne ? Math.max(-0.35, Math.min(0.35, -input.vx / 4000)) : 0;
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 12);
    if (input.airborne && Math.abs(input.spin) > 0.01) this.tumble += input.spin * dt;
    else {
      this.tumble = ((this.tumble + Math.PI) % TAU + TAU) % TAU - Math.PI;
      this.tumble += (0 - this.tumble) * Math.min(1, dt * 8);
      if (Math.abs(this.tumble) < 0.002) this.tumble = 0;
    }
    if (input.airborne) bendTarget += Math.max(-0.2, Math.min(0.2, -input.accelX * 0.15));

    // Held: swings like a pendulum from the grab point, the bottom lagging behind.
    if (held && input.grab) {
      const drive = Math.max(-0.6, Math.min(0.6, -input.grab.vx / 6000));
      this.swingVel += (18 * (drive - this.swing) - 4 * this.swingVel) * dt;
    } else this.swingVel += (-30 * this.swing - 6 * this.swingVel) * dt;
    this.swing += this.swingVel * dt;
    if (held) bendTarget += -this.swing * 0.35 + Math.max(-0.25, Math.min(0.25, input.accelX * 0.2));
    // Hanging by the hands: stretched out, swaying a little.
    if (hanging) {
      stretch = 1.06;
      bendTarget += Math.sin(t * 2.2) * 0.03;
    }

    // Springs: the bend wobbles, the side-step eases.
    this.bendVel += (70 * (bendTarget - this.bend) - 9 * this.bendVel) * dt;
    this.bend += this.bendVel * dt;
    this.bend = Math.max(-0.45, Math.min(0.45, this.bend));
    this.shift += (shiftTarget - this.shift) * Math.min(1, dt * 10);
    // Face the cursor by flipping horizontally once it is clearly to one side; the flip eases
    // through a squeeze rather than popping.
    if (!(input.music && input.danceAmount > 0.5 && !this.clips.has("dance")) && Math.abs(input.yaw) > 0.25) this.facing = input.yaw > 0 ? 1 : -1;
    this.facingBlend += (this.facing - this.facingBlend) * Math.min(1, dt * 14);
    const face = Math.abs(this.facingBlend) < 0.15 ? 0.15 * Math.sign(this.facingBlend || 1) : this.facingBlend;

    // Fit the image to the stage, anchored at the bottom centre (or hung from its top).
    const scale = Math.min(W / img.width, H / img.height) * 0.8;
    const dw = img.width * scale;
    const dh = img.height * scale * stretch;
    const cx = W / 2 + this.shift * W;
    const feetY = H * 0.97 + bob * H;
    const topPivot = held || hanging;
    this.crownY = (feetY - dh * squashY) / H;
    if (topPivot) {
      ctx.translate(cx, feetY - dh);
      ctx.rotate(this.lean + this.swing + this.tumble);
      ctx.scale(squashX * face, squashY);
      this.drawBent(img, -dw / 2, 0, dw, dh, this.bend);
    } else {
      ctx.translate(cx, feetY);
      ctx.rotate(this.lean + this.tumble + rot);
      ctx.scale(squashX * face, squashY);
      this.drawBent(img, -dw / 2, -dh, dw, dh, this.bend);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Draw the image in horizontal strips, each sheared so its offset runs continuously from
   * the strip below to the strip above: the feet stay put and the top leans over by `bend`
   * of the height along a smooth curve, with no steps between strips. One draw when straight.
   */
  private drawBent(img: ImageBitmap, x: number, y: number, dw: number, dh: number, bend: number) {
    const ctx = this.ctx;
    if (Math.abs(bend) < 0.002) {
      ctx.drawImage(img, x, y, dw, dh);
      return;
    }
    const strips = 12;
    const sh = img.height / strips;
    const dsh = dh / strips;
    // Offset at a height fraction f (0 at the feet, 1 at the top).
    const offAt = (f: number) => bend * dh * f * f;
    for (let i = 0; i < strips; i++) {
      const top = y + i * dsh; // strip's top edge, in the current frame
      const fTop = 1 - i / strips;
      const fBot = 1 - (i + 1) / strips;
      const o0 = offAt(fTop);
      const o1 = offAt(fBot);
      // Shear so the offset is o0 at the top edge and o1 at the bottom edge of this strip.
      const k = (o1 - o0) / dsh;
      ctx.save();
      ctx.transform(1, 0, k, 1, o0 - k * top, 0);
      // A hair of overlap between strips hides seams at non-integer scales.
      const extra = i < strips - 1 ? 1 : 0;
      ctx.drawImage(img, 0, i * sh, img.width, sh + extra * (sh / dsh), x, top, dw, dsh + extra);
      ctx.restore();
    }
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
