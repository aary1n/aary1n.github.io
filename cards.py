"""Social preview cards: the image X, LinkedIn, iMessage etc. show when a link is shared.

1200x630 JPEGs drawn with Pillow: title and footer on the left, one flower photo on the right.
Fonts come from the system (Palatino/Georgia and Consolas on Windows), so cards look best
built on the machine you write on. Used by build.py; not run directly.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1200, 630
MARGIN = 80
PHOTO = 470
BG = (17, 17, 14)
TEXT = (216, 211, 193)
DIM = (148, 143, 127)

SERIF = ["C:/Windows/Fonts/pala.ttf", "C:/Windows/Fonts/georgia.ttf",
         "/System/Library/Fonts/Supplemental/Georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"]
MONO = ["C:/Windows/Fonts/consola.ttf", "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]


def font(candidates, size):
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def wrap(draw, text, fnt, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if not line or draw.textlength(trial, font=fnt) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line] if line else lines


def hex_rgb(colour):
    colour = colour.lstrip("#")
    return tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))


def card(out, *, title, footer, photo=None, swatch=None):
    """photo: path to an image file. swatch: category colour as "#rrggbb", drawn before the footer."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_w = W - 2 * MARGIN
    if photo and Path(photo).exists():
        with Image.open(photo) as src:
            square = ImageOps.fit(src.convert("RGB"), (PHOTO, PHOTO), Image.LANCZOS)
        img.paste(square, (W - MARGIN - PHOTO, (H - PHOTO) // 2))
        text_w = W - 3 * MARGIN - PHOTO + 20

    d.text((MARGIN, 104), "aaryans.page", font=font(MONO, 26), fill=DIM, anchor="ls")

    # the largest size at which the title fits in four lines; truncate if even the smallest doesn't
    for size in (72, 64, 56, 50, 44):
        f = font(SERIF, size)
        lines = wrap(d, title, f, text_w)
        if len(lines) <= 4:
            break
    if len(lines) > 4:
        lines = lines[:4]
        lines[3] = lines[3].rstrip(".,;: ") + "…"
    step = round(size * 1.24)
    for i, line in enumerate(lines):
        d.text((MARGIN, 200 + size * .3 + i * step), line, font=f, fill=TEXT, anchor="ls")

    x = MARGIN
    if swatch:
        r, g, b = hex_rgb(swatch)
        light = tuple(min(255, int(c * 1.9)) for c in (r, g, b))  # same lift as the legend swatches on the site
        d.rounded_rectangle((x, 523, x + 18, 541), radius=3, fill=light)
        x += 34
    d.text((x, 541), footer, font=font(MONO, 26), fill=DIM, anchor="ls")

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, quality=86, optimize=True, progressive=True)
