#!/usr/bin/env python3
"""Generate the ComicTranslate toolbar icons - pure stdlib, no Pillow.

Design: indigo rounded square, white speech bubble, letter "A" (dark indigo)
and the hanzi 文 (rose) inside - the classic translation iconography.

The scene is an analytic function of (x, y): rounded-rect and segment
distance tests with smooth edge falloff, 4x4 supersampled per pixel for
antialiasing. Spinner frames are NOT generated here: the background page
draws those on the fly with canvas arcs (browser.action.setIcon + ImageData).

  python3 tools/make_icons.py          # writes assets/icons/*.png + previews
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "icons")

INDIGO_TOP = (99, 102, 241)     # #6366F1
INDIGO_BOT = (67, 56, 202)      # #4338CA
WHITE = (255, 255, 255)
INK = (30, 27, 75)              # #1E1B4B
ROSE = (225, 29, 72)            # #E11D48


def sd_round_rect(x, y, cx, cy, hw, hh, r):
    """Signed distance to a rounded rectangle (negative inside)."""
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    ox = max(dx, 0.0)
    oy = max(dy, 0.0)
    return math.hypot(ox, oy) + min(max(dx, dy), 0.0) - r


def sd_segment(px, py, ax, ay, bx, by):
    """Distance from point to segment."""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    if L2 <= 0.0:
        return math.hypot(wx, wy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def cov(d, px):
    """Smooth 1px-wide edge coverage for a signed distance."""
    return max(0.0, min(1.0, 0.5 - d / px))


def stroke(x, y, segs, px):
    """Coverage of a polyline drawn with per-segment half-thicknesses."""
    a = 0.0
    for (ax, ay, bx, by, th) in segs:
        a = max(a, cov(sd_segment(x, y, ax, ay, bx, by) - th / 2.0, px))
    return a


def glyph_a(cx):
    """Letter A as three strokes."""
    ax, top, foot, th = cx, 0.315, 0.615, 0.055
    lx, rx = cx - 0.105, cx + 0.105
    bar_y = 0.525
    t = (bar_y - top) / (foot - top)
    bl, br = cx - 0.105 * t, cx + 0.105 * t
    return [
        (ax, top, lx, foot, th),
        (ax, top, rx, foot, th),
        (bl, bar_y, br, bar_y, th * 0.85),
    ]


def glyph_wen():
    """文: dot + horizontal bar + crossing diagonals."""
    return [
        (0.645, 0.315, 0.690, 0.318, 0.050),   # the dot, laid flat
        (0.560, 0.405, 0.780, 0.405, 0.050),   # horizontal bar
        (0.575, 0.460, 0.765, 0.670, 0.052),   # left-falling stroke
        (0.765, 0.460, 0.575, 0.670, 0.052),   # right-falling stroke
    ]


def sample_scene(u, v, px):
    # 1. background rounded square with a vertical gradient
    d_bg = sd_round_rect(u, v, 0.5, 0.5, 0.5, 0.5, 0.18)
    a_bg = cov(d_bg, px)
    if a_bg <= 0.0:
        return (0, 0, 0, 0)
    t = max(0.0, min(1.0, v))
    r = INDIGO_TOP[0] + (INDIGO_BOT[0] - INDIGO_TOP[0]) * t
    g = INDIGO_TOP[1] + (INDIGO_BOT[1] - INDIGO_TOP[1]) * t
    b = INDIGO_TOP[2] + (INDIGO_BOT[2] - INDIGO_TOP[2]) * t
    col = [r, g, b]

    # 2. speech bubble: rounded body + triangular tail
    a_bub = cov(sd_round_rect(u, v, 0.5, 0.46, 0.33, 0.235, 0.075), px)
    # tail: point-in-triangle via three half-plane tests, then feather the
    # edges by testing slightly shrunken/expanded triangles.
    ax, ay = 0.30, 0.67
    bx, by = 0.46, 0.66
    cxx, cyy = 0.30, 0.86

    def half(p, q, x, y):
        return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])

    e1 = half((ax, ay), (bx, by), u, v)
    e2 = half((bx, by), (cxx, cyy), u, v)
    e3 = half((cxx, cyy), (ax, ay), u, v)
    margin = (abs(e1) < 0.008 or abs(e2) < 0.008 or abs(e3) < 0.008)
    inside = ((e1 >= 0 and e2 >= 0 and e3 >= 0) or
              (e1 <= 0 and e2 <= 0 and e3 <= 0))
    if inside:
        a_bub = 1.0
    elif margin:
        a_bub = max(a_bub, 0.5)
    if a_bub > 0.0:
        col[0] += (WHITE[0] - col[0]) * a_bub
        col[1] += (WHITE[1] - col[1]) * a_bub
        col[2] += (WHITE[2] - col[2]) * a_bub

    # 3. glyphs on top of the bubble
    a_a = stroke(u, v, glyph_a(0.335), px)
    if a_a > 0.0:
        col[0] += (INK[0] - col[0]) * a_a
        col[1] += (INK[1] - col[1]) * a_a
        col[2] += (INK[2] - col[2]) * a_a
    a_w = stroke(u, v, glyph_wen(), px)
    if a_w > 0.0:
        col[0] += (ROSE[0] - col[0]) * a_w
        col[1] += (ROSE[1] - col[1]) * a_w
        col[2] += (ROSE[2] - col[2]) * a_w

    return (int(col[0]), int(col[1]), int(col[2]), int(255 * a_bg))


def render(size, ss=4):
    """RGBA rows with 4x4 supersampling."""
    px = 1.0 / (size * ss)
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) / size
                    v = (y + (sy + 0.5) / ss) / size
                    cr, cg, cb, ca = sample_scene(u, v, px)
                    r += cr
                    g += cg
                    b += cb
                    a += ca
            n = ss * ss
            row += bytes((r // n, g // n, b // n, a // n))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    """Minimal RGBA PNG writer (color type 6, one filter-0 row per line)."""
    def chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body +
                struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + row for row in rows)
    payload = (b"\x89PNG\r\n\x1a\n" +
               chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
               chunk(b"IDAT", zlib.compress(raw, 9)) +
               chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(payload)


SHADES = " .:-=+*#%@"


def preview(size=48, ss=2):
    """Coarse ASCII render so the shape can be eyeballed in a terminal."""
    px = 1.0 / (size * ss)
    out = []
    for y in range(0, size, 2):
        line = ""
        for x in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) / size
                    v = (y + (sy + 0.5) / ss) / size
                    cr, cg, cb, ca = sample_scene(u, v, px)
                    r += cr
                    g += cg
                    b += cb
                    a += ca
            n = ss * ss
            if a // n < 32:
                line += " "
            else:
                lum = (r // n + g // n + b // n) // 3
                line += SHADES[min(9, max(1, 9 - lum * 9 // 255))]
        out.append(line)
    return "\n".join(out)


def main():
    os.makedirs(OUT, exist_ok=True)
    rows96 = render(96)
    for size in (32, 48, 96, 128):
        rows = rows96 if size == 96 else render(size)
        path = os.path.join(OUT, "icon-%d.png" % size)
        write_png(path, size, rows)
        print("wrote", path)
    print()
    print(preview())


if __name__ == "__main__":
    main()