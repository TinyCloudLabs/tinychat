#!/usr/bin/env python3
"""Generate Exo's app icons and splash screens for Android and iOS from one brand mark.

Source: mobile/assets/tinycloud-mark.png, the TinyCloud cloud mark (TinyCloudLabs/docs logo/tinycloud-icon.png,
cropped to its content). Exo has no designed mark of its own yet; replace that file (keep a transparent background,
roughly 3:2) and rerun to rebrand every size at once.

Writes (every path is already wired, so nothing else changes):
  Android  res/mipmap-*/ic_launcher_foreground.png   adaptive-icon foreground (mipmap-anydpi-v26/ic_launcher*.xml,
                                                      background @color/ic_launcher_background)
           res/mipmap-*/ic_launcher.png, ic_launcher_round.png   legacy icons for API 24-25
           res/drawable*/splash.png                  pre-Android 12 launch background (Android 12+ draws the system
                                                      splash from styles.xml: brand color + adaptive foreground)
  iOS      Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png   1024 px, opaque (App Store rejects alpha)
           Assets.xcassets/Splash.imageset/splash-2732x2732*.png
  Store    mobile/assets/play-store-icon.png         512 px Play Console listing icon, 32-bit RGBA PNG (not bundled)

Needs Pillow (`python3 -m pip install pillow`). Run from anywhere: python3 mobile/scripts/brand-assets.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parent.parent
RES = MOBILE / "android/app/src/main/res"
XCASSETS = MOBILE / "ios/App/App/Assets.xcassets"

# TinyCloud brand blue (the background of the TinyCloud app icon, js-sdk documentation/static/img/logo512.png).
# Keep in sync with res/values/ic_launcher_background.xml and exo_brand in res/values/colors.xml.
BRAND = (0x44, 0x73, 0xB9)

mark = Image.open(MOBILE / "assets/tinycloud-mark.png").convert("RGBA")


def place_mark(canvas: Image.Image, width_ratio: float) -> Image.Image:
    """Paste the mark centered on `canvas`, scaled to `width_ratio` of the canvas's shorter side."""
    w, h = canvas.size
    target_w = round(min(w, h) * width_ratio)
    target_h = round(mark.height * target_w / mark.width)
    scaled = mark.resize((target_w, target_h), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((w - target_w) // 2, (h - target_h) // 2))
    return canvas


def solid(size: tuple[int, int]) -> Image.Image:
    return Image.new("RGBA", size, BRAND + (255,))


def masked(icon: Image.Image, shape: str) -> Image.Image:
    """Clip a square icon to a rounded square or a circle, anti-aliased by drawing the mask at 4x."""
    n = icon.width
    big = n * 4
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    inset = round(big * 0.04)  # Material legacy icons keep a small margin inside the 48dp square
    box = (inset, inset, big - inset - 1, big - inset - 1)
    if shape == "circle":
        draw.ellipse(box, fill=255)
    else:
        draw.rounded_rectangle(box, radius=round(big * 0.18), fill=255)
    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask.resize((n, n), Image.LANCZOS))
    return out


def save(image: Image.Image, path: Path, opaque: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    (image.convert("RGB") if opaque else image).save(path, optimize=True)
    print(f"{path.relative_to(MOBILE)} {image.width}x{image.height}")


# Master square icon: the mark at 64% of the width on brand blue. Every launcher icon is downscaled from it.
MASTER = place_mark(solid((1024, 1024)), 0.64)

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for density, scale in DENSITIES.items():
    # Adaptive foreground: 108dp canvas, launchers show at most the central 72dp and masks may cut to a 66dp circle.
    # At 50% of the canvas the mark's bounding box stays inside that circle.
    fg = round(108 * scale)
    save(place_mark(Image.new("RGBA", (fg, fg), (0, 0, 0, 0)), 0.50), RES / f"mipmap-{density}/ic_launcher_foreground.png")
    legacy = round(48 * scale)
    base = MASTER.resize((legacy, legacy), Image.LANCZOS)
    save(masked(base, "rounded"), RES / f"mipmap-{density}/ic_launcher.png")
    save(masked(base, "circle"), RES / f"mipmap-{density}/ic_launcher_round.png")

# Pre-Android 12 splash: drawn as the launch window background, so keep each file's existing size and orientation.
SPLASHES = {
    "drawable": (480, 320),
    "drawable-land-mdpi": (480, 320), "drawable-land-hdpi": (800, 480), "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960), "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (320, 480), "drawable-port-hdpi": (480, 800), "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600), "drawable-port-xxxhdpi": (1280, 1920),
}
for folder, size in SPLASHES.items():
    save(place_mark(solid(size), 0.30), RES / f"{folder}/splash.png", opaque=True)

save(MASTER, XCASSETS / "AppIcon.appiconset/AppIcon-512@2x.png", opaque=True)
# LaunchScreen.storyboard aspect-fills this square, so a phone shows only its central vertical strip.
ios_splash = place_mark(solid((2732, 2732)), 0.22)
for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
    save(ios_splash, XCASSETS / f"Splash.imageset/{name}", opaque=True)

# Play Console wants a 32-bit PNG (RGBA) for the listing icon; MASTER is RGBA and fully opaque, so keep its alpha channel.
save(MASTER.resize((512, 512), Image.LANCZOS), MOBILE / "assets/play-store-icon.png")
