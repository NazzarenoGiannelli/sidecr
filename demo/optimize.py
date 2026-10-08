"""Makes the release PNGs smaller without visible loss.

    python demo/optimize.py [--min-psnr N] docs/media [file.png ...]

Per image: pngquant and oxipng when they are on PATH; otherwise the best of a 256-colour palette made by ffmpeg
(palettegen over all pixels, Sierra dithering) when ffmpeg is on PATH and one made with PIL (median cut,
Floyd-Steinberg), each kept only when it is close enough to the original (PSNR >= MIN_PSNR dB); else the truecolour
image re-saved with the best zlib settings. Prints before and after.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

MIN_PSNR = 44.0


def psnr(a, b):
    a = np.asarray(a.convert("RGB"), np.float32)
    b = np.asarray(b.convert("RGB"), np.float32)
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255.0**2 / mse)


def optimise(p: Path, min_psnr: float):
    before = p.stat().st_size
    if shutil.which("pngquant"):
        subprocess.run(["pngquant", "--force", "--skip-if-larger", "--quality=80-98", "--strip", "--output", str(p), str(p)], check=False)
        if shutil.which("oxipng"):
            subprocess.run(["oxipng", "-o", "4", "--strip", "safe", str(p)], check=False, capture_output=True)
        print(f"  {p.name}: {before // 1024} KB -> {p.stat().st_size // 1024} KB (pngquant)")
        return
    img = Image.open(p).convert("RGB")
    tmp_true = p.with_suffix(".true.png")
    img.save(tmp_true, optimize=True, compress_level=9)
    best, how = tmp_true, "truecolour"
    candidates = []
    tmp_pal = p.with_suffix(".pal.png")
    pal = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    pal.save(tmp_pal, optimize=True)
    candidates.append((tmp_pal, "PIL palette"))
    tmp_ff = p.with_suffix(".ff.png")
    if shutil.which("ffmpeg"):
        vf = "split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a"
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp_true), "-vf", vf, str(tmp_ff)], capture_output=True)
        if r.returncode == 0 and tmp_ff.exists():
            candidates.append((tmp_ff, "ffmpeg palette"))
    notes = []
    for path, name in candidates:
        q = psnr(img, Image.open(path))
        notes.append(f"{name} {q:.1f} dB")
        if q >= min_psnr and path.stat().st_size < best.stat().st_size:
            best, how = path, f"{name}, PSNR {q:.1f} dB"
    best.replace(p)
    for t in (tmp_true, tmp_pal, tmp_ff):
        t.unlink(missing_ok=True)
    print(f"  {p.name}: {before // 1024} KB -> {p.stat().st_size // 1024} KB ({how}; tried {', '.join(notes)})")


def main():
    args = sys.argv[1:]
    min_psnr = MIN_PSNR
    if args[:1] == ["--min-psnr"]:
        min_psnr, args = float(args[1]), args[2:]
    root = Path(args[0])
    names = args[1:] or [p.name for p in sorted(root.glob("*.png")) if p.name != "preview-sheet.png"]
    print("[optimize]")
    for n in names:
        optimise(root / n, min_psnr)


if __name__ == "__main__":
    main()
