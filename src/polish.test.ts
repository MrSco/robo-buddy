import { describe, expect, it } from "vitest";
import { Havoc, contactFraction } from "./havoc";
import { heardSpeech } from "./chat";
import { traceOutline } from "./screensaver-fracture";
import { SimulationClock } from "./simulation-clock";
import { LoadingOwner } from "./preview-loading";
import { Debris, MAX_DEBRIS, MAX_DEBRIS_PIXELS } from "./screensaver-debris";
import { artworkRegions } from "./screensaver-fracture";

it("sends real speech to be transcribed and keeps a quiet room to itself", () => {
  const noise = (floor: number, n = 200) => Array.from({ length: n }, () => floor + Math.random() * floor * 0.3);
  const speech = (levels: number[], at: number, loud: number, n = 10) => {
    const out = levels.slice();
    for (let i = at; i < at + n; i++) out[i] = loud;
    return out;
  };
  // A silent mic, and a hissy one: neither is worth transcribing.
  expect(heardSpeech(noise(0))).toBe(false);
  expect(heardSpeech(noise(0.02))).toBe(false);
  // A loud room, still saying nothing.
  expect(heardSpeech(noise(0.2))).toBe(false);
  // Someone speaking, quietly, in each of those rooms.
  expect(heardSpeech(speech(noise(0), 40, 0.3))).toBe(true);
  expect(heardSpeech(speech(noise(0.02), 40, 0.2))).toBe(true);
  expect(heardSpeech(speech(noise(0.2), 40, 0.9))).toBe(true);
  // A cough or a knock: one moment of noise is not a sentence.
  expect(heardSpeech(speech(noise(0.01), 40, 0.8, 2))).toBe(false);
  // No meter ran, so there is nothing to judge and the recording goes anyway.
  expect(heardSpeech([])).toBe(true);
});
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
  /** Several pieces within reach, as a real desk offers: he works across them rather than
   * hitting one of them over and over. */
  const field = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    x: -120 + i * 100,
    y: 550,
    w: 90,
    h: 50,
    debris: i % 2 === 0,
  }));
  it("applies one contact per attack and cancels when grabbed", () => {
    const h = new Havoc(() => 0.2);
    const tick = (t: number, available = true) => h.update(t, available, 70, 0, 0, 320, 660, [target], false);
    // Early seconds of a cycle belong to travel; the strike starts once that window has passed.
    expect(tick(1)).toBeNull();
    expect(tick(5)?.kind).toBe("throw");
    expect(tick(5.3)?.impact).toBe(false);
    expect(tick(5.8)?.impact).toBe(true);
    expect(tick(5.9)?.impact).toBe(false);
    expect(tick(5.95, false)).toBeNull();
    expect(tick(6)).toBeNull();
  });
  it("increases attacks while retaining travel intervals", () => {
    function count(intensity: number) {
      const h = new Havoc(() => 0.6);
      let hits = 0,
        travel = 0;
      for (let t = 0; t < 120; t += 0.05) {
        const a = h.update(t, true, intensity, 0, 0, 320, 660, field, false);
        if (a?.impact) hits++;
        if (!a && t % 12 < 4) travel++;
      }
      return { hits, travel };
    }
    const low = count(0),
      high = count(100);
    expect(high.hits).toBeGreaterThan(low.hits * 1.5);
    expect(high.travel).toBeGreaterThan(300);
  });
  it("stops swinging at nothing so the travel scheduler gets the screen back", () => {
    // Nothing within reach anywhere: he is allowed a swing or two and then has to go looking,
    // or he roots himself in the gap a window left and shadow-boxes there for good.
    const h = new Havoc(() => 0.6);
    let started = 0;
    let previous = false;
    for (let t = 0; t < 120; t += 0.05) {
      const action = h.update(t, true, 100, 0, 0, 320, 660, [], false);
      if (action && !previous) started++;
      previous = !!action;
    }
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(20);
    // With something to hit, the same two minutes are busy.
    const busy = new Havoc(() => 0.6);
    let withTarget = 0;
    previous = false;
    for (let t = 0; t < 120; t += 0.05) {
      const action = busy.update(t, true, 100, 0, 0, 320, 660, field, false);
      if (action && !previous) withTarget++;
      previous = !!action;
    }
    expect(withTarget).toBeGreaterThan(started * 2);
  });
  it("lands the blow halfway through a strike, and later for a throw", () => {
    // Halfway is where a strike is fully extended; a thrown object leaves the hand later.
    expect(contactFraction("punch")).toBeCloseTo(0.5);
    expect(contactFraction("kick")).toBeCloseTo(0.5);
    expect(contactFraction("throw")).toBeGreaterThan(contactFraction("punch"));
    const h = new Havoc(() => 0.6, () => 1);
    const tick = (t: number) => h.update(t, true, 100, 0, 0, 320, 660, [target], false);
    let contact = -1;
    for (let t = 4; t < 9; t += 0.01) {
      const action = tick(t);
      if (action?.impact) {
        contact = t - action.start;
        break;
      }
    }
    expect(contact).toBeGreaterThan(0.45);
    expect(contact).toBeLessThan(0.72);
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
it("hands a shard to the next screen along, and bounces it where there is none", () => {
  const monitors = [
    { x: 0, y: 0, width: 1000, height: 800 },
    { x: 1000, y: 0, width: 1000, height: 800 },
  ];
  // Standing in for one screensaver page: it owns monitor 0 and can only see its own pixels.
  const mine = monitors[0];
  const sent: { to: number; x: number }[] = [];
  const handOn = (b: { x: number; y: number }, edge: 1 | -1) => {
    const px = edge === 1 ? mine.x + mine.width + 1 : mine.x - 1;
    const py = mine.y + b.y;
    const to = monitors.findIndex((m, i) => i !== 0 && px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height);
    if (to < 0) return false;
    sent.push({ to, x: monitors[to].x + 1 });
    return true;
  };
  const d = new Debris();
  // Thrown right, off the inner edge: monitor 1 is that way, so it goes over.
  const right = d.add(shard(80))!;
  right.x = 900;
  right.y = 200;
  right.vx = 3000;
  right.vy = -200;
  for (let i = 0; i < 120 && d.bodies.length; i++) d.step(1 / 60, mine.width, mine.height, handOn);
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(1);
  expect(sent[0].x).toBeGreaterThanOrEqual(1000);
  expect(d.bodies).toHaveLength(0);

  // Thrown left, off the outer edge: nothing over there, so it stays and bounces. Kept short,
  // because a piece that bounces off the far wall will cross the screen and leave by the inner
  // edge like the first one did.
  const left = d.add(shard(80))!;
  left.x = 100;
  left.y = 200;
  left.vx = -3000;
  left.vy = -200;
  for (let i = 0; i < 30; i++) d.step(1 / 60, mine.width, mine.height, handOn);
  expect(sent).toHaveLength(1);
  expect(d.bodies).toHaveLength(1);
  expect(d.bodies[0].x).toBeGreaterThanOrEqual(0);
  expect(d.bodies[0].vx).toBeGreaterThan(0);
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

describe("cutout silhouette", () => {
  /** A filled disc, optionally hollowed out in the middle the way the artwork is. */
  function disc(w: number, h: number, radius: number, hollow = 0) {
    const p = new Uint8ClampedArray(w * h * 4);
    const cx = w / 2,
      cy = h / 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius && d >= hollow) p.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
      }
    return p;
  }
  function radii(outline: Float32Array) {
    const out: number[] = [];
    for (let i = 0; i < outline.length; i += 2) out.push(Math.hypot(outline[i] - 0.5, outline[i + 1] - 0.5));
    return out;
  }

  it("follows the edge of the artwork rather than its bounding box", () => {
    const { outline, x0, x1 } = traceOutline(disc(64, 64, 24), 64, 64, 64);
    expect(x0).toBeLessThanOrEqual(16);
    expect(x1).toBeGreaterThanOrEqual(47);
    // Every point sits on the boundary of its own box, so a round blast stays round.
    for (const r of radii(outline)) expect(r).toBeGreaterThan(0.4);
    for (let i = 0; i < outline.length; i++) expect(outline[i]).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < outline.length; i++) expect(outline[i]).toBeLessThanOrEqual(1);
  });

  it("is not speared by a gap inside the blast", () => {
    // The centre is empty, as it is in artwork whose middle is punched clean through. Stopping
    // at the first gap on each ray would collapse the shape onto that hole and throw spikes
    // across the slice, which is how an earlier attempt at this failed.
    const { outline } = traceOutline(disc(64, 64, 24, 10), 64, 64, 64);
    const all = radii(outline);
    const smallest = Math.min(...all);
    const largest = Math.max(...all);
    expect(smallest).toBeGreaterThan(0.4);
    expect(largest / smallest).toBeLessThan(1.3);
  });

  it("falls back to the whole rectangle when the artwork says nothing", () => {
    const { outline } = traceOutline(new Uint8ClampedArray(32 * 32 * 4), 32, 32, 8);
    for (let i = 0; i < outline.length; i++) expect(outline[i] === 0 || outline[i] === 1).toBe(true);
  });
});

it("works across the pieces in front of him instead of hitting one of them repeatedly", () => {
  // One piece, struck once, is passed over while he looks for something else. Without that he
  // plants himself over a broken window or a settled shard and keeps swinging at it.
  const h = new Havoc(() => 0.6);
  const one = [{ id: 7, x: 140, y: 550, w: 100, h: 50, debris: false }];
  let starts = 0;
  let previous = false;
  for (let t = 0; t < 30; t += 0.05) {
    const action = h.update(t, true, 100, 0, 0, 320, 660, one, false);
    if (action && !previous) starts++;
    previous = !!action;
  }
  expect(starts).toBeLessThan(8);
});

it("keeps its reach to his own arm, not to how wide the window happens to be", () => {
  // A window wide enough to fill the screen used to count as within reach from most of the way
  // across it, because reach was measured from its centre against its own half-width. He could
  // then stand still and keep hitting it from across the desk. Far away it should now occupy
  // him no more than an empty screen does; beside him it should occupy him a great deal more.
  function starts(targets: { id: number; x: number; y: number; w: number; h: number; debris: boolean }[]) {
    const h = new Havoc(() => 0.6);
    let count = 0;
    let previous = false;
    for (let t = 0; t < 120; t += 0.05) {
      const action = h.update(t, true, 100, 0, 0, 320, 660, targets, false);
      if (action && !previous) count++;
      previous = !!action;
    }
    return count;
  }
  const huge = { id: 9, y: 200, w: 2400, h: 900, debris: false };
  const far = starts([{ ...huge, x: 1400 }]);
  const beside = starts([{ ...huge, x: -1000 }]);
  expect(far).toBeLessThanOrEqual(starts([]));
  expect(beside).toBeGreaterThan(far);
});
