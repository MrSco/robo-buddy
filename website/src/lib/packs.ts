export interface PackRef {
  id: string;
  name: string;
  base: string;
  bundled: boolean;
}

export interface Manifest {
  name: string;
  author?: string;
  version: number;
  renderer: "3d" | "2d";
  model: string;
  clips?: Record<string, string>;
  states: Record<
    string,
    {
      clip: string;
      clips?: string[];
      loop?: boolean;
      beatsPerLoop?: number;
      playbackRate?: number;
      then?: string;
      speed?: number;
      naturalMps?: number;
      sheet?: string;
      frames?: number;
      fps?: number;
    }
  >;
  idleVariants?: string[];
  fidgets?: Array<string | string[]>;
  dances?: Array<string | { clip: string; beatsPerLoop?: number; label?: string }>;
  persona?: string;
  llm?: { temperature?: number; maxWords?: number };
  lines?: Partial<Record<"greet" | "poked" | "sleep" | "wake" | "land" | "bump" | "dance" | "idle", string[]>>;
  sounds?: Partial<Record<"poked" | "land" | "wake" | "greet" | "bounce" | "bump" | "grab" | "throw", string>>;
  lookAtBone?: string;
}

export const BUILTIN_PACKS: PackRef[] = [
  { id: "t-800", name: "T-800", base: "/characters/t-800/", bundled: true },
  { id: "rocco", name: "Rocco", base: "/characters/rocco/", bundled: true },
  { id: "mannequin", name: "Mannequin", base: "/characters/mannequin/", bundled: true },
  { id: "pixel-pal", name: "Pixel Pal", base: "/characters/pixel-pal/", bundled: true }
];
