import sys
from PIL import Image, ImageDraw, ImageFont
OUT = sys.argv[1]
BG0, BG1 = (10, 11, 14), (18, 22, 32)
FG, AMBER, LINE = (217, 221, 228), (245, 166, 35), (43, 49, 60)
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

def bg(w, h):
    im = Image.new("RGB", (w, h), BG0)
    d = ImageDraw.Draw(im)
    for y in range(h):  # vertical gradient, top lighter (like the command bar)
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(BG1[i] * (1 - t) + BG0[i] * t) for i in range(3)))
    return im

def mark(im, cx, cy, size):
    """'AZ' in the terminal's mono, the amber degree sign of the brand, and an amber prompt cursor underneath."""
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(BOLD, int(size * 0.46))
    txt = "AZ"
    bb = d.textbbox((0, 0), txt, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x, y = cx - tw / 2 - bb[0], cy - th / 2 - bb[1] - size * 0.05
    d.text((x, y), txt, font=f, fill=FG)
    # degree sign, top right of the Z
    r = size * 0.045
    ox, oy = cx + tw / 2 + size * 0.07, cy - th / 2 - size * 0.03
    d.ellipse([ox - r, oy - r, ox + r, oy + r], outline=AMBER, width=max(2, int(size * 0.022)))
    # prompt line: ">" and a block cursor
    fy = cy + th / 2 + size * 0.09
    fs = ImageFont.truetype(BOLD, int(size * 0.16))
    gb = d.textbbox((0, 0), ">", font=fs)
    gx = cx - tw / 2
    d.text((gx - gb[0], fy - gb[1]), ">", font=fs, fill=AMBER)
    cw, ch = size * 0.075, size * 0.13
    bx = gx + (gb[2] - gb[0]) + size * 0.05
    d.rectangle([bx, fy, bx + cw, fy + ch], fill=AMBER)
    d.line([(bx + cw + size * 0.06, fy + ch), (cx + tw / 2, fy + ch)], fill=LINE, width=max(1, int(size * 0.012)))

def icon(px, scale=1.0, name=None):
    im = bg(px, px)
    mark(im, px / 2, px / 2, px * scale)
    im.save(f"{OUT}/{name}", optimize=True)

icon(180, 1.0, "icon-180.png")      # apple-touch-icon (iOS rounds the corners itself)
icon(192, 1.0, "icon-192.png")
icon(512, 1.0, "icon-512.png")
icon(512, 0.74, "icon-maskable-512.png")  # inside the 80% safe zone
icon(32, 1.0, "icon-32.png")

# iOS launch images (portrait): CSS size, pixel ratio
LAUNCH = [(440, 956, 3), (402, 874, 3), (420, 912, 3), (393, 852, 3), (430, 932, 3), (390, 844, 3), (375, 812, 3), (414, 896, 3), (414, 896, 2), (375, 667, 2)]
for w, h, r in LAUNCH:
    W, H = w * r, h * r
    im = bg(W, H)
    mark(im, W / 2, H / 2 - H * 0.04, W * 0.42)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(BOLD, int(W * 0.034))
    t = "ALESSANDRO  TERMINAL"
    bb = d.textbbox((0, 0), t, font=f)
    d.text((W / 2 - (bb[2] - bb[0]) / 2 - bb[0], H / 2 + H * 0.12), t, font=f, fill=(115, 123, 136))
    im.save(f"{OUT}/launch-{W}x{H}.png", optimize=True)
print("ok")
