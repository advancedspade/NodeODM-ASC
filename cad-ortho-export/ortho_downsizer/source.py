"""Inspect a source raster and report what actually matters for downsizing.

The one non-obvious measurement here is ``transparent_fraction``. ODM orthophotos
are a ragged flight footprint inside a rectangular grid, and the surround is
alpha=0 over *black* RGB. Measured across three real jobs on this machine that
surround is 12%, 51% and 80% of the image. Anything that discards the alpha
channel without filling the hole therefore paints a huge black rectangle across
the drawing, which is why the converter treats background fill as a first-class
option instead of an afterthought.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling

from .crs_util import CrsError, as_pyproj, format_length, linear_unit
from .paths import long_path as _long

RASTER_EXTENSIONS = {".tif", ".tiff", ".geotiff", ".gtiff"}

#: Side length of the decimated probe used for transparency statistics.
_PROBE = 512


@dataclass
class SourceInfo:
    path: str
    width: int
    height: int
    count: int
    dtype: str
    crs_epsg: int | None
    crs_name: str
    crs_wkt: str
    crs_units: str
    metres_per_unit: float
    res_x: float
    res_y: float
    bounds: tuple[float, float, float, float]
    file_bytes: int
    has_alpha: bool
    transparent_fraction: float
    background_is_dark: bool
    compression: str | None
    overview_levels: list[int]

    # ---- derived conveniences -------------------------------------------
    @property
    def name(self) -> str:
        return Path(self.path).name

    @property
    def megapixels(self) -> float:
        return self.width * self.height / 1e6

    @property
    def file_mb(self) -> float:
        return self.file_bytes / 1e6

    @property
    def gsd_metres(self) -> float:
        """Ground sample distance in metres, whatever the CRS unit is."""
        return abs(self.res_x) * self.metres_per_unit

    @property
    def gsd_text(self) -> str:
        return format_length(self.gsd_metres)

    @property
    def is_geographic(self) -> bool:
        return self.metres_per_unit == 0.0

    def summary(self) -> str:
        crs = f"EPSG:{self.crs_epsg}" if self.crs_epsg else self.crs_name or "no CRS"
        return (f"{self.width:,} x {self.height:,} px | {self.count} band | {crs} | "
                f"{self.gsd_text}/px | {self.file_mb:,.1f} MB")


class SourceError(ValueError):
    """Raised when a file cannot serve as a downsizing source."""


def _probe_transparency(ds) -> tuple[bool, float, bool]:
    """Return (has_alpha, transparent fraction, background_is_dark).

    Reads a decimated overview rather than the full raster -- these files run to
    2.7 GB and the answer only needs to be good to a percent.
    """
    has_alpha = ColorInterp.alpha in ds.colorinterp
    out_h = min(_PROBE, ds.height)
    out_w = min(_PROBE, ds.width)
    try:
        mask = ds.dataset_mask(out_shape=(out_h, out_w))
    except TypeError:  # older rasterio without out_shape on dataset_mask
        mask = ds.read_masks(1, out_shape=(out_h, out_w))

    transparent = mask < 128
    fraction = float(transparent.mean())

    background_is_dark = False
    if fraction > 0.001:
        bands = [b for b, ci in enumerate(ds.colorinterp, start=1)
                 if ci != ColorInterp.alpha][:3] or [1]
        rgb = ds.read(bands, out_shape=(len(bands), out_h, out_w),
                      resampling=Resampling.average)
        under = rgb[:, transparent]
        if under.size:
            background_is_dark = bool(np.median(under) < 64)
    return has_alpha, fraction, background_is_dark


def _is_gdal_vsi(path: str) -> bool:
    """True for GDAL virtual paths such as ``/vsigs/bucket/object``."""
    return str(path).startswith("/vsi")


def _file_bytes(path: Path) -> int:
    """Byte size of a local file. Virtual filesystems report 0; the caller can fill it in."""
    try:
        return os.path.getsize(_long(path))
    except OSError:
        if _is_gdal_vsi(path):
            return 0
        raise


def inspect(path: str | os.PathLike) -> SourceInfo:
    """Open ``path`` and describe it, or raise :class:`SourceError`."""
    p = Path(path)
    vsi = _is_gdal_vsi(p)
    # os.path.exists is false for /vsigs even when the object is there.
    if not vsi and not os.path.exists(_long(p)):
        raise SourceError(f"File not found: {p}")
    if p.suffix.lower() not in RASTER_EXTENSIONS:
        raise SourceError(f"Not a TIFF: {p.name}")

    try:
        ds = rasterio.open(p)
    except Exception as exc:  # noqa: BLE001
        raise SourceError(f"Could not open {p.name}: {exc}") from exc

    with ds:
        if ds.crs is None:
            raise SourceError(
                f"{p.name} carries no coordinate system, so there is nothing to "
                "preserve. Georeference it first (QGIS: Layer > Set CRS)."
            )
        crs = as_pyproj(ds.crs)
        try:
            units, mpu = linear_unit(crs)
        except CrsError:
            units, mpu = "degree", 0.0

        epsg = ds.crs.to_epsg()
        has_alpha, frac, dark = _probe_transparency(ds)
        try:
            nbytes = _file_bytes(p)
        except OSError as exc:
            raise SourceError(f"Could not stat {p.name}: {exc}") from exc

        return SourceInfo(
            # resolve() follows local symlinks. A /vsigs path must stay as written
            # or the later warp opens a path GDAL does not understand.
            path=str(p) if vsi else str(p.resolve()),
            width=ds.width,
            height=ds.height,
            count=ds.count,
            dtype=ds.dtypes[0],
            crs_epsg=epsg,
            crs_name=crs.name,
            crs_wkt=crs.to_wkt(),
            crs_units=units,
            metres_per_unit=mpu,
            res_x=ds.res[0],
            res_y=ds.res[1],
            bounds=tuple(ds.bounds),
            file_bytes=nbytes,
            has_alpha=has_alpha,
            transparent_fraction=frac,
            background_is_dark=dark,
            compression=(ds.profile.get("compress") or None),
            overview_levels=list(ds.overviews(1)),
        )
