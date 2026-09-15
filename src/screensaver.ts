import { Debris } from "./screensaver-debris";
import { windowOutline, outlinePath, windowGlass, maskedWindow, fractureImage, surface } from "./screensaver-fracture";
import type { StrikeKind } from "./havoc";
import { cyclePhase, shatterProgress, crtStartsAt, SHATTER_SECONDS, drawCrtSlice, erosionSeconds, type CrtCycle, type DesktopRect } from "./screensaver-cycle";
import { loadCrackTextures, type CrackTexture } from "./screensaver-cracks";
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
import { listen, emitTo } from "@tauri-apps/api/event";
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
  /** The broken silhouette it will be cut to, in 0..1 of its own rectangle, so it scales exactly. */
  outline: Float32Array | null;
  /** Whether that silhouette has been applied yet. A window starts whole and is cut on the
   * first hit: the desk should look like your desk when the screensaver opens and come apart
   * as he works, rather than sitting there already smashed before he has touched anything. */
  carved: boolean;
  cut: HTMLCanvasElement;
  damage: number;
  broken: boolean;
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

}

const GRAVITY = 1900; // px/s^2
const BOUNCE = 0.31;
const FRICTION = 2.4;
const SETTLE = 28; // px/s

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: true })!;
const loading = document.getElementById("loading") as HTMLParagraphElement;

let sprites: Sprite[] = [];
const debris = new Debris();
const shatterQueue = new Set<Sprite>();
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
    await listen<{kind: StrikeKind; dir: number}>("buddy-strike", e => punched(e.payload.dir, e.payload.kind));
    await listen<CrtCycle>("screensaver-crt", (event) => beginCycle(event.payload));
  } catch (err) {
    log(`no crt sync: ${String(err).slice(0, 120)}`);
  }
  if (erosionStyle === "cracks") {
    crackTextures = await loadCrackTextures();
    log(`loaded ${crackTextures.length} impacts`);
  }
  initErosion(screen.width, screen.height);

  // Back to front, so the sprite drawn last is the one that was on top. Each carries its own
  // picture, so a window that was buried still looks like itself once he knocks it loose.
  for (const r of screen.sprites.slice().reverse()) {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.png}`)).blob());
    const outline = crackTextures.length ? windowOutline(crackTextures[sprites.length % crackTextures.length]) : null;
    sprites.push({
      outline, carved: false, cut: maskedWindow(img, null), damage: 0, broken: false,
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
    });
  }
  // Every window is taken out of the picture, square, because the piece covering it is square
  // too. It has to come out now rather than when the piece is first hit: leaving it in meant a
  // crack punched through a window revealed the desktop's own copy of that same window sitting
  // behind it, so the cracks looked painted on instead of broken through. What the piece leaves
  // behind when it is later cut to a smaller shape is put back by the carve.
  hctx.save();
  hctx.globalCompositeOperation = "destination-out";
  for (const s of sprites) hctx.fillRect(s.homeX, s.homeY, s.w, s.h);
  hctx.restore();
  erodedCtx.clearRect(0, 0, screen.width, screen.height);
  erodedCtx.drawImage(desktopSrc, 0, 0);
  log(`drew ${sprites.length} sprites for ${screen.width}x${screen.height}`);
  loading.hidden = true;
  resize();
  requestAnimationFrame(frame);
  await invoke("screensaver_page_ready", { index: screenIndex });
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
    .filter((s) => !s.broken && s.asleep && s.reveal < 0.6)
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
  const targets = phase === "erode" ? [
    // Mostly eroded is as good as gone: the same cut-off the standable list uses, so he is not
    // sent to swing at a window that has already broken away to an empty hole.
    ...sprites.filter(s => !s.broken && s.reveal < 0.6).map(s => ({id: s.id, x: screen!.x+s.x, y: screen!.y+s.y, w:s.w, h:s.h, debris:false})),
    ...debris.bodies.filter(b => b.fade>.3).map(b => ({id:10000+b.id, x:screen!.x+b.x-b.w/2, y:screen!.y+b.y-b.h/2, w:b.w,h:b.h,debris:true})),
  ] : [];
  void emitTo("buddy", "screensaver-targets", {index:screenIndex, targets}).catch(() => {});
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
  const under = (s: Sprite) => !s.broken && s.asleep && cx >= s.x - 20 && cx <= s.x + s.w + 20;
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
  carve(s);
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
  breakAt(buddy.x + buddy.w / 2, buddy.y + buddy.h * .55);
  // He pushes it the way he is going, hard enough that a real run sends it properly.
  const dir = Math.abs(buddyVx) > 40 ? Math.sign(buddyVx) : bx + bw / 2 < s.x + s.w / 2 ? 1 : -1;
  const push = Math.min(3.2, speed / 300);
  s.vx += dir * 1100 * push * dt * 6;
  // Dropping onto something drives it down; running into it lifts it a little.
  s.vy += (buddyVy > 200 ? 300 : -220) * push * dt * 6;
  s.spin += dir * 2.8 * push * dt * 6;
  carve(s);
  s.asleep = false;
  s.damage += dt * speed / 550;
  if (s.damage >= 1 || buddyVy > 800) shatterQueue.add(s);
}

/**
 * He has thrown a punch, facing `dir`. His fist tears a chunk out of the desktop wherever it
 * lands, and whatever window is in front of it goes flying: far harder than a shoulder-barge,
 * because a punch is meant to be the big one.
 */
function punched(dir: number, kind: StrikeKind = "punch") {
  if (!buddy || phase !== "erode") return;
  const fistX = buddy.x + buddy.w / 2 + dir * buddy.w * 0.3;
  const fistY = buddy.y + buddy.h * (kind === "punch" ? 0.45 : 0.85);
  if (debris.strike(fistX, fistY, dir, kind, buddy.h * .3)) return;
  // One mark where the fist lands.
  breakAt(fistX, fistY);
  let hit: Sprite | null = null;
  let nearest = Infinity;
  // Front-most first, so the one he can actually see takes the hit.
  for (let i = sprites.length - 1; i >= 0; i--) {
    const s = sprites[i];
    if (s.broken) continue;
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
  carve(hit);
  hit.vx += dir * 1800;
  hit.vy -= 620;
  hit.spin += dir * 3.6;
  hit.asleep = false;
  hit.damage += kind === "kick" ? 1 : .4;
  if (hit.damage >= 1) shatterQueue.add(hit);
  else shed(hit, false);
}

/**
 * Cut a window down to its broken silhouette, once, the first time something happens to it.
 * Called before any damage is baked into the raster, because it replaces that raster.
 */
function carve(s: Sprite) {
  if (s.carved) return;
  s.carved = true;
  if (!s.outline) return;
  // What the piece does not take with it stays stuck to the screen, so the gap it leaves is its
  // own broken shape rather than the square the window filled. Taken before the clip below:
  // built afterwards it is the clipped window minus the very shape it was clipped to, which is
  // nothing at all, and the corners of every square hole stayed black.
  //
  // Only while there is still a desk to stick to. At the end of the cycle the picture has
  // already been broken into its own pieces before the windows are shed, and each window shed
  // after that painted its leftover frame back onto the empty canvas, where it stayed: those
  // were the remnants of window cutouts sitting there after everything else had gone. From here
  // the whole window goes into the debris instead, which is what the rest of the desk is doing.
  if (erodedCtx && phase === "erode") {
    const remnant = surface(s.w, s.h);
    const rc = remnant.getContext("2d")!;
    rc.drawImage(s.cut, 0, 0, s.w, s.h);
    rc.globalCompositeOperation = "destination-out";
    rc.fill(outlinePath(s.outline, s.w, s.h));
    erodedCtx.drawImage(remnant, s.homeX, s.homeY);
    remnant.width = remnant.height = 1;
  }
  // Now the piece itself, clipped where it stands so cracks it has already taken survive being
  // reshaped; rebuilding it from the original picture wiped them.
  const cc = s.cut.getContext("2d")!;
  cc.save();
  cc.globalCompositeOperation = "destination-in";
  cc.fill(outlinePath(s.outline, s.cut.width, s.cut.height));
  cc.restore();
}

/**
 * Break what is left of the desktop picture into pieces that fall and fade with everything
 * else. Without this only the windows came apart at the end and the picture behind them simply
 * stopped being drawn, which is not the desk being destroyed, it is the desk being switched off.
 *
 * Coarse pieces, and not at full resolution: they are tumbling and fading within a few seconds,
 * and a screen's worth of full-size canvases would swamp the debris budget on its own.
 */
function shatterDesktop() {
  if (!eroded || !erodedCtx || !screen) return;
  const across = 3;
  const down = 2;
  const cw = Math.ceil(screen.width / across);
  const ch = Math.ceil(screen.height / down);
  for (let row = 0; row < down; row++) {
    for (let col = 0; col < across; col++) {
      const sx = col * cw;
      const sy = row * ch;
      const w = Math.min(cw, screen.width - sx);
      const h = Math.min(ch, screen.height - sy);
      if (w < 2 || h < 2) continue;
      const scale = Math.min(1, 512 / Math.max(w, h));
      const chunk = surface(w * scale, h * scale);
      chunk.getContext("2d")!.drawImage(eroded, sx, sy, w, h, 0, 0, chunk.width, chunk.height);
      // Broken along the cracks in the artwork, the same way a window is, so the desk comes
      // apart in shards. Cut into a grid of rectangles it read as a floor being tiled.
      const texture = crackTextures.length ? crackTextures[(row * across + col) % crackTextures.length] : null;
      const parts = texture ? fractureImage(chunk, texture, w, h) : [];
      chunk.width = chunk.height = 1;
      for (const part of parts) {
        // Thrown outward from the middle of the screen, so the desk blows apart rather than
        // sliding off the bottom in one sheet.
        const px = sx + part.x + part.w / 2;
        const away = px / screen.width - 0.5;
        debris.add({
          img: part.img,
          x: px,
          y: sy + part.y + part.h / 2,
          w: part.w,
          h: part.h,
          vx: away * 1100 + (Math.random() - 0.5) * 300,
          vy: -240 - Math.random() * 300,
          angle: 0,
          spin: (Math.random() - 0.5) * 2.6,
        });
      }
    }
  }
  erodedCtx.clearRect(0, 0, screen.width, screen.height);
}

/** Artwork partitions are rasterized only on impact, never in the render loop. */
function shed(s: Sprite, all: boolean) {
  if (s.broken || !crackTextures.length) return;
  carve(s);
  const pieces = fractureImage(s.cut, crackTextures[s.id % crackTextures.length], s.w, s.h).sort((a,b) => a.w*a.h-b.w*b.h);
  const selected = all ? pieces : pieces.slice(0, 1);
  const c = s.cut.getContext("2d")!;
  for (const piece of selected) {
    const lx = piece.x + piece.w/2 - s.w/2, ly = piece.y + piece.h/2 - s.h/2;
    c.save(); c.globalCompositeOperation="destination-out";
    c.drawImage(piece.img, piece.x/s.w*s.cut.width, piece.y/s.h*s.cut.height, piece.w/s.w*s.cut.width, piece.h/s.h*s.cut.height); c.restore();
    debris.add({img:piece.img, x:s.x+s.w/2+lx*Math.cos(s.angle)-ly*Math.sin(s.angle), y:s.y+s.h/2+lx*Math.sin(s.angle)+ly*Math.cos(s.angle), w:piece.w,h:piece.h,vx:s.vx+(Math.random()-.5)*350,vy:s.vy-250-Math.random()*250,angle:s.angle,spin:s.spin+(Math.random()-.5)*3});
  }
  for (const piece of pieces.slice(selected.length)) piece.img.width=piece.img.height=1;
  if (all) { s.broken=true; s.reveal=1; if(held===s)held=null; }
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
let erosionStyle: "tiles" | "cracks" = "cracks";
interface Tile { img: HTMLCanvasElement; x: number; y: number; vx: number; vy: number; angle: number; spin: number }
let tiles: Tile[] = [];
let crackSeed: number[] = [];
/** Per cell: the window that owns this crack, or -1 when it is the desktop's own. */
let crackOwner: Int16Array = new Int16Array(0);
let crackTextures: CrackTexture[] = [];
/** Cells whose reveal is changing right now, so only these are repainted each frame. */
const active = new Set<number>();
/** The order cells break in: a shuffle, so it does not sweep away in obvious rows. */
let order: number[] = [];
let orderPtr = 0;
let carry = 0;
/** "erode": desktop and windows breaking away. "crtOff": the tube-TV collapse before it all
 * snaps back whole and erodes again. */
let phase: "erode" | "shatter" | "bare" | "crtOff" | "void" = "erode";
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
  debris.clear(); shatterQueue.clear(); rimPatterns.clear();
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
    s.broken=false; s.damage=0;
    s.cut.width=s.cut.height=1; s.cut=maskedWindow(s.img,null); s.carved=false;
    s.reveal = 0;
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

/** Bake local damage into the window once so it never punches through unrelated layers. */
function damageWindow(s: Sprite, cr: { tex: number; lx: number; ly: number; rot: number; sc: number }) {
  const tex=crackTextures[cr.tex];if(!tex)return;
  // One crack, where it landed. Emphatically not a carve: the slow ambient erosion drops its
  // first cells within seconds of the screensaver opening, and carving on one of those cut every
  // window to its broken silhouette before he had touched anything, which is why they looked
  // smashed from the start. Reshaping the whole window is for him knocking it about.
  const c=s.cut.getContext("2d")!;c.save();
  c.scale(s.cut.width/s.w,s.cut.height/s.h);c.translate(cr.lx,cr.ly);c.rotate(cr.rot);c.scale(cr.sc,cr.sc);
  c.globalCompositeOperation="destination-out";c.drawImage(tex.hole,-tex.cx,-tex.cy);
  c.globalCompositeOperation="source-atop";c.drawImage(tex.glass,-tex.cx,-tex.cy);c.restore();
}

function nudgeCell(i: number) {
  if (reveal[i] > 0 || active.has(i)) return;
  if (erosionStyle === "tiles" && desktopSrc && screen) {
    const x = (i % cols) * CELL, y = Math.floor(i / cols) * CELL;
    const img = document.createElement("canvas");
    img.width = Math.min(CELL, screen.width - x); img.height = Math.min(CELL, screen.height - y);
    const tc = img.getContext("2d")!; tc.translate(-x, -y); tc.drawImage(desktopSrc, 0, 0);
    for (const sp of sprites) {
      if (sp.broken) continue;
      tc.save(); tc.translate(sp.x + sp.w / 2, sp.y + sp.h / 2); tc.rotate(sp.angle);
      tc.drawImage(sp.cut, -sp.w / 2, -sp.h / 2, sp.w, sp.h); tc.restore();
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
      if (sp.broken) continue;
      if (px < sp.x || px > sp.x + sp.w || py < sp.y || py > sp.y + sp.h) continue;
      damageWindow(sp, {
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

/**
 * Break the one cell he struck. A radius used to take every cell it touched, which at this grid
 * size was up to sixteen of them for a single punch: one blow left a whole region of glass gone
 * at once, which read as a patch of damage rather than as a hit.
 */
function breakAt(px: number, py: number) {
  if (!cols || !screen || phase !== "erode") return;
  if (px < 0 || py < 0 || px >= screen.width || py >= screen.height) return;
  nudgeCell(Math.floor(py / CELL) * cols + Math.floor(px / CELL));
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

/** How wide the broken glass rides along the edge of a cutout, in screen pixels. */
const RIM = 44;
/** One pattern per artwork, kept rather than rebuilt for every cutout on every frame. */
const rimPatterns = new Map<number, CanvasPattern | null>();

/**
 * The broken glass around a cutout, laid along its edge rather than stretched across the whole
 * window. Stretched, a few hundred pixels of artwork had to cover a window several times that
 * wide and arrived as a soft grey smear; as a pattern stroked along the silhouette it keeps its
 * own pixel density however large the window is.
 */
function drawCutoutEdges(target: CanvasRenderingContext2D, s: Sprite, rx: number, ry: number) {
  // Nothing to trace until the window has been cut to its silhouette. A square window with a
  // broken rim drawn round the shape it has not taken yet reads as two different windows.
  if (!crackTextures.length || !s.outline || !s.carved) return;
  const slot = s.id % crackTextures.length;
  if (!rimPatterns.has(slot)) rimPatterns.set(slot, target.createPattern(windowGlass(crackTextures[slot]), "repeat"));
  const pattern = rimPatterns.get(slot);
  if (!pattern) return;
  target.save();
  target.translate(rx, ry);
  target.strokeStyle = pattern;
  target.lineWidth = RIM;
  target.lineJoin = "round";
  // Only over glass that is still there, the same rule the cracks follow. Drawn plainly it also
  // landed in the empty space a window used to fill, and on one that has shattered altogether,
  // leaving a crisp jagged ring hanging in the dark with nothing inside it.
  target.globalCompositeOperation = "source-atop";
  target.stroke(outlinePath(s.outline, s.w, s.h));
  target.restore();
}

function updateErosion(dt: number) {
  if (!cols) return;
  // Frozen once the tube starts going off; still running through the collapse, where every cell
  // has already been set going at once and only has to finish.
  if (phase !== "erode" && phase !== "shatter") return;
  // Feed new cells into the erosion from the shuffled order, at a steady rate.
  if (phase === "erode") {
    carry += ((cols * rows) / ambientSeconds) * dt;
    while (carry >= 1 && orderPtr < order.length) {
      nudgeCell(order[orderPtr++]);
      carry -= 1;
    }
  }
  // Advance every breaking cell and repaint it; drop it once it is fully gone.
  for (const i of active) {
    reveal[i] = Math.min(1, reveal[i] + BREAK_RATE * dt);
    paintCell(i);
    if (reveal[i] >= 1) active.delete(i);
  }
  // Whole desktop gone and settled: pull the plug. Tell every screen to collapse at the same
  // moment (this one included, via the event), so the whole desk powers off as one.
  if (phase === "erode" && !crtRequested && reveal.every(value => value >= 1) && active.size === 0 && tiles.length === 0) {
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
  if (held && buddy && buddyVy > 800 && Math.abs(buddy.y + buddy.h - held.y) < GRIP) shatterQueue.add(held);

  if (crtCycle && screen) {
    const next = cyclePhase(crtCycle, Date.now());
    if (next === "erode") {
      restoreDesktop();
      phase = "erode";
      sendSurfaces();
    } else if (next === "shatter") {
      // Everything still standing breaks into pieces, and the pieces fade out together. The
      // desk is not dimmed where it stands: every cell is set going at once so the picture
      // itself comes apart, and every window is queued to be shed. Nothing is standable from
      // here, which the surface list already handles by refusing anything outside the erode
      // phase. He keeps roaming throughout; his own clock does not start until this is done.
      if (phase === "erode") {
        phase = "shatter";
        held = null;
        for (const s of sprites) if (!s.broken) shatterQueue.add(s);
        // The picture itself goes too, in pieces. Cells are left alone from here: they punch
        // holes in a picture that is no longer being drawn.
        shatterDesktop();
        sendSurfaces();
      }
      // Faded as one, over what is left of this stretch: the usual rule ages each piece on its
      // own, so the last ones made hung about long after the rest had gone.
      debris.fadeAll(dt, Math.max(0.2, SHATTER_SECONDS * (1 - shatterProgress(crtCycle, Date.now()))));
    } else if (next === "bare") {
      // Nothing of the desk left: just him, in front of whatever plays behind. This is the
      // stretch the void seconds actually buy, which is why the breaking up above is not part
      // of it.
      if (phase !== "bare") {
        phase = "bare";
        held = null;
        debris.clear();
        tiles = [];
        sendSurfaces();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      requestAnimationFrame(frame);
      return;
    } else if (next !== "waiting") {
      if (phase !== "crtOff" && phase !== "void") {
        held = null;
        sendSurfaces();
      }
      phase = next;
      // The tube's own stretch begins after the collapse, not when the cycle did.
      drawCrtSlice(ctx, screen, screen.virtualDesktop, (Date.now() - crtCycle.startedAt) / 1000 - crtStartsAt(crtCycle));
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

    updateErosion(dt);
    if (eroded) ctx.drawImage(eroded, 0, 0, canvas.width, canvas.height);

    const floor = screen.height;
    const pending = shatterQueue.values().next().value;
    if (pending) { shatterQueue.delete(pending); shed(pending, true); }
    for (const s of sprites) {
      if (s.broken) continue;
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
          if (s.vy > 950) shatterQueue.add(s);
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
      ctx.drawImage(s.cut, -s.w / 2, -s.h / 2, s.w, s.h);
      // Once it has been knocked out of place its own square corners are broken too, drawn in its
      // own frame so they turn and travel with it.
      if (erosionStyle === "cracks" && (Math.abs(s.x - s.homeX) >= MOVED_AWAY || Math.abs(s.y - s.homeY) >= MOVED_AWAY)) {
        drawCutoutEdges(ctx, s, -s.w / 2, -s.h / 2);
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
        if (!sp.broken && Math.abs(sp.x - sp.homeX) < MOVED_AWAY && Math.abs(sp.y - sp.homeY) < MOVED_AWAY) continue;
        drawCutoutEdges(ctx, sp, sp.homeX, sp.homeY);
      }
    }
    for (const tile of tiles) {
      tile.vy += GRAVITY * dt; tile.x += tile.vx * dt; tile.y += tile.vy * dt; tile.angle += tile.spin * dt;
      ctx.save(); ctx.translate(tile.x, tile.y); ctx.rotate(tile.angle);
      ctx.drawImage(tile.img, -tile.img.width / 2, -tile.img.height / 2); ctx.restore();
    }
    tiles = tiles.filter(tile => tile.y - CELL <= screen!.height);
    debris.step(dt, screen.width, screen.height);
    debris.draw(ctx);
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
  end();
});
