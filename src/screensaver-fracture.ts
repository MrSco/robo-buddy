import type { CrackTexture } from "./screensaver-cracks";
export function surface(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  return canvas;
}
/** Connected regions separated by the actual bright crack lines, not procedural polygons. */
export function artworkRegions(pixels: Uint8ClampedArray, w: number, h: number, limit = 8): Int16Array {
  const n = w * h,
    barrier = new Uint8Array(n),
    labels = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    if (pixels[k + 3] > 45 && Math.max(pixels[k], pixels[k + 1], pixels[k + 2]) > 115) {
      const x = i % w,
        y = Math.floor(i / w);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) barrier[i + dy * w + dx] = 1;
    }
  }
  const components: number[][] = [],
    queue = new Int32Array(n);
  const neighbours = (i: number, visit: (j: number) => void) => {
    if (i % w) visit(i - 1);
    if (i % w < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  };
  for (let i = 0; i < n; i++)
    if (!barrier[i] && labels[i] < 0) {
      let head = 0,
        tail = 1;
      queue[0] = i;
      labels[i] = 0;
      const region: number[] = [];
      while (head < tail) {
        const p = queue[head++];
        region.push(p);
        neighbours(p, (j) => {
          if (!barrier[j] && labels[j] < 0) {
            labels[j] = 0;
            queue[tail++] = j;
          }
        });
      }
      if (region.length >= 12) components.push(region);
    }
  components.sort((a, b) => b.length - a.length);
  labels.fill(-1);
  let head = 0,
    tail = 0;
  components.slice(0, limit).forEach((region, id) => {
    for (const p of region) {
      labels[p] = id;
      queue[tail++] = p;
    }
  });
  // Fill the thin line pixels and tiny pockets from adjacent regions. The seam follows the artwork.
  while (head < tail) {
    const p = queue[head++];
    neighbours(p, (j) => {
      if (labels[j] < 0) {
        labels[j] = labels[p];
        queue[tail++] = j;
      }
    });
  }
  return labels;
}

const templates = new WeakMap<CrackTexture, HTMLCanvasElement[]>();
function fractureMasks(tex: CrackTexture): HTMLCanvasElement[] {
  const cached = templates.get(tex);
  if (cached) return cached;
  const art = surface(160, 160),
    ac = art.getContext("2d")!;
  ac.drawImage(tex.glass, 0, 0, 160, 160);
  const labels = artworkRegions(ac.getImageData(0, 0, 160, 160).data, 160, 160);
  let count = 0;
  for (const label of labels) if (label + 1 > count) count = label + 1;
  const masks: HTMLCanvasElement[] = [];
  if (count < 2) {
    // Some slices contain only an impact pocket: its artwork supplies a two-piece split.
    const hole = surface(160, 160),
      hc = hole.getContext("2d")!;
    hc.drawImage(tex.hole, 0, 0, 160, 160);
    const rest = surface(160, 160),
      rc = rest.getContext("2d")!;
    rc.fillRect(0, 0, 160, 160);
    rc.globalCompositeOperation = "destination-out";
    rc.drawImage(hole, 0, 0);
    masks.push(hole, rest);
  } else
    for (let id = 0; id < count; id++) {
      const mask = surface(160, 160),
        mc = mask.getContext("2d")!,
        data = mc.createImageData(160, 160);
      for (let i = 0; i < labels.length; i++) if (labels[i] === id) data.data[i * 4 + 3] = 255;
      mc.putImageData(data, 0, 0);
      masks.push(mask);
    }
  templates.set(tex, masks);
  return masks;
}

const outlines = new WeakMap<CrackTexture, { outline: Float32Array; glass: HTMLCanvasElement }>();

/** How many rays the silhouette is sampled along. */
const RAYS = 192;
/**
 * The longest side a window's working raster is allowed. It only has to be sharp on screen, and
 * a window is redrawn at its own size, so anything under that size is visible softness. The old
 * cap was low enough to blur the window's own contents as well as its edge.
 */
const CUT_MAX = 1600;

/** The glass artwork cropped to the blast, at its own resolution rather than resampled. */
export function windowGlass(tex: CrackTexture) {
  windowOutline(tex);
  return outlines.get(tex)!.glass;
}

/**
 * The silhouette of the blast in the supplied artwork, as a closed polygon in 0..1 of its own
 * bounding box.
 *
 * A polygon and not a bitmap, because a window is several times the size of the artwork. A mask
 * baked at the artwork's resolution arrives at the window soft, and one baked square arrives
 * stretched unevenly as well, which is what made displaced windows look smeared. A polygon
 * scales to any size and any aspect exactly.
 *
 * Sampled by marching out from the centroid and keeping the furthest solid pixel on each ray
 * rather than stopping at the first gap: the artwork is full of gaps inside the blast, and
 * stopping at one throws a long spike across the slice. Taking a median of each ray with its
 * neighbours removes the single-sample noise that survives that.
 */
export function windowOutline(tex: CrackTexture): Float32Array {
  const cached = outlines.get(tex);
  if (cached) return cached.outline;
  const w = tex.hole.width,
    h = tex.hole.height;
  const traced = traceOutline(tex.hole.getContext("2d")!.getImageData(0, 0, w, h).data, w, h);
  const glass = surface(Math.max(1, traced.x1 - traced.x0 + 1), Math.max(1, traced.y1 - traced.y0 + 1));
  if (traced.x1 >= traced.x0)
    glass
      .getContext("2d")!
      .drawImage(tex.glass, traced.x0, traced.y0, glass.width, glass.height, 0, 0, glass.width, glass.height);
  outlines.set(tex, { outline: traced.outline, glass });
  return traced.outline;
}

export interface TracedOutline {
  outline: Float32Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The silhouette trace itself, over raw pixels, so it can be exercised without a canvas. */
export function traceOutline(pixels: Uint8ClampedArray, w: number, h: number, rays = RAYS): TracedOutline {
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && pixels[(y * w + x) * 4 + 3] > 100;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    sumX = 0,
    sumY = 0,
    count = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (solid(x, y)) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        sumX += x;
        sumY += y;
        count++;
      }
  const outline = new Float32Array(rays * 2);
  if (count === 0) {
    // Nothing legible in the artwork: a plain rectangle, so the window still appears at all.
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      outline[i * 2] = Math.cos(a) < 0 ? 0 : 1;
      outline[i * 2 + 1] = Math.sin(a) < 0 ? 0 : 1;
    }
    return { outline, x0: 0, y0: 0, x1: -1, y1: -1 };
  }
  const cx = sumX / count,
    cy = sumY / count;
  const reach = Math.ceil(Math.hypot(w, h));
  const radii = new Float32Array(rays);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2,
      dx = Math.cos(a),
      dy = Math.sin(a);
    let far = 0;
    for (let r = 1; r <= reach; r++) {
      const x = Math.round(cx + dx * r),
        y = Math.round(cy + dy * r);
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      if (solid(x, y)) far = r;
    }
    radii[i] = far;
  }
  const bw = x1 - x0 + 1,
    bh = y1 - y0 + 1;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const trio = [radii[(i - 1 + rays) % rays], radii[i], radii[(i + 1) % rays]].sort((p, q) => p - q);
    const r = trio[1];
    const x = (cx + Math.cos(a) * r - x0) / bw,
      y = (cy + Math.sin(a) * r - y0) / bh;
    outline[i * 2] = Math.min(1, Math.max(0, x));
    outline[i * 2 + 1] = Math.min(1, Math.max(0, y));
  }
  return { outline, x0, y0, x1, y1 };
}

/** The silhouette as a path over a rectangle of this size, ready to clip, fill or stroke. */
export function outlinePath(outline: Float32Array, w: number, h: number): Path2D {
  const path = new Path2D();
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i] * w,
      y = outline[i + 1] * h;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

export function maskedWindow(img: ImageBitmap, outline: Float32Array | null): HTMLCanvasElement {
  const scale = Math.min(1, CUT_MAX / Math.max(img.width, img.height));
  const canvas = surface(img.width * scale, img.height * scale),
    c = canvas.getContext("2d")!;
  // Clipped rather than composited against a bitmap: the edge is then as sharp as this raster,
  // instead of as sharp as a few hundred pixels of artwork stretched over the whole window.
  if (outline) {
    c.save();
    c.clip(outlinePath(outline, canvas.width, canvas.height));
  }
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (outline) c.restore();
  return canvas;
}
/** Longest side of the working raster a pane's crack field is traced at. */
const FIELD_MAX = 720;
/** Impact points struck into a whole pane, and the radial cracks each one throws off. */
const IMPACTS = 9;
const ARMS = 6;
/** How far a crack is allowed to wander off true, in radians per step. Glass breaks nearly
 * straight: more than this and the shards come out as rounded cells rather than splinters. */
const WOBBLE = 0.15;

/** Repeatable noise, so one screen's break is the same every time it is asked for. */
function noise(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Crack lines across a whole pane, white on black, for artworkRegions to partition.
 *
 * The impact artwork cannot do this job. A slice is a blast with a hole in the middle of an
 * otherwise empty square, so the one region the labelling finds is everything *around* the
 * blast: a full rectangle with a bite out of it. Stretched over a piece of desktop that is
 * exactly the tile it looked like. Stamping several slices does not help either, because their
 * arms end in mid air and never cut the background into anything.
 *
 * So the field is drawn rather than photographed. Every arm runs from its impact right off the
 * edge of the pane, which is what makes this a partition and not a pattern: a curve that ends
 * on the boundary divides the face it crosses, so no region can span the whole pane however
 * the arms happen to fall. Arms from neighbouring impacts cross each other, and a few ragged
 * hops between consecutive arms stand in for the lateral cracks that stop real glass breaking
 * into nothing but long wedges.
 */
export function crackField(w: number, h: number, seed: number): HTMLCanvasElement {
  const field = surface(w, h);
  const c = field.getContext("2d")!;
  c.fillStyle = "#000";
  c.fillRect(0, 0, w, h);
  c.strokeStyle = "#fff";
  c.lineCap = "round";
  c.lineJoin = "round";
  const random = noise(seed);
  const span = Math.hypot(w, h);
  const width = Math.max(1.4, span / 250);
  const cols = Math.max(1, Math.round(Math.sqrt((IMPACTS * w) / Math.max(1, h))));
  const rows = Math.max(1, Math.ceil(IMPACTS / cols));
  const points: { x: number; y: number }[] = [];
  for (let r = 0; r < rows && points.length < IMPACTS; r++)
    for (let q = 0; q < cols && points.length < IMPACTS; q++)
      points.push({ x: ((q + 0.15 + random() * 0.7) * w) / cols, y: ((r + 0.15 + random() * 0.7) * h) / rows });
  const run = (x0: number, y0: number, aim: number, length: number) => {
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x0, y0);
    let x = x0,
      y = y0;
    const step = Math.max(14, length / 9);
    for (let d = 0; d < length; d += step) {
      const angle = aim + (random() - 0.5) * WOBBLE;
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
      c.lineTo(x, y);
    }
    c.stroke();
  };
  for (const p of points) {
    const base = random() * Math.PI * 2;
    const arms = ARMS + Math.floor(random() * 3);
    const aims: number[] = [];
    for (let i = 0; i < arms; i++) {
      const aim = base + (i * 2 * Math.PI) / arms + (random() - 0.5) * 0.7;
      aims.push(aim);
      run(p.x, p.y, aim, span);
    }
    for (let i = 0; i < arms; i++) {
      if (random() < 0.45) continue;
      const radius = (0.08 + random() * 0.3) * span;
      const x0 = p.x + Math.cos(aims[i]) * radius;
      const y0 = p.y + Math.sin(aims[i]) * radius;
      const far = radius * (0.7 + random() * 0.6);
      const x1 = p.x + Math.cos(aims[(i + 1) % arms]) * far;
      const y1 = p.y + Math.sin(aims[(i + 1) % arms]) * far;
      c.lineWidth = width * 0.8;
      c.beginPath();
      c.moveTo(x0, y0);
      for (let s = 1; s <= 5; s++) {
        const t = s / 5;
        c.lineTo(x0 + (x1 - x0) * t + (random() - 0.5) * radius * 0.25, y0 + (y1 - y0) * t + (random() - 0.5) * radius * 0.25);
      }
      c.stroke();
    }
  }
  return field;
}

/**
 * A whole pane broken into shards: the desktop at the end of a cycle, rather than a window.
 *
 * `budget` is the raster the caller can afford in total; every piece is scaled by the same
 * factor to fit inside it, so the break is as sharp as the debris allowance permits and never
 * arrives so heavy that adding the last pieces evicts the first.
 */
export function shatterPlane(
  src: CanvasImageSource,
  worldW: number,
  worldH: number,
  seed: number,
  pieces: number,
  budget: number,
): FragmentImage[] {
  const scale = Math.min(1, FIELD_MAX / Math.max(worldW, worldH));
  const fw = Math.max(8, Math.round(worldW * scale));
  const fh = Math.max(8, Math.round(worldH * scale));
  const field = crackField(fw, fh, seed);
  const labels = artworkRegions(field.getContext("2d")!.getImageData(0, 0, fw, fh).data, fw, fh, pieces);
  field.width = field.height = 1;
  let count = 0;
  for (const label of labels) if (label + 1 > count) count = label + 1;
  if (count < 1) return [];
  // One pass for every region's bounds, rather than a full-size mask each.
  const x0 = new Int32Array(count).fill(fw),
    y0 = new Int32Array(count).fill(fh),
    x1 = new Int32Array(count).fill(-1),
    y1 = new Int32Array(count).fill(-1);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const id = labels[y * fw + x];
      if (id < 0) continue;
      if (x < x0[id]) x0[id] = x;
      if (y < y0[id]) y0[id] = y;
      if (x > x1[id]) x1[id] = x;
      if (y > y1[id]) y1[id] = y;
    }
  let area = 0;
  for (let id = 0; id < count; id++)
    if (x1[id] >= x0[id]) area += ((x1[id] - x0[id] + 1) / scale) * ((y1[id] - y0[id] + 1) / scale);
  const raster = Math.min(1, Math.sqrt(budget / Math.max(1, area)));
  const out: FragmentImage[] = [];
  for (let id = 0; id < count; id++) {
    if (x1[id] < x0[id]) continue;
    const mw = x1[id] - x0[id] + 1,
      mh = y1[id] - y0[id] + 1;
    const mask = surface(mw, mh);
    const mc = mask.getContext("2d")!;
    const bits = mc.createImageData(mw, mh);
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++)
        if (labels[(y + y0[id]) * fw + x + x0[id]] === id) bits.data[(y * mw + x) * 4 + 3] = 255;
    mc.putImageData(bits, 0, 0);
    const wx = x0[id] / scale,
      wy = y0[id] / scale,
      ww = mw / scale,
      wh = mh / scale;
    const pw = Math.max(1, Math.round(ww * raster)),
      ph = Math.max(1, Math.round(wh * raster));
    const piece = surface(pw, ph);
    const pc = piece.getContext("2d")!;
    pc.drawImage(src, wx, wy, ww, wh, 0, 0, pw, ph);
    pc.globalCompositeOperation = "destination-in";
    pc.drawImage(mask, 0, 0, pw, ph);
    mask.width = mask.height = 1;
    out.push({ img: piece, x: wx, y: wy, w: ww, h: wh });
  }
  return out;
}

export interface FragmentImage {
  img: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Carve tight image regions, capped in raster resolution before allocating debris bodies. */
export function fractureImage(
  image: HTMLCanvasElement,
  tex: CrackTexture,
  worldW: number,
  worldH: number,
): FragmentImage[] {
  const scale = Math.min(1, 384 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale));
  const pieces: FragmentImage[] = [];
  for (const mask of fractureMasks(tex)) {
    const temp = surface(width, height),
      c = temp.getContext("2d")!;
    c.drawImage(image, 0, 0, width, height);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(mask, 0, 0, width, height);
    const rgba = c.getImageData(0, 0, width, height).data;
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1,
      area = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (rgba[(y * width + x) * 4 + 3] > 80) {
          area++;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    if (area < 30) {
      temp.width = temp.height = 1;
      continue;
    }
    const cropped = surface(x1 - x0 + 1, y1 - y0 + 1);
    cropped
      .getContext("2d")!
      .drawImage(temp, x0, y0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    pieces.push({
      img: cropped,
      x: (x0 / width) * worldW,
      y: (y0 / height) * worldH,
      w: (cropped.width / width) * worldW,
      h: (cropped.height / height) * worldH,
    });
    temp.width = temp.height = 1;
  }
  return pieces;
}
