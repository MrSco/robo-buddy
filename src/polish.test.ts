import { describe, expect, it } from "vitest";
import { Havoc } from "./havoc";
import { SimulationClock } from "./simulation-clock";
import { LoadingOwner } from "./preview-loading";
import { Debris, MAX_DEBRIS, MAX_DEBRIS_PIXELS } from "./screensaver-debris";
import { artworkRegions } from "./screensaver-fracture";

it("freezes simulation deadlines across an overnight fullscreen pause", () => {
  let now = 0;
  const clock = new SimulationClock(() => now);
  now = 16;
  expect(clock.getDelta()).toBe(0.016);
  clock.setPaused(true);
  now += 12 * 3600 * 1000;
  expect(clock.getDelta()).toBe(0);
  expect(clock.elapsedTime).toBe(0.016);
  clock.setPaused(false);
  now += 16;
  expect(clock.getDelta()).toBe(0.016);
  expect(clock.elapsedTime).toBe(0.032);
});
it("stale preview success/failure cannot own a newer load or cancelled preview", () => {
  const owner = new LoadingOwner();
  const a = owner.begin(),
    b = owner.begin();
  expect(owner.owns(a)).toBe(false);
  expect(owner.owns(b)).toBe(true);
  owner.cancel();
  expect(owner.owns(b)).toBe(false);
});
describe("havoc", () => {
  const target = { id: 1, x: 140, y: 550, w: 100, h: 50, debris: true };
  it("applies one contact per attack and cancels when grabbed", () => {
    const h = new Havoc(() => 0.2);
    const tick = (t: number, available = true) => h.update(t, available, 70, 0, 0, 320, 660, [target], false);
    expect(tick(1)).toBeNull();
    expect(tick(3)?.kind).toBe("throw");
    expect(tick(3.3)?.impact).toBe(false);
    expect(tick(4.01)?.impact).toBe(true);
    expect(tick(4.1)?.impact).toBe(false);
    expect(tick(4.15, false)).toBeNull();
    expect(tick(4.2)).toBeNull();
  });
  it("increases attacks while retaining travel intervals", () => {
    function count(intensity: number) {
      const h = new Havoc(() => 0.6);
      let hits = 0,
        travel = 0;
      for (let t = 0; t < 120; t += 0.05) {
        const a = h.update(t, true, intensity, 0, 0, 320, 660, [], false);
        if (a?.impact) hits++;
        if (!a && t % 14 < 3) travel++;
      }
      return { hits, travel };
    }
    const low = count(0),
      high = count(100);
    expect(high.hits).toBeGreaterThan(low.hits * 1.5);
    expect(high.travel).toBeGreaterThan(300);
  });
});
function shard(x = 300) {
  return {
    img: { width: 120, height: 80 } as HTMLCanvasElement,
    x,
    y: 100,
    w: 120,
    h: 80,
    vx: 100,
    vy: 0,
    angle: 0,
    spin: 1,
  };
}
it("bounds debris over thirty simulated minutes and releases every canvas on restore", () => {
  const d = new Debris();
  let max = 0;
  for (let frame = 0; frame < 30 * 60 * 60; frame++) {
    if (frame % 10 === 0) d.add(shard(200 + (frame % 1000)));
    d.step(1 / 60, 2560, 1440);
    max = Math.max(max, d.bodies.length);
    if (frame % 600 === 0) {
      expect(d.bodies.length).toBeLessThanOrEqual(MAX_DEBRIS);
      expect(d.pixels).toBeLessThanOrEqual(MAX_DEBRIS_PIXELS);
    }
  }
  expect(max).toBeGreaterThan(30);
  const images = d.bodies.map((b) => b.img);
  d.clear();
  expect(d.bodies).toHaveLength(0);
  expect(d.pixels).toBe(0);
  expect(images.every((i) => i.width === 1)).toBe(true);
});
it("settles debris, then kicks and throws it awake, and eventually fades it", () => {
  const d = new Debris();
  d.add(shard());
  for (let i = 0; i < 900; i++) d.step(1 / 60, 1000, 800);
  const b = d.bodies[0];
  expect(b.asleep).toBe(true);
  expect(d.strike(b.x, b.y, 1, "kick", 100)).toBe(true);
  expect(b.vx).toBe(1400);
  expect(b.asleep).toBe(false);
  expect(d.strike(b.x, b.y, -1, "throw", 100)).toBe(true);
  expect(b.vx).toBe(-1700);
  expect(b.vy).toBe(-1200);
  for (let i = 0; i < 2400; i++) d.step(1 / 60, 1000, 800);
  expect(d.bodies).toHaveLength(0);
});
it("derives shard boundaries from a bent artwork crack, not a square grid", () => {
  const w = 40,
    h = 40,
    p = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const x = y < 20 ? 12 : 26;
    for (let xx = Math.min(x, y === 20 ? 12 : x); xx <= x; xx++) {
      const k = (y * w + xx) * 4;
      p.fill(255, k, k + 4);
    }
  }
  const labels = artworkRegions(p, w, h);
  expect(labels[5 * w + 5]).not.toBe(labels[5 * w + 35]);
  expect(labels[5 * w + 20]).toBe(labels[5 * w + 35]);
  expect(labels[30 * w + 20]).toBe(labels[30 * w + 5]);
  expect(Array.from(labels).every((l) => l >= 0)).toBe(true);
});
