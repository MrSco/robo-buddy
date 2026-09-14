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
  const count = Math.max(...labels) + 1;
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

const outlines = new WeakMap<CrackTexture, { mask: HTMLCanvasElement; glass: HTMLCanvasElement }>();
export function windowGlass(tex: CrackTexture) {
  windowMask(tex);
  return outlines.get(tex)!.glass;
}

/** A cached shape fitted from the enclosed impact silhouette in the supplied PNG. */
export function windowMask(tex: CrackTexture): HTMLCanvasElement {
  const cached = outlines.get(tex);
  if (cached) return cached.mask;
  const hc = tex.hole.getContext("2d")!,
    w = tex.hole.width,
    h = tex.hole.height;
  const pixels = hc.getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (pixels[(y * w + x) * 4 + 3] > 100) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  const mask = surface(256, 256),
    mc = mask.getContext("2d")!;
  if (x1 < 0) mc.fillRect(0, 0, 256, 256);
  else mc.drawImage(tex.hole, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, 256, 256);
  const glass = surface(256, 256);
  if (x1 >= 0) glass.getContext("2d")!.drawImage(tex.glass, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, 256, 256);
  outlines.set(tex, { mask, glass });
  return mask;
}
export function maskedWindow(img: ImageBitmap, mask: HTMLCanvasElement | null): HTMLCanvasElement {
  const scale = Math.min(1, 640 / Math.max(img.width, img.height));
  const canvas = surface(img.width * scale, img.height * scale),
    c = canvas.getContext("2d")!;
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (mask) {
    c.globalCompositeOperation = "destination-in";
    c.drawImage(mask, 0, 0, canvas.width, canvas.height);
    c.globalCompositeOperation = "source-over";
  }
  return canvas;
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
