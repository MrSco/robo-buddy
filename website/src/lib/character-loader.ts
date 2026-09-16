import type { Character, Manifest, PackRef } from "./character";
import { loadCharacter } from "./character";

export interface CharacterDef {
  id: string;
  name: string;
  tag: string;
  emoji: string;
  manifestPath: string;
  base: string;
  avatar?: string;
  defaultQuotes: string[];
  pokedQuotes: string[];
  thrownQuotes: string[];
  danceQuotes: string[];
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: "t-800",
    name: "T-800",
    tag: "Terminator",
    emoji: "🤖",
    avatar: "/images/t800-avatar.png",
    manifestPath: "/characters/t-800/manifest.json",
    base: "/characters/t-800/",
    defaultQuotes: [
      "I'll be back.",
      "Come with me if you want to live.",
      "Desire is irrelevant. I am a machine.",
      "Talk to the hand.",
      "The more contact I have with humans, the more I learn."
    ],
    pokedQuotes: [
      "Target acquired. Do not touch the chassis.",
      "Armor integrity at 100%.",
      "I am a cybernetic organism. Living tissue over metal.",
      "Hasta la vista, baby."
    ],
    thrownQuotes: [
      "I'll be back!",
      "Kinetic displacement detected.",
      "Systems undamaged.",
      "Mission parameters unchanged."
    ],
    danceQuotes: [
      "Affirmative. Executing robot hip-hop routine.",
      "Groove protocol initiated.",
      "Heavy metal rhythm synchronized."
    ]
  },
  {
    id: "rocco",
    name: "Rocco",
    tag: "3D Scan",
    emoji: "🧔",
    manifestPath: "/characters/rocco/manifest.json",
    base: "/characters/rocco/",
    defaultQuotes: [
      "Hey! Welcome to Robo Buddy.",
      "Got any music playing? I dance to whatever's on.",
      "Windows are physical furniture, you know.",
      "Watch your cursor, I'm keeping my eyes on it!"
    ],
    pokedQuotes: [
      "Hey, watch the hair!",
      "Ouch, poke someone else!",
      "Haha, ticklish!",
      "Who clicked me?"
    ],
    thrownQuotes: [
      "Whoaaa flying!",
      "Watch the landing!",
      "I believe I can fly!",
      "Safe and sound on the ground!"
    ],
    danceQuotes: [
      "Now this is my jam!",
      "Dancing along to the beat!",
      "Check out these moves!"
    ]
  },
  {
    id: "mannequin",
    name: "Mannequin",
    tag: "Pro Rig",
    emoji: "🧍",
    manifestPath: "/characters/mannequin/manifest.json",
    base: "/characters/mannequin/",
    defaultQuotes: [
      "Clean geometry, zero baggage.",
      "I can do every dance in the shared library.",
      "Every animation retargets to me at runtime."
    ],
    pokedQuotes: [
      "Click detected on polygon mesh.",
      "Flinch protocol engaged.",
      "*hollow fiberglass thud*"
    ],
    thrownQuotes: [
      "Ragdoll physics active!",
      "Aerodynamic test in progress.",
      "Landed with perfect balance."
    ],
    danceQuotes: [
      "Synchronizing joints to rhythm.",
      "Executing standard groove sequence.",
      "Mixamo dance stream loaded."
    ]
  },
  {
    id: "pixel-pal",
    name: "Pixel Pal",
    tag: "2D Sprite",
    emoji: "👾",
    manifestPath: "/characters/pixel-pal/manifest.json",
    base: "/characters/pixel-pal/",
    defaultQuotes: [
      "Retro 16-bit desktop companion!",
      "No 3D GPU required for this flat buddy.",
      "Boing boing boing!"
    ],
    pokedQuotes: [
      "Boing!",
      "Pixel poke!",
      "*bleep bloop*"
    ],
    thrownQuotes: [
      "Wheeeeee!",
      "2D airtime!",
      "*thud*"
    ],
    danceQuotes: [
      "8-bit party time!",
      "Bouncing to the chiptunes!"
    ]
  }
];

export async function fetchCharacter(def: CharacterDef): Promise<{ character: Character | null; manifest: Manifest }> {
  const res = await fetch(def.manifestPath);
  const manifest = (await res.json()) as Manifest;
  if (manifest.renderer !== "3d") {
    return { character: null, manifest };
  }
  const pack: PackRef = {
    id: def.id,
    name: def.name,
    base: def.base,
    bundled: true
  };
  const character = await loadCharacter(pack, manifest);
  return { character, manifest };
}
