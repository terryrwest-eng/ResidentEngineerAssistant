"""
Generate the Android launcher icon.

Kept in the repo rather than done once by hand, because an icon gets tweaked:
a colour is wrong on a dark home screen, a shape is muddy at 48px. Re-running
this regenerates every density consistently, which is not something you get
from editing five PNGs by hand.

WHAT IT DRAWS: a length of large-diameter pipe, laid on the diagonal with the
bore facing the viewer. The job is commercial pipeline construction, and pipe
is the one thing on that site nobody mistakes for anything else. Safety amber
on engineering slate.

WHY NOT A HARD HAT: it was the first attempt. At icon size a hard hat with an
elliptical brim reads as a sun hat, and a hat only says "construction" — the
pipe says which trade.

WHY THE DIAGONAL: a horizontal cylinder reads as a battery or a pill. The tilt
makes it a length of something running through the frame, and it fills a square
tile far better than a flat bar does.

    python3 scripts/make_app_icon.py

Everything is drawn 8x and downsampled, so the curves stay clean without
needing an SVG rasteriser on the machine.
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, '..', 'frontend', 'android', 'app', 'src', 'main', 'res')

# Engineering slate and safety amber. The slate is dark enough to hold its own
# on a white home screen and light enough not to vanish on a black one.
SLATE = (19, 42, 62, 255)
AMBER = (245, 158, 11, 255)
AMBER_DARK = (201, 114, 5, 255)    # the shaded underside of the pipe
# A shade off the background rather than the background itself, so the bore
# still reads as a hole once the adaptive icon is composited onto its own
# background colour.
BORE = (12, 28, 42, 255)

SS = 8          # supersample factor
TILT = 27.0     # degrees

# Adaptive icons are 108dp, of which the mask keeps about 72dp. Art stays inside
# that. 66dp is the strict safe circle, but drawing to it looks timid next to
# everything else on a home screen.
CANVAS = 108.0
SAFE = 74.0

LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


def _pipe_layer(size: int) -> Image.Image:
    """
    The pipe, drawn flat on its own layer and then tilted.

    Drawing it horizontally and rotating is far easier to get right than
    drawing an ellipse on the diagonal, and the rotation happens at 8x so the
    edges come back clean.
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    u = size / CANVAS

    def bbox(x0, y0, x1, y1):
        return [(x0 * u, y0 * u), (x1 * u, y1 * u)]

    # Proportions are doing the work here. A short, thick-walled cylinder reads
    # as a can or a roll of tape; large-diameter pipe is long, and its wall is
    # thin against the bore.
    TOP, BOT = 37.0, 71.0          # outside diameter
    CAP = 18.0                     # how wide the end ellipses read
    LEFT, RIGHT = 12.0, 96.0
    WALL_X, WALL_Y = 4.0, 6.5      # wall thickness at the near end

    # Far end first, so the body covers where the two meet.
    draw.ellipse(bbox(RIGHT - CAP, TOP, RIGHT, BOT), fill=AMBER_DARK)
    # Body.
    draw.rectangle(bbox(LEFT + CAP / 2, TOP, RIGHT - CAP / 2, BOT), fill=AMBER)
    # The underside, so the cylinder has a light direction instead of reading
    # as a flat bar with circles stuck on the ends. Thin: a wide band stops
    # being shading and becomes a painted stripe.
    draw.rectangle(bbox(LEFT + CAP / 2, BOT - 5.5, RIGHT - CAP / 2, BOT), fill=AMBER_DARK)
    # Near end: the wall, then the bore punched through it.
    draw.ellipse(bbox(LEFT, TOP, LEFT + CAP, BOT), fill=AMBER)
    draw.ellipse(bbox(LEFT + WALL_X, TOP + WALL_Y,
                      LEFT + CAP - WALL_X, BOT - WALL_Y), fill=BORE)

    return img.rotate(TILT, resample=Image.BICUBIC, center=(size / 2, size / 2))


def _art(size: int, scale: float) -> Image.Image:
    """The pipe, scaled to `scale` of the tile and centred."""
    layer = _pipe_layer(size * 2)
    target = max(1, int(size * scale))
    layer = layer.resize((target, target), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    off = (size - target) // 2
    out.alpha_composite(layer, (off, off))
    return out


def foreground(size: int) -> Image.Image:
    """The adaptive icon's foreground layer: art only, transparent behind."""
    big = size * SS
    return _art(big, SAFE / CANVAS).resize((size, size), Image.LANCZOS)


def legacy(size: int, round_icon: bool) -> Image.Image:
    """A complete icon for launchers that predate adaptive icons."""
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if round_icon:
        draw.ellipse([0, 0, big - 1, big - 1], fill=SLATE)
    else:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=SLATE)

    # Nothing crops these, so the art can sit larger than the adaptive safe
    # zone — but not so large it touches a rounded corner.
    img.alpha_composite(_art(big, 0.84 if round_icon else 0.90))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    written = 0
    for density, size in FOREGROUND.items():
        foreground(size).save(os.path.join(RES, f'mipmap-{density}', 'ic_launcher_foreground.png'))
        written += 1

    for density, size in LEGACY.items():
        folder = os.path.join(RES, f'mipmap-{density}')
        legacy(size, False).save(os.path.join(folder, 'ic_launcher.png'))
        legacy(size, True).save(os.path.join(folder, 'ic_launcher_round.png'))
        written += 2

    # A flat background colour, which is what the guidelines ask for — a
    # patterned one fights whatever mask the launcher applies over it.
    with open(os.path.join(RES, 'values', 'ic_launcher_background.xml'), 'w', encoding='utf-8') as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<resources>\n'
            '    <color name="ic_launcher_background">#132A3E</color>\n'
            '</resources>\n'
        )
    written += 1

    print(f'wrote {written} files under {os.path.normpath(RES)}')


if __name__ == '__main__':
    main()
