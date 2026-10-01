"""Windows long-path handling, shared by the modules that touch the filesystem.

GDAL opens and writes paths longer than 260 characters without complaint, but
Python's ``open``/``stat``/``exists`` do not. That asymmetry produces the worst
possible failure mode: the GeoTIFF is written successfully and then the run is
reported as failed when the world file cannot be created beside it. Job folders
here already run deep -- ``Desktop\\CAD Deliverables\\<job>\\GeoTIFF\\Drone Image
- Post QGIS\\`` plus a doubled-up ODM filename -- so this is a matter of when,
not whether.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Prefix below the 260-character limit, leaving room for sidecar suffixes.
_THRESHOLD = 240


def long_path(p: Path | str) -> str:
    """Return ``p`` in Windows extended-length form when it is long enough to need it."""
    s = str(p)
    if os.name == "nt" and len(s) > _THRESHOLD and not s.startswith("\\\\?\\"):
        return "\\\\?\\" + os.path.abspath(s)
    return s
