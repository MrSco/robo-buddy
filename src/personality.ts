/**
 * Personality profiles: a persona for the LLM, a bucket of pre-baked bubble lines, and the
 * model settings that go with them. "pack" means the character's own persona and lines.
 */
import { defaultPersona, type Lines } from "./chat";

export interface Personality {
  id: string;
  name: string;
  description?: string;
  /** System prompt; `{name}` is replaced with the character's name. */
  persona?: string;
  lines?: Lines;
  llm?: { temperature?: number; maxWords?: number };
}

let cached: Personality[] | null = null;

export async function listPersonalities(): Promise<Personality[]> {
  if (cached) return cached;
  try {
    const res = await fetch("/personalities/index.json");
    const data = (await res.json()) as { profiles: Personality[] };
    cached = data.profiles;
  } catch {
    cached = [{ id: "pack", name: "As the character" }];
  }
  return cached;
}

export interface ResolvedPersonality {
  id: string;
  persona: string;
  lines: Lines;
  temperature: number;
  maxWords: number;
}

/** The persona, lines and model settings in effect for a character under a profile id. */
export async function resolvePersonality(id: string, characterName: string, packPersona: string | undefined, packLines: Lines): Promise<ResolvedPersonality> {
  const profiles = await listPersonalities();
  const p = profiles.find((x) => x.id === id) ?? profiles[0];
  const temperature = p.llm?.temperature ?? 0.9;
  const maxWords = p.llm?.maxWords ?? 35;
  if (!p.persona) {
    return { id: p.id, persona: packPersona ?? defaultPersona(characterName), lines: packLines, temperature, maxWords };
  }
  const persona =
    p.persona.replaceAll("{name}", characterName) +
    ` Reply in one or two short sentences, at most ${maxWords} words, plain text only: no markdown, no lists, no emojis.`;
  return { id: p.id, persona, lines: p.lines ?? {}, temperature, maxWords };
}
