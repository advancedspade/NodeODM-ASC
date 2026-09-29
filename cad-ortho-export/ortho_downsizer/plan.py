"""Work out the output grid before touching a single pixel.

Splitting planning from conversion buys two things: the GUI can show the exact
output dimensions and a size estimate while the operator is still turning dials,
and the grid arithmetic -- the part that decides whether the image lands in the
right place -- is testable without writing a 40 MB file.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import rasterio
from pyproj import CRS
from rasterio.warp import calculate_default_transform

from .crs_util import CrsError, format_length, get_crs, is_projected, linear_unit, to_crs_units
from .source import SourceInfo

#: Codec identifiers. WEBP is deliberately absent: measured on a real ortho it
#: produced a 0.23 MB file at 12.0 dB PSNR -- visually destroyed -- because
#: lossy WEBP in a TIFF mangles the alpha band. It is not a safe option here.
CODECS = ("jpeg", "deflate", "lzw")

#: Empirical bytes-per-pixel, calibrated on Calvada_Dixon (12940x14643 ODM
#: ortho, 51.4% transparent) downsized to 5 cm in EPSG:6418. These drive the
#: pre-run estimate only; the reported figure after a run is measured, not
#: modelled. Scene content moves these easily by a factor of two.
_JPEG_A, _JPEG_K = 0.01974, 0.0411     # solid-pixel bytes = A * exp(K * quality)
_DEFLATE_BPP = 4.36                     # whole-image average, overviews included
_LZW_BPP = 5.00
_OVERVIEW_GROWTH = 1.332                # 1/4 + 1/16 + 1/64 + 1/256 of the base


@dataclass
class Plan:
    source: SourceInfo
    dst_epsg: int | None
    dst_crs_name: str
    dst_units: str
    metres_per_unit: float
    gsd_crs_units: float
    gsd_metres: float
    width: int
    height: int
    transform: "rasterio.Affine"
    bounds: tuple[float, float, float, float]
    reprojecting: bool

    @property
    def megapixels(self) -> float:
        return self.width * self.height / 1e6

    @property
    def pixel_reduction(self) -> float:
        """How many source pixels collapse into one output pixel."""
        src_px = self.source.width * self.source.height
        return src_px / max(self.width * self.height, 1)

    def estimate_bytes(self, codec: str, quality: int = 90, overviews: bool = True) -> int:
        total_px = self.width * self.height
        solid_px = total_px * max(1.0 - self.source.transparent_fraction, 0.02)
        if codec == "jpeg":
            raw = solid_px * _JPEG_A * math.exp(_JPEG_K * quality)
        elif codec == "lzw":
            raw = total_px * _LZW_BPP / _OVERVIEW_GROWTH
        else:
            raw = total_px * _DEFLATE_BPP / _OVERVIEW_GROWTH
        if overviews:
            raw *= _OVERVIEW_GROWTH
        return int(max(raw, 4096))

    def describe(self) -> str:
        return (f"{self.source.width:,}x{self.source.height:,} @ {self.source.gsd_text} "
                f"-> {self.width:,}x{self.height:,} @ {format_length(self.gsd_metres)} "
                f"({self.pixel_reduction:.1f}x fewer pixels)")


class PlanError(ValueError):
    """Raised when the requested output grid is impossible or unreasonable."""


#: Refuse to plan a grid bigger than this; it is almost always a unit slip
#: (entering 5 for "5 cm" while the CRS is in feet asks for 30x more pixels).
MAX_OUTPUT_PIXELS = 2_500_000_000


def build_plan(
    info: SourceInfo,
    gsd: float,
    gsd_unit: str,
    target_epsg: int | None = None,
) -> Plan:
    """Resolve target CRS plus a ground sample distance into a concrete grid.

    ``target_epsg=None`` keeps the source CRS, which still resamples but skips
    the reprojection. Either way the grid is produced by GDAL's own
    ``calculate_default_transform`` so the output covers the reprojected source
    footprint exactly the way a ``gdalwarp -tr`` would.
    """
    if gsd <= 0:
        raise PlanError("Ground sample distance must be greater than zero.")

    src_crs = get_crs(info.crs_epsg) if info.crs_epsg else CRS.from_wkt(info.crs_wkt)
    if target_epsg is None:
        dst_crs = src_crs
        dst_epsg = info.crs_epsg
    else:
        dst_crs = get_crs(target_epsg)
        dst_epsg = int(target_epsg)

    if not is_projected(dst_crs):
        raise PlanError(
            f"EPSG:{dst_epsg} ({dst_crs.name}) is a lat/lon system. A ground "
            "sample distance in metres or feet has no meaning there -- choose a "
            "State Plane or UTM zone instead."
        )

    unit_name, mpu = linear_unit(dst_crs)
    try:
        res = to_crs_units(gsd, gsd_unit, dst_crs)
    except CrsError as exc:
        raise PlanError(str(exc)) from exc

    with rasterio.open(info.path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds, resolution=res,
        )

    width, height = int(width), int(height)
    if width < 1 or height < 1:
        raise PlanError(
            f"A {format_length(gsd * _unit_metres(gsd_unit))} pixel is larger than "
            "the whole image. Pick a finer ground sample distance."
        )
    if width * height > MAX_OUTPUT_PIXELS:
        raise PlanError(
            f"That asks for {width:,} x {height:,} = {width*height/1e9:.1f} billion "
            f"pixels, which is finer than the {info.gsd_text} source. Check the "
            f"units -- the target CRS measures in {unit_name}."
        )

    left = transform.c
    top = transform.f
    return Plan(
        source=info,
        dst_epsg=dst_epsg,
        dst_crs_name=dst_crs.name,
        dst_units=unit_name,
        metres_per_unit=mpu,
        gsd_crs_units=res,
        gsd_metres=res * mpu,
        width=width,
        height=height,
        transform=transform,
        bounds=(left, top + height * transform.e, left + width * transform.a, top),
        reprojecting=(target_epsg is not None and target_epsg != info.crs_epsg),
    )


def _unit_metres(unit_key: str) -> float:
    from .crs_util import LENGTH_UNITS
    return LENGTH_UNITS.get(unit_key, 1.0)
