#!/usr/bin/env python3
"""Draw the Gretchen icon — the coral ✻ spark on the app's dark ground —
and emit Gretchen.icns via iconutil. Pure PIL, no font dependencies."""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Gretchen.icns")
BG = (26, 25, 21, 255)        # --bg
ACCENT = (217, 119, 87, 255)  # --accent

def draw_icon(size):
    s = 4  # supersample for smooth edges
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # macOS-style rounded square, inset like Big Sur+ icons
    inset = round(n * 0.09)
    radius = round(n * 0.20)
    d.rounded_rectangle([inset, inset, n - inset, n - inset], radius=radius, fill=BG)

    # six-spoke spark: tapered petals around the center
    cx = cy = n / 2
    r_out = n * 0.30
    r_in = n * 0.045
    width = n * 0.052
    for i in range(6):
        a = math.pi / 2 + i * math.pi / 3
        tipx, tipy = cx + r_out * math.cos(a), cy - r_out * math.sin(a)
        basex, basey = cx + r_in * math.cos(a), cy - r_in * math.sin(a)
        # petal = thick line with round caps, tapering via two segments
        d.line([basex, basey, tipx, tipy], fill=ACCENT, width=round(width))
        d.ellipse([tipx - width * 0.5, tipy - width * 0.5, tipx + width * 0.5, tipy + width * 0.5], fill=ACCENT)
    d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)

with tempfile.TemporaryDirectory() as td:
    iconset = Path(td) / "Gretchen.iconset"
    iconset.mkdir()
    for size in (16, 32, 64, 128, 256, 512, 1024):
        img = draw_icon(size)
        if size <= 512:
            img.save(iconset / f"icon_{size}x{size}.png")
        if size >= 32:
            img.save(iconset / f"icon_{size // 2}x{size // 2}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT)], check=True)
print(f"wrote {OUT}")
