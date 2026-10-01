"""Downsize drone orthophotos without moving them off their ground position.

Public surface:

    inspect(path)                  -> SourceInfo    what the source actually is
    build_plan(info, gsd, unit, epsg) -> Plan       the output grid, before writing
    convert(plan, options)         -> Result        do the work
    verify_geolocation(src, out)   -> VerifyResult  prove it did not shift
"""

from .convert import (BACKGROUND_FILLS, ConvertError, OVERVIEW_SAFETY, Options, RESAMPLING,
                      Result, convert, output_path_for, pick_overview_level)
from .crs_util import CrsError, CrsHit, FAVOURITE_EPSG, LENGTH_UNITS, describe, format_length, search
from .plan import CODECS, Plan, PlanError, build_plan
from .source import SourceError, SourceInfo, inspect
from .verify import VerifyResult, verify_geolocation

__version__ = "1.0.0"

__all__ = [
    "BACKGROUND_FILLS", "CODECS", "ConvertError", "CrsError", "CrsHit",
    "FAVOURITE_EPSG", "LENGTH_UNITS", "OVERVIEW_SAFETY", "Options", "Plan",
    "PlanError", "RESAMPLING", "Result", "SourceError", "SourceInfo",
    "VerifyResult", "build_plan", "convert", "describe", "format_length",
    "inspect", "output_path_for", "pick_overview_level", "search",
    "verify_geolocation", "__version__",
]
