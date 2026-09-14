import { describe, expect, it, vi } from "vitest";
import { collapseProgress, crtShape, cyclePhase, erosionSeconds } from "./screensaver-cycle";
import { ScreensaverDance } from "./screensaver-dance";

describe("screensaver cycle across offset monitors", () => {
  const desktop = { x: -2560, y: -95, width: 7680, height: 1535 };
  it("collapses to the virtual desktop centre, not three monitor centres", () => {
    const line = crtShape(desktop, 0.8)!;
    expect(line.x + line.width / 2).toBe(1280);
    expect(line.y + line.height / 2).toBe(672.5);
    const dot = crtShape(desktop, 1.1)!;
    expect(dot.round).toBe(true);
    expect(dot.x + dot.width / 2).toBe(1280);
    expect(dot.x).toBeGreaterThan(0);
    expect(dot.x + dot.width).toBeLessThan(2560);
  });
  it("shares phase timing even when frames arrive late", () => {
    // The desk shatters and fades for as long as the blackness afterwards lasts, then the tube
    // goes off, then that blackness. He roams through the first and the last of those.
    const cycle = { startedAt: 1000, voidSeconds: 6 };
    expect(cyclePhase(cycle, 999)).toBe("waiting");
    expect(cyclePhase(cycle, 1000)).toBe("collapse");
    expect(cyclePhase(cycle, 6999)).toBe("collapse");
    expect(cyclePhase(cycle, 7000)).toBe("crtOff");
    expect(cyclePhase(cycle, 8349)).toBe("crtOff");
    expect(cyclePhase(cycle, 8350)).toBe("void");
    expect(cyclePhase(cycle, 14349)).toBe("void");
    expect(cyclePhase(cycle, 14350)).toBe("erode");
    expect(crtShape(desktop, 2)).toBeNull();
    // Nothing to fade and nothing to wait through when the setting is zero.
    expect(cyclePhase({ ...cycle, voidSeconds: 0 }, 2350)).toBe("erode");
    expect(collapseProgress({ ...cycle, voidSeconds: 0 }, 1000)).toBe(1);
  });
  it("fades the desk away evenly across the collapse", () => {
    const cycle = { startedAt: 1000, voidSeconds: 6 };
    expect(collapseProgress(cycle, 1000)).toBe(0);
    expect(collapseProgress(cycle, 4000)).toBeCloseTo(0.5);
    expect(collapseProgress(cycle, 7000)).toBe(1);
    // Late frames never drive it past either end.
    expect(collapseProgress(cycle, 999)).toBe(0);
    expect(collapseProgress(cycle, 99999)).toBe(1);
  });
  it("defaults slow and supports buddy-only erosion", () => {
    expect(erosionSeconds(20)).toBe(488);
    expect(erosionSeconds(0)).toBe(Infinity);
    expect(erosionSeconds(100)).toBe(40);
    expect(erosionSeconds(NaN)).toBe(488);
  });
});

describe("screensaver dance budget with continuous music", () => {
  it("takes short breaks and does not begin one stranded on a window", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const gate = new ScreensaverDance();
      gate.reset(0);
      expect(gate.allows(44, true, true)).toBe(false);
      expect(gate.allows(45, true, false)).toBe(false);
      expect(gate.allows(50, true, true)).toBe(true);
      expect(gate.allows(59, true, true)).toBe(true);
      expect(gate.allows(60, true, true)).toBe(false);
      expect(gate.allows(124, true, true)).toBe(false);
      expect(gate.allows(125, true, true)).toBe(true);
    } finally { random.mockRestore(); }
  });
});
