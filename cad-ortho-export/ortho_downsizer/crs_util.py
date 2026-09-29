"""CRS lookup and the length-unit arithmetic the ground-sample-distance entry needs.

The unit handling here is deliberately explicit. A drone ortho arrives in metres
(UTM or WGS84-derived) and leaves in US survey feet (California SPCS), and those
two feet -- survey and international -- differ by 2 ppm. Over a 600 ft site that
is only 0.001 ft, but the same mistake applied to a State Plane *coordinate*
of 6,610,000 ft is 13 ft of error. So units are always carried as an explicit
metres-per-unit factor and never inferred from context.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from pyproj import CRS
from pyproj.database import query_crs_info

#: 1200/3937 exactly -- the US survey foot's legal definition.
US_SURVEY_FOOT = 1200.0 / 3937.0
INTERNATIONAL_FOOT = 0.3048

#: Display name -> metres per unit. Order is the order shown in the GUI.
LENGTH_UNITS: dict[str, float] = {
    "cm": 0.01,
    "m": 1.0,
    "ft (US survey)": US_SURVEY_FOOT,
    "ft (int'l)": INTERNATIONAL_FOOT,
    "in": 0.0254,
}

#: Zones this shop actually works in, most-used first. Names are resolved from
#: the PROJ database at call time rather than hard-coded -- getting a zone
#: number wrong in a literal is a silent, expensive class of bug.
FAVOURITE_EPSG: tuple[int, ...] = (
    6416, 6418, 6420, 6422, 6424, 6426,   # NAD83(2011) California zones 1-6, ftUS
    2225, 2226, 2227, 2228, 2229, 2230,   # NAD83 California zones 1-6, ftUS
    32610, 32611,                          # WGS84 / UTM 10N, 11N -- common ODM output
)


@dataclass(frozen=True)
class CrsHit:
    epsg: int
    name: str
    unit_name: str
    metres_per_unit: float
    area: str

    @property
    def label(self) -> str:
        return f"EPSG:{self.epsg} - {self.name} [{self.unit_name}]"


class CrsError(ValueError):
    """Raised when a CRS cannot be resolved or is unusable for this job."""


@lru_cache(maxsize=512)
def get_crs(epsg: int) -> CRS:
    try:
        return CRS.from_epsg(int(epsg))
    except Exception as exc:  # noqa: BLE001
        raise CrsError(f"EPSG:{epsg} is not a known coordinate system ({exc}).") from exc


def as_pyproj(crs) -> CRS:
    """Coerce a rasterio CRS, WKT string, EPSG int or pyproj CRS into pyproj.

    rasterio hands back its own ``rasterio.crs.CRS``, which has no axis
    metadata. Everything in this package that reasons about units needs the
    pyproj object, so the conversion happens here once rather than at each call.
    """
    if isinstance(crs, CRS):
        return crs
    if crs is None:
        raise CrsError("No coordinate system supplied.")
    if isinstance(crs, int):
        return get_crs(crs)
    try:
        return CRS.from_user_input(crs)
    except Exception:  # noqa: BLE001
        try:
            return CRS.from_wkt(crs.to_wkt())
        except Exception as exc:  # noqa: BLE001
            raise CrsError(f"Unrecognised coordinate system: {crs!r} ({exc}).") from exc


def linear_unit(crs) -> tuple[str, float]:
    """Return ``(unit name, metres per unit)`` for a projected CRS's axes.

    Geographic CRSs report degrees, which are not a length; callers that need a
    ground sample distance must reject those, so this surfaces the raw unit name
    rather than trying to fake a conversion.
    """
    crs = as_pyproj(crs)
    if not crs.axis_info:
        raise CrsError(f"{crs.name} exposes no axis information.")
    axis = crs.axis_info[0]
    return axis.unit_name, float(axis.unit_conversion_factor)


def is_projected(crs) -> bool:
    return bool(as_pyproj(crs).is_projected)


@lru_cache(maxsize=1)
def _all_projected() -> tuple[tuple[str, str, str, str], ...]:
    """(code, name, projection_method, area) for every EPSG projected CRS."""
    rows = []
    for info in query_crs_info(auth_name="EPSG", pj_types=("PROJECTED_CRS",)):
        if info.deprecated:
            continue
        rows.append((info.code, info.name, info.projection_method_name or "",
                     info.area_of_use.name if info.area_of_use else ""))
    return tuple(rows)


def describe(epsg: int) -> CrsHit:
    """Resolve one EPSG code to a display record."""
    crs = get_crs(epsg)
    try:
        unit_name, factor = linear_unit(crs)
    except CrsError:
        unit_name, factor = "degree", 0.0
    area = crs.area_of_use.name if crs.area_of_use else ""
    return CrsHit(int(epsg), crs.name, unit_name, factor, area)


def search(query: str, limit: int = 60) -> list[CrsHit]:
    """Substring search over EPSG projected CRS names, codes and areas.

    A bare number is treated as a code first -- typing "6420" should land on
    EPSG:6420, not on every zone whose area description contains "6420".
    """
    q = (query or "").strip().lower()
    if not q:
        return [describe(code) for code in FAVOURITE_EPSG]

    hits: list[CrsHit] = []
    if q.isdigit():
        try:
            hits.append(describe(int(q)))
        except CrsError:
            pass

    seen = {h.epsg for h in hits}
    terms = [t for t in q.replace(":", " ").split() if t and t != "epsg"]
    for code, name, method, area in _all_projected():
        if len(hits) >= limit:
            break
        epsg = int(code)
        if epsg in seen:
            continue
        haystack = f"{code} {name} {method} {area}".lower()
        if all(t in haystack for t in terms):
            try:
                hits.append(describe(epsg))
            except CrsError:
                continue
            seen.add(epsg)
    return hits


def to_crs_units(value: float, unit_key: str, crs: CRS) -> float:
    """Convert ``value`` given in ``unit_key`` into ``crs``'s own linear unit.

    This is the one conversion that decides how big every output pixel is, so a
    geographic target CRS is refused outright rather than silently treated as
    though degrees were metres.
    """
    crs = as_pyproj(crs)
    if unit_key not in LENGTH_UNITS:
        raise CrsError(f"Unknown length unit {unit_key!r}.")
    if not is_projected(crs):
        raise CrsError(
            f"{crs.name} is a geographic (lat/lon) system, so it has no ground "
            "distance unit. Pick a projected CRS -- a State Plane zone or a UTM "
            "zone -- to set a ground sample distance."
        )
    unit_name, metres_per_crs_unit = linear_unit(crs)
    if metres_per_crs_unit <= 0:
        raise CrsError(f"{crs.name} reports a non-length axis unit ({unit_name}).")
    return float(value) * LENGTH_UNITS[unit_key] / metres_per_crs_unit


def from_crs_units(value: float, unit_key: str, crs: CRS) -> float:
    """Inverse of :func:`to_crs_units` -- CRS units to ``unit_key``."""
    _, metres_per_crs_unit = linear_unit(crs)
    return float(value) * metres_per_crs_unit / LENGTH_UNITS[unit_key]


def format_length(metres: float) -> str:
    """Human-readable length used in the source-inspection readouts."""
    if metres < 0.01:
        return f"{metres * 1000:.1f} mm"
    if metres < 1.0:
        return f"{metres * 100:.2f} cm"
    return f"{metres:.3f} m"
