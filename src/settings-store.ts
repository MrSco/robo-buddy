import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./input";

export type ClickThroughMode = "pixel" | "window" | "locked";

export interface Settings {
  character: string;
  size: number;
  /** Light and reflection strength on 3D characters, 1 = as designed. */
  lighting: number;
  musicEnabled: boolean;
  mouseEnabled: boolean;
  physicsEnabled: boolean;
  musicThreshold: number;
  requireTempo: boolean;
  clickThrough: ClickThroughMode;
  autostart: boolean;
  paused: boolean;
  /** Minutes of inactivity before sleeping; 0 = never. */
  sleepAfterMin: number;
  soundsEnabled: boolean;
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
}

export const DEFAULT_SETTINGS: Settings = {
  character: "rocco",
  size: 1,
  lighting: 1,
  musicEnabled: true,
  mouseEnabled: true,
  physicsEnabled: true,
  musicThreshold: 0.15,
  requireTempo: false,
  clickThrough: "pixel",
  autostart: false,
  paused: false,
  sleepAfterMin: 5,
  soundsEnabled: true,
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
