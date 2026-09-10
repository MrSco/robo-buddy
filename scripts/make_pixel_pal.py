"""Generate the bundled 2D sample character "Pixel Pal": a round blob with eyes.

Writes animated WebP files (with alpha) for idle, dance and poked states into
public/characters/pixel-pal/. Run: python scripts/make_pixel_pal.py
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "characters", "pixel-pal")
SIZE = 256
BODY = (255, 170, 60, 255)
BODY_DARK = (220, 120, 30, 255)
EYE = (40, 30, 30, 255)
WHITE = (255, 255, 255, 255)


def frame(squash=0.0, bob=0.0, arm=0.0, blink=False, mouth_open=0.0, look=0.0):
    im = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, base = SIZE / 2, SIZE - 12
    w = 150 * (1 + squash * 0.35)
    h = 160 * (1 - squash * 0.35)
    top = base - h - bob
    # feet
    d.ellipse((cx - 48, base - 18, cx - 8, base + 4), fill=BODY_DARK)
    d.ellipse((cx + 8, base - 18, cx + 48, base + 4), fill=BODY_DARK)
    # arms
    for side in (-1, 1):
        ax = cx + side * (w / 2 - 6)
        ay = top + h * 0.55
        ex = ax + side * 34 * math.cos(arm * side)
        ey = ay - 34 * math.sin(max(arm * side, -0.2))
        d.line((ax, ay, ex, ey), fill=BODY_DARK, width=16)
        d.ellipse((ex - 10, ey - 10, ex + 10, ey + 10), fill=BODY_DARK)
    # body
    d.rounded_rectangle((cx - w / 2, top, cx + w / 2, base - 8), radius=int(min(w, h) * 0.45), fill=BODY)
    # eyes
    ey = top + h * 0.38
    for side in (-1, 1):
        ex = cx + side * 30 + look * 8
        if blink:
            d.line((ex - 14, ey, ex + 14, ey), fill=EYE, width=5)
        else:
            d.ellipse((ex - 16, ey - 18, ex + 16, ey + 18), fill=WHITE)
            d.ellipse((ex - 8 + look * 5, ey - 8, ex + 8 + look * 5, ey + 8), fill=EYE)
    # mouth
    my = top + h * 0.66
    if mouth_open > 0:
        d.ellipse((cx - 16, my - 4, cx + 16, my + 4 + 22 * mouth_open), fill=EYE)
    else:
        d.arc((cx - 22, my - 14, cx + 22, my + 10), start=15, end=165, fill=EYE, width=5)
    return im


def save(name, frames, fps):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=int(1000 / fps),
        loop=0,
        lossless=True,
        quality=90,
        method=4,
    )
    print(f"wrote {path} ({len(frames)} frames @ {fps} fps)")


def main():
    # idle: gentle breathing bob, blink on two frames
    idle = []
    n = 24
    for i in range(n):
        p = i / n
        idle.append(frame(squash=0.06 * math.sin(p * math.tau), bob=4 * math.sin(p * math.tau), blink=i in (18, 19)))
    save("idle.webp", idle, 12)

    # dance: one loop = 2 beats; squash on beats, arms pump alternately
    dance = []
    n = 16
    for i in range(n):
        p = i / n  # two beats per loop
        beat = (1 - math.cos(p * 2 * math.tau)) / 2
        arm = 0.9 * math.sin(p * math.tau)
        dance.append(frame(squash=0.25 * beat, bob=18 * (1 - beat), arm=arm, mouth_open=0.6, look=math.sin(p * math.tau)))
    save("dance.webp", dance, 16)

    # poked: surprised hop, mouth open, then settle. Not looped.
    poked = []
    n = 10
    for i in range(n):
        p = i / (n - 1)
        poked.append(frame(squash=-0.3 * math.sin(p * math.pi), bob=40 * math.sin(p * math.pi), arm=1.3 * math.sin(p * math.pi), mouth_open=1.0))
    save("poked.webp", poked, 20)


if __name__ == "__main__":
    main()
