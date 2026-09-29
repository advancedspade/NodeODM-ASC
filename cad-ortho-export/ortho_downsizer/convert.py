"""Warp, resample, compress and write the downsized GeoTIFF plus its sidecars.

The whole job runs through a :class:`~rasterio.vrt.WarpedVRT` pinned to the
planned output grid, copied out in row strips. That keeps memory flat on the
2.7 GB orthos in this shop's archive, gives an honest progress fraction, and --
the reason it is worth doing this way -- makes the output pixel grid identical
to what GDAL's own warper would produce, which is what ``verify`` later proves.

Alpha is handled per codec because TIFF gives no single answer:

* ``jpeg``  -- JPEG cannot carry a fourth channel, so RGB is compressed and the
  footprint travels as a TIFF *internal mask*. GDAL-aware software (QGIS, this
  tool) sees true transparency; AutoCAD does not read mask bands, so the area
  outside the flight footprint is filled with a chosen colour first. Left
  unfilled it would be black, because that is what ODM writes under alpha=0.
* ``deflate`` / ``lzw`` -- lossless, and the alpha channel survives as a real
  fourth band that AutoCAD's image transparency honours.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window

from .crs_util import get_crs
from .paths import long_path
from .plan import Plan

ProgressFn = Callable[[float, str], None]

RESAMPLING = {
    "average": Resampling.average,
    "bilinear": Resampling.bilinear,
    "cubic": Resampling.cubic,
    "lanczos": Resampling.lanczos,
    "nearest": Resampling.nearest,
}

BACKGROUND_FILLS = {"white": 255, "black": 0, "none": None}

#: Roughly how much image to hold in RAM at once, per strip.
_STRIP_BUDGET_BYTES = 64 << 20

#: An ODM ortho ships with overviews, and warping a 20x-decimated output from
#: full resolution re-reads 400x more data than the result can hold -- measured
#: at 32 s versus 0.7 s on a 203 MB job. gdalwarp's own default (-ovr AUTO) is
#: to read from an overview; this does the same.
#:
#: Preferred margin: the overview must be at least this many times finer than
#: the target grid, so the tool still performs real averaging of its own.
OVERVIEW_SAFETY = 2.0
#: Absolute floor. When nothing meets the preferred margin the choice is between
#: an overview that is merely finer than the target and reading full resolution,
#: and the latter is not a quality win -- on a 4.8 GB corridor ortho decimated
#: 3.55x it meant warping 36 Gpx (~100 min) instead of 2.2 Gpx, for imagery that
#: gets averaged down either way. Below 1.0 the overview would be upsampled,
#: which is a real loss, so that is never allowed.
OVERVIEW_SAFETY_FLOOR = 1.0


@dataclass
class Options:
    codec: str = "jpeg"
    quality: int = 90
    background: str = "white"
    overviews: bool = True
    sidecars: bool = True
    resampling: str = "average"
    output_dir: str | None = None
    suffix: str = "_small"
    overwrite: bool = False
    fast: bool = True          # read from source overviews where safe


def pick_overview_level(src, target_width: int, safety: float = OVERVIEW_SAFETY) -> int | None:
    """Index of the coarsest source overview still comfortably finer than the output.

    Tries the preferred margin first and falls back to the floor, so a source
    whose finest overview sits between the two is still used rather than
    triggering a full-resolution read. Returns ``None`` when the source has no
    overviews, or when even the finest is coarser than the target grid.
    """
    factors = src.overviews(1)
    if not factors:
        return None

    def coarsest_meeting(margin: float) -> int | None:
        chosen = None
        for i, factor in enumerate(factors):
            if src.width / factor >= target_width * margin:
                chosen = i
            else:
                break
        return chosen

    # Explicit None test: level 0 is both a valid answer and falsy.
    preferred = coarsest_meeting(safety)
    return preferred if preferred is not None else coarsest_meeting(OVERVIEW_SAFETY_FLOOR)


@dataclass
class Result:
    source_path: str
    output_path: str
    ok: bool
    message: str
    source_bytes: int = 0
    output_bytes: int = 0
    width: int = 0
    height: int = 0
    seconds: float = 0.0
    sidecars: list[str] = field(default_factory=list)

    @property
    def ratio(self) -> float:
        return self.source_bytes / self.output_bytes if self.output_bytes else 0.0

    @property
    def source_mb(self) -> float:
        return self.source_bytes / 1e6

    @property
    def output_mb(self) -> float:
        return self.output_bytes / 1e6


class ConvertError(RuntimeError):
    pass


def _same_file(a: Path, b: Path) -> bool:
    """True when two paths name the same file, short names and links included."""
    try:
        return os.path.normcase(str(Path(a).resolve())) == os.path.normcase(str(Path(b).resolve()))
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def output_path_for(plan: Plan, opts: Options) -> Path:
    stem = Path(plan.source.path).stem
    out_dir = Path(opts.output_dir) if opts.output_dir else Path(plan.source.path).parent
    return out_dir / f"{stem}{opts.suffix}.tif"


def _profile(plan: Plan, opts: Options, band_count: int) -> dict:
    prof = dict(
        driver="GTiff",
        dtype="uint8",
        crs=get_crs(plan.dst_epsg) if plan.dst_epsg else None,
        transform=plan.transform,
        width=plan.width,
        height=plan.height,
        count=band_count,
        tiled=True,
        blockxsize=512,
        blockysize=512,
        BIGTIFF="IF_SAFER",
    )
    if opts.codec == "jpeg":
        prof.update(compress="jpeg", photometric="ycbcr",
                    jpeg_quality=int(opts.quality), interleave="pixel")
    elif opts.codec == "lzw":
        prof.update(compress="lzw", predictor=2, interleave="pixel")
    else:
        prof.update(compress="deflate", predictor=2, zlevel=6, interleave="pixel")
    return prof


def _strip_rows(width: int, bands: int) -> int:
    per_row = max(width * bands, 1)
    rows = max(int(_STRIP_BUDGET_BYTES / per_row), 512)
    return int(round(rows / 512.0)) * 512 or 512


def _overview_levels(width: int, height: int) -> list[int]:
    levels, level = [], 2
    while max(width, height) // level > 256 and level <= 64:
        levels.append(level)
        level *= 2
    return levels


def write_sidecars(out_path: Path, plan: Plan) -> list[str]:
    """Write ``.tfw`` and ``.prj`` next to the GeoTIFF.

    Redundant with the embedded georeferencing, and written anyway: Civil3D's
    image-correlation path reads the world file, and a ``.prj`` is what makes a
    manual re-attach land on the right State Plane coordinates. The world file
    stores the *centre* of the upper-left pixel, while an affine transform
    stores its *corner* -- the half-pixel shift below is that convention, and
    getting it wrong displaces the image by half a pixel.
    """
    written: list[str] = []
    t = plan.transform
    tfw = out_path.with_suffix(".tfw")
    body = "\n".join(f"{v:.10f}" for v in (
        t.a, t.d, t.b, t.e, t.c + t.a / 2.0, t.f + t.e / 2.0)) + "\n"
    with open(long_path(tfw), "w", encoding="ascii") as fh:
        fh.write(body)
    written.append(str(tfw))

    if plan.dst_epsg:
        prj = out_path.with_suffix(".prj")
        with open(long_path(prj), "w", encoding="ascii") as fh:
            fh.write(get_crs(plan.dst_epsg).to_wkt(version="WKT1_ESRI"))
        written.append(str(prj))
    return written


def convert(plan: Plan, opts: Options, progress: ProgressFn | None = None) -> Result:
    """Run one downsizing job. Never raises for expected failures -- see ``Result.ok``."""
    started = time.time()
    src_path = Path(plan.source.path)
    out_path = output_path_for(plan, opts)

    def report(frac: float, msg: str) -> None:
        if progress:
            progress(max(0.0, min(frac, 1.0)), msg)

    if opts.codec not in ("jpeg", "deflate", "lzw"):
        return Result(str(src_path), str(out_path), False, f"Unknown codec {opts.codec!r}.")
    # resolve() rather than abspath(): a temp or junctioned folder can reach the
    # same file through an 8.3 short name, and that must still count as a match.
    if _same_file(out_path, src_path):
        return Result(str(src_path), str(out_path), False,
                      "Output would overwrite the source. Change the suffix or output folder.")
    if os.path.exists(long_path(out_path)) and not opts.overwrite:
        return Result(str(src_path), str(out_path), False,
                      f"{out_path.name} already exists. Enable overwrite or change the suffix.")

    os.makedirs(long_path(out_path.parent), exist_ok=True)
    resamp = RESAMPLING.get(opts.resampling, Resampling.average)
    fill = BACKGROUND_FILLS.get(opts.background, 255)

    try:
        with rasterio.Env(GDAL_TIFF_INTERNAL_MASK="YES", GDAL_CACHEMAX=512,
                          NUM_THREADS="ALL_CPUS"):
            with rasterio.open(src_path) as probe:
                colour_bands = [i for i, ci in enumerate(probe.colorinterp, start=1)
                                if ci != ColorInterp.alpha][:3]
                alpha_band = next((i for i, ci in enumerate(probe.colorinterp, start=1)
                                   if ci == ColorInterp.alpha), None)
                level = pick_overview_level(probe, plan.width) if opts.fast else None

            if not colour_bands:
                colour_bands = [1]
            if opts.codec == "jpeg" and len(colour_bands) != 3:
                return Result(
                    str(src_path), str(out_path), False,
                    f"{src_path.name} has {len(colour_bands)} colour band(s); JPEG "
                    "compression here expects RGB. Use the lossless option instead.")

            keep_alpha = opts.codec != "jpeg" and plan.source.has_alpha
            band_count = len(colour_bands) + (1 if keep_alpha else 0)
            open_kwargs = {"OVERVIEW_LEVEL": level} if level is not None else {}

            with rasterio.open(src_path, **open_kwargs) as src:
                vrt_opts = dict(crs=get_crs(plan.dst_epsg) if plan.dst_epsg else src.crs,
                                transform=plan.transform, width=plan.width,
                                height=plan.height, resampling=resamp)

                with WarpedVRT(src, **vrt_opts) as vrt, \
                        rasterio.open(out_path, "w", **_profile(plan, opts, band_count)) as dst:
                    if keep_alpha:
                        dst.colorinterp = [ColorInterp.red, ColorInterp.green,
                                           ColorInterp.blue, ColorInterp.alpha][:band_count]

                    rows = _strip_rows(plan.width, len(colour_bands) + 1)
                    n_strips = max(1, (plan.height + rows - 1) // rows)
                    for i in range(n_strips):
                        row_off = i * rows
                        win = Window(0, row_off, plan.width,
                                     min(rows, plan.height - row_off))
                        # Reading the alpha band directly costs one band-warp;
                        # dataset_mask() costs a separate full pass (10 s on a
                        # real job) for the same answer when alpha is present.
                        if alpha_band is not None:
                            block = vrt.read(colour_bands + [alpha_band], window=win)
                            data, mask = block[:-1], block[-1]
                        else:
                            data = vrt.read(colour_bands, window=win)
                            mask = vrt.dataset_mask(window=win)

                        if opts.codec == "jpeg" and fill is not None:
                            data[:, mask < 128] = fill

                        dst.write(data, indexes=list(range(1, len(colour_bands) + 1)),
                                  window=win)
                        if keep_alpha:
                            dst.write(mask, band_count, window=win)
                        else:
                            dst.write_mask(mask, window=win)

                        report(0.85 * (i + 1) / n_strips,
                               f"Resampling... {100 * (i + 1) // n_strips}%")

            if opts.overviews:
                levels = _overview_levels(plan.width, plan.height)
                if levels:
                    report(0.88, "Building overviews...")
                    with rasterio.open(out_path, "r+") as dst:
                        dst.build_overviews(levels, Resampling.average)

        sidecars: list[str] = []
        if opts.sidecars:
            report(0.97, "Writing world file and .prj...")
            sidecars = write_sidecars(out_path, plan)

        report(1.0, "Done")
        out_bytes = os.path.getsize(long_path(out_path))
        try:
            src_bytes = os.path.getsize(long_path(src_path))
        except OSError:
            # /vsigs sources have no local stat. inspect() leaves file_bytes at 0
            # unless the caller filled it from object metadata.
            src_bytes = int(plan.source.file_bytes or 0)
        return Result(
            source_path=str(src_path), output_path=str(out_path), ok=True,
            message=f"{src_bytes/1e6:,.1f} MB -> {out_bytes/1e6:,.1f} MB "
                    f"({src_bytes/max(out_bytes,1):.0f}x smaller)",
            source_bytes=src_bytes, output_bytes=out_bytes,
            width=plan.width, height=plan.height,
            seconds=time.time() - started, sidecars=sidecars,
        )

    except Exception as exc:  # noqa: BLE001
        if os.path.exists(long_path(out_path)):
            try:
                os.remove(long_path(out_path))   # never leave a half-written deliverable
            except OSError:
                pass
        return Result(str(src_path), str(out_path), False, f"{type(exc).__name__}: {exc}",
                      seconds=time.time() - started)
