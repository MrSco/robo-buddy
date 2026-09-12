/** Extract compositing layers from the supplied glass artwork without changing the PNGs. */
export interface CrackTexture {
  hole: HTMLCanvasElement;
  glass: HTMLCanvasElement;
  name: string;
  cx: number;
  cy: number;
}

// Inspected impact centres in the existing slices. Avoid incomplete corner/frame slices.
const SOURCES = [
  { file: "c00", x: 160, y: 200 },
  { file: "c01", x: 254, y: 180 },
  { file: "c02", x: 198, y: 204 },
  { file: "c03", x: 172, y: 208 },
  { file: "c06", x: 229, y: 196 },
  { file: "c10", x: 157, y: 183 },
  { file: "c11", x: 144, y: 167 },
  { file: "c12", x: 178, y: 154 },
  { file: "c13", x: 190, y: 154 },
  { file: "c14", x: 207, y: 151 },
  { file: "c15", x: 176, y: 150 },
  { file: "c16", x: 163, y: 167 },
  { file: "c27", x: 128, y: 127 },
];

function layer(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export async function loadCrackTextures(): Promise<CrackTexture[]> {
  return Promise.all(SOURCES.map(async ({ file, x: cx, y: cy }) => {
    const response = await fetch(`/cracks/${file}.png`);
    if (!response.ok) throw new Error(`Could not load crack artwork: ${file}`);
    const bitmap = await createImageBitmap(await response.blob());
    const w = bitmap.width, h = bitmap.height;
    const original = layer(w, h), oc = original.getContext("2d")!;
    oc.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = oc.getImageData(0, 0, w, h);
    const luminance = (x: number, y: number) => {
      const i = (Math.max(0, Math.min(h - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)))) * 4;
      return (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
    };
    // Follow the first glass rim outwards from the actual hole centre in the artwork.
    // The path is sampled from source pixels; it is not a generated crack silhouette.
    const hole = layer(w, h), hc = hole.getContext("2d")!;
    const centre = luminance(cx, cy);
    const alphaAt = (x: number, y: number) => pixels.data[(Math.max(0, Math.min(h - 1, Math.round(y))) * w + Math.max(0, Math.min(w - 1, Math.round(x)))) * 4 + 3];
    const transparentCentre = alphaAt(cx, cy) < 40;
    hc.beginPath();
    for (let ray = 0; ray < 360; ray++) {
      const a = ray * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
      let radius = 5;
      const limit = Math.min(w, h) * 0.46;
      for (; radius < limit; radius++) {
        const value = luminance(cx + dx * radius, cy + dy * radius);
        if (transparentCentre ? alphaAt(cx + dx * radius, cy + dy * radius) > 80 : value > centre + 35) break;
      }
      const x = cx + dx * radius, y = cy + dy * radius;
      if (!ray) hc.moveTo(x, y); else hc.lineTo(x, y);
    }
    hc.closePath(); hc.fill();

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
