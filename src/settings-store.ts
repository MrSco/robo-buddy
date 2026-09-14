import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./input";

export type ClickThroughMode = "pixel" | "window" | "locked";

export interface Settings {
  character: string;
  size: number;
  /** Light and reflection strength on 3D characters, 1 = as designed. The global fallback. */
  lighting: number;
  /** Lighting per character id; a bright scan and a black endoskeleton want very different values. */
  lightingByCharacter: Record<string, number>;
  musicEnabled: boolean;
  mouseEnabled: boolean;
  physicsEnabled: boolean;
  gravityStrength: number;
  bounciness: number;
  throwStrength: number;
  screensaverIntensity: number;
  /**
   * How eagerly he locks onto a beat, 0..1. Low waits for a tempo to hold steady a long while
   * before he moves; high starts almost at once. Loudness plays no part: a beat is a beat at any
   * volume, so a quiet track gets him going just as a loud one does.
   */
  musicBeatLock: number;
  clickThrough: ClickThroughMode;
  autostart: boolean;
  paused: boolean;
  /** Minutes of inactivity before sleeping; 0 = never. */
  sleepAfterMin: number;
  soundsEnabled: boolean;
  /** Sound effects during the screensaver. Off by default: a sleeping room should stay quiet. */
  screensaverSounds: boolean;
  /**
   * A .scr to run behind the screensaver, so knocking a window away reveals it playing rather
   * than plain black. Blank for black.
   */
  screensaverBackdrop: string;
  screensaverBackdropMode: "" | "windows" | "custom" | "none";
  screensaverAfterMin: number;
  screensaverErosionStyle: "tiles" | "cracks";
  screensaverErosionSpeed: number;
  screensaverVoidSeconds: number;
  bubblesEnabled: boolean;
  /** Wander along the floor when idle. */
  wanderEnabled: boolean;
  /** "random", "procedural", or a dance clip name from the pack. */
  danceMode: string;
  /** Per pack id: idle variants / fidgets the user left enabled. Missing = all. */
  idleSets: Record<string, string[]>;
  /** Per library clip name: role override ("idle", "fidget", "dance", "poke", "held", "fall", "walk", "off"). */
  animRoles: Record<string, string>;
  hideWhenFullscreen: boolean;
  /** Overlap the taskbar by the camera's bottom margin so the soles sit on its edge. */
  standOnTaskbar: boolean;
  /** Talk (M6). */
  chatEnabled: boolean;
  chatProvider: string;
  chatEndpoint: string;
  chatModel: string;
  chatSttModel: string;
  chatVoice: boolean;
  chatGenerateLines: boolean;
  chatDailyCap: number;
  /** Separate base URL for transcriptions (a local Vibe server); blank = chat endpoint. */
  chatSttEndpoint: string;
  /** "windows" or "piper". */
  ttsEngine: string;
  /** "pipeline" (chat + speech models) or "live" (OpenAI GPT-Live, one session that listens, thinks and speaks). */
  talkMode: string;
  /** Live voice: the backend model that reasons and runs tools. */
  liveBackendModel: string;
  /** Live voice: optional voice name; blank = the server's default. */
  liveVoice: string;
  /** Live voice: minutes per day, a safety net for a session left open. 0 = no limit. */
  liveDailyMinutes: number;
  piperExe: string;
  piperVoice: string;
  /** Personality profile id; "pack" = the character's own persona and lines. */
  personality: string;
  /** React to typing (key counts and a couple of shortcuts only). */
  keyboardEnabled: boolean;
  /** Land on and walk along the top edges of other windows. */
  surfacesEnabled: boolean;
  /** Open the talk box with a system-wide hotkey. */
  talkHotkeyEnabled: boolean;
  /** The combo itself, as "Ctrl+Shift+T". */
  talkHotkey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  character: "rocco",
  size: 1,
  lighting: 1,
  lightingByCharacter: {},
  musicEnabled: true,
  mouseEnabled: true,
  physicsEnabled: true,
  gravityStrength: 1,
  bounciness: 0.26,
  throwStrength: 1,
  screensaverIntensity: 70,
  musicBeatLock: 0.7,
  clickThrough: "pixel",
  autostart: false,
  paused: false,
  sleepAfterMin: 5,
  soundsEnabled: true,
  screensaverSounds: false,
  screensaverBackdrop: "",
  screensaverBackdropMode: "",
  screensaverAfterMin: 0,
  screensaverErosionStyle: "cracks",
  screensaverErosionSpeed: 20,
  screensaverVoidSeconds: 6,
  bubblesEnabled: true,
  wanderEnabled: true,
  danceMode: "random",
  idleSets: {},
  animRoles: {},
  hideWhenFullscreen: true,
  standOnTaskbar: true,
  chatEnabled: false,
  chatProvider: "groq",
  chatEndpoint: "https://api.groq.com/openai/v1",
  chatModel: "groq/compound",
  chatSttModel: "whisper-large-v3-turbo",
  chatVoice: true,
  chatGenerateLines: true,
  chatDailyCap: 300,
  chatSttEndpoint: "",
  ttsEngine: "windows",
  talkMode: "pipeline",
  liveBackendModel: "gpt-5.6-luna",
  liveVoice: "",
  liveDailyMinutes: 30,
  piperExe: "",
  piperVoice: "",
  personality: "pack",
  keyboardEnabled: true,
  surfacesEnabled: true,
  talkHotkeyEnabled: false,
  talkHotkey: "Ctrl+Shift+T",
};

export async function getSettings(): Promise<Settings> {
  if (!IN_TAURI) {
    const params = new URLSearchParams(location.search);
    return { ...DEFAULT_SETTINGS, character: params.get("character") ?? "rocco" };
  }
  return { ...DEFAULT_SETTINGS, ...(await invoke<Settings>("get_settings")) };
}

export async function setSettings(s: Settings): Promise<void> {
  if (!IN_TAURI) return;
  await invoke("set_settings", { settings: s });
}

export async function onSettingsChanged(fn: (s: Settings) => void): Promise<void> {
  if (!IN_TAURI) return;
  await listen<Settings>("settings-changed", (e) => fn({ ...DEFAULT_SETTINGS, ...e.payload }));
}

/** Lighting for one character: its own value, else the global default. */
export function lightingFor(settings: Settings, character: string): number {
  return settings.lightingByCharacter?.[character] ?? settings.lighting ?? 1;
}

/**
 * The beat-lock slider in seconds: 0 waits eight seconds for a tempo to prove itself, 1 moves
 * after one. Shared so the settings window and the buddy read the slider the same way.
 */
export function beatLockSeconds(lock: number): number {
  const v = Number.isFinite(lock) ? Math.min(1, Math.max(0, lock)) : 0.7;
  return 8 - v * 7;
}
