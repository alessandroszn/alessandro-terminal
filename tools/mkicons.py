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
    """The terminal's prompt with the initials, on one line: an amber '>', 'AZ' in the terminal's mono, an amber block cursor."""
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(BOLD, int(size * 0.36))
    b1, b2 = d.textbbox((0, 0), ">", font=f), d.textbbox((0, 0), "AZ", font=f)
    w1, w2, th = b1[2] - b1[0], b2[2] - b2[0], b2[3] - b2[1]
    cw, gap = size * 0.11, size * 0.04
    x, top = cx - (w1 + gap + w2 + gap + cw) / 2, cy - th / 2
    d.text((x - b1[0], top - b2[1]), ">", font=f, fill=AMBER)
    x += w1 + gap
    d.text((x - b2[0], top - b2[1]), "AZ", font=f, fill=FG)
    x += w2 + gap
    d.rectangle([x, top + th * 0.08, x + cw, top + th], fill=AMBER)

def icon(px, scale=1.0, name=None):
    im = bg(px, px)
    mark(im, px / 2, px / 2, px * scale)
    im.save(f"{OUT}/{name}", optimize=True)

icon(180, 1.0, "icon-180.png")      # apple-touch-icon (iOS rounds the corners itself)
icon(192, 1.0, "icon-192.png")
icon(512, 1.0, "icon-512.png")
icon(512, 0.74, "icon-maskable-512.png")  # inside the 80% safe zone
# the browser tab's icon (22 Oct 2026, the look of Nico's): an amber ">" on black, as the SVG in the pages' <link rel="icon">
def tab_icon(px, name):
    S = 8  # drawn 8x larger, then reduced: smooth edges
    im = Image.new("RGB", (px * S, px * S), (0, 0, 0))
    d = ImageDraw.Draw(im)
    k = px * S / 64  # the SVG's 64-unit grid: M10 22 L38 35 L10 48, stroke 6
    d.line([(10 * k, 22 * k), (38 * k, 35 * k), (10 * k, 48 * k)], fill=AMBER, width=round(6 * k), joint="curve")
    im.resize((px, px), Image.LANCZOS).save(f"{OUT}/{name}", optimize=True)

tab_icon(32, "icon-32.png")

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
