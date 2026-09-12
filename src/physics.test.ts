import { describe, expect, it } from "vitest";
import { WindowPhysics } from "./physics";
import type { Surface, WorkArea } from "./input";

/**
 * The climb, end to end, with the numbers from the machine this was debugged on: three
 * 2560x1440 monitors side by side (the outer two sit a little higher than the primary), a
 * 48px taskbar, and a character 660px tall at size 1.5. Every window on a normal desktop has
 * its title bar 200-300px down the screen, which is far too high for him to stand on, so the
 * screensaver drags whatever he hangs from downward until there is room. That drag is modelled
 * here the way screensaver.ts does it, so the physics and the page are tested as one system.
 */
const H = 660;
const W = 480;
const HEAD = 102;
const TASKBAR = 48;
const AREAS: WorkArea[] = [
  { left: -2560, top: -86, right: 0, bottom: 1306, monitorBottom: 1354 },
  { left: 0, top: 0, right: 2560, bottom: 1392, monitorBottom: 1440 },
  { left: 2560, top: -95, right: 5120, bottom: 1297, monitorBottom: 1345 },
] as WorkArea[];

/** The screensaver's rule: his weight sinks a gripped window to this fraction of his height. */
const STAND_RATIO = 0.82;
const DRAG_SPEED = 620;
const GRIP = 70;

function buddyOn(area: WorkArea, cx: number): WindowPhysics {
  const p = new WindowPhysics({ gravity: true, throwable: false });
  p.w = W;
  p.h = H;
  p.headPx = HEAD;
  p.crownPx = HEAD;
  p.floorOverlap = TASKBAR;
  p.roam = true;
  // Private on purpose in the class; a test may reach in rather than pretend to be Tauri.
  (p as unknown as { areas: WorkArea[] }).areas = AREAS;
  (p as unknown as { area: WorkArea }).area = area;
  p.x = cx - W / 2;
  p.y = area.bottom - H + TASKBAR;
  p.mode = "rest";
  return p;
}

/**
 * Run the physics at 60fps with the screensaver's drag alongside it: while his hands or feet
 * are at a window's top edge, that window sinks until standing on it keeps his head on screen.
 * Returns how many seconds it took him to come to rest on `hwnd`, or null.
 */
function climb(p: WindowPhysics, area: WorkArea, surfaces: Surface[], hwnd: number, seconds = 6): number | null {
  const dt = 1 / 60;
  let held: Surface | null = null;
  for (let t = 0; t < seconds; t += dt) {
    p.surfaces = surfaces.map((s) => ({ ...s }));
    p.step(dt);
    if (p.mode === "rest" && p.support === hwnd) return t;
    const cx = p.x + p.w / 2;
    const hands = p.y + p.h * 0.07;
    const feet = p.y + p.h;
    // The page's grip test, with its latch: once held, a window stays held while its edge is
    // anywhere between his hands and his feet (the pull-up), and is let go after that.
    const still = (s: Surface) => cx >= s.left - 20 && cx <= s.right + 20 && s.top >= hands - GRIP && s.top <= feet + GRIP;
    if (!held || !still(held)) held = surfaces.find((s) => cx >= s.left - 20 && cx <= s.right + 20 && (Math.abs(hands - s.top) < GRIP || Math.abs(feet - s.top) < GRIP)) ?? null;
    if (held) {
      const want = area.top + H * STAND_RATIO;
      if (held.top < want) {
        const drop = Math.min(want - held.top, DRAG_SPEED * dt);
        held.top += drop;
        held.bottom += drop;
      }
    }
  }
  return null;
}

describe("climbing a window during the screensaver", () => {
  it("leaves even a monitor-wide window and returns to the roaming floor", () => {
    const p = buddyOn(AREAS[0], -1900);
    const win = { hwnd: 902001, left: -2560, right: 0, top: 560, bottom: 1306 };
    p.surfaces = [win];
    p.support = win.hwnd;
    p.y = win.top - H;
    expect(p.deskBounds).toEqual({ left: -2560, right: 5120 });
    p.leapOff(1);
    for (let frame = 0; frame < 600; frame++) p.step(1 / 60);
    expect(p.support).toBeNull();
    expect(p.mode).toBe("rest");
    for (let frame = 0; frame < 240; frame++) p.nudge(10);
    expect(p.x + p.w / 2).toBeGreaterThan(win.right);
  });

  it("hangs from a title bar high up the screen, pulls it down, and stands on it", () => {
    const area = AREAS[1];
    const win: Surface = { hwnd: 900001, left: 400, top: 250, right: 1900, bottom: 1200 };
    const p = buddyOn(area, 1000);
    p.surfaces = [win];
    const target = p.climbable();
    expect(target).not.toBeNull();
    expect(target!.hwnd).toBe(900001);
    p.hop(target!.top);
    const took = climb(p, area, [win], 900001);
    expect(took, "he should end up standing on the window").not.toBeNull();
    expect(p.y + p.h).toBeCloseTo(p.surfaces[0].top, 0);
    // With his head allowed a little over the top of the screen, it fits without ducking.
    expect(p.crouchPx).toBe(0);
  });

  it("does the same on a monitor whose top is above the primary one", () => {
    const area = AREAS[0];
    const win: Surface = { hwnd: 902001, left: -2200, top: 200, right: -600, bottom: 1100 };
    const p = buddyOn(area, -1400);
    p.surfaces = [win];
    const target = p.climbable();
    expect(target?.hwnd).toBe(902001);
    p.hop(target!.top);
    expect(climb(p, area, [win], 902001)).not.toBeNull();
    expect(p.y + p.h).toBeCloseTo(p.surfaces[0].top, 0);
  });

  it("steps up onto a low window that settled on the floor", () => {
    const area = AREAS[1];
    // A 300px-tall piece resting on the bottom of the screen: its top is below his hands.
    const win: Surface = { hwnd: 900002, left: 600, top: 1140, right: 1500, bottom: 1440 };
    const p = buddyOn(area, 1000);
    p.surfaces = [win];
    expect(p.climbable(), "an edge below his hands is not something to climb").toBeNull();
    const charge = p.chargeTarget();
    expect(charge?.hwnd).toBe(900002);
    p.hop(charge!.top);
    expect(climb(p, area, [win], 900002)).not.toBeNull();
    expect(p.y + p.h).toBe(1140);
  });

  it("is refused if the window leaves the list the moment he touches it", () => {
    // What went wrong before: his walk shoved the window awake, so it dropped out of the
    // standable list before he jumped, and there was nothing to grab.
    const area = AREAS[1];
    const p = buddyOn(area, 1000);
    p.hop(250);
    expect(climb(p, area, [], 900001)).toBeNull();
    expect(p.support).toBeNull();
  });
});
