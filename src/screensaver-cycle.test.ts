import { describe, expect, it, vi } from "vitest";
import { crtShape, cyclePhase, erosionSeconds, shatterProgress, SHATTER_SECONDS } from "./screensaver-cycle";
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
    // Everything breaks up first, and that is not part of either stretch of him roaming: the
    // bare stretch starts once the pieces are gone, then the tube, then the same in blackness.
    const cycle = { startedAt: 1000, voidSeconds: 6 };
    const bare = SHATTER_SECONDS * 1000;
    expect(cyclePhase(cycle, 999)).toBe("waiting");
    expect(cyclePhase(cycle, 1000)).toBe("shatter");
    expect(cyclePhase(cycle, 1000 + bare - 1)).toBe("shatter");
    expect(cyclePhase(cycle, 1000 + bare)).toBe("bare");
    // Six seconds of him and the backdrop, whole, after the breaking up rather than during it.
    expect(cyclePhase(cycle, 1000 + bare + 5999)).toBe("bare");
    expect(cyclePhase(cycle, 1000 + bare + 6000)).toBe("crtOff");
    expect(cyclePhase(cycle, 1000 + bare + 7349)).toBe("crtOff");
    expect(cyclePhase(cycle, 1000 + bare + 7350)).toBe("void");
    expect(cyclePhase(cycle, 1000 + bare + 13349)).toBe("void");
    expect(cyclePhase(cycle, 1000 + bare + 13350)).toBe("erode");
    expect(crtShape(desktop, 2)).toBeNull();
    // With no roaming asked for, the breaking up still happens; it is the show, not a wait.
    expect(cyclePhase({ ...cycle, voidSeconds: 0 }, 1000 + bare - 1)).toBe("shatter");
    expect(cyclePhase({ ...cycle, voidSeconds: 0 }, 1000 + bare)).toBe("crtOff");
  });
  it("fades the pieces out together across the breaking up", () => {
    const cycle = { startedAt: 1000, voidSeconds: 6 };
    expect(shatterProgress(cycle, 1000)).toBe(0);
    expect(shatterProgress(cycle, 1000 + SHATTER_SECONDS * 500)).toBeCloseTo(0.5);
    expect(shatterProgress(cycle, 1000 + SHATTER_SECONDS * 1000)).toBe(1);
    // Late frames never drive it past either end, and it does not depend on the roaming length.
    expect(shatterProgress(cycle, 999)).toBe(0);
    expect(shatterProgress(cycle, 99999)).toBe(1);
    expect(shatterProgress({ ...cycle, voidSeconds: 0 }, 1000 + SHATTER_SECONDS * 500)).toBeCloseTo(0.5);
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
