import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export interface CursorState {
  x: number;
  y: number;
  buttons: number;
  /** False until the first sample arrives. Coordinates can be negative on multi-monitor setups. */
  valid: boolean;
}

export interface WorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const IN_TAURI = "__TAURI_INTERNALS__" in window;

/** Latest global cursor state in physical screen pixels, fed by the Rust polling thread. */
export const cursor: CursorState = { x: 0, y: 0, buttons: 0, valid: false };
let prevButtons = 0;
const releaseHandlers: Array<() => void> = [];

export function onLeftRelease(fn: () => void) {
  releaseHandlers.push(fn);
}

export async function startInput() {
  if (!IN_TAURI) {
    // Browser fallback for development: window-relative pointer events.
    window.addEventListener("pointermove", (e) => {
      cursor.x = e.screenX;
      cursor.y = e.screenY;
      cursor.valid = true;
    });
    window.addEventListener("pointerup", () => {
      for (const fn of releaseHandlers) fn();
    });
    return;
  }
  await listen<CursorState>("cursor", (e) => {
    cursor.x = e.payload.x;
    cursor.y = e.payload.y;
    cursor.buttons = e.payload.buttons;
    cursor.valid = true;
    if (prevButtons & 1 && !(cursor.buttons & 1)) {
      for (const fn of releaseHandlers) fn();
    }
    prevButtons = cursor.buttons;
  });
}

export async function getWorkArea(x: number, y: number): Promise<WorkArea> {
  if (!IN_TAURI) return { left: 0, top: 0, right: screen.width, bottom: screen.height };
  return invoke<WorkArea>("work_area", { x, y });
}
