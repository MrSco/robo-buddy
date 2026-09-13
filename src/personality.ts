/**
 * Personality profiles: a persona for the LLM, a bucket of pre-baked bubble lines, and the
 * model settings that go with them. "pack" means the character's own persona and lines.
 */
import { invoke } from "@tauri-apps/api/core";
import { defaultPersona, type Lines } from "./chat";
import { IN_TAURI } from "./input";

export interface Personality {
  id: string;
  name: string;
  /** Bundled profiles are read-only; user ones live in %APPDATA%/.../personalities.json. */
  user?: boolean;
  description?: string;
  /** System prompt; `{name}` is replaced with the character's name. */
  persona?: string;
  lines?: Lines;
  llm?: { temperature?: number; maxWords?: number };
}

let cached: Personality[] | null = null;

export function invalidatePersonalities() {
  cached = null;
}

/** Bundled profiles, then the user's own (a user profile with a bundled id replaces it). */
export async function listPersonalities(): Promise<Personality[]> {
  if (cached) return cached;
  let bundled: Personality[] = [{ id: "pack", name: "As the character" }];
  try {
    const res = await fetch("/personalities/index.json");
    const data = (await res.json()) as { profiles: Personality[] };
    bundled = data.profiles;
  } catch {
    /* keep the fallback */
  }
  const users = await loadUserPersonalities();
  const merged = bundled.filter((b) => !users.some((u) => u.id === b.id)).concat(users);
  cached = merged;
  return merged;
}

export async function loadUserPersonalities(): Promise<Personality[]> {
  if (!IN_TAURI) return [];
  try {
    const raw = await invoke<string | null>("load_user_personalities");
    if (!raw) return [];
    const list = JSON.parse(raw) as Personality[];
    return Array.isArray(list) ? list.map((p) => ({ ...p, user: true })) : [];
  } catch {
    return [];
  }
}

export async function saveUserPersonalities(list: Personality[]): Promise<void> {
  const clean = list.map(({ user: _u, ...rest }) => rest);
  await invoke("save_user_personalities", { json: JSON.stringify(clean, null, 2) });
  cached = null;
}

/** Turn a name into a stable id ("Night Owl" -> "night-owl"), unique against `taken`. */
export function slugFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

export interface ResolvedPersonality {
  id: string;
  persona: string;
  lines: Lines;
  temperature: number;
  maxWords: number;
}

/** The persona, lines and model settings in effect for a character under a profile id. */
export async function resolvePersonality(
  id: string,
  characterName: string,
  packPersona: string | undefined,
  packLines: Lines,
  packLlm?: { temperature?: number; maxWords?: number },
): Promise<ResolvedPersonality> {
  const profiles = await listPersonalities();
  const p = profiles.find((x) => x.id === id) ?? profiles[0];
  if (!p.persona) {
    // As the character: its own warmth and brevity too, not just its own words.
    const temperature = packLlm?.temperature ?? p.llm?.temperature ?? 0.9;
    const maxWords = packLlm?.maxWords ?? p.llm?.maxWords ?? 35;
    return { id: p.id, persona: packPersona ?? defaultPersona(characterName, maxWords), lines: packLines, temperature, maxWords };
  }
  const temperature = p.llm?.temperature ?? 0.9;
  const maxWords = p.llm?.maxWords ?? 35;
  const persona =
    p.persona.replaceAll("{name}", characterName) +
    ` Reply in one or two short sentences, at most ${maxWords} words, plain text only: no markdown, no lists, no emojis.`;
  return { id: p.id, persona, lines: p.lines ?? {}, temperature, maxWords };
}
