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
  /** Another screensaver is playing underneath; leave the holes see-through. */
  seeThrough: boolean;
}

/** One piece of the desktop he can push about. */
interface Sprite {
  /** Stable for the life of the screensaver; his physics tracks what he stands on by it. */
  id: number;
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
const ctx = canvas.getContext("2d", { alpha: true })!;
const loading = document.getElementById("loading") as HTMLParagraphElement;

let sprites: Sprite[] = [];
/**
 * The desktop as it was, with a hole cut where each window sat. Three layers make the picture:
 * black underneath, this in the middle, and the loose windows on top. Knock one away and you
 * see straight through its hole to the black.
 */
let backdrop: ImageBitmap | null = null;
/** Which monitor this window covers; the backend keeps each screen's pieces apart by it. */
let screenIndex = 0;
let screen: MonitorShot | null = null;
/** Device pixels per CSS pixel for the canvas backing store. */
let dpr = 1;
let ended = false;

/** Where the buddy's window is, in capture coordinates; null when he is not around. */
let buddy: { x: number; y: number; w: number; h: number } | null = null;
/** How fast he is travelling, px/s, from one poll to the next. It is his speed that shoves. */
let buddyVx = 0;
let buddyVy = 0;
/**
 * The piece he has hold of, if any: hanging from its top edge, pulling himself up onto it, or
 * standing on it. Its new position is reported to him every tick while he does, and his own
 * speed never shoves it out from under him.
 */
let held: Sprite | null = null;
/** He is running at a window to shove it. Only then does his speed move anything. */
let barging = false;
/** The punch count this page has already acted on, so one punch lands once here. */
let lastPunchSeq = 0;
let lastBuddy: { x: number; y: number; t: number } | null = null;

const log = (m: string) => void invoke("append_log", { line: `screensaver: ${m}` }).catch(() => {});

async function start() {
  log(`page loaded, label=${getCurrentWindow().label} inner=${window.innerWidth}x${window.innerHeight}`);
  // Each monitor gets its own window and its own picture, taken before any of them went up, so
  // they show the desktop as it really was rather than these backdrops covering it.
  // The window is labelled "screensaver-<n>", one per monitor.
  screenIndex = Number(/(\d+)$/.exec(getCurrentWindow().label)?.[1] ?? 0);
  screen = await invoke<MonitorShot>("capture_desktop", { index: screenIndex });
  // The page's own black would sit in front of anything playing underneath, so it is dropped
  // when there is something to see. The canvas paints the black itself otherwise.
  if (screen.seeThrough) {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }
  const full = await createImageBitmap(await (await fetch(`data:image/png;base64,${screen.png}`)).blob());
  // Punch the windows out of the desktop picture once, here, rather than every frame.
  const holes = document.createElement("canvas");
  holes.width = screen.width;
  holes.height = screen.height;
  const hctx = holes.getContext("2d")!;
  hctx.drawImage(full, 0, 0);
  for (const r of screen.sprites) hctx.clearRect(r.x, r.y, r.width, r.height);
  backdrop = await createImageBitmap(holes);
  full.close();

  // Back to front, so the sprite drawn last is the one that was on top. Each carries its own
  // picture, so a window that was buried still looks like itself once he knocks it loose.
  for (const r of screen.sprites.slice().reverse()) {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.png}`)).blob());
    sprites.push({
      id: sprites.length,
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
  let tick = 0;
  while (!ended) {
    try {
      const r = await invoke<{ x: number; y: number; width: number; height: number; punch: number; punchSeq: number; barging: boolean } | null>("buddy_rect");
      barging = r?.barging ?? false;
      // His window is in virtual-screen pixels; this page draws one monitor.
      buddy = r && screen ? { x: r.x - screen.x, y: r.y - screen.y, w: r.width, h: r.height } : null;
      if (buddy) {
        const now = performance.now();
        if (lastBuddy) {
          const dt = Math.max(0.016, (now - lastBuddy.t) / 1000);
          // Smoothed, so one late poll does not read as a sprint.
          buddyVx = buddyVx * 0.5 + ((buddy.x - lastBuddy.x) / dt) * 0.5;
          buddyVy = buddyVy * 0.5 + ((buddy.y - lastBuddy.y) / dt) * 0.5;
        }
        lastBuddy = { x: buddy.x, y: buddy.y, t: now };
        // He hit something. Every monitor's page sees the same count, so each acts on it once;
        // the pages he is not standing on find nothing in front of his fist and do nothing.
        if (r && r.punchSeq !== lastPunchSeq) {
          lastPunchSeq = r.punchSeq;
          if (r.punch) punched(r.punch);
        }
      } else {
        lastBuddy = null;
        buddyVx = 0;
        buddyVy = 0;
      }
    } catch {
      buddy = null;
    }
    // Tell him where the pieces are, so he climbs and stands on what is actually drawn rather
    // than on the real windows hidden behind the backdrop. While he has hold of one it is
    // moving under him, so he needs telling every tick rather than every third.
    if (screen && (held || ++tick % 3 === 0)) sendSurfaces();
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** The resting pieces, as things he can stand on, in virtual-screen pixels. */
function sendSurfaces() {
  if (!screen) return;
  // Front to back: the occlusion test treats the first entry as the one on top, and `sprites`
  // is stored back to front for drawing. Sent the wrong way round, the rearmost window shadows
  // every other one and he finds nothing he can climb.
  const list = sprites
    .filter((s) => s.asleep)
    .reverse()
    .map((s) => ({
      // Its own id, not its place in this list: pieces drop out of the list the moment they are
      // knocked loose, and every screen used to number from the same base, so two pieces on two
      // monitors shared an identity and whatever he was standing on changed name under him.
      hwnd: 900000 + screenIndex * 1000 + s.id,
      left: Math.round(screen!.x + s.x),
      top: Math.round(screen!.y + s.y),
      right: Math.round(screen!.x + s.x + s.w),
      bottom: Math.round(screen!.y + s.y + s.h),
    }));
  void invoke("screensaver_surfaces", { index: screenIndex, surfaces: list }).catch(() => {});
}

/** Below this he is loitering, not charging, and nothing should budge. */
const SHOVE_SPEED = 140; // px/s
/**
 * How fast a window sinks under his weight while he hangs off it, px/s. He is told where the
 * pieces are twenty times a second, so a faster sink than this would slide out of the reach of
 * the grip test below before he had heard about it.
 */
const DRAG_SPEED = 620;
/** How near his hands or feet have to be to a top edge to take hold of it, px. */
const GRIP = 70;
/**
 * A window's top edge has to be at least this far down the screen, as a fraction of his height,
 * before standing on it keeps his head on screen. Every window on a normal desktop sits higher
 * than that, which is why he used to reach the top of one and immediately bump his head: he is
 * 660px tall and a title bar 200px down the screen leaves him nowhere to be. So his weight
 * drags the window down until there is room, and then he climbs on. At 0.82 the fit works out
 * for any character, however little of his window sits above his head, within the duck his
 * physics allows him.
 */
const STAND_RATIO = 0.82;

/**
 * The piece he has hold of now, if any. He takes hold when his hands or his feet are at a
 * resting piece's top edge (a grab, a landing), and keeps hold for as long as that edge stays
 * anywhere between his hands and his feet: a pull-up moves the edge from one to the other, and
 * letting go halfway through it would leave the window stuck above where he can stand.
 */
function gripped(): Sprite | null {
  if (!buddy) return null;
  const cx = buddy.x + buddy.w / 2;
  const handY = buddy.y + buddy.h * 0.07;
  const feetY = buddy.y + buddy.h;
  const under = (s: Sprite) => s.asleep && cx >= s.x - 20 && cx <= s.x + s.w + 20;
  if (held && under(held) && held.y >= handY - GRIP && held.y <= feetY + GRIP) return held;
  // Front-most first: `sprites` is stored back to front for drawing, and he gets hold of the
  // one on top, the same one his own physics picked out of the surface list.
  for (let i = sprites.length - 1; i >= 0; i--) {
    const s = sprites[i];
    if (!under(s)) continue;
    if (Math.abs(handY - s.y) < GRIP || Math.abs(feetY - s.y) < GRIP) return s;
  }
  return null;
}

/** His weight pulls the window he is hanging from down, until he has room to stand on it. */
function dragUnder(s: Sprite, dt: number) {
  if (!buddy || !screen) return;
  const want = buddy.h * STAND_RATIO;
  if (s.y >= want) return;
  // Something has to stay on screen, or a very tall window would slide away entirely.
  const lowest = screen.height - s.h * 0.35;
  const to = Math.min(want, lowest);
  if (s.y >= to) return;
  s.y = Math.min(to, s.y + DRAG_SPEED * dt);
  s.angle = 0;
}

/**
 * It is his speed that shoves things, not merely touching them, and only when he means it: a
 * barge, which he announces. Standing inside a maximised window does nothing, which is why
 * everything used to take off the instant the screensaver appeared. Walking through one or
 * jumping at one does nothing either, and that matters more than it sounds: before the barge
 * was announced, every stroll and every leap at a window knocked it loose, and a loose window
 * is not something he can stand on, so he never got on top of anything.
 */
function shove(s: Sprite, dt: number) {
  if (!buddy || !barging) return;
  // His middle, where the shoving happens; the rest of his window is mostly empty air.
  const bx = buddy.x + buddy.w * 0.34;
  const bw = buddy.w * 0.32;
  const by = buddy.y + buddy.h * 0.15;
  const bh = buddy.h * 0.85;
  if (bx + bw < s.x || bx > s.x + s.w || by + bh < s.y || by > s.y + s.h) return;

  const speed = Math.hypot(buddyVx, buddyVy);
  if (speed < SHOVE_SPEED) return;
  // He pushes it the way he is going, hard enough that a real run sends it properly.
  const dir = Math.abs(buddyVx) > 40 ? Math.sign(buddyVx) : bx + bw / 2 < s.x + s.w / 2 ? 1 : -1;
  const push = Math.min(3, speed / 320);
  s.vx += dir * 900 * push * dt * 6;
  // Dropping onto something drives it down; running into it lifts it a little.
  s.vy += (buddyVy > 200 ? 260 : -180) * push * dt * 6;
  s.spin += dir * 2.4 * push * dt * 6;
  s.asleep = false;
}

/**
 * He has thrown a punch, facing `dir`. Whatever is in front of his fist goes flying: far harder
 * than a shoulder-barge, because a punch is meant to be the big one.
 */
function punched(dir: number) {
  if (!buddy) return;
  const fistX = buddy.x + buddy.w / 2 + dir * buddy.w * 0.3;
  const fistY = buddy.y + buddy.h * 0.45;
  let hit: Sprite | null = null;
  let nearest = Infinity;
  // Front-most first, so the one he can actually see takes the hit.
  for (let i = sprites.length - 1; i >= 0; i--) {
    const s = sprites[i];
    if (fistY < s.y || fistY > s.y + s.h) continue;
    // It has to be in front of his fist. Without this, one behind him reads as touching it and
    // flies off in the direction he is facing, which is not where he is looking.
    const ahead = dir > 0 ? s.x + s.w > fistX : s.x < fistX;
    if (!ahead) continue;
    // A little reach past the fist, so he does not have to be touching it exactly.
    const gap = Math.max(0, dir > 0 ? s.x - fistX : fistX - (s.x + s.w));
    if (gap > 90) continue;
    if (gap < nearest) {
      nearest = gap;
      hit = s;
    }
  }
  if (!hit) return;
  hit.vx += dir * 1500;
  hit.vy -= 520;
  hit.spin += dir * 3.2;
  hit.asleep = false;
}

let last = performance.now();
function frame(now: number) {
  if (ended) return;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  held = gripped();

  if (screen) {
    const scale = canvas.width / screen.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // With something playing underneath the holes stay see-through; otherwise they are black,
    // so an emptied hole reads as empty rather than as wallpaper.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!screen.seeThrough) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // The desktop, minus the windows: wallpaper and icons stay, their windows are holes.
    if (backdrop) ctx.drawImage(backdrop, 0, 0, canvas.width, canvas.height);

    const floor = screen.height;
    for (const s of sprites) {
      if (s === held) {
        // He is holding this one. Shoving it would fling it out from under him at the very
        // moment he grabbed it, which is what used to happen on every charge.
        dragUnder(s, dt);
      } else if (!s.asleep) {
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
        // Each screen is its own playpen, so nothing slides off onto a neighbour. Most of a
        // piece stays on screen: shoved half off, what is left is too narrow to be worth
        // climbing, and he would rather have something to get on top of.
        const OFF = 0.22;
        if (s.x < -s.w * OFF) {
          s.x = -s.w * OFF;
          s.vx = Math.abs(s.vx) * 0.4;
        }
        if (s.x > screen.width - s.w * (1 - OFF)) {
          s.x = screen.width - s.w * (1 - OFF);
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
  // Keep asking until this page goes away with the window. These cover every screen and hide
  // the cursor, so an unheard request to stop looks exactly like a hung machine, and no one
  // else is coming along to take them down.
  let tries = 0;
  const ask = () => {
    invoke("screensaver_stop").catch(() => {});
    if (++tries < 6) setTimeout(ask, 1200);
  };
  ask();
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
