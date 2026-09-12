/** Extract compositing layers from the supplied glass artwork without changing the PNGs. */
export interface CrackTexture {
  hole: HTMLCanvasElement;
  glass: HTMLCanvasElement;
  name: string;
  cx: number;
  cy: number;
}

// The usable impact slices: a blast with a hole through the middle. Incomplete frame slices are
// left out.
const SOURCES = ["c00", "c01", "c02", "c03", "c06", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c27"];

/**
 * The edge and corner pieces. These are a different thing from the impacts above: glass giving way
 * along a straight edge, with no hole punched through the middle, drawn so the solid glass sits in
 * the corner and the shards point away from it. They suit the square corners of a window cutout,
 * which the round impacts do not.
 */
const EDGE_SOURCES = ["cc01", "cc02", "cc03"];

/** One edge/corner piece, ready to lay into a corner. Glass only; it punches no hole. */
export interface EdgeDecal {
  img: HTMLCanvasElement;
  name: string;
  w: number;
  h: number;
}

export async function loadEdgeDecals(): Promise<EdgeDecal[]> {
  const out: EdgeDecal[] = [];
  for (const file of EDGE_SOURCES) {
    try {
      const response = await fetch(`/cracks/${file}.png`);
      if (!response.ok) continue;
      const bitmap = await createImageBitmap(await response.blob());
      const img = layer(bitmap.width, bitmap.height);
      img.getContext("2d")!.drawImage(bitmap, 0, 0);
      out.push({ img, name: file, w: bitmap.width, h: bitmap.height });
      bitmap.close();
    } catch {
      // A missing edge piece just means plainer cutout corners.
    }
  }
  return out;
}

/** Glass has to be both present and not near-black; a blast centre may be a gap or a dark pit. */
const GLASS_ALPHA = 40;
const GLASS_DARK = 60;

/**
 * Find the hole in a slice by reading the artwork, not by measuring it by hand. The hole is the
 * pocket the cracks enclose, so flood inwards from the border across everything that is not glass
 * (that flood is the space around the slice) and whatever it cannot reach is the hole. That covers
 * both the slices whose centre is punched clean through and the ones whose centre is a dark pit.
 *
 * This replaces two fragile things: a hand-measured table of centres, which went stale the moment a
 * slice was cropped, and a ray-march outwards from that centre, which sprayed long spikes across
 * the whole slice whenever it started somewhere the artwork did not expect.
 */
function traceHole(data: Uint8ClampedArray, w: number, h: number): { cx: number; cy: number; mask: Uint8Array } {
  const n = w * h;
  const glass = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = (data[o] + data[o + 1] + data[o + 2]) / 3;
    glass[i] = data[o + 3] > GLASS_ALPHA && lum >= GLASS_DARK ? 1 : 0;
  }
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!outside[i] && !glass[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  // Only the biggest enclosed pocket is the impact. A spiderweb slice also encloses the gaps
  // between its rings, and punching those out too would eat the web itself rather than leave it
  // as the detail around the hole.
  const seen = new Uint8Array(n);
  const mask = new Uint8Array(n);
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let start = 0; start < n; start++) {
    if (outside[start] || glass[start] || seen[start]) continue;
    head = 0;
    tail = 0;
    seen[start] = 1;
    queue[tail++] = start;
    let size = 0;
    let ax = 0;
    let ay = 0;
    while (head < tail) {
      const i = queue[head++];
      size++;
      ax += i % w;
      ay += (i / w) | 0;
      const x = i % w;
      const y = (i / w) | 0;
      const step = (j: number) => {
        if (!seen[j] && !outside[j] && !glass[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      };
      if (x > 0) step(i - 1);
      if (x < w - 1) step(i + 1);
      if (y > 0) step(i - w);
      if (y < h - 1) step(i + w);
    }
    if (size > count) {
      count = size;
      sx = ax;
      sy = ay;
      mask.fill(0);
      for (let k = 0; k < tail; k++) mask[queue[k]] = 1;
    }
  }
  if (count > 80) return { cx: Math.round(sx / count), cy: Math.round(sy / count), mask };
  // Nothing enclosed at all: leave no hole and sit the crack on its own weight.
  let tot = 0;
  sx = 0;
  sy = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    tot += a;
    sx += (i % w) * a;
    sy += ((i / w) | 0) * a;
  }
  return tot
    ? { cx: Math.round(sx / tot), cy: Math.round(sy / tot), mask: new Uint8Array(n) }
    : { cx: w >> 1, cy: h >> 1, mask: new Uint8Array(n) };
}

function layer(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export async function loadCrackTextures(): Promise<CrackTexture[]> {
  return Promise.all(SOURCES.map(async (file) => {
    const response = await fetch(`/cracks/${file}.png`);
    if (!response.ok) throw new Error(`Could not load crack artwork: ${file}`);
    const bitmap = await createImageBitmap(await response.blob());
    const w = bitmap.width, h = bitmap.height;
    const original = layer(w, h), oc = original.getContext("2d")!;
    oc.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = oc.getImageData(0, 0, w, h);
    // Read the hole before the glass pass below rewrites the alpha in place.
    const { cx, cy, mask } = traceHole(pixels.data, w, h);
    const hole = layer(w, h), hc = hole.getContext("2d")!;
    const holePixels = hc.createImageData(w, h);
    for (let i = 0; i < w * h; i++) if (mask[i]) holePixels.data[i * 4 + 3] = 255;
    hc.putImageData(holePixels, 0, 0);

    // These slices already carry alpha. Preserve it: amplifying RGB from nearly
    // transparent pixels introduces colored fringes from PNG unpremultiplication.
    const glass = layer(w, h), gc = glass.getContext("2d")!;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const edge = Math.min(1, Math.min(x, y, w - 1 - x, h - 1 - y) / 24);
      pixels.data[i + 3] = Math.max(0, pixels.data[i + 3] - 8) / 247 * 255 * edge;
    }
    gc.putImageData(pixels, 0, 0);
    gc.globalCompositeOperation = "destination-out"; gc.drawImage(hole, 0, 0);
    gc.globalCompositeOperation = "source-over";
    return { hole, glass, cx, cy, name: file };
  }));
}
