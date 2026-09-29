"""Prove the output still sits where the source sat.

Comparing corner coordinates does not answer that question. Reprojection turns a
rectangular footprint into a curved quadrilateral, so the output's bounding-box
corner is legitimately *not* the transformed source corner -- on a real job here
that difference was 5.7 ft, and it was correct. Sampling matched ground points
does not answer it either: at a 4.5x decimation one output pixel averages ~20
source pixels, and the resulting noise swamps the shift being looked for.

What does answer it: reproject the source onto the output's own grid, then slide
the two rasters against each other. If the georeferencing is right, zero offset
is the minimum and its neighbours are markedly worse. On a lossless run zero
scores exactly 0.000 while one pixel away scores 11.4 -- there is no ambiguity
in that signal, and a parabola through the minimum refines it to a fraction of
a pixel, which is then reported in ground units the surveyor can act on.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window

from .crs_util import format_length, linear_unit

#: Half-width of the integer shift search, in output pixels.
SEARCH = 3
#: Side length of the comparison window.
WINDOW = 512
#: Below this variance the window is too flat to localise a shift.
FLAT_VARIANCE = 4.0


@dataclass
class VerifyResult:
    ok: bool
    dx: int
    dy: int
    dx_subpixel: float
    dy_subpixel: float
    score_zero: float
    score_best: float
    neighbour_score: float
    shift_ground: float
    ground_unit: str
    window: tuple[int, int, int, int]
    textured: bool
    message: str

    @property
    def verdict(self) -> str:
        return "PASS" if self.ok else "FAIL"


def _pick_window(ds, size: int = WINDOW, pad: int = SEARCH + 1) -> Window | None:
    """Choose a valid, textured window, preferring the centre of real data.

    The window has to fit *inside* the flight footprint, not merely inside the
    raster. An ODM ortho can be half transparent, so on a small output a
    full-size window would straddle the ragged edge and be rejected for lack of
    coverage. Sizing the window against the available area -- and falling back to
    the best partially-covered candidate rather than giving up -- keeps the check
    working on small and heavily-masked images alike.
    """
    avail_w = ds.width - 2 * pad
    avail_h = ds.height - 2 * pad
    if avail_w < 32 or avail_h < 32:
        return None
    size_x = max(32, min(size, avail_w // 2 or avail_w, avail_w))
    size_y = max(32, min(size, avail_h // 2 or avail_h, avail_h))

    mask = ds.dataset_mask(out_shape=(min(256, ds.height), min(256, ds.width)))
    ys, xs = np.nonzero(mask > 200)
    if len(ys) == 0:
        return None
    sy = ds.height / mask.shape[0]
    sx = ds.width / mask.shape[1]

    candidates: list[tuple[float, float, Window]] = []
    for qy, qx in ((0.5, 0.5), (0.35, 0.35), (0.65, 0.65),
                   (0.35, 0.65), (0.65, 0.35), (0.5, 0.35), (0.5, 0.65)):
        cy = int(np.quantile(ys, qy) * sy)
        cx = int(np.quantile(xs, qx) * sx)
        col = int(np.clip(cx - size_x // 2, pad, max(ds.width - size_x - pad, pad)))
        row = int(np.clip(cy - size_y // 2, pad, max(ds.height - size_y - pad, pad)))
        w = Window(col, row,
                   min(size_x, ds.width - col - pad),
                   min(size_y, ds.height - row - pad))
        if w.width < 32 or w.height < 32:
            continue
        coverage = float((ds.dataset_mask(window=w) > 200).mean())
        variance = float(ds.read(1, window=w).astype("float32").var())
        candidates.append((coverage, variance, w))

    if not candidates:
        return None
    solid = [c for c in candidates if c[0] >= 0.6]
    if solid:                                   # prefer full coverage, then texture
        return max(solid, key=lambda c: c[1])[2]
    partial = [c for c in candidates if c[0] >= 0.25]
    if partial:                                 # ragged ortho: best available
        return max(partial, key=lambda c: c[0] * c[1])[2]
    return None


def _subpixel(scores: dict[tuple[int, int], float], dx: int, dy: int) -> tuple[float, float]:
    """Parabolic refinement of the minimum, in pixels."""
    def refine(axis: int) -> float:
        key = lambda d: (dx + d, dy) if axis == 0 else (dx, dy + d)  # noqa: E731
        try:
            lo, mid, hi = scores[key(-1)], scores[key(0)], scores[key(1)]
        except KeyError:
            return 0.0
        denom = lo - 2.0 * mid + hi
        if abs(denom) < 1e-12:
            return 0.0
        return float(np.clip(0.5 * (lo - hi) / denom, -1.0, 1.0))
    return refine(0), refine(1)


def verify_geolocation(source_path: str | Path, output_path: str | Path,
                       search: int = SEARCH) -> VerifyResult:
    """Cross-check ``output_path``'s georeferencing against ``source_path``."""
    with rasterio.open(output_path) as out:
        unit_name, mpu = linear_unit(out.crs)
        pixel_ground = abs(out.transform.a)

        win = _pick_window(out, pad=search + 1)
        if win is None:
            return VerifyResult(False, 0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, unit_name,
                                (0, 0, 0, 0), False,
                                "No valid image data found to verify against.")

        ref = out.read(1, window=win).astype("float32")
        textured = float(ref.var()) > FLAT_VARIANCE

        with rasterio.open(source_path) as src:
            with WarpedVRT(src, crs=out.crs, transform=out.transform,
                           width=out.width, height=out.height,
                           resampling=Resampling.average) as vrt:
                pad = search + 1
                big = vrt.read(1, window=Window(win.col_off - pad, win.row_off - pad,
                                                win.width + 2 * pad,
                                                win.height + 2 * pad)).astype("float32")

        scores: dict[tuple[int, int], float] = {}
        for dy in range(-search, search + 1):
            for dx in range(-search, search + 1):
                cut = big[pad + dy: pad + dy + int(win.height),
                          pad + dx: pad + dx + int(win.width)]
                if cut.shape != ref.shape:
                    continue
                scores[(dx, dy)] = float(np.abs(cut - ref).mean())

        if not scores:
            return VerifyResult(False, 0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, unit_name,
                                (0, 0, 0, 0), textured,
                                "Comparison window could not be extracted.")

        (bdx, bdy), best = min(scores.items(), key=lambda kv: kv[1])
        zero = scores.get((0, 0), float("nan"))
        neighbours = [v for k, v in scores.items() if k != (0, 0)]
        neighbour = min(neighbours) if neighbours else float("nan")

        sdx, sdy = _subpixel(scores, bdx, bdy)
        total_px = float(np.hypot(bdx + sdx, bdy + sdy))
        ground = total_px * pixel_ground

        ok = (bdx, bdy) == (0, 0)
        if not textured:
            msg = ("Image is too uniform here to localise a shift; georeferencing "
                   "was written from the planned transform and is almost certainly "
                   "fine, but this check could not confirm it independently.")
            ok = False
        elif ok:
            msg = (f"Zero shift is the best match ({zero:.3f} vs {neighbour:.3f} one "
                   f"pixel away). Residual {total_px:.2f} px = "
                   f"{format_length(ground * mpu)} on the ground.")
        else:
            msg = (f"Best match is offset by ({bdx:+d},{bdy:+d}) px = "
                   f"{format_length(ground * mpu)}. The output does NOT line up "
                   "with the source -- do not deliver this file.")

        return VerifyResult(
            ok=ok, dx=bdx, dy=bdy, dx_subpixel=sdx, dy_subpixel=sdy,
            score_zero=zero, score_best=best, neighbour_score=neighbour,
            shift_ground=ground, ground_unit=unit_name,
            window=(int(win.col_off), int(win.row_off), int(win.width), int(win.height)),
            textured=textured, message=msg,
        )
