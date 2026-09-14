import type { Music } from "./audio";
import type { MirrorPose } from "./mocap";
import type { ClipChoice } from "./behavior";
import type { Manifest, PackRef } from "./packs";

/** Behaviour states resolved by main.ts each frame. Packs may provide a clip per state. */
export type StateName = "idle" | "dance" | "poked" | "dragged" | "fall" | "jump" | "sleep" | "fidget" | "walk" | "land" | "down" | "typing" | "mirror" | "hang" | "mantle";

export type GrabPart = "head" | "torso" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

export interface GrabInfo {
  part: GrabPart;
  /** Horizontal cursor velocity in px/s, for pendulum swing. */
  vx: number;
}

export interface FrameInput {
  t: number;
  dt: number;
  state: StateName;
  /** Clip to play for this state, resolved by main.ts; null means procedural / none. */
  clip: ClipChoice | null;
  /** Body yaw in radians: 0 faces the viewer, +-PI/2 faces along the floor. */
  facing: number;
  /** Where he is being held, when dragged: which part and the cursor velocity for swing. */
  grab: GrabInfo | null;
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
  /** Window acceleration normalised to roughly +-1 for a hard yank (screen space, y down). */
  accelX: number;
  accelY: number;
  /** Tumble rate in rad/s while airborne. */
  spin: number;
  /** He is speaking a reply out loud: small head nods. */
  talking: boolean;
  /** Airborne with no falling clip in the pack: use the procedural arm flail. */
  flail: boolean;
  /** Webcam pose to copy this frame (M7), or null. */
  mirror: MirrorPose | null;
  attack?: { kind: "punch" | "kick" | "throw"; progress: number; procedural: boolean; start: number } | null;
}

export interface Renderer {
  readonly kind: "3d" | "2d";
  load(pack: PackRef, manifest: Manifest): Promise<void>;
  /** CSS pixel size of the stage. */
  resize(w: number, h: number): void;
  frame(input: FrameInput): void;
  /** Alpha (0..255) of the last drawn frame at CSS pixel coordinates. */
  alphaAt(x: number, y: number): number;
  /** Top of the character's head in CSS pixels; speech bubbles sit above this point. */
  bubbleAnchor(): { x: number; y: number };
  /** Which body part is under a CSS-pixel point (3D only), or null when nothing is near. */
  partAt(x: number, y: number): GrabPart | null;
  /** Dev: what the cursor has hold of and where it is, for the debug title. */
  gripReport?(): string;
  /** CSS-pixel position of the point he is held by (a hand, the head...), or null. */
  holdPoint(): { x: number; y: number } | null;
  /** True when the pack provides a clip for the state, so procedural fallbacks can step aside. */
  hasClip(state: StateName): boolean;
  /** Length of a clip by name in seconds; 0 when unknown. */
  clipDuration(name: string): number;
  /** Release the loaded character but keep the renderer (and its GL context) usable. */
  unload(): void;
}
