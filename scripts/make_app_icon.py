"""
Generate the Android launcher icon.

Kept in the repo rather than done once by hand, because an icon gets tweaked:
a colour is wrong on a dark home screen, a shape is muddy at 48px. Re-running
this regenerates every density consistently, which is not something you get
from editing five PNGs by hand.

WHAT IT DRAWS: two pipe runs, each turning twice with a gate valve in line,
drawn as lines — a piping isometric IS a line drawing, and at icon size a shaded tube
spends all its detail on looking like a tube instead of showing where the pipe
goes. The job is commercial pipeline construction, and
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
FAVICON = os.path.join(HERE, '..', 'frontend', 'public', 'favicon.svg')

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

# An adaptive icon is a 108dp canvas of which only the central 72dp survives —
# the outer 18dp on every side is cropped whatever mask the launcher uses. The
# art is scaled to sit inside that with a little air, because a route that runs
# to the very edge of the circle looks like it was cropped by accident.
CANVAS = 108.0
SAFE = 64.0

LEGACY = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


# The three isometric axes, in screen space with y pointing down. Every run
# follows one of these — that is what makes a drawing read as an isometric
# rather than as bent tubing.
ISO_UP_RIGHT = (0.866, -0.5)
ISO_DOWN_RIGHT = (0.866, 0.5)
ISO_UP = (0.0, -1.0)

# How far the valve body reaches along the run. The pipe stops here on each
# side and the bowtie spans the gap.
WEIGHT = 6.0
VALVE_LEN = 5.6
VALVE_HT = 6.4
# The run is cut this far out, not at the valve body itself: the stroke has a
# round cap, and cutting flush lets that cap reach half its width INTO the
# triangle and fill the notch. One side ends up blunt and the other sharp, and
# the bowtie looks lopsided for a reason that is not obvious at all.
VALVE_CUT = VALVE_LEN + WEIGHT / 2


def _routes() -> tuple[list[list[tuple[float, float]]], list[tuple]]:
    """
    Two runs, each turning twice, with a gate valve in line on both.

    Returns the paths and the valve placements. Drawn as lines rather than as
    rendered tubes, a route can carry this much: two elbows each and a valve
    apiece would have been mush as solid pipe, and is legible as line work.

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

    # Run, riser, run. Two turns is what makes it a route rather than a bend,
    # and the offset between the two ends is what shows the riser did something.
    legs = [(ISO_UP_RIGHT, 36), (ISO_UP, 20), (ISO_UP_RIGHT, 36)]
    spacing = 27.0
    offset = (ISO_DOWN_RIGHT[0] * spacing, ISO_DOWN_RIGHT[1] * spacing)

    upper = walk((0.0, 0.0), legs)
    lower = walk(offset, legs)
    paths = [upper, lower]

    def on_leg(path, leg, t):
        """A point `t` of the way along one leg, with that leg's index and axis."""
        (x0, y0), (x1, y1) = path[leg], path[leg + 1]
        return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t), legs[leg][0], leg

    # Mid-leg on the two legs that are furthest apart: the upper run's
    # approach and the lower run's outgoing. Put them on the inner legs and
    # both valves land in the middle of the frame, on top of the elbows and on
    # top of each other — which is exactly what the first attempt did.
    valves = [on_leg(upper, 0, 0.5), on_leg(lower, 2, 0.5)]

    xs = [x for path in paths for x, _ in path]
    ys = [y for path in paths for _, y in path]
    dx = 54.0 - (min(xs) + max(xs)) / 2
    dy = 54.0 - (min(ys) + max(ys)) / 2

    paths = [[(x + dx, y + dy) for x, y in path] for path in paths]
    valves = [((x + dx, y + dy), axis, leg) for (x, y), axis, leg in valves]

    # Cut each run either side of its valve. Drawn over an unbroken line the
    # bowtie reads as a star — the line contributes two more points to the four
    # the triangles already have. A valve body interrupts the pipe on a real
    # isometric, and interrupting it here is also what makes it legible.
    cut = []
    for path, ((vx, vy), axis, leg) in zip(paths, valves):
        back = (vx - axis[0] * VALVE_CUT, vy - axis[1] * VALVE_CUT)
        fwd = (vx + axis[0] * VALVE_CUT, vy + axis[1] * VALVE_CUT)
        cut.append(path[:leg + 1] + [back])
        cut.append([fwd] + path[leg + 1:])

    return cut, [(pt, axis) for pt, axis, _ in valves]


def _valve(draw: ImageDraw.ImageDraw, point: tuple[float, float],
           axis: tuple[float, float], half_len: float, half_ht: float,
           colour) -> None:
    """
    A gate valve: two triangles meeting at a point on the centreline.

    The bowtie is the symbol every piping drawing uses, and it is the only
    fitting that stays recognisable when it is four pixels across — a flange
    or a tee is a line at that size, which is to say nothing at all.
    """
    x, y = point
    dx, dy = axis
    nx, ny = -dy, dx      # across the run

    def corner(along, across):
        return (x + dx * along + nx * across, y + dy * along + ny * across)

    draw.polygon([corner(-half_len, -half_ht), corner(-half_len, half_ht),
                  (x, y)], fill=colour)
    draw.polygon([corner(half_len, -half_ht), corner(half_len, half_ht),
                  (x, y)], fill=colour)


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
    The routing, drawn as lines.

    WHY LINES AND NOT RENDERED PIPE: a piping isometric IS a line drawing, and
    at icon size a shaded tube spends all its detail on looking like a tube
    instead of on showing where the pipe goes. Thin strokes leave room for the
    turns and the valves, which are the parts that say "system" rather than
    "length of pipe".

    One stroke with round joins IS the run, elbows included — separately drawn
    segments leave a seam at every corner that nothing hides.
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    u = size / CANVAS

    paths, valves = _routes()
    weight = WEIGHT * u     # line work, not a rendered tube

    for path in paths:
        pts = [(x * u, y * u) for x, y in path]
        draw.line(pts, fill=AMBER, width=max(1, int(round(weight))), joint='curve')
        # joint='curve' rounds the corners but leaves the ends square, which on
        # a thin line reads as a nick rather than a cut end.
        r = weight / 2
        for x, y in (pts[0], pts[-1]):
            draw.ellipse([x - r, y - r, x + r, y + r], fill=AMBER)

    for (x, y), axis in valves:
        _valve(draw, (x * u, y * u), axis, VALVE_LEN * u, VALVE_HT * u, AMBER)

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


def write_favicon(path: str) -> None:
    """
    The browser tab icon, emitted from the same route data as the PNGs.

    Hand-writing the SVG to match meant keeping two sets of coordinates in
    step, and they drifted the first time the route changed. Generating it
    removes the chance.
    """
    paths, valves = _routes()

    out = [
        '<!--',
        '  Daily Reporter — browser tab icon.',
        '',
        '  GENERATED by scripts/make_app_icon.py. Do not edit by hand: change the',
        '  route there and re-run, or this and the launcher icon drift apart.',
        '',
        '  Two pipe runs turning twice, with a gate valve in line on each. Drawn',
        '  as line work, which is what a piping isometric is.',
        '-->',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">',
        f'  <rect width="108" height="108" rx="24" fill="{_hex(SLATE)}"/>',
        f'  <g fill="none" stroke="{_hex(AMBER)}" stroke-width="{WEIGHT:g}"'
        ' stroke-linecap="round" stroke-linejoin="round">',
    ]
    for run in paths:
        pts = ' '.join(f'{x:.2f},{y:.2f}' for x, y in run)
        out.append(f'    <polyline points="{pts}"/>')
    out.append('  </g>')

    for (vx, vy), axis in valves:
        dx, dy = axis
        nx, ny = -dy, dx

        def corner(along, across):
            return (vx + dx * along + nx * across, vy + dy * along + ny * across)

        for sign in (-1, 1):
            a = corner(sign * VALVE_LEN, -VALVE_HT)
            b = corner(sign * VALVE_LEN, VALVE_HT)
            pts = f'{a[0]:.2f},{a[1]:.2f} {b[0]:.2f},{b[1]:.2f} {vx:.2f},{vy:.2f}'
            out.append(f'  <polygon points="{pts}" fill="{_hex(AMBER)}"/>')

    out.append('</svg>')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')

def _hex(rgba) -> str:
    return '#%02X%02X%02X' % rgba[:3]


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

    write_favicon(FAVICON)
    written += 1

    print(f'wrote {written} files under {os.path.normpath(RES)}')


if __name__ == '__main__':
    main()
