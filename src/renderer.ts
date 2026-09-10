import type { Music } from "./audio";
import type { Manifest, PackRef } from "./packs";

/** Behaviour states resolved by main.ts each frame. Packs may provide a clip per state. */
export type StateName = "idle" | "dance" | "poked" | "dragged" | "fall" | "sleep";

export interface FrameInput {
  t: number;
  dt: number;
  state: StateName;
  /** 0..1 blend for the dance layer. */
  danceAmount: number;
  /** 0..1 blend for the sleep pose. */
  sleepAmount: number;
  music: Music | null;
  /** Head look target in radians. */
  yaw: number;
  pitch: number;
  /** Seconds since the last poke, Infinity if none. */
  sincePoke: number;
  /** Seconds since landing, Infinity if none, and how hard (0..1). */
  sinceLand: number;
  landStrength: number;
  airborne: boolean;
  /** Horizontal velocity in px/s while airborne, for leaning. */
  vx: number;
}

export interface Renderer {
  readonly kind: "3d" | "2d";
  load(pack: PackRef, manifest: Manifest): Promise<void>;
  /** CSS pixel size of the stage. */
  resize(w: number, h: number): void;
  frame(input: FrameInput): void;
  /** Alpha (0..255) of the last drawn frame at CSS pixel coordinates. */
  alphaAt(x: number, y: number): number;
  /** True when the pack provides a clip for the state, so procedural fallbacks can step aside. */
  hasClip(state: StateName): boolean;
  /** Length of the state's clip in seconds, for one-shot states like "poked". */
  clipDuration(state: StateName): number;
  /** Release the loaded character but keep the renderer (and its GL context) usable. */
  unload(): void;
}
