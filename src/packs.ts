import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { IN_TAURI } from "./input";

export interface PackRef {
  /** "rocco" for bundled packs, "user:<folder>" for packs in the app data dir. */
  id: string;
  name: string;
  /** Base URL, always ending in "/". */
  base: string;
  bundled: boolean;
}

export interface Manifest {
  name: string;
  author?: string;
  version: number;
  renderer: "3d" | "2d";
  model: string;
  /** Optional named external clip files (GLB/GLTF with animations), relative to the pack. */
  clips?: Record<string, string>;
  states: Record<
    string,
    { clip: string; loop?: boolean; beatsPerLoop?: number; playbackRate?: number; then?: string; sheet?: string; frames?: number; fps?: number }
  >;
  reactions: {
    music?: { enabled: boolean; threshold?: number };
    mouse?: { enabled: boolean; lookAtCursor?: boolean; pokeState?: string };
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
  return [...bundled, ...users.map((u) => ({ id: u.id, name: u.name, base: userBase(u.dir), bundled: false }))];
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
