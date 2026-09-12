import { cyclePhase, drawCrtSlice, erosionSeconds, type CrtCycle, type DesktopRect } from "./screensaver-cycle";
import { loadCrackTextures, loadEdgeDecals, type CrackTexture, type EdgeDecal } from "./screensaver-cracks";
/**
 * Screensaver backdrop. It takes one picture of the desktop, dims it, and cuts a sprite out of
 * that picture for every window that was on screen. He then shoves those sprites around while
 * the real desktop sits untouched underneath: nothing here moves, closes or resizes a real
 * window. Any input at all ends it.
 *
 * The buddy stays in his own window on top of this one, so his physics, poses and clips are
 * exactly what they are on the taskbar; this page only needs to know where he is.
 */
import { getSettings } from "./settings-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  virtualDesktop: DesktopRect;
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
  /** How much of it has broken away, 0..1: set as the erosion grid eats its cells, so his
   * physics stops treating a window that is mostly gone as something to stand on. */
  reveal: number;
  /**
   * The cracks in this window's own glass, held in its own coordinates so they travel with it.
   * Kept on the screen grid instead, they stayed put while the window slid out from under them
   * and the damage appeared to swim across its face.
   */
  cracks: Array<{ tex: number; lx: number; ly: number; rot: number; sc: number }>;
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
 * The desktop as it was, with a hole cut where each window sat, kept whole so eroded cells can
 * be painted back when the picture grows again. Three layers make the scene: black (or the
 * screensaver playing behind) underneath, the desktop in the middle, and the loose windows on
 * top. Break a cell of the desktop and you see straight through to whatever is underneath.
 */
let desktopSrc: HTMLCanvasElement | null = null;
/** The working desktop actually drawn: cells cleared from it reveal the layer behind. */
let eroded: HTMLCanvasElement | null = null;
let erodedCtx: CanvasRenderingContext2D | null = null;
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
  // The layer behind the desktop shows through wherever a cell is broken away: black when there
  // is nothing underneath, or see-through to the screensaver playing under us. Making it the
  // page's own background means a hole is just a cleared pixel, the same for the desktop and for
  // the windows, in either mode.
  const behind = screen.seeThrough ? "transparent" : "#000";
  document.documentElement.style.background = behind;
  document.body.style.background = behind;
  const full = await createImageBitmap(await (await fetch(`data:image/png;base64,${screen.png}`)).blob());
  // Punch the windows out of the desktop picture once, here, rather than every frame. This is
  // kept whole, and a working copy is what actually gets drawn and eroded.
  desktopSrc = document.createElement("canvas");
  desktopSrc.width = screen.width;
  desktopSrc.height = screen.height;
  const hctx = desktopSrc.getContext("2d")!;
  hctx.drawImage(full, 0, 0);
  for (const r of screen.sprites) hctx.clearRect(r.x, r.y, r.width, r.height);
  full.close();
  eroded = document.createElement("canvas");
  eroded.width = screen.width;
  eroded.height = screen.height;
  erodedCtx = eroded.getContext("2d")!;
  erodedCtx.drawImage(desktopSrc, 0, 0);
  const settings = await getSettings();
  erosionStyle = settings.screensaverErosionStyle;
  ambientSeconds = erosionSeconds(settings.screensaverErosionSpeed);
  // Every screen has to collapse on the same tick, which is what this event carries. It is not
  // worth the whole screensaver if it cannot be heard: without it each screen just runs its own
  // cycle. This threw once because the backdrop windows had no event permission, and the throw
  // took the rest of start() with it, leaving nothing on screen but the error.
  try {
    await listen<CrtCycle>("screensaver-crt", (event) => beginCycle(event.payload));
  } catch (err) {
    log(`no crt sync: ${String(err).slice(0, 120)}`);
  }
  if (erosionStyle === "cracks") {
    crackTextures = await loadCrackTextures();
    edgeDecals = await loadEdgeDecals();
    log(`loaded ${crackTextures.length} impacts, ${edgeDecals.length} edge pieces`);
  }
  initErosion(screen.width, screen.height);

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
      reveal: 0,
      cracks: [],
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
  const list = (phase === "erode" ? sprites : [])
    .filter((s) => s.asleep && s.reveal < 0.6)
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
  const push = Math.min(3.2, speed / 300);
  s.vx += dir * 1100 * push * dt * 6;
  // Dropping onto something drives it down; running into it lifts it a little.
  s.vy += (buddyVy > 200 ? 300 : -220) * push * dt * 6;
  s.spin += dir * 2.8 * push * dt * 6;
  s.asleep = false;
}

/**
 * He has thrown a punch, facing `dir`. His fist tears a chunk out of the desktop wherever it
 * lands, and whatever window is in front of it goes flying: far harder than a shoulder-barge,
 * because a punch is meant to be the big one.
 */
function punched(dir: number) {
  if (!buddy) return;
  const fistX = buddy.x + buddy.w / 2 + dir * buddy.w * 0.3;
  const fistY = buddy.y + buddy.h * 0.45;
  // A fist through the glass shatters a good patch of it, so he is plainly the one wrecking it.
  breakAt(fistX, fistY, 360);
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
  hit.vx += dir * 1800;
  hit.vy -= 620;
  hit.spin += dir * 3.6;
  hit.asleep = false;
}

// ---- Breaking the desktop, so no patch of it stands still long enough to burn in ----
// The desktop picture is a grid of cells. Over ERODE_SECONDS every cell breaks away in turn to
// reveal the moving layer behind (the screensaver playing under us, or plain black); once the
// whole screen is gone it grows back the same way and the cycle repeats, so there is always
// motion everywhere and no pixel is left lit and still. His fists and his charges break the
// cells they strike at once, so the destruction reads as his doing rather than a timer's.
const CELL = 240; // px of the capture per grid cell: each one shatters as a single glass crack
// Left to itself the desktop erodes very slowly, over minutes; the buddy is what really tears it
// apart, so most of the damage follows his fists rather than a timer.
let ambientSeconds = erosionSeconds(20);
const BREAK_RATE = 2.4; // how fast one cell shatters once it starts, per second
let cols = 0;
let rows = 0;
/** Per cell: 0 intact, 1 fully broken (revealing behind); between is a growing fracture. */
let reveal: Float32Array = new Float32Array(0);
let erosionStyle: "tiles" | "cracks" = "tiles";
interface Tile { img: HTMLCanvasElement; x: number; y: number; vx: number; vy: number; angle: number; spin: number }
let tiles: Tile[] = [];
let crackSeed: number[] = [];
/** Per cell: the window that owns this crack, or -1 when it is the desktop's own. */
let crackOwner: Int16Array = new Int16Array(0);
let crackTextures: CrackTexture[] = [];
/** The edge/corner pieces laid into the square corners of a window cutout. */
let edgeDecals: EdgeDecal[] = [];
/** Cells whose reveal is changing right now, so only these are repainted each frame. */
const active = new Set<number>();
/** The order cells break in: a shuffle, so it does not sweep away in obvious rows. */
let order: number[] = [];
let orderPtr = 0;
let carry = 0;
/** "erode": desktop and windows breaking away. "crtOff": the tube-TV collapse before it all
 * snaps back whole and erodes again. */
let phase: "erode" | "crtOff" | "void" = "erode";
let crtCycle: CrtCycle | null = null;
let crtRequested = false;

function shuffledCells(): number[] {
  const a = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initErosion(w: number, h: number) {
  cols = Math.ceil(w / CELL);
  rows = Math.ceil(h / CELL);
  reveal = new Float32Array(cols * rows);
  crackSeed = Array.from({ length: cols * rows }, () => Math.random() * 1000);
  crackOwner = new Int16Array(cols * rows).fill(-1);
  tiles = [];
  active.clear();
  order = shuffledCells();
  orderPtr = 0;
  carry = 0;
  phase = "erode";
  crtCycle = null;
  crtRequested = false;
}

/** Everything back to the snapshot, whole: the desktop repainted, every window returned to
 * where it was cut from, resting and solid. Called the instant the tube-off collapse finishes. */
function restoreDesktop() {
  if (erodedCtx && eroded && desktopSrc) {
    erodedCtx.clearRect(0, 0, eroded.width, eroded.height);
    erodedCtx.drawImage(desktopSrc, 0, 0);
  }
  reveal.fill(0);
  crackSeed = Array.from({ length: cols * rows }, () => Math.random() * 1000);
  crackOwner = new Int16Array(cols * rows).fill(-1);
  crtCycle = null;
  crtRequested = false;
  held = null;
  tiles = [];
  active.clear();
  order = shuffledCells();
  orderPtr = 0;
  carry = 0;
  for (const s of sprites) {
    s.reveal = 0;
    s.cracks.length = 0;
    s.x = s.homeX;
    s.y = s.homeY;
    s.vx = 0;
    s.vy = 0;
    s.angle = 0;
    s.spin = 0;
    s.asleep = true;
  }
}

/** Apply the supplied artwork at a fixed size: a hole plus its original glass detail. */
function drawCrack(target: CanvasRenderingContext2D, i: number, glass: boolean) {
  if (!crackTextures.length || reveal[i] <= 0) return;
  if (crackOwner[i] >= 0) return; // a window is carrying this one.
  const seed = crackSeed[i];
  const texture = crackTextures[Math.floor(seed) % crackTextures.length];
  const x = (i % cols) * CELL + CELL * (0.5 + Math.sin(seed) * 0.22);
  const y = Math.floor(i / cols) * CELL + CELL * (0.5 + Math.cos(seed * 7) * 0.22);
  target.save();
  target.translate(x, y); target.rotate(seed);
  const scale = 1.15 + (seed % 1) * 0.4;
  target.scale(scale, scale);
  // "source-atop" keeps the glass only where there is still something to be broken. Drawn plainly
  // over the top it also landed on the empty rectangles left by windows he has knocked away, and
  // inside the holes other cracks had already punched, so shards hung in mid-air over nothing.
  target.globalCompositeOperation = glass ? "source-atop" : "destination-out";
  // Only the appearance advances; the source silhouette never balloons into a grid cell.
  target.globalAlpha = Math.min(1, reveal[i] * 4);
  target.drawImage(glass ? texture.glass : texture.hole, -texture.cx, -texture.cy);
  target.restore();
}

function cutCell(target: CanvasRenderingContext2D, i: number) {
  if (reveal[i] <= 0) return;
  if (erosionStyle === "cracks") { drawCrack(target, i, false); return; }
  target.save();
  target.globalCompositeOperation = "destination-out";
  target.fillStyle = "#000";
  target.fillRect((i % cols) * CELL, Math.floor(i / cols) * CELL, CELL, CELL);
  target.restore();
}
// Glass is composited once over the complete desktop/window scene to avoid accumulating alpha.
function paintCell(i: number) { if (erodedCtx && erosionStyle === "tiles") cutCell(erodedCtx, i); }

function nudgeCell(i: number) {
  if (reveal[i] > 0 || active.has(i)) return;
  if (erosionStyle === "tiles" && desktopSrc && screen) {
    const x = (i % cols) * CELL, y = Math.floor(i / cols) * CELL;
    const img = document.createElement("canvas");
    img.width = Math.min(CELL, screen.width - x); img.height = Math.min(CELL, screen.height - y);
    const tc = img.getContext("2d")!; tc.translate(-x, -y); tc.drawImage(desktopSrc, 0, 0);
    for (const sp of sprites) {
      tc.save(); tc.translate(sp.x + sp.w / 2, sp.y + sp.h / 2); tc.rotate(sp.angle);
      tc.drawImage(sp.img, -sp.w / 2, -sp.h / 2, sp.w, sp.h); tc.restore();
    }
    tiles.push({ img, x: x + img.width / 2, y: y + img.height / 2, vx: (Math.random() - 0.5) * 150, vy: -60, angle: 0, spin: (Math.random() - 0.5) * 1.8 });
  }
  if (erosionStyle === "cracks" && crackTextures.length && crackOwner.length) {
    // Where this crack will land, matching drawCrack exactly.
    const seed = crackSeed[i];
    const px = (i % cols) * CELL + CELL * (0.5 + Math.sin(seed) * 0.22);
    const py = Math.floor(i / cols) * CELL + CELL * (0.5 + Math.cos(seed * 7) * 0.22);
    // Front-most window first: a crack struck into a window belongs to that window and rides
    // along with it, rather than staying pinned to the screen while the window slides away.
    for (let k = sprites.length - 1; k >= 0; k--) {
      const sp = sprites[k];
      if (px < sp.x || px > sp.x + sp.w || py < sp.y || py > sp.y + sp.h) continue;
      sp.cracks.push({
        tex: Math.floor(seed) % crackTextures.length,
        lx: px - sp.x,
        ly: py - sp.y,
        rot: seed,
        sc: 1.15 + (seed % 1) * 0.4,
      });
      crackOwner[i] = sp.id;
      break;
    }
  }
  active.add(i);
}

/** Break every cell within `radius` px of a point at once: his fist or shoulder hit there. */
function breakAt(px: number, py: number, radius: number) {
  if (!cols || phase !== "erode") return;
  const c0 = Math.max(0, Math.floor((px - radius) / CELL));
  const c1 = Math.min(cols - 1, Math.floor((px + radius) / CELL));
  const r0 = Math.max(0, Math.floor((py - radius) / CELL));
  const r1 = Math.min(rows - 1, Math.floor((py + radius) / CELL));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) nudgeCell(r * cols + c);
  }
}

/**
 * How much of a resting window has broken away, in the very same grid pieces as the desktop around
 * it, so his physics stops treating a window that is mostly gone as something to stand on.
 */
function punchSprite(s: Sprite) {
  if (!cols || s.reveal >= 1) return;
  const c0 = Math.max(0, Math.floor(s.x / CELL));
  const c1 = Math.min(cols - 1, Math.floor((s.x + s.w - 1) / CELL));
  const r0 = Math.max(0, Math.floor(s.y / CELL));
  const r1 = Math.min(rows - 1, Math.floor((s.y + s.h - 1) / CELL));
  let total = 0;
  let gone = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      total++;
      gone += erosionStyle === "tiles" ? Number(reveal[r * cols + c] > 0) : reveal[r * cols + c];
    }
  }
  s.reveal = total ? gone / total : 0;
}

/** How far a window must have shifted from where it was cut out before the rectangle it left
 * behind counts as exposed. */
const MOVED_AWAY = 12;

/**
 * Lay an edge piece into one square corner of a rectangle. The artwork is drawn with its solid
 * glass in its own top-left and the shards running away from it, so anchoring it at the corner and
 * turning it a quarter turn per corner points the break inwards every time.
 */
function drawCorner(target: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number, corner: number, decal: EdgeDecal, size: number) {
  const scale = size / decal.w;
  target.save();
  target.translate(corner === 1 || corner === 2 ? rx + rw : rx, corner >= 2 ? ry + rh : ry);
  target.rotate((corner * Math.PI) / 2);
  target.scale(scale, scale);
  target.drawImage(decal.img, 0, 0);
  target.restore();
}

/**
 * A window he has knocked out of place leaves a clean rectangle with square corners, both as a hole
 * in the desktop and as the window itself now sitting elsewhere. Break a couple of those corners
 * with the edge pieces rather than filling the area with round impacts, which is what the straight
 * sides actually want. Seeded per window so the same corners stay broken instead of flickering.
 */
function drawCutoutEdges(target: CanvasRenderingContext2D, s: Sprite, rx: number, ry: number) {
  if (!edgeDecals.length) return;
  // Two corners of the four, never all of them: sparing is the point.
  const first = s.id % 4;
  for (let k = 0; k < 2; k++) {
    const corner = (first + (k === 0 ? 0 : 1 + (s.id % 2))) % 4;
    const decal = edgeDecals[(s.id + k) % edgeDecals.length];
    const size = Math.max(70, Math.min(s.w, s.h) * 0.42);
    drawCorner(target, rx, ry, s.w, s.h, corner, decal, size);
  }
}

function updateErosion(dt: number) {
  if (!cols) return;
  if (phase !== "erode") return; // during the collapse the grid is left frozen.
  // Feed new cells into the erosion from the shuffled order, at a steady rate.
  carry += ((cols * rows) / ambientSeconds) * dt;
  while (carry >= 1 && orderPtr < order.length) {
    nudgeCell(order[orderPtr++]);
    carry -= 1;
  }
  // Advance every breaking cell and repaint it; drop it once it is fully gone.
  for (const i of active) {
    reveal[i] = Math.min(1, reveal[i] + BREAK_RATE * dt);
    paintCell(i);
    if (reveal[i] >= 1) active.delete(i);
  }
  // Whole desktop gone and settled: pull the plug. Tell every screen to collapse at the same
  // moment (this one included, via the event), so the whole desk powers off as one.
  if (!crtRequested && reveal.every(value => value >= 1) && active.size === 0 && tiles.length === 0) {
    crtRequested = true;
    void invoke<CrtCycle>("screensaver_crt").then(beginCycle).catch(() => { crtRequested = false; });
  }
}

function beginCycle(cycle: CrtCycle) {
  if (!crtCycle || cycle.startedAt > crtCycle.startedAt) crtCycle = cycle;
}

let last = performance.now();
function frame(now: number) {
  if (ended) return;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  held = gripped();

  if (crtCycle && screen) {
    const next = cyclePhase(crtCycle, Date.now());
    if (next === "erode") {
      restoreDesktop();
      phase = "erode";
      sendSurfaces();
    } else if (next !== "waiting") {
      if (phase === "erode") {
        phase = "crtOff";
        held = null;
        sendSurfaces();
      }
      phase = next;
      drawCrtSlice(ctx, screen, screen.virtualDesktop, (Date.now() - crtCycle.startedAt) / 1000);
      requestAnimationFrame(frame);
      return;
    }
  }

  if (screen) {
    const scale = canvas.width / screen.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A cleared pixel shows the page background behind: black, or see-through to the screensaver
    // playing underneath. Broken cells of the desktop and of the windows both read as that.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The desktop, minus the windows and minus whatever has broken away: wallpaper and icons
    // stay until a cell of them is torn out to show the moving layer behind. His charges tear a
    // path through it as he barges along; the timed erosion takes care of the rest.
    if (barging && buddy) breakAt(buddy.x + buddy.w / 2, buddy.y + buddy.h * 0.55, 200);
    updateErosion(dt);
    if (eroded) ctx.drawImage(eroded, 0, 0, canvas.width, canvas.height);

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
      // Once it has been knocked out of place its own square corners are broken too, drawn in its
      // own frame so they turn and travel with it.
      if (erosionStyle === "cracks" && (Math.abs(s.x - s.homeX) >= MOVED_AWAY || Math.abs(s.y - s.homeY) >= MOVED_AWAY)) {
        drawCutoutEdges(ctx, s, -s.w / 2, -s.h / 2);
      }
      // Its own damage, drawn in its own frame so it turns and travels with the window.
      if (erosionStyle === "cracks" && s.cracks.length) {
        for (const cr of s.cracks) {
          const tex = crackTextures[cr.tex];
          if (!tex) continue;
          for (const glass of [false, true]) {
            ctx.save();
            ctx.translate(-s.w / 2 + cr.lx, -s.h / 2 + cr.ly);
            ctx.rotate(cr.rot);
            ctx.scale(cr.sc, cr.sc);
            ctx.globalCompositeOperation = glass ? "source-atop" : "destination-out";
            ctx.drawImage(glass ? tex.glass : tex.hole, -tex.cx, -tex.cy);
            ctx.restore();
          }
        }
      }
      ctx.restore();
      // A resting window breaks up in the same pieces as the desktop; one in flight stays whole.
      if (s.asleep && s.angle === 0) punchSprite(s);
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // Every hole is punched first and only then is any glass laid down, because the glass is
    // clipped to what is still solid: lay one crack's glass before the next one's hole and it
    // would be drawn over ground that is about to be knocked out from under it.
    for (let i = 0; i < reveal.length; i++) cutCell(ctx, i);
    if (erosionStyle === "cracks") {
      for (let i = 0; i < reveal.length; i++) drawCrack(ctx, i, true);
      // The square hole each displaced window left behind in the desktop.
      for (const sp of sprites) {
        if (Math.abs(sp.x - sp.homeX) < MOVED_AWAY && Math.abs(sp.y - sp.homeY) < MOVED_AWAY) continue;
        drawCutoutEdges(ctx, sp, sp.homeX, sp.homeY);
      }
    }
    for (const tile of tiles) {
      tile.vy += GRAVITY * dt; tile.x += tile.vx * dt; tile.y += tile.vy * dt; tile.angle += tile.spin * dt;
      ctx.save(); ctx.translate(tile.x, tile.y); ctx.rotate(tile.angle);
      ctx.drawImage(tile.img, -tile.img.width / 2, -tile.img.height / 2); ctx.restore();
    }
    tiles = tiles.filter(tile => tile.y - CELL <= screen!.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
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
