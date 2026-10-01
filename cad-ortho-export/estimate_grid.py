"""Output grid for the CAD-export size warning.

Runs on the reference node, which already has GDAL from the OpenDroneMap
image. The export worker's rasterio package is not installed there. Prints
one JSON object: width, height, transparentFraction.

argv: /vsigs/bucket/object  <gsd metres>  <epsg or empty to keep the source CRS>
"""

from __future__ import annotations

import json
import sys

from osgeo import gdal, osr

gdal.UseExceptions()


def _projected(srs: osr.SpatialReference) -> osr.SpatialReference:
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    if not srs.IsProjected():
        raise ValueError(f"{srs.GetName()} is not a projected CRS.")
    if srs.GetLinearUnits() <= 0:
        raise ValueError(f"{srs.GetName()} has no linear unit.")
    return srs


def _transparent_fraction(ds: gdal.Dataset) -> float:
    """Decimated alpha sample. No overviews means skip the read and assume solid."""
    band = None
    for index in range(1, ds.RasterCount + 1):
        candidate = ds.GetRasterBand(index)
        if candidate.GetColorInterpretation() == gdal.GCI_AlphaBand:
            band = candidate
            break
    if band is None or band.GetOverviewCount() < 1:
        return 0.0
    chosen = band
    for index in range(band.GetOverviewCount()):
        overview = band.GetOverview(index)
        if overview is not None and overview.XSize >= 256:
            chosen = overview
    data = chosen.ReadRaster(0, 0, chosen.XSize, chosen.YSize, buf_xsize=256, buf_ysize=256, buf_type=gdal.GDT_Byte)
    if not data:
        return 0.0
    transparent = sum(1 for value in data if value < 128)
    return transparent / len(data)


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: estimate_grid.py VSI_PATH GSD_METRES EPSG", file=sys.stderr)
        return 2
    path, metres_text, epsg_text = sys.argv[1:]
    if not path.startswith("/vsigs/"):
        print("source must be a /vsigs/ path", file=sys.stderr)
        return 2
    metres = float(metres_text)
    if metres <= 0:
        print("ground resolution must be positive", file=sys.stderr)
        return 2

    ds = gdal.Open(path)
    if ds is None:
        print(f"could not open {path}", file=sys.stderr)
        return 1
    src = ds.GetSpatialRef()
    if src is None:
        print("orthophoto has no CRS", file=sys.stderr)
        return 1
    src = src.Clone()
    if epsg_text.strip():
        dst = osr.SpatialReference()
        dst.ImportFromEPSG(int(epsg_text))
    else:
        dst = src.Clone()
    dst = _projected(dst)
    res = metres / dst.GetLinearUnits()
    warped = gdal.Warp(
        "/vsimem/cad_export_estimate.vrt",
        ds,
        format="VRT",
        dstSRS=dst.ExportToWkt(),
        xRes=res,
        yRes=res,
        resampleAlg=gdal.GRA_NearestNeighbour,
    )
    if warped is None or warped.RasterXSize < 1 or warped.RasterYSize < 1:
        print("could not resolve the output grid", file=sys.stderr)
        return 1
    payload = {
        "width": int(warped.RasterXSize),
        "height": int(warped.RasterYSize),
        "transparentFraction": _transparent_fraction(ds),
    }
    gdal.Unlink("/vsimem/cad_export_estimate.vrt")
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
