import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IN_TAURI } from "./input";

export type ClickThroughMode = "pixel" | "window" | "locked";

export interface Settings {
  character: string;
  size: number;
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
}

export const DEFAULT_SETTINGS: Settings = {
  character: "rocco",
  size: 1,
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
