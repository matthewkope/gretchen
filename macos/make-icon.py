#!/usr/bin/env python3
"""Draw the Gretchen icon — the coral ✻ florette (the same glyph the web app
shows as its favicon and sidebar brand) on a white ground — and emit
Gretchen.icns via iconutil. Pure PIL; renders the real ✻ glyph from Menlo, a
system font present on every Mac, so the dock icon matches the web UI exactly."""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Gretchen.icns")
WHITE = (255, 255, 255, 255)
ACCENT = (217, 119, 87, 255)  # #d97757 — the favicon coral

# fonts whose ✻ (U+273B) is the filled six-petalled florette the web UI shows;
# tried in order, first that loads wins. Menlo ships on every Mac.
GLYPH_FONTS = [
    ("/System/Library/Fonts/Menlo.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
]
GLYPH_FRAC = 0.56  # ✻ ink height as a fraction of the icon


def load_font(px):
    for path, index in GLYPH_FONTS:
        try:
            return ImageFont.truetype(path, px, index=index)
        except OSError:
            continue
    return None


def rounded_white(n):
    """A macOS-style rounded square, inset like Big Sur+ icons, on white."""
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    inset = round(n * 0.09)
    radius = round(n * 0.20)
    d.rounded_rectangle([inset, inset, n - inset, n - inset], radius=radius, fill=WHITE)
    return img


def draw_spark(d, n):
    """Fallback six-spoke spark, used only if no glyph font is available."""
    cx = cy = n / 2
    r_out, r_in, width = n * 0.30, n * 0.045, n * 0.052
    for i in range(6):
        a = math.pi / 2 + i * math.pi / 3
        tipx, tipy = cx + r_out * math.cos(a), cy - r_out * math.sin(a)
        basex, basey = cx + r_in * math.cos(a), cy - r_in * math.sin(a)
        d.line([basex, basey, tipx, tipy], fill=ACCENT, width=round(width))
        d.ellipse([tipx - width * 0.5, tipy - width * 0.5, tipx + width * 0.5, tipy + width * 0.5], fill=ACCENT)
    d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], fill=ACCENT)


def draw_icon(size):
    s = 4  # supersample for smooth edges
    n = size * s
    img = rounded_white(n)

    font = load_font(n)  # render big, then crop+scale to an exact size
    if font is not None:
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(layer).text((n / 2, n / 2), "✻", font=font, fill=ACCENT, anchor="mm")
        bbox = layer.getbbox()
        if bbox:
            glyph = layer.crop(bbox)
            target_h = round(n * GLYPH_FRAC)
            target_w = round(glyph.width * target_h / glyph.height)
            glyph = glyph.resize((target_w, target_h), Image.LANCZOS)
            img.alpha_composite(glyph, ((n - target_w) // 2, (n - target_h) // 2))
        else:
            draw_spark(ImageDraw.Draw(img), n)
    else:
        draw_spark(ImageDraw.Draw(img), n)

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
