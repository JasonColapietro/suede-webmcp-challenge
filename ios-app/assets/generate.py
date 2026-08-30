#!/usr/bin/env python3
"""Generate icon-only.png (1024) + splash.png (2732) for Suede Agent Studio iOS.

Extracts the Suede chrome "S" mark at high res from the approved 1024px brand
JPEG (white mark on dark grid), then composes:
  - icon:   white/chrome mark on an indigo gradient field (#4f46e5 family)
  - splash: indigo mark on white, matching the bright editorial site theme
Run: python3 generate.py  (from ios-app/assets/)
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = "/Users/jason/Suede Assets/01 Brand Assets/Logos/Additional Logos/SuedeAI logo transparent.png"
INDIGO = (79, 70, 229)        # --primary #4f46e5
INDIGO_DEEP = (61, 53, 197)   # toward #4338ca
INDIGO_LIGHT = (99, 91, 240)


def extract_mark_mask() -> Image.Image:
    """Mark shape from the approved transparent PNG's alpha, upscale-refined:
    supersample -> blur -> sigmoid curve -> vector-crisp edges at any size."""
    alpha = Image.open(SRC).convert("RGBA").split()[3]
    alpha = alpha.crop(alpha.getbbox())
    big = alpha.resize((alpha.width * 10, alpha.height * 10), Image.LANCZOS)
    big = big.filter(ImageFilter.GaussianBlur(14))

    def sigmoid(v: int) -> int:
        t = (v - 128) / 18.0
        return int(255 / (1 + 2.718281828 ** (-t)))

    return big.point(sigmoid)


def vertical_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        grad.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    return grad.resize((size, size))


def tinted_mark(mask: Image.Image, width: int, top: tuple, bottom: tuple) -> Image.Image:
    """Mark filled with a subtle vertical gradient, alpha = mask."""
    ratio = width / mask.width
    size = (width, int(mask.height * ratio))
    m = mask.resize(size, Image.LANCZOS)
    fill = Image.new("RGB", (1, size[1]))
    for y in range(size[1]):
        t = y / (size[1] - 1)
        fill.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    fill = fill.resize(size)
    out = fill.convert("RGBA")
    out.putalpha(m)
    return out


def make_icon() -> None:
    S = 1024
    base = vertical_gradient(S, INDIGO_LIGHT, INDIGO_DEEP).convert("RGBA")
    # soft radial lift behind the mark for depth
    glow = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(glow)
    d.ellipse((S * 0.18, S * 0.14, S * 0.82, S * 0.78), fill=46)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    lift = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    lift.putalpha(glow)
    base.alpha_composite(lift)

    mask = extract_mark_mask()
    mark = tinted_mark(mask, int(S * 0.62), (255, 255, 255), (224, 226, 240))
    # subtle drop shadow for the chrome read
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sh = mark.split()[3].point(lambda v: v // 3)
    shadow.paste((28, 24, 90, 255), ((S - mark.width) // 2, (S - mark.height) // 2 + 14), sh)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base.alpha_composite(shadow)
    base.alpha_composite(mark, ((S - mark.width) // 2, (S - mark.height) // 2))
    base.convert("RGB").save("icon-only.png")
    print("icon-only.png", base.size)


def make_splash() -> None:
    S = 2732
    splash = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    mask = extract_mark_mask()
    mark = tinted_mark(mask, 400, INDIGO, INDIGO_DEEP)
    splash.alpha_composite(mark, ((S - mark.width) // 2, (S - mark.height) // 2))
    splash.convert("RGB").save("splash.png")
    print("splash.png", splash.size)


if __name__ == "__main__":
    make_icon()
    make_splash()
