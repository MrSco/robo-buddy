import { expect, it, vi } from "vitest";
import { Behavior } from "./behavior";

it("makes another decision after leaping off a screensaver window", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
  try {
    const behavior = new Behavior();
    behavior.setPack({ name: "test", version: 1, renderer: "3d", model: "", reactions: {}, states: { idle: { clip: "idle" }, walk: { clip: "walk", speed: 300 } } }, () => 1, 0);
    behavior.energetic = true;
    const status = { t: 30, free: true, x: -1400, w: 480, left: -2200, right: -600, climb: null, charge: null, onSurface: true, support: 902001, deskLeft: -2560, deskRight: 5120 };
    behavior.update(status);
    expect(behavior.pendingLeave).toBe(1);
    behavior.pendingLeave = null;
    behavior.update({ ...status, t: 30.1, free: false, onSurface: false, support: null });
    const next = behavior.update({ ...status, t: 35, onSurface: false, support: null, left: -2560, right: 5120 });
    expect(next.kind).toBe("walk");
  } finally { random.mockRestore(); }
});
