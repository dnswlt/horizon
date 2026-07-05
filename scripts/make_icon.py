"""Regenerate static/favicon.ico (the Windows .exe icon) from favicon.svg.

Run via `make icon` whenever the SVG favicon changes. The .ico is a committed
source asset that PyInstaller bakes into Horizon.exe (see build.bat).

Requires:
  - rsvg-convert  (macOS: `brew install librsvg`)
  - Pillow        (`pip install pillow`)
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SVG = REPO / "static" / "favicon.svg"
ICO = REPO / "static" / "favicon.ico"

# Sizes Windows may render (taskbar, Explorer, alt-tab, high-DPI).
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    if shutil.which("rsvg-convert") is None:
        sys.exit("rsvg-convert not found. Install it with: brew install librsvg")
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow not found. Install it with: pip install pillow")

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        png = Path(tmp.name)
    try:
        # Rasterize the vector source large, then let Pillow build every slot
        # from that crisp master so small sizes stay sharp.
        subprocess.run(
            ["rsvg-convert", "-w", "256", "-h", "256", str(SVG), "-o", str(png)],
            check=True,
        )
        Image.open(png).convert("RGBA").save(ICO, format="ICO", sizes=SIZES)
    finally:
        png.unlink(missing_ok=True)

    print(f"wrote {ICO.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
