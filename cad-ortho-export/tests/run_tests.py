"""Test suite for the ortho downsizer. Run: python tests/run_tests.py

Self-contained: synthesises its own GeoTIFFs, so it needs no job data. Output is
ASCII-only because this machine's console is cp1252.

The load-bearing test is ``verify catches an injected shift``. A verifier that
only ever says PASS is worse than none at all, so the suite deliberately builds
a deliberately mis-georeferenced file and requires the checker to fail it.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import ColorInterp
from rasterio.transform import Affine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ortho_downsizer as od
from ortho_downsizer import crs_util, plan as plan_mod
from ortho_downsizer.convert import write_sidecars
from ortho_downsizer.paths import long_path
import gcs_export

PASSED, FAILED = 0, 0
_FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {name}")
    else:
        FAILED += 1
        _FAILURES.append(name)
        print(f"  FAIL  {name}" + (f"  -- {detail}" if detail else ""))


def near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


# --------------------------------------------------------------------- data
def make_ortho(path: Path, width=1200, height=900, res=0.02,
               epsg=32610, left=600000.0, top=4255000.0,
               alpha=True, seed=3) -> Path:
    """A textured RGB(A) GeoTIFF standing in for an ODM orthophoto.

    The texture must be locally distinctive or the shift search has nothing to
    lock onto, so this is smoothed noise plus hard edges rather than a gradient.
    """
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, size=(height, width), dtype=np.uint8).astype("float32")
    k = 9
    pad = np.pad(base, k // 2, mode="edge")
    smooth = np.zeros_like(base)
    for dy in range(k):
        for dx in range(k):
            smooth += pad[dy:dy + height, dx:dx + width]
    smooth /= k * k
    smooth += 60 * np.sin(np.linspace(0, 25, width))[None, :]
    smooth += 60 * np.cos(np.linspace(0, 19, height))[:, None]
    band = np.clip(smooth, 0, 255).astype("uint8")

    rgb = np.stack([band, np.roll(band, 7, axis=1), np.roll(band, 13, axis=0)])
    count = 4 if alpha else 3
    a = np.full((height, width), 255, "uint8")
    if alpha:                      # ragged footprint, black underneath, as ODM writes
        yy, xx = np.mgrid[0:height, 0:width]
        outside = ((xx - width / 2) ** 2 / (width * 0.42) ** 2
                   + (yy - height / 2) ** 2 / (height * 0.42) ** 2) > 1.0
        a[outside] = 0
        rgb[:, outside] = 0

    transform = Affine(res, 0, left, 0, -res, top)
    prof = dict(driver="GTiff", dtype="uint8", width=width, height=height, count=count,
                crs=f"EPSG:{epsg}", transform=transform, tiled=True,
                blockxsize=256, blockysize=256, compress="deflate")
    with rasterio.open(path, "w", **prof) as ds:
        ds.write(rgb, [1, 2, 3])
        if alpha:
            ds.write(a, 4)
            ds.colorinterp = [ColorInterp.red, ColorInterp.green,
                              ColorInterp.blue, ColorInterp.alpha]
    return path


# -------------------------------------------------------------------- tests
def test_units() -> None:
    print("\n[units and CRS]")
    check("US survey foot is exactly 1200/3937",
          crs_util.US_SURVEY_FOOT == 1200.0 / 3937.0)
    check("survey and international feet differ by ~2 ppm",
          near((crs_util.US_SURVEY_FOOT / crs_util.INTERNATIONAL_FOOT - 1) * 1e6, 2.0, 0.1))

    ft_crs = crs_util.get_crs(6418)                       # CA zone 2, ftUS
    v = crs_util.to_crs_units(5.0, "cm", ft_crs)
    check("5 cm converts to 0.16404 ftUS", near(v, 0.05 / crs_util.US_SURVEY_FOOT, 1e-9),
          f"got {v}")

    m_crs = crs_util.get_crs(32610)                       # UTM 10N, metres
    check("5 cm converts to 0.05 m", near(crs_util.to_crs_units(5.0, "cm", m_crs), 0.05, 1e-12))
    check("1 ftUS into a metre CRS is 0.3048006",
          near(crs_util.to_crs_units(1.0, "ft (US survey)", m_crs), 1200 / 3937, 1e-12))

    try:
        crs_util.to_crs_units(5.0, "cm", crs_util.get_crs(4326))
        check("geographic CRS is refused for a ground resolution", False, "no error raised")
    except crs_util.CrsError:
        check("geographic CRS is refused for a ground resolution", True)

    name, factor = crs_util.linear_unit(ft_crs)
    check("EPSG:6418 reports the US survey foot", "US survey foot" in name, name)
    check("EPSG:6418 unit factor matches 1200/3937", near(factor, 1200 / 3937, 1e-12))


def test_crs_search() -> None:
    print("\n[CRS search]")
    hits = od.search("6420")
    check("a bare code finds itself first", hits and hits[0].epsg == 6420,
          str(hits[:1]))
    check("EPSG:6420 is California zone 3 in ftUS",
          "zone 3" in od.describe(6420).name.lower()
          and "foot" in od.describe(6420).unit_name.lower())
    # Guards the exact mix-up recorded in the survey engine's notes.
    check("EPSG:6418 is zone 2, not zone 3", "zone 2" in od.describe(6418).name.lower())
    named = od.search("california zone 3")
    check("a name search finds California zone 3", any("zone 3" in h.name.lower() for h in named),
          f"{len(named)} hits")
    check("defaults list the shop's favourite zones", len(od.search("")) == len(od.FAVOURITE_EPSG))


def test_plan(tmp: Path) -> None:
    print("\n[planning]")
    src = make_ortho(tmp / "plan.tif", width=1200, height=900, res=0.02)
    info = od.inspect(src)
    check("source is read as 4-band with alpha", info.count == 4 and info.has_alpha)
    check("source GSD reads back as 2 cm", near(info.gsd_metres, 0.02, 1e-9))
    check("transparent fraction is detected", 0.1 < info.transparent_fraction < 0.6,
          f"{info.transparent_fraction:.3f}")
    check("black background under alpha is detected", info.background_is_dark)

    p = od.build_plan(info, 10.0, "cm", target_epsg=None)
    check("keeping the CRS keeps the EPSG", p.dst_epsg == 32610)
    check("10 cm from 2 cm gives 5x fewer pixels per side",
          near(p.width, 1200 / 5, 1), f"{p.width}")
    check("planned GSD is 10 cm", near(p.gsd_metres, 0.10, 1e-9))
    check("pixel reduction is reported as ~25x", near(p.pixel_reduction, 25, 1.0),
          f"{p.pixel_reduction:.1f}")

    pf = od.build_plan(info, 10.0, "cm", target_epsg=6418)
    check("reprojection is flagged", pf.reprojecting)
    check("target GSD converts into ftUS", near(pf.gsd_crs_units, 0.10 / (1200 / 3937), 1e-9))
    check("output stays about the same size across CRSs",
          near(pf.width, p.width, 3), f"{pf.width} vs {p.width}")

    try:
        od.build_plan(info, 10.0, "cm", target_epsg=4326)
        check("geographic target CRS is refused", False, "no error")
    except od.PlanError:
        check("geographic target CRS is refused", True)

    try:  # 5 ftUS entered as 5 cm-worth of pixels is the classic unit slip
        od.build_plan(info, 0.000001, "cm", target_epsg=6418)
        check("an absurd pixel count is refused", False, "no error")
    except od.PlanError:
        check("an absurd pixel count is refused", True)

    try:
        od.build_plan(info, 0, "cm", target_epsg=6418)
        check("zero resolution is refused", False, "no error")
    except od.PlanError:
        check("zero resolution is refused", True)

    check("estimate grows with JPEG quality",
          p.estimate_bytes("jpeg", 95) > p.estimate_bytes("jpeg", 70))
    check("lossless estimate exceeds JPEG",
          p.estimate_bytes("deflate") > p.estimate_bytes("jpeg", 90))


def test_world_file(tmp: Path) -> None:
    print("\n[world file]")
    src = make_ortho(tmp / "wf.tif", width=600, height=400, res=0.05)
    info = od.inspect(src)
    p = od.build_plan(info, 20.0, "cm", target_epsg=None)
    out = tmp / "wf_out.tif"
    shutil.copy(src, out)
    written = write_sidecars(out, p)
    check("a .tfw and a .prj are written", len(written) == 2, str(written))

    vals = [float(x) for x in Path(str(out.with_suffix(".tfw"))).read_text().split()]
    t = p.transform
    check("world file line 1 is the x pixel size", near(vals[0], t.a, 1e-9))
    check("world file line 4 is the negative y pixel size", near(vals[3], t.e, 1e-9))
    # The half-pixel corner-vs-centre convention is the classic silent error.
    check("world file stores the CENTRE of the upper-left pixel",
          near(vals[4], t.c + t.a / 2.0, 1e-9) and near(vals[5], t.f + t.e / 2.0, 1e-9))
    check("world file is not storing the corner", not near(vals[4], t.c, 1e-9))

    rebuilt = Affine(vals[0], vals[2], vals[4] - vals[0] / 2.0,
                     vals[1], vals[3], vals[5] - vals[3] / 2.0)
    err = max(abs(getattr(rebuilt, k) - getattr(t, k)) for k in "abcdef")
    check("world file round-trips to the transform exactly", err < 1e-6, f"err {err:.2e}")
    check(".prj is ESRI WKT1", "PROJCS" in out.with_suffix(".prj").read_text()[:200])


def test_convert(tmp: Path) -> None:
    print("\n[conversion]")
    src = make_ortho(tmp / "conv.tif", width=1600, height=1200, res=0.01)
    info = od.inspect(src)
    # 2 cm keeps the output past the 256 px floor where overviews start earning
    # their keep, so the overview assertion below is meaningful.
    p = od.build_plan(info, 2.0, "cm", target_epsg=None)

    r = od.convert(p, od.Options(codec="jpeg", quality=90, output_dir=str(tmp),
                                 suffix="_jpg", overwrite=True))
    check("JPEG conversion succeeds", r.ok, r.message)
    check("JPEG output is smaller than the source", r.output_bytes < r.source_bytes,
          f"{r.output_mb:.2f} vs {r.source_mb:.2f} MB")
    check("two sidecars accompany the output", len(r.sidecars) == 2)
    with rasterio.open(r.output_path) as ds:
        check("JPEG output holds 3 bands", ds.count == 3, str(ds.count))
        check("JPEG output carries an internal mask",
              ds.mask_flag_enums[0][0].name == "per_dataset",
              str(ds.mask_flag_enums[0]))
        check("output dimensions match the plan", (ds.width, ds.height) == (p.width, p.height))
        check("output transform matches the plan",
              max(abs(getattr(ds.transform, k) - getattr(p.transform, k))
                  for k in "abcdef") < 1e-9)
        check("overviews were built", len(ds.overviews(1)) > 0)
        rgb = ds.read([1, 2, 3])
        m = ds.dataset_mask()
        outside = m < 128
        check("outside the footprint is filled white, not left black",
              outside.any() and rgb[:, outside].mean() > 230,
              f"mean {rgb[:, outside].mean():.1f}")

    r2 = od.convert(p, od.Options(codec="deflate", output_dir=str(tmp),
                                  suffix="_lossless", overwrite=True, fast=False))
    check("lossless conversion succeeds", r2.ok, r2.message)
    with rasterio.open(r2.output_path) as ds:
        check("lossless output keeps 4 bands", ds.count == 4, str(ds.count))
        check("band 4 is tagged as alpha", ds.colorinterp[3] == ColorInterp.alpha)
        a = ds.read(4)
        check("alpha is a real range, not all-opaque", a.min() == 0 and a.max() == 255)
    check("lossless is larger than JPEG", r2.output_bytes > r.output_bytes)

    black = od.convert(p, od.Options(codec="jpeg", background="black", output_dir=str(tmp),
                                     suffix="_black", overwrite=True))
    with rasterio.open(black.output_path) as ds:
        outside = ds.dataset_mask() < 128
        check("black fill is honoured", ds.read([1, 2, 3])[:, outside].mean() < 25)

    # guardrails
    same = od.convert(p, od.Options(output_dir=str(src.parent), suffix="", overwrite=True))
    check("refuses to overwrite its own source", not same.ok and "overwrite the source" in same.message,
          same.message)
    again = od.convert(p, od.Options(codec="jpeg", output_dir=str(tmp), suffix="_jpg",
                                     overwrite=False))
    check("refuses to clobber an existing output", not again.ok and "already exists" in again.message,
          again.message)

    rgb_only = make_ortho(tmp / "rgb.tif", width=400, height=300, res=0.02, alpha=False)
    ri = od.inspect(rgb_only)
    check("a 3-band source reports no alpha", not ri.has_alpha)
    rp = od.build_plan(ri, 8.0, "cm", target_epsg=None)
    r3 = od.convert(rp, od.Options(codec="jpeg", output_dir=str(tmp), suffix="_rgb",
                                   overwrite=True))
    check("a source without alpha still converts", r3.ok, r3.message)


def test_overview_choice(tmp: Path) -> None:
    print("\n[overview acceleration]")
    src = make_ortho(tmp / "ovr.tif", width=2048, height=2048, res=0.01)
    with rasterio.open(src, "r+") as ds:
        ds.build_overviews([2, 4, 8, 16], rasterio.enums.Resampling.average)

    with rasterio.open(src) as ds:
        lvl = od.pick_overview_level(ds, target_width=256)
        check("a coarse target picks a coarse overview", lvl is not None and lvl >= 1, str(lvl))
        chosen_w = ds.width / ds.overviews(1)[lvl]
        check("the chosen overview stays finer than the target by the safety margin",
              chosen_w >= 256 * od.OVERVIEW_SAFETY, f"{chosen_w} vs {256*od.OVERVIEW_SAFETY}")
        check("a target finer than every overview uses no overview",
              od.pick_overview_level(ds, target_width=1500) is None)
        # Between the preferred margin and the floor the finest overview is
        # still worth using; falling back to full resolution would cost 16x the
        # work for imagery that gets averaged down anyway.
        mid = int(ds.width / 2 / 1.4)          # 2x overview is 1.4x finer: below
        lvl_mid = od.pick_overview_level(ds, target_width=mid)   # safety 2.0, above floor
        check("the floor rescues a target between the margin and 1.0",
              lvl_mid == 0, f"{lvl_mid} for target {mid}")
        check("level 0 is not lost to the falsy-zero trap", lvl_mid is not None)

    plain = make_ortho(tmp / "noovr.tif", width=300, height=300, res=0.02)
    with rasterio.open(plain) as ds:
        check("a source without overviews returns None",
              od.pick_overview_level(ds, target_width=50) is None)


def test_verify(tmp: Path) -> None:
    print("\n[geolocation verification]")
    src = make_ortho(tmp / "ver.tif", width=1600, height=1200, res=0.01)
    info = od.inspect(src)
    p = od.build_plan(info, 4.0, "cm", target_epsg=None)
    good = od.convert(p, od.Options(codec="deflate", output_dir=str(tmp),
                                    suffix="_good", overwrite=True, fast=False))
    check("reference conversion succeeded", good.ok, good.message)

    v = od.verify_geolocation(src, good.output_path)
    check("a correct output verifies PASS", v.ok, v.message)
    check("the minimum sits at zero shift", (v.dx, v.dy) == (0, 0), f"({v.dx},{v.dy})")
    check("the window had texture to lock onto", v.textured)
    check("zero shift clearly beats its neighbours",
          v.score_zero < v.neighbour_score * 0.5,
          f"zero {v.score_zero:.3f} vs neighbour {v.neighbour_score:.3f}")
    check("residual shift is sub-pixel", v.shift_ground < abs(p.transform.a),
          f"{v.shift_ground}")

    # THE test: corrupt the georeferencing and require a FAIL.
    shifted = tmp / "shifted.tif"
    shutil.copy(good.output_path, shifted)
    with rasterio.open(shifted, "r+") as ds:
        t = ds.transform
        ds.transform = Affine(t.a, t.b, t.c + 3 * t.a, t.d, t.e, t.f + 3 * t.e)
    sv = od.verify_geolocation(src, shifted)
    check("a 3-pixel georeferencing error is caught", not sv.ok, sv.message)
    check("the reported offset matches the injected one",
          abs(sv.dx) == 3 or abs(sv.dy) == 3, f"({sv.dx},{sv.dy})")
    check("the failure message says not to deliver it", "do not deliver" in sv.message.lower())

    # A half-pixel error is subtler; the parabola should still see it.
    half = tmp / "half.tif"
    shutil.copy(good.output_path, half)
    with rasterio.open(half, "r+") as ds:
        t = ds.transform
        ds.transform = Affine(t.a, t.b, t.c + 0.5 * t.a, t.d, t.e, t.f)
    hv = od.verify_geolocation(src, half)
    check("a half-pixel error shows up in the sub-pixel residual",
          hv.shift_ground > 0.2 * abs(p.transform.a), f"{hv.shift_ground:.4f}")


def test_reproject_verify(tmp: Path) -> None:
    print("\n[reprojection end to end]")
    src = make_ortho(tmp / "rp.tif", width=1400, height=1100, res=0.01,
                     epsg=32610, left=600000.0, top=4255000.0)
    info = od.inspect(src)
    p = od.build_plan(info, 5.0, "cm", target_epsg=6416)
    check("plan targets the requested EPSG", p.dst_epsg == 6416)
    check("target unit is the US survey foot", "foot" in p.dst_units.lower(), p.dst_units)

    r = od.convert(p, od.Options(codec="deflate", output_dir=str(tmp), suffix="_rp",
                                 overwrite=True, fast=False))
    check("reprojecting conversion succeeds", r.ok, r.message)
    with rasterio.open(r.output_path) as ds:
        check("output carries the target CRS", ds.crs.to_epsg() == 6416, str(ds.crs))
        px_ft = abs(ds.transform.a)
        check("output pixel is 5 cm expressed in ftUS",
              near(px_ft * (1200 / 3937), 0.05, 1e-6), f"{px_ft} ftUS")

    v = od.verify_geolocation(src, r.output_path)
    check("the reprojected output verifies PASS", v.ok, v.message)
    check("reprojected residual is sub-pixel", v.shift_ground < abs(p.transform.a),
          f"{v.shift_ground} vs {abs(p.transform.a)}")


def test_paths() -> None:
    print("\n[path handling]")
    short = "C:\\jobs\\a.tif"
    check("a short path is untouched", long_path(short) == short)
    deep = "C:\\" + "\\".join(["averyverylongfoldername"] * 12) + "\\ortho.tif"
    out = long_path(deep)
    if os.name == "nt":
        check("a long path gets the extended-length prefix", out.startswith("\\\\?\\"), out[:12])
        check("prefixing is not applied twice", long_path(out) == out)
    else:
        check("non-Windows paths are untouched", out == deep)


class _StatusBlob:
    """In-memory stand-in for a GCS blob. A mismatched generation is a 412."""

    def __init__(self, doc: dict, generation: int) -> None:
        self.doc = doc
        self.generation = generation
        self.uploads: list[int] = []

    def reload(self) -> None:
        return None

    def download_as_bytes(self) -> bytes:
        return json.dumps(self.doc).encode("utf-8")

    def upload_from_string(self, data: str, content_type: str | None = None, if_generation_match: int | None = None) -> None:
        if if_generation_match != self.generation:
            err = RuntimeError("generation mismatch")
            err.code = 412  # type: ignore[attr-defined]
            raise err
        self.uploads.append(if_generation_match)
        self.generation += 1
        self.doc = json.loads(data)


def test_output_suffix() -> None:
    print("\n-- output suffix --")
    check("reproject names the file by EPSG", gcs_export.output_suffix(False, 2225) == "_2225")
    check("keep-CRS keeps the small suffix", gcs_export.output_suffix(True, 2225) == "_small")
    check("missing EPSG keeps the small suffix", gcs_export.output_suffix(False, None) == "_small")


def test_status_fence() -> None:
    print("\n-- status fence --")
    check("a claim owns only its own record", gcs_export.claim_owns({"claim": "a"}, "a"))
    check("a different claim does not own the record", not gcs_export.claim_owns({"claim": "a"}, "b"))
    check("an empty claim owns nothing", not gcs_export.claim_owns({"claim": ""}, ""))
    check("a running record may publish", gcs_export.publish_allowed({"claim": "a", "status": "running"}, "a"))
    check("a succeeded record may not publish", not gcs_export.publish_allowed({"claim": "a", "status": "succeeded"}, "a"))

    blob = _StatusBlob({"claim": "ours", "status": "queued", "startedAt": "t0"}, 7)
    status = gcs_export._Status("b", "k", "ours", blob=blob)
    status.write(status="running", execution="exec-1", claim="stolen")
    check("a matching claim writes with if_generation_match", blob.uploads == [7], str(blob.uploads))
    check("the write cannot replace the claim", blob.doc["claim"] == "ours" and blob.doc["status"] == "running")
    check("the execution token is recorded on the owned record", blob.doc["execution"] == "exec-1")

    foreign = _StatusBlob({"claim": "replacement", "status": "queued"}, 3)
    lost = False
    try:
        gcs_export._Status("b", "k", "ours", blob=foreign).write(status="succeeded", outputs=["odm_orthophoto/x.tif"])
    except gcs_export.LeaseLost:
        lost = True
    check("a replaced claim is not overwritten", lost and foreign.uploads == [] and foreign.doc["status"] == "queued")

    raced = _StatusBlob({"claim": "ours", "status": "running"}, 9)

    def clash(data: str, content_type: str | None = None, if_generation_match: int | None = None) -> None:
        err = RuntimeError("precondition")
        err.code = 412  # type: ignore[attr-defined]
        raise err

    raced.upload_from_string = clash  # type: ignore[method-assign]
    raced_lost = False
    try:
        gcs_export._Status("b", "k", "ours", blob=raced).write(status="failed")
    except gcs_export.LeaseLost:
        raced_lost = True
    check("a generation change rejects the write", raced_lost and raced.doc["status"] == "running")

    owned = gcs_export._Status("b", "k", "ours", blob=_StatusBlob({"claim": "ours"}, 1))
    owned.assert_owns()
    refused = False
    try:
        gcs_export._Status("b", "k", "ours", blob=_StatusBlob({"claim": "other"}, 1)).assert_owns()
    except gcs_export.LeaseLost:
        refused = True
    check("output publish is refused when the claim changed", refused)

    gcs_export._Status("b", "k", "ours", blob=_StatusBlob({"claim": "ours", "status": "running"}, 4)).assert_running()
    inactive = False
    try:
        gcs_export._Status("b", "k", "ours", blob=_StatusBlob({"claim": "ours", "status": "succeeded"}, 4)).assert_running()
    except gcs_export.LeaseLost:
        inactive = True
    check("publish is refused once the record is no longer running", inactive)


def test_gcs_uri() -> None:
    print("\n-- gs:// paths --")
    bucket, key = gcs_export.parse_gs(
        "gs://asc-nodeodm-outputs-prod/outputs/Job/odm_orthophoto/odm_orthophoto.tif")
    check("parse_gs splits bucket and object",
          bucket == "asc-nodeodm-outputs-prod" and key.endswith("odm_orthophoto.tif"))
    check("gs_to_vsi uses the GDAL prefix",
          gcs_export.gs_to_vsi("gs://b/outputs/p/odm_orthophoto/odm_orthophoto.tif")
          == "/vsigs/b/outputs/p/odm_orthophoto/odm_orthophoto.tif")
    dest_bucket, prefix = gcs_export.split_gs_prefix(
        "gs://b/outputs/p/odm_orthophoto/")
    check("split_gs_prefix drops a trailing slash",
          dest_bucket == "b" and prefix == "outputs/p/odm_orthophoto")
    raised = False
    try:
        gcs_export.parse_gs("gs://bucket-only")
    except ValueError:
        raised = True
    check("parse_gs rejects a URI with no object", raised)

    dest_key = "outputs/p/odm_orthophoto"
    check("stage_key accepts the .uploads staging area",
          gcs_export.stage_key("gs://b/outputs/.uploads/cad-export/p/claim1", "b", dest_key)
          == "outputs/.uploads/cad-export/p/claim1")
    for bad in ("gs://other/outputs/.uploads/cad-export/p/claim1",
                "gs://b/outputs/p/odm_orthophoto/.cad-claim/claim1",
                "gs://b/outputs/p/staging",
                "gs://b/outputs/p/odm_orthophoto",
                ""):
        rejected = False
        try:
            gcs_export.stage_key(bad, "b", dest_key)
        except ValueError:
            rejected = True
        check(f"stage_key rejects {bad or 'an empty prefix'!r}", rejected)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="ortho_downsizer_tests_"))
    print(f"Drone Ortho Downsizer -- test suite\nscratch: {tmp}")
    try:
        for fn, needs_tmp in (
            (test_units, False), (test_crs_search, False), (test_plan, True),
            (test_world_file, True), (test_convert, True), (test_overview_choice, True),
            (test_verify, True), (test_reproject_verify, True), (test_paths, False),
            (test_output_suffix, False), (test_status_fence, False), (test_gcs_uri, False),
        ):
            try:
                fn(tmp) if needs_tmp else fn()
            except Exception:  # noqa: BLE001
                global FAILED
                FAILED += 1
                _FAILURES.append(fn.__name__)
                print(f"  ERROR in {fn.__name__}:\n{traceback.format_exc()}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total = PASSED + FAILED
    print(f"\n{'='*60}\n{PASSED}/{total} checks passed")
    if _FAILURES:
        print("failed: " + ", ".join(_FAILURES))
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
