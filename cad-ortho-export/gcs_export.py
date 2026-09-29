"""Cloud Run entrypoint: downsize one orthophoto already stored in GCS.

The source is opened through GDAL's ``/vsigs/`` filesystem so a multi-gigabyte
GeoTIFF is range-read instead of downloaded. The small GeoTIFF and its
``.tfw`` / ``.prj`` sidecars are written under ``/tmp`` and uploaded next to
the source. Status is ``odm_orthophoto/cad_export.json`` in the same prefix.

Environment (set per execution by the NodeODM reference node):

    CAD_EXPORT_SOURCE         gs://bucket/outputs/<project>/odm_orthophoto/odm_orthophoto.tif
    CAD_EXPORT_DEST_PREFIX    gs://bucket/outputs/<project>/odm_orthophoto
    CAD_EXPORT_GSD            target ground sample distance (default 5)
    CAD_EXPORT_UNIT           cm | m | ft (US survey)
    CAD_EXPORT_KEEP_CRS       true to resample without reprojecting
    CAD_EXPORT_EPSG           required unless KEEP_CRS is true
    CAD_EXPORT_SOURCE_BYTES   optional object size; /vsigs has no local stat
    CAD_EXPORT_CLAIM          lease minted into the queued status object. Every
                              status write and the output upload are refused
                              unless the live object still carries this claim.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Same floor the API enforces. Finer than 1 cm on a corridor ortho is a unit
# slip that asks the job to write a raster larger than the source.
_MIN_GSD_METRES = 0.01
_MAX_GSD_METRES = 10.0
_EXPORT_UNITS = ("cm", "m", "ft (US survey)")

STATUS_NAME = "cad_export.json"


def parse_gs(uri: str) -> tuple[str, str]:
    """Split ``gs://bucket/object`` into ``(bucket, object)``."""
    text = str(uri or "").strip()
    if not text.startswith("gs://"):
        raise ValueError(f"Not a gs:// URI: {text!r}")
    rest = text[5:]
    bucket, sep, key = rest.partition("/")
    if not bucket or not sep or not key or key.endswith("/"):
        raise ValueError(f"gs:// URI needs a bucket and an object name: {text!r}")
    return bucket, key


def gs_to_vsi(uri: str) -> str:
    """GDAL path for a ``gs://`` object."""
    bucket, key = parse_gs(uri)
    return f"/vsigs/{bucket}/{key}"


def split_gs_prefix(uri: str) -> tuple[str, str]:
    """Split ``gs://bucket/some/prefix`` into ``(bucket, some/prefix)``."""
    bucket, key = parse_gs(str(uri or "").strip().rstrip("/") + "/" + STATUS_NAME)
    suffix = "/" + STATUS_NAME
    if not key.endswith(suffix):
        raise ValueError(f"Could not split prefix {uri!r}.")
    return bucket, key[: -len(suffix)]


def _gsd_metres(gsd: float, unit: str) -> float:
    import ortho_downsizer as od

    factor = od.LENGTH_UNITS.get(unit)
    if factor is None:
        raise ValueError(f"Unsupported unit {unit!r}.")
    return float(gsd) * factor


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


class LeaseLost(Exception):
    """This execution no longer owns the queued status object."""


def claim_owns(doc: object, claim: str) -> bool:
    """True when ``doc`` is the status record minted for ``claim``."""
    if not claim or not isinstance(doc, dict):
        return False
    return doc.get("claim") == claim


def _generation_conflict(exc: BaseException) -> bool:
    code = getattr(exc, "code", None)
    return type(exc).__name__ in ("PreconditionFailed", "NotFound") or code in (404, 412, "404", "412")


class _Status:
    """Status writer fenced to one claim.

    A replacement export writes a new claim with ``ifGenerationMatch``. This
    writer reloads before every update and publishes only when the live object
    still has our claim and that generation, so a stale execution cannot
    overwrite ``running``, ``failed``, or ``succeeded``.
    """

    def __init__(self, bucket: str, key: str, claim: str, blob: object = None) -> None:
        if blob is None:
            from google.cloud import storage

            blob = storage.Client().bucket(bucket).blob(key)
        self._blob = blob
        self.claim = claim
        self.doc: dict = {}

    def _live(self) -> tuple[dict, int]:
        try:
            self._blob.reload()
            payload = json.loads(self._blob.download_as_bytes())
        except Exception as exc:
            if _generation_conflict(exc):
                raise LeaseLost("CAD export status is gone.") from exc
            raise
        generation = getattr(self._blob, "generation", None)
        if not claim_owns(payload, self.claim) or generation is None:
            raise LeaseLost("CAD export status belongs to another execution.")
        return payload, int(generation)

    def assert_owns(self) -> None:
        """Raise ``LeaseLost`` when this execution may no longer publish output."""
        self._live()

    def write(self, **fields: object) -> None:
        payload, generation = self._live()
        fields.pop("claim", None)
        payload.update(fields)
        payload["claim"] = self.claim
        body = json.dumps(payload, indent=2) + "\n"
        try:
            self._blob.upload_from_string(
                body,
                content_type="application/json",
                if_generation_match=generation,
            )
        except Exception as exc:
            if _generation_conflict(exc):
                raise LeaseLost("CAD export status changed before the update.") from exc
            raise
        self.doc = payload


def _stage_prefix(dest_prefix: str, claim: str) -> str:
    return f"{dest_prefix.rstrip('/')}/.cad-claim/{claim}"


def _upload_outputs(bucket_name: str, dest_prefix: str, paths: list[Path]) -> list[str]:
    from google.cloud import storage

    bucket = storage.Client().bucket(bucket_name)
    written: list[str] = []
    types = {".tif": "image/tiff", ".tiff": "image/tiff", ".tfw": "text/plain", ".prj": "text/plain"}
    for path in paths:
        key = f"{dest_prefix.rstrip('/')}/{path.name}"
        blob = bucket.blob(key)
        blob.upload_from_filename(str(path), content_type=types.get(path.suffix.lower(), "application/octet-stream"))
        written.append(path.name)
    return written


def _delete_staged(bucket_name: str, dest_prefix: str, claim: str, names: list[str]) -> None:
    from google.cloud import storage

    bucket = storage.Client().bucket(bucket_name)
    stage = _stage_prefix(dest_prefix, claim)
    for name in names:
        try:
            bucket.blob(f"{stage}/{name}").delete()
        except Exception as exc:  # noqa: BLE001
            if not _generation_conflict(exc):
                print(f"[FAIL] could not delete staged {name}: {exc}")


def _publish_staged(bucket_name: str, dest_prefix: str, claim: str, names: list[str]) -> None:
    """Copy claim-scoped uploads onto the public orthophoto names."""
    from google.cloud import storage

    bucket = storage.Client().bucket(bucket_name)
    stage = _stage_prefix(dest_prefix, claim)
    final = dest_prefix.rstrip("/")
    for name in names:
        bucket.copy_blob(bucket.blob(f"{stage}/{name}"), bucket, f"{final}/{name}")


def _source_bytes_from_gcs(uri: str) -> int:
    raw = os.environ.get("CAD_EXPORT_SOURCE_BYTES", "").strip()
    if raw.isdigit():
        return int(raw)
    from google.cloud import storage

    bucket_name, key = parse_gs(uri)
    blob = storage.Client().bucket(bucket_name).get_blob(key)
    if blob is None or not blob.size:
        return 0
    return int(blob.size)


def _record_failure(status: _Status, **fields: object) -> None:
    try:
        status.write(**fields)
    except LeaseLost as exc:
        print(f"[FAIL] {exc}")
    except Exception as write_exc:  # noqa: BLE001
        print(f"[FAIL] could not record status: {write_exc}")


def main() -> int:
    source = os.environ.get("CAD_EXPORT_SOURCE", "").strip()
    dest = os.environ.get("CAD_EXPORT_DEST_PREFIX", "").strip()
    claim = os.environ.get("CAD_EXPORT_CLAIM", "").strip()
    if not claim:
        print("[FAIL] CAD_EXPORT_CLAIM is required.")
        return 2
    try:
        gsd = float(os.environ.get("CAD_EXPORT_GSD", "5"))
        unit = os.environ.get("CAD_EXPORT_UNIT", "cm").strip()
        keep = _env_flag("CAD_EXPORT_KEEP_CRS")
        epsg_raw = os.environ.get("CAD_EXPORT_EPSG", "").strip()
        epsg = int(epsg_raw) if epsg_raw else None
        if unit not in _EXPORT_UNITS:
            raise ValueError(f"Unsupported unit {unit!r}.")
        metres = _gsd_metres(gsd, unit)
        if metres < _MIN_GSD_METRES or metres > _MAX_GSD_METRES:
            raise ValueError(
                f"Ground resolution {gsd} {unit} is outside {_MIN_GSD_METRES}-{_MAX_GSD_METRES} m."
            )
        if not keep and epsg is None:
            raise ValueError("Set CAD_EXPORT_EPSG or CAD_EXPORT_KEEP_CRS=true.")
        src_bucket, _src_key = parse_gs(source)
        dest_bucket, dest_key = split_gs_prefix(dest)
        if src_bucket != dest_bucket:
            raise ValueError("Source and destination must be in the same bucket.")
    except (ValueError, TypeError) as exc:
        print(f"[FAIL] {exc}")
        dest_raw = os.environ.get("CAD_EXPORT_DEST_PREFIX", "").strip()
        try:
            fail_bucket, fail_key = split_gs_prefix(dest_raw)
            _record_failure(
                _Status(fail_bucket, f"{fail_key}/{STATUS_NAME}", claim),
                status="failed",
                finishedAt=_utcnow(),
                error=str(exc),
                execution=os.environ.get("CLOUD_RUN_EXECUTION") or None,
            )
        except ValueError as write_exc:
            print(f"[FAIL] could not record status: {write_exc}")
        return 2

    status_key = f"{dest_key}/{STATUS_NAME}"
    status = _Status(dest_bucket, status_key, claim)
    params = {
        "gsd": gsd,
        "unit": unit,
        "keepCrs": keep,
        "epsg": None if keep else epsg,
    }
    try:
        status.write(
            status="running",
            params=params,
            startedAt=_utcnow(),
            finishedAt=None,
            execution=os.environ.get("CLOUD_RUN_EXECUTION") or None,
            error=None,
            verify=None,
            outputs=[],
            sourceBytes=0,
            outputBytes=0,
            seconds=0,
        )
    except LeaseLost as exc:
        print(f"[FAIL] {exc}")
        return 1
    print(f"CAD export running: {source}")
    print(f"  gsd={gsd} {unit} keepCrs={keep} epsg={params['epsg']}")

    try:
        vsi = gs_to_vsi(source)
        import ortho_downsizer as od

        info = od.inspect(vsi)
        if info.file_bytes <= 0:
            info.file_bytes = _source_bytes_from_gcs(source)
        plan = od.build_plan(
            info, gsd, unit, target_epsg=None if keep else epsg,
        )
        out_dir = Path("/tmp/cad-export")
        out_dir.mkdir(parents=True, exist_ok=True)
        opts = od.Options(
            codec="jpeg",
            quality=90,
            background="white",
            overviews=True,
            sidecars=True,
            resampling="average",
            output_dir=str(out_dir),
            suffix="_small",
            overwrite=True,
            fast=True,
        )
        print(f"  {plan.describe()}")

        last = [-1]

        def progress(frac: float, msg: str) -> None:
            pct = int(frac * 100)
            if pct >= last[0] + 10:
                last[0] = pct
                print(f"    {pct:3d}%  {msg}")

        result = od.convert(plan, opts, progress=progress)
        if not result.ok:
            _record_failure(
                status,
                status="failed",
                finishedAt=_utcnow(),
                error=result.message,
                seconds=result.seconds,
                sourceBytes=info.file_bytes,
            )
            print(f"[FAIL] {result.message}")
            return 1

        verify_doc = None
        try:
            verdict = od.verify_geolocation(vsi, result.output_path)
            verify_doc = {"ok": verdict.ok, "message": verdict.message}
            print(f"  [{verdict.verdict}] geolocation: {verdict.message}")
        except Exception as exc:  # noqa: BLE001
            verify_doc = {"ok": False, "message": f"{type(exc).__name__}: {exc}"}
            print(f"  [FAIL] geolocation check: {verify_doc['message']}")

        paths = [Path(result.output_path)] + [Path(p) for p in result.sidecars]
        # Stage under the claim, then record success only if this execution
        # still owns the status object. The public names are copied after that
        # write, so a replaced execution cannot publish its TIFF.
        names = _upload_outputs(dest_bucket, _stage_prefix(dest_key, claim), paths)
        try:
            status.write(
                status="succeeded",
                finishedAt=_utcnow(),
                error=None,
                verify=verify_doc,
                outputs=[f"odm_orthophoto/{name}" for name in names],
                sourceBytes=result.source_bytes or info.file_bytes,
                outputBytes=result.output_bytes,
                seconds=result.seconds,
            )
        except LeaseLost as exc:
            _delete_staged(dest_bucket, dest_key, claim, names)
            print(f"[FAIL] {exc}")
            return 1
        try:
            _publish_staged(dest_bucket, dest_key, claim, names)
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] could not publish CAD export: {exc}")
            _record_failure(
                status,
                status="failed",
                finishedAt=_utcnow(),
                error=f"Could not publish CAD export: {exc}",
            )
            _delete_staged(dest_bucket, dest_key, claim, names)
            return 1
        _delete_staged(dest_bucket, dest_key, claim, names)
        print(f"[OK] {result.message} in {result.seconds:.1f}s")
        return 0
    except LeaseLost as exc:
        print(f"[FAIL] {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] {type(exc).__name__}: {exc}")
        traceback.print_exc()
        _record_failure(
            status,
            status="failed",
            finishedAt=_utcnow(),
            error=f"{type(exc).__name__}: {exc}",
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
