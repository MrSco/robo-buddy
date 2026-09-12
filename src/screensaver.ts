/**
 * Screensaver backdrop. It takes one picture of the desktop, dims it, and cuts a sprite out of
 * that picture for every window that was on screen. He then shoves those sprites around while
 * the real desktop sits untouched underneath: nothing here moves, closes or resizes a real
 * window. Any input at all ends it.
 *
 * The buddy stays in his own window on top of this one, so his physics, poses and clips are
 * exactly what they are on the taskbar; this page only needs to know where he is.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The window's own pixels, base64 PNG. */
  png: string;
}

/** One monitor: its picture, where it sits, and the windows that were on it. */
interface MonitorShot {
  x: number;
  y: number;
  width: number;
  height: number;
  png: string;
  sprites: SpriteRect[];
}

/** One piece of the desktop he can push about. */
interface Sprite {
  img: ImageBitmap;
  /** Where it was cut from, so the hole it leaves can be drawn. */
  homeX: number;
  homeY: number;
  w: number;
  h: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  /** Rests once it has settled on the floor, so a tidy pile stops jittering. */
  asleep: boolean;
}

const GRAVITY = 1900; // px/s^2
const BOUNCE = 0.42;
const FRICTION = 2.4;
const SETTLE = 28; // px/s

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
const loading = document.getElementById("loading") as HTMLParagraphElement;

let shot: ImageBitmap | null = null;
let sprites: Sprite[] = [];
let screen: MonitorShot | null = null;
/** Device pixels per CSS pixel for the canvas backing store. */
let dpr = 1;
let ended = false;

/** Where the buddy's window is, in capture coordinates; null when he is not around. */
let buddy: { x: number; y: number; w: number; h: number } | null = null;

const log = (m: string) => void invoke("append_log", { line: `screensaver: ${m}` }).catch(() => {});

async function start() {
  log(`page loaded, label=${getCurrentWindow().label} inner=${window.innerWidth}x${window.innerHeight}`);
  // Each monitor gets its own window and its own picture, taken before any of them went up, so
  // they show the desktop as it really was rather than these backdrops covering it.
  // The window is labelled "screensaver-<n>", one per monitor.
  const index = Number(/(\d+)$/.exec(getCurrentWindow().label)?.[1] ?? 0);
  screen = await invoke<MonitorShot>("capture_desktop", { index });
  const blob = await (await fetch(`data:image/png;base64,${screen.png}`)).blob();
  shot = await createImageBitmap(blob);
  // Back to front, so the sprite drawn last is the one that was on top. Each carries its own
  // picture, so a window that was buried still looks like itself once he knocks it loose.
  for (const r of screen.sprites.slice().reverse()) {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.png}`)).blob());
    sprites.push({
      img,
      homeX: r.x,
      homeY: r.y,
      w: r.width,
      h: r.height,
      x: r.x,
      y: r.y,
      vx: 0,
      vy: 0,
      angle: 0,
      spin: 0,
      asleep: true,
    });
  }
  log(`drew ${sprites.length} sprites for ${screen.width}x${screen.height}`);
  loading.hidden = true;
  resize();
  requestAnimationFrame(frame);
  void pollBuddy();
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

/** The buddy's window, asked for now and then; 20 times a second is plenty for a shove. */
async function pollBuddy() {
  while (!ended) {
    try {
      const r = await invoke<{ x: number; y: number; width: number; height: number } | null>("buddy_rect");
      // His window is in virtual-screen pixels; this page draws one monitor.
      buddy = r && screen ? { x: r.x - screen.x, y: r.y - screen.y, w: r.width, h: r.height } : null;
    } catch {
      buddy = null;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * He shoves a sprite by running into its edge. Standing in front of a big window is not a
 * shove, so the push only counts when he is barely overlapping it: otherwise a maximised
 * window, which covers him entirely, would take off the moment the screensaver appeared.
 */
function shove(s: Sprite, dt: number) {
  if (!buddy) return;
  // His middle, where the shoving happens; the rest of his window is mostly empty air.
  const bx = buddy.x + buddy.w * 0.34;
  const bw = buddy.w * 0.32;
  const by = buddy.y + buddy.h * 0.15;
  const bh = buddy.h * 0.85;
  const overlapX = Math.min(bx + bw, s.x + s.w) - Math.max(bx, s.x);
  const overlapY = Math.min(by + bh, s.y + s.h) - Math.max(by, s.y);
  if (overlapX <= 0 || overlapY <= 0) return;
  // Only a shallow overlap is a collision. Deeper than this and he is simply in front of it.
  const reach = Math.min(bw, s.w) * 0.9;
  if (overlapX > reach) return;
  // Push it the way he is going: out of whichever side of it he came in through.
  const dir = bx + bw / 2 < s.x + s.w / 2 ? 1 : -1;
  const force = s.asleep ? 26 : 9;
  s.vx += dir * 60 * force * dt;
  s.vy -= 18 * force * dt;
  s.spin += dir * 0.16 * force * dt;
  s.asleep = false;
}

let last = performance.now();
function frame(now: number) {
  if (ended) return;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (screen && shot) {
    const scale = canvas.width / screen.width;
    // The desktop as it was, dimmed so the loose pieces read as the live part of the picture.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(shot, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(6, 10, 20, 0.72)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const floor = screen.height;
    for (const s of sprites) {
      if (!s.asleep) {
        shove(s, dt);
        s.vy += GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.angle += s.spin * dt;
        if (s.y + s.h >= floor) {
          s.y = floor - s.h;
          s.vy = -s.vy * BOUNCE;
          s.vx *= Math.max(0, 1 - FRICTION * dt);
          s.spin *= 0.7;
          if (Math.abs(s.vy) < SETTLE && Math.abs(s.vx) < SETTLE) {
            s.vy = 0;
            s.vx = 0;
            s.spin = 0;
            // Straighten up as it comes to rest rather than leaving it at a random tilt.
            s.angle *= 0.8;
            if (Math.abs(s.angle) < 0.02) {
              s.angle = 0;
              s.asleep = true;
            }
          }
        }
        // Each screen is its own playpen, so nothing slides off onto a neighbour.
        if (s.x < -s.w * 0.5) {
          s.x = -s.w * 0.5;
          s.vx = Math.abs(s.vx) * 0.4;
        }
        if (s.x > screen.width - s.w * 0.5) {
          s.x = screen.width - s.w * 0.5;
          s.vx = -Math.abs(s.vx) * 0.4;
        }
      } else {
        shove(s, dt);
      }

      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.save();
      ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
      ctx.rotate(s.angle);
      ctx.drawImage(s.img, -s.w / 2, -s.h / 2, s.w, s.h);
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  requestAnimationFrame(frame);
}

/** Any sign of a person ends it, the way a screensaver should. */
function end() {
  if (ended) return;
  ended = true;
  invoke("screensaver_stop").catch(() => {});
}

let startedAt = performance.now();
let firstMove: { x: number; y: number } | null = null;
window.addEventListener("mousemove", (e) => {
  // The pointer is usually sitting still under the screensaver; only real movement counts.
  if (!firstMove) {
    firstMove = { x: e.screenX, y: e.screenY };
    return;
  }
  if (Math.hypot(e.screenX - firstMove.x, e.screenY - firstMove.y) > 12) end();
});
for (const ev of ["mousedown", "keydown", "wheel", "touchstart"] as const) {
  window.addEventListener(ev, () => {
    // A stray event in the first moment is usually the click that started it.
    if (performance.now() - startedAt > 700) end();
  });
}
window.addEventListener("resize", resize);

void start().catch((err) => {
  log(`failed: ${String(err).slice(0, 200)}`);
  loading.hidden = false;
  loading.textContent = `Screensaver: ${String(err).slice(0, 120)}`;
});
