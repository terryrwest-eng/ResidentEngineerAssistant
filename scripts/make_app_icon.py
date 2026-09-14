"""
Generate the Android launcher icon.

Kept in the repo rather than done once by hand, because an icon gets tweaked:
a colour is wrong on a dark home screen, a shape is muddy at 48px. Re-running
this regenerates every density consistently, which is not something you get
from editing five PNGs by hand.

WHAT IT DRAWS: two runs of pipe coming in along one isometric axis and turning
up together. The job is commercial pipeline construction, and
a piping isometric is what that work looks like on paper. One line is a length
of pipe; two running together with laterals is a system. Safety amber on
engineering slate.

THREE VERSIONS WERE WRONG BEFORE THIS ONE, all of which looked fine as an idea:
  - a clipboard with a voice waveform: the bars read as drips off a shower head
  - a hard hat: the elliptical brim made it a sun hat, and a hat does not say
    which trade
  - a single tilted cylinder: a paper towel roll. One tube with no route is
    not piping.
What fixed it was the ROUTE. Two elbows and a change of direction is the thing
that says pipeline, and no amount of shading on a lone cylinder gets there.

    python3 scripts/make_app_icon.py

Everything is drawn 8x and downsampled, so the curves stay clean without
needing an SVG rasteriser on the machine.
"""

import math
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

# Adaptive icons are 108dp, of which the mask keeps about 72dp. Art stays inside
# that. 66dp is the strict safe circle, but drawing to it looks timid next to
# everything else on a home screen.
CANVAS = 108.0
SAFE = 74.0

LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


# The three isometric axes, in screen space with y pointing down. Every run
# follows one of these — that is what makes a drawing read as an isometric
# rather than as bent tubing.
ISO_UP_RIGHT = (0.866, -0.5)
ISO_DOWN_RIGHT = (0.866, 0.5)
ISO_UP = (0.0, -1.0)


def _routes() -> list[list[tuple[float, float]]]:
    """
    Two runs coming in along one isometric axis and turning up together.

    HOW MUCH FITS AT 48px is the whole constraint. An earlier version ran two
    parallel headers with branches dropping off both; at icon size the runs
    fused into a blob and the branches read as feet. Two lines and one elbow
    each is the most this holds.

    The pair is offset along the OTHER horizontal axis, not straight down, so
    they sit side by side in the same plane like pipes in a rack — offset
    vertically they would share an x and their risers would collide.
    """
    def walk(start, legs):
        pts = [start]
        for axis, length in legs:
            x, y = pts[-1]
            pts.append((x + axis[0] * length, y + axis[1] * length))
        return pts

    # A long approach and a shorter riser. Even legs read as two boots; the
    # run has to dominate for the turn to look like a turn.
    legs = [(ISO_UP_RIGHT, 38), (ISO_UP, 21)]
    spacing = 27.0
    offset = (ISO_DOWN_RIGHT[0] * spacing, ISO_DOWN_RIGHT[1] * spacing)

    paths = [
        walk((0.0, 0.0), legs),
        walk(offset, legs),
    ]

    xs = [x for path in paths for x, _ in path]
    ys = [y for path in paths for _, y in path]
    dx = 54.0 - (min(xs) + max(xs)) / 2
    dy = 54.0 - (min(ys) + max(ys)) / 2
    return [[(x + dx, y + dy) for x, y in path] for path in paths]


def _open_end(img: Image.Image, point: tuple[float, float],
              axis: tuple[float, float], dia: float) -> None:
    """
    The bore at a cut end, drawn square to the run.

    A pipe end seen at an angle is an ellipse whose short axis lies along the
    run — so it is drawn that way flat and rotated onto the run's angle, which
    is easier to get right than solving for the ellipse in place.
    """
    x, y = point
    box = int(dia * 2)
    layer = Image.new('RGBA', (box, box), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = box / 2
    along = dia * 0.16      # foreshortened along the run
    across = dia * 0.30     # the bore across it
    d.ellipse([c - along, c - across, c + along, c + across], fill=BORE)

    # Screen y points down, so the run's angle above horizontal negates it.
    angle = math.degrees(math.atan2(-axis[1], axis[0]))
    layer = layer.rotate(angle, resample=Image.BICUBIC, center=(c, c))
    img.alpha_composite(layer, (int(x - c), int(y - c)))


def _pipe_layer(size: int) -> Image.Image:
    """
    Two runs of pipe following an isometric routing.

    WHY POLYLINES AND NOT CYLINDERS: joining separately drawn cylinders at an
    elbow leaves a seam that no amount of fiddling hides. One thick stroke with
    round joins IS the run, elbows included, and a round join is the right
    shape for a long-radius bend anyway.

    The back run is drawn first and carries a slate outline, so where the two
    cross the front one reads as being in front instead of the pair merging
    into one shape.
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    u = size / CANVAS

    routes = _routes()
    dia = 13.0 * u
    drop = 2.6 * u
    gap = 3.2 * u          # the dark separation between the two runs

    def stroke(path, width, colour, dy=0.0):
        pts = [(x * u, y * u + dy) for x, y in path]
        draw.line(pts, fill=colour, width=max(1, int(width)), joint='curve')
        # joint='curve' rounds the corners but leaves the ends square, which
        # makes a run look sawn off rather than continuing.
        for x, y in (pts[0], pts[-1]):
            draw.ellipse([x - width / 2, y - width / 2,
                          x + width / 2, y + width / 2], fill=colour)

    # Back run first, complete, then a slate outline under the front one so the
    # two never touch.
    for i, path in enumerate(routes):
        if i == 1:
            stroke(path, dia + gap * 2, SLATE)
        stroke(path, dia, AMBER_DARK, drop)
        stroke(path, dia, AMBER)

    for path in routes:
        _open_end(img, (path[0][0] * u, path[0][1] * u), ISO_UP_RIGHT, dia)

    return img


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
