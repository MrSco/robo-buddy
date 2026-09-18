import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./input";
import type { RigParams } from "./autorig";

export interface PackRef {
  /** "rocco" for bundled packs, "user:<folder>" for packs in the app data dir. */
  id: string;
  name: string;
  /** Base URL, always ending in "/". */
  base: string;
  bundled: boolean;
  /** Absolute directory on disk for user packs. */
  dir?: string;
}

export interface Manifest {
  name: string;
  author?: string;
  version: number;
  renderer: "3d" | "2d";
  model: string;
  /** Alignment parameters used when auto-rigging this model. */
  rigParams?: RigParams;
  /** Optional named external clip files (GLB/GLTF with animations), relative to the pack. */
  clips?: Record<string, string>;
  states: Record<
    string,
    {
      clip: string;
      /** Alternatives picked at random each time the state starts. */
      clips?: string[];
      loop?: boolean;
      beatsPerLoop?: number;
      playbackRate?: number;
      then?: string;
      /** Walk, run and sprint states: px/s at size 1. */
      speed?: number;
      /**
       * Walk, run and sprint states: metres per second this clip's own stride covers, so its
       * playback can be matched to how fast he is really moving. Defaults to a walking 1.15.
       */
      naturalMps?: number;
      sheet?: string;
      frames?: number;
      fps?: number;
    }
  >;
  /** Clip names to cycle through while idle. */
  idleVariants?: string[];
  /** One-shot clips (or sequences) played now and then while idle. */
  fidgets?: Array<string | string[]>;
  /** Dance clips the user can choose from; "procedural" is the built-in groove. */
  dances?: Array<string | { clip: string; beatsPerLoop?: number; label?: string }>;
  /** Who he is when talking (M6); a default persona is built from the name when absent. */
  persona?: string;
  /** How the model answers as this character: its own warmth and its own brevity. */
  llm?: { temperature?: number; maxWords?: number };
  /** Optional speech-bubble lines per event; one is picked at random. */
  lines?: Partial<Record<"greet" | "poked" | "sleep" | "wake" | "land" | "bump" | "dance" | "idle", string[]>>;
  /** Optional sound files per event, relative to the pack. Either a single file or array of variations. */
  sounds?: Partial<
    Record<
      | "poked"
      | "land"
      | "wake"
      | "greet"
      | "bounce"
      | "bump"
      | "grab"
      | "throw"
      | "footstep"
      | "jump"
      | "sleep"
      | "bubble",
      string | string[]
    >
  >;
  reactions: {
    music?: { enabled: boolean; threshold?: number };
    mouse?: {
      enabled: boolean;
      lookAtCursor?: boolean;
      pokeState?: string;
      /** 2D only: mirror the picture to face the cursor. Off by default; a mirrored face or photo reads as a jump. */
      flipToFace?: boolean;
    };
    physics?: { gravity?: boolean; throwable?: boolean; walk?: boolean };
  };
}

interface UserPack {
  id: string;
  name: string;
  dir: string;
}

function userBase(dir: string): string {
  // Asset protocol URL for a directory; files are appended as path segments.
  const url = convertFileSrc(dir);
  return url.endsWith("/") ? url : url + "/";
}

export async function listPacks(): Promise<PackRef[]> {
  const ids = (await (await fetch("/characters/index.json")).json()) as string[];
  const bundled: PackRef[] = [];
  for (const id of ids) {
    try {
      const m = (await (await fetch(`/characters/${id}/manifest.json`)).json()) as Manifest;
      bundled.push({ id, name: m.name, base: `/characters/${id}/`, bundled: true });
    } catch {
      // A broken bundled pack should not take the list down.
    }
  }
  if (!IN_TAURI) return bundled;
  const users = await invoke<UserPack[]>("list_user_packs");
  return [...bundled, ...users.map((u) => ({ id: u.id, name: u.name, base: userBase(u.dir), bundled: false, dir: u.dir }))];
}

/**
 * Store a character's own persona, lines and model settings in its manifest. Imported packs
 * only; a bundled pack lives in the install directory and an edit there would be lost on the
 * next update. Undefined clears a field, putting that part back to the built-in default.
 */
export async function savePackPersona(
  id: string,
  persona: string | undefined,
  lines: Manifest["lines"] | undefined,
  llm: Manifest["llm"] | undefined,
): Promise<void> {
  await invoke("set_pack_persona", { id, persona: persona ?? null, lines: lines ?? null, llm: llm ?? null });
}

export async function resolvePack(id: string): Promise<PackRef> {
  const packs = await listPacks();
  return packs.find((p) => p.id === id) ?? packs[0];
}

export function validateManifest(m: unknown): Manifest {
  const x = m as Partial<Manifest>;
  if (!x || typeof x !== "object") throw new Error("manifest is not an object");
  if (x.renderer !== "3d" && x.renderer !== "2d") throw new Error(`manifest.renderer must be "3d" or "2d"`);
  if (typeof x.model !== "string" || !x.model) throw new Error("manifest.model is required");
  if (!x.states || typeof x.states !== "object") throw new Error("manifest.states is required");
  if (!x.states.idle) throw new Error('manifest.states.idle is required');
  return { name: x.name ?? "Unnamed", version: x.version ?? 1, reactions: x.reactions ?? {}, ...x } as Manifest;
}
