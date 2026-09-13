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

/** A pack, with or without the run gait, and nothing else to do but walk about. */
function walker(run: boolean) {
  const behavior = new Behavior();
  behavior.setPack(
    {
      name: "test",
      version: 1,
      renderer: "3d",
      model: "",
      reactions: {},
      states: {
        idle: { clip: "idle" },
        walk: { clip: "walk", speed: 110 },
        ...(run
          ? {
              run: { clip: "run", speed: 300, naturalMps: 3.5 },
              sprint: { clip: "sprint", speed: 480, naturalMps: 5.6 },
            }
          : {}),
      },
    },
    () => 1,
    0,
  );
  return behavior;
}

const floor = { free: true, x: 1200, w: 320, left: 0, right: 2560, climb: null, charge: null, onSurface: false, support: null, deskLeft: 0, deskRight: 2560 };

it("breaks into a run on the floor once the pack has a run gait", () => {
  const behavior = walker(true);
  const gaits = new Map<number, string>();
  for (let i = 0; i < 400; i++) {
    const act = behavior.update({ ...floor, t: i * 3 });
    if (act.kind === "walk") gaits.set(act.speed, act.clip?.name ?? "-");
  }
  // The cycle has to come with the speed: travelling at a run drawn with the walk clip is the
  // skating this replaced.
  expect(gaits.get(300)).toBe("run");
  expect(gaits.get(110)).toBe("walk");
});

it("charges at a window with the sprint cycle during the screensaver", () => {
  const behavior = walker(true);
  behavior.energetic = true;
  const charge = { hwnd: 1234, x: 2100, top: 400 };
  let charged: { speed: number; clip: string } | null = null;
  for (let i = 0; i < 400 && !charged; i++) {
    const act = behavior.update({ ...floor, t: i * 3, charge });
    if (act.kind === "walk" && act.then) charged = { speed: act.speed, clip: act.clip?.name ?? "-" };
  }
  expect(charged).toEqual({ speed: 480, clip: "sprint" });
});

it("never runs when the pack has no run clip", () => {
  const behavior = walker(false);
  for (let i = 0; i < 400; i++) {
    const act = behavior.update({ ...floor, t: i * 3 });
    if (act.kind === "walk") expect(act.speed).toBe(110);
  }
});
