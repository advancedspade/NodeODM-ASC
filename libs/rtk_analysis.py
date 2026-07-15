#!/usr/bin/env python3
"""Read DJI image metadata and perform RTK positioning quality analysis."""

from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
import statistics
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Optional

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".tif", ".tiff", ".dng", ".png"}

EXIFTOOL_TAGS = [
    "FileName",
    "CreateDate",
    "GPSLatitude",
    "GPSLongitude",
    "GPSAltitude",
    "GpsStatus",
    "AltitudeType",
    "AbsoluteAltitude",
    "RelativeAltitude",
    "RtkFlag",
    "RtkStdLon",
    "RtkStdLat",
    "RtkStdHgt",
    "RtkDiffAge",
    "SurveyingMode",
    "DroneModel",
    "ProductName",
]

RTK_FLAG_LABELS = {
    0: "No positioning",
    16: "Single point",
    50: "RTK fixed",
}

MAP_CATEGORIES = {
    "Fix": {"color_kml": "ff00ff00", "color_hex": "#00ff00"},
    "Fix+Warn": {"color_kml": "ff00ffff", "color_hex": "#ffff00"},
    "Float": {"color_kml": "ff0080ff", "color_hex": "#ff8000"},
    "Single": {"color_kml": "ff0000ff", "color_hex": "#ff0000"},
}

KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)


def map_category(rtk_flag: Optional[int], quality: str) -> str:
    if rtk_flag == 50:
        return "Fix+Warn" if quality == "WARN" else "Fix"
    if rtk_flag is not None and 34 <= rtk_flag <= 49:
        return "Float"
    return "Single"


def parse_coordinate(value: str) -> Optional[float]:
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def classify_rtk_flag(flag: Optional[int]) -> str:
    if flag is None:
        return "Missing"
    if flag in RTK_FLAG_LABELS:
        return RTK_FLAG_LABELS[flag]
    if 34 <= flag <= 49:
        return "RTK float"
    return f"Unknown ({flag})"


def parse_float(value: str) -> Optional[float]:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_int(value: str) -> Optional[int]:
    parsed = parse_float(value)
    if parsed is None:
        return None
    return int(parsed)


def horizontal_accuracy(std_lon: Optional[float], std_lat: Optional[float]) -> Optional[float]:
    if std_lon is None or std_lat is None:
        return None
    return math.hypot(std_lon, std_lat)


def vertical_accuracy(std_hgt: Optional[float]) -> Optional[float]:
    return std_hgt


def positional_accuracy_3d(
    std_lon: Optional[float], std_lat: Optional[float], std_hgt: Optional[float]
) -> Optional[float]:
    if std_lon is None or std_lat is None or std_hgt is None:
        return None
    return math.sqrt(std_lon**2 + std_lat**2 + std_hgt**2)


def assess_quality(
    rtk_flag: Optional[int],
    std_lon: Optional[float],
    std_lat: Optional[float],
    std_hgt: Optional[float],
    diff_age: Optional[float],
    gps_status: str,
) -> tuple[str, list[str]]:
    issues: list[str] = []

    if gps_status and gps_status.upper() != "RTK":
        issues.append(f"GPS status is '{gps_status}', not RTK")

    if rtk_flag is None:
        issues.append("Missing RtkFlag")
    elif rtk_flag == 50:
        pass
    elif 34 <= (rtk_flag or -1) <= 49:
        issues.append(f"RTK float solution (flag {rtk_flag})")
    elif rtk_flag == 16:
        issues.append("Single-point positioning (no RTK fix)")
    elif rtk_flag == 0:
        issues.append("No positioning solution")
    else:
        issues.append(f"Unrecognized RtkFlag value ({rtk_flag})")

    horiz = horizontal_accuracy(std_lon, std_lat)
    if horiz is not None and horiz > 0.05:
        issues.append(f"Horizontal std dev {horiz:.4f} m exceeds 5 cm")
    if std_hgt is not None and std_hgt > 0.10:
        issues.append(f"Vertical std dev {std_hgt:.4f} m exceeds 10 cm")
    if diff_age is not None and diff_age > 3.0:
        issues.append(f"Correction age {diff_age:.1f} s exceeds 3 s")

    if not issues:
        return "PASS", issues
    if rtk_flag == 50 and all(
        "std dev" not in issue and "Correction age" not in issue for issue in issues
    ):
        return "WARN", issues
    if rtk_flag == 50:
        return "WARN", issues
    return "FAIL", issues


@dataclass
class ImageRtkRecord:
    filename: str
    filepath: str
    create_date: str
    gps_latitude: str
    gps_longitude: str
    gps_altitude: str
    gps_status: str
    altitude_type: str
    absolute_altitude: Optional[float]
    relative_altitude: Optional[float]
    rtk_flag: Optional[int]
    rtk_solution: str
    rtk_std_lon: Optional[float]
    rtk_std_lat: Optional[float]
    rtk_std_hgt: Optional[float]
    rtk_diff_age: Optional[float]
    surveying_mode: Optional[int]
    horizontal_std_m: Optional[float]
    vertical_std_m: Optional[float]
    positional_std_3d_m: Optional[float]
    quality: str
    map_category: str
    issues: str
    drone_model: str
    product_name: str


def find_exiftool() -> str:
    exiftool = shutil.which("exiftool")
    if not exiftool:
        raise RuntimeError(
            "ExifTool is required but was not found on PATH. "
            "Install from https://exiftool.org/ and try again."
        )
    return exiftool


def iter_images(folder: Path) -> list[Path]:
    images = [
        path
        for path in sorted(folder.iterdir())
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not images:
        raise FileNotFoundError(f"No supported image files found in {folder}")
    return images


def read_metadata_with_exiftool(exiftool: str, folder: Path) -> list[dict[str, str]]:
    tag_args = [f"-{tag}" for tag in EXIFTOOL_TAGS]
    extensions: set[str] = set()
    for ext in IMAGE_EXTENSIONS:
        bare = ext.lstrip(".")
        extensions.add(bare.lower())
        extensions.add(bare.upper())
    ext_args = [part for ext in sorted(extensions) for part in ("-ext", ext)]
    command = [exiftool, "-json", "-n", *tag_args, *ext_args, str(folder)]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(f"ExifTool failed:\n{result.stderr}")
    if not result.stdout.strip():
        raise RuntimeError("ExifTool returned no metadata.")
    return json.loads(result.stdout)


def build_record(raw: dict[str, object], folder: Path) -> ImageRtkRecord:
    source = str(raw.get("SourceFile", ""))
    path = Path(source)
    filename = str(raw.get("FileName") or path.name)

    rtk_flag = parse_int(str(raw.get("RtkFlag", "") or ""))
    std_lon = parse_float(str(raw.get("RtkStdLon", "") or ""))
    std_lat = parse_float(str(raw.get("RtkStdLat", "") or ""))
    std_hgt = parse_float(str(raw.get("RtkStdHgt", "") or ""))
    diff_age = parse_float(str(raw.get("RtkDiffAge", "") or ""))
    gps_status = str(raw.get("GpsStatus") or "")

    quality, issues = assess_quality(rtk_flag, std_lon, std_lat, std_hgt, diff_age, gps_status)

    return ImageRtkRecord(
        filename=filename,
        filepath=str(path if path.is_absolute() else folder / filename),
        create_date=str(raw.get("CreateDate") or ""),
        gps_latitude=str(raw.get("GPSLatitude") or ""),
        gps_longitude=str(raw.get("GPSLongitude") or ""),
        gps_altitude=str(raw.get("GPSAltitude") or ""),
        gps_status=gps_status,
        altitude_type=str(raw.get("AltitudeType") or ""),
        absolute_altitude=parse_float(str(raw.get("AbsoluteAltitude") or "")),
        relative_altitude=parse_float(str(raw.get("RelativeAltitude") or "")),
        rtk_flag=rtk_flag,
        rtk_solution=classify_rtk_flag(rtk_flag),
        rtk_std_lon=std_lon,
        rtk_std_lat=std_lat,
        rtk_std_hgt=std_hgt,
        rtk_diff_age=diff_age,
        surveying_mode=parse_int(str(raw.get("SurveyingMode") or "")),
        horizontal_std_m=horizontal_accuracy(std_lon, std_lat),
        vertical_std_m=vertical_accuracy(std_hgt),
        positional_std_3d_m=positional_accuracy_3d(std_lon, std_lat, std_hgt),
        quality=quality,
        map_category=map_category(rtk_flag, quality),
        issues="; ".join(issues),
        drone_model=str(raw.get("DroneModel") or ""),
        product_name=str(raw.get("ProductName") or ""),
    )


def summarize(values: list[float]) -> dict[str, Optional[float]]:
    if not values:
        return {"count": 0, "min": None, "max": None, "mean": None, "median": None, "stdev": None}
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": statistics.mean(values),
        "median": statistics.median(values),
        "stdev": statistics.stdev(values) if len(values) > 1 else 0.0,
    }


def format_stat(name: str, stats: dict[str, Optional[float]], unit: str = "m") -> str:
    if not stats["count"]:
        return f"  {name}: no data"
    return (
        f"  {name}: min={stats['min']:.5f}{unit}, max={stats['max']:.5f}{unit}, "
        f"mean={stats['mean']:.5f}{unit}, median={stats['median']:.5f}{unit}, "
        f"stdev={stats['stdev']:.5f}{unit}"
    )


def placemark_records(records: list[ImageRtkRecord]) -> list[ImageRtkRecord]:
    located: list[ImageRtkRecord] = []
    for record in records:
        if parse_coordinate(record.gps_latitude) is None:
            continue
        if parse_coordinate(record.gps_longitude) is None:
            continue
        located.append(record)
    return located


def write_geojson(records: list[ImageRtkRecord], output_path: Path) -> int:
    features = []
    for record in placemark_records(records):
        lat = parse_coordinate(record.gps_latitude)
        lon = parse_coordinate(record.gps_longitude)
        assert lat is not None and lon is not None

        altitude = record.absolute_altitude
        if altitude is None:
            altitude = parse_coordinate(record.gps_altitude)

        coordinates: list[float] = [lon, lat]
        if altitude is not None:
            coordinates.append(altitude)

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coordinates},
                "properties": {
                    "filename": record.filename,
                    "create_date": record.create_date,
                    "rtk_flag": record.rtk_flag,
                    "rtk_solution": record.rtk_solution,
                    "quality": record.quality,
                    "map_category": record.map_category,
                    "color": MAP_CATEGORIES[record.map_category]["color_hex"],
                    "rtk_diff_age": record.rtk_diff_age,
                    "horizontal_std_m": record.horizontal_std_m,
                    "vertical_std_m": record.vertical_std_m,
                    "absolute_altitude": record.absolute_altitude,
                    "issues": record.issues,
                },
            }
        )

    geojson = {"type": "FeatureCollection", "features": features}
    output_path.write_text(json.dumps(geojson, indent=2), encoding="utf-8")
    return len(features)


def _kml_element(
    tag: str, text: str | None = None, parent: ET.Element | None = None, **attrs: str
) -> ET.Element:
    element = ET.Element(f"{{{KML_NS}}}{tag}", attrs)
    if text is not None:
        element.text = text
    if parent is not None:
        parent.append(element)
    return element


def write_kml(records: list[ImageRtkRecord], output_path: Path, folder: Path) -> int:
    located = placemark_records(records)
    doc = _kml_element("Document")
    _kml_element("name", f"RTK Analysis - {folder.name}", parent=doc)

    for category, style in MAP_CATEGORIES.items():
        style_id = category.lower().replace("+", "-")
        style_el = _kml_element("Style", id=style_id)
        icon_style = _kml_element("IconStyle", parent=style_el)
        _kml_element("color", style["color_kml"], parent=icon_style)
        _kml_element("scale", "0.9", parent=icon_style)
        icon = _kml_element("Icon", parent=icon_style)
        _kml_element(
            "href",
            "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png",
            parent=icon,
        )
        doc.append(style_el)

    for record in located:
        lat = parse_coordinate(record.gps_latitude)
        lon = parse_coordinate(record.gps_longitude)
        assert lat is not None and lon is not None

        altitude = record.absolute_altitude
        if altitude is None:
            altitude = parse_coordinate(record.gps_altitude)

        style_id = record.map_category.lower().replace("+", "-")
        placemark = _kml_element("Placemark")
        _kml_element("name", record.filename, parent=placemark)
        description = (
            f"Category: {record.map_category}\n"
            f"RTK solution: {record.rtk_solution} (flag {record.rtk_flag})\n"
            f"Quality: {record.quality}\n"
            f"Diff age: {record.rtk_diff_age if record.rtk_diff_age is not None else 'n/a'} s\n"
            f"Horizontal std: {record.horizontal_std_m if record.horizontal_std_m is not None else 'n/a'} m\n"
            f"Vertical std: {record.vertical_std_m if record.vertical_std_m is not None else 'n/a'} m\n"
            f"Captured: {record.create_date}\n"
            f"Issues: {record.issues or 'none'}"
        )
        _kml_element("description", description, parent=placemark)
        _kml_element("styleUrl", f"#{style_id}", parent=placemark)

        point = _kml_element("Point", parent=placemark)
        alt_text = f"{altitude:.3f}" if altitude is not None else "0"
        _kml_element("coordinates", f"{lon:.8f},{lat:.8f},{alt_text}", parent=point)
        doc.append(placemark)

    kml = _kml_element("kml")
    kml.append(doc)
    tree = ET.ElementTree(kml)
    ET.indent(tree, space="  ")
    tree.write(output_path, encoding="UTF-8", xml_declaration=True)
    return len(located)


def write_csv(records: list[ImageRtkRecord], output_path: Path) -> None:
    fieldnames = list(asdict(records[0]).keys()) if records else []
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow(asdict(record))


@dataclass
class AnalysisOutputs:
    folder: Path
    output_dir: Path
    records: list[ImageRtkRecord]
    csv_path: Path
    geojson_path: Path
    kml_path: Path
    report_path: Path
    summary_path: Path
    geojson_count: int
    kml_count: int


def records_to_api_list(records: list[ImageRtkRecord]) -> list[dict[str, object]]:
    return [
        {
            "filename": record.filename,
            "quality": record.quality,
            "map_category": record.map_category,
            "rtk_solution": record.rtk_solution,
            "rtk_flag": record.rtk_flag,
            "rtk_diff_age": record.rtk_diff_age,
            "horizontal_std_m": record.horizontal_std_m,
            "vertical_std_m": record.vertical_std_m,
            "issues": record.issues,
            "gps_latitude": record.gps_latitude,
            "gps_longitude": record.gps_longitude,
        }
        for record in records
    ]


def build_summary_dict(records: list[ImageRtkRecord]) -> dict[str, object]:
    total = len(records)
    quality_counts = Counter(record.quality for record in records)
    solution_counts = Counter(record.rtk_solution for record in records)
    map_counts = Counter(record.map_category for record in records)
    fixed_count = sum(1 for record in records if record.rtk_flag == 50)

    horiz_values = [r.horizontal_std_m for r in records if r.horizontal_std_m is not None]
    diff_age_values = [r.rtk_diff_age for r in records if r.rtk_diff_age is not None]

    flagged = [
        {
            "filename": record.filename,
            "quality": record.quality,
            "map_category": record.map_category,
            "rtk_solution": record.rtk_solution,
            "rtk_flag": record.rtk_flag,
            "issues": record.issues,
        }
        for record in records
        if record.quality != "PASS"
    ]

    summary: dict[str, object] = {
        "total": total,
        "quality": {k: quality_counts.get(k, 0) for k in ("PASS", "WARN", "FAIL")},
        "map_category": {k: map_counts.get(k, 0) for k in ("Fix", "Fix+Warn", "Float", "Single")},
        "rtk_solution": dict(solution_counts),
        "fixed_count": fixed_count,
        "fixed_pct": round(100.0 * fixed_count / total, 2) if total else 0.0,
        "flagged_count": len(flagged),
        "flagged": flagged,
        "records": records_to_api_list(records),
    }
    if horiz_values:
        summary["median_horizontal_std_m"] = round(statistics.median(horiz_values), 6)
    if diff_age_values:
        summary["median_diff_age_s"] = round(statistics.median(diff_age_values), 3)
    if records:
        summary["drone"] = records[0].product_name or records[0].drone_model or "Unknown"
    return summary


def run_analysis(
    folder: Path,
    output_path: Optional[Path] = None,
    output_dir: Optional[Path] = None,
) -> AnalysisOutputs:
    folder = folder.resolve()
    if output_dir is not None:
        out_dir = output_dir.resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        csv_path = out_dir / "rtk_analysis.csv"
        geojson_path = out_dir / "rtk_analysis.geojson"
        kml_path = out_dir / "rtk_analysis.kml"
        report_path = out_dir / "rtk_analysis.txt"
        summary_path = out_dir / "rtk_summary.json"
    else:
        out_dir = folder
        csv_path = (output_path or folder / "rtk_analysis.csv").resolve()
        geojson_path = folder / "rtk_analysis.geojson"
        kml_path = folder / "rtk_analysis.kml"
        report_path = folder / "rtk_analysis.txt"
        summary_path = folder / "rtk_summary.json"

    exiftool = find_exiftool()
    iter_images(folder)
    raw_records = read_metadata_with_exiftool(exiftool, folder)
    records = [build_record(raw, folder) for raw in raw_records]
    records.sort(key=lambda record: record.filename.lower())
    write_csv(records, csv_path)
    geojson_count = write_geojson(records, geojson_path)
    kml_count = write_kml(records, kml_path, folder)
    report_path.write_text(build_report_text(records, folder), encoding="utf-8")
    summary_path.write_text(
        json.dumps(build_summary_dict(records), indent=2),
        encoding="utf-8",
    )

    return AnalysisOutputs(
        folder=folder,
        output_dir=out_dir,
        records=records,
        csv_path=csv_path,
        geojson_path=geojson_path,
        kml_path=kml_path,
        report_path=report_path,
        summary_path=summary_path,
        geojson_count=geojson_count,
        kml_count=kml_count,
    )


def build_report_text(records: list[ImageRtkRecord], folder: Path) -> str:
    total = len(records)
    quality_counts = Counter(record.quality for record in records)
    solution_counts = Counter(record.rtk_solution for record in records)
    flag_counts = Counter(record.rtk_flag for record in records)
    map_counts = Counter(record.map_category for record in records)

    horiz_values = [r.horizontal_std_m for r in records if r.horizontal_std_m is not None]
    vert_values = [r.vertical_std_m for r in records if r.vertical_std_m is not None]
    pos3d_values = [r.positional_std_3d_m for r in records if r.positional_std_3d_m is not None]
    diff_age_values = [r.rtk_diff_age for r in records if r.rtk_diff_age is not None]

    flagged = [r for r in records if r.quality != "PASS"]
    lines: list[str] = []

    lines.append("=" * 72)
    lines.append("DJI RTK METADATA ANALYSIS")
    lines.append("=" * 72)
    lines.append(f"Folder: {folder}")
    lines.append(f"Images analyzed: {total}")
    if records:
        lines.append(f"Drone: {records[0].product_name or records[0].drone_model or 'Unknown'}")
    lines.append("")

    lines.append("RTK solution breakdown:")
    for solution, count in sorted(solution_counts.items(), key=lambda item: (-item[1], item[0])):
        pct = 100.0 * count / total
        lines.append(f"  {solution}: {count} ({pct:.1f}%)")
    lines.append("")

    lines.append("RtkFlag values:")
    for flag, count in sorted(flag_counts.items(), key=lambda item: (item[0] is None, item[0])):
        label = classify_rtk_flag(flag)
        pct = 100.0 * count / total
        lines.append(f"  {flag} ({label}): {count} ({pct:.1f}%)")
    lines.append("")

    lines.append("Quality assessment:")
    for quality in ("PASS", "WARN", "FAIL"):
        count = quality_counts.get(quality, 0)
        pct = 100.0 * count / total
        lines.append(f"  {quality}: {count} ({pct:.1f}%)")
    lines.append("")

    lines.append("Map categories:")
    for category in ("Fix", "Fix+Warn", "Float", "Single"):
        count = map_counts.get(category, 0)
        if count:
            color = MAP_CATEGORIES[category]["color_hex"]
            pct = 100.0 * count / total
            lines.append(f"  {category} ({color}): {count} ({pct:.1f}%)")
    lines.append("")

    lines.append("Accuracy statistics (from RtkStdLon/Lat/Hgt, 68% confidence):")
    lines.append(format_stat("Horizontal", summarize(horiz_values)))
    lines.append(format_stat("Vertical", summarize(vert_values)))
    lines.append(format_stat("3D positional", summarize(pos3d_values)))
    lines.append(format_stat("Correction age", summarize(diff_age_values), unit="s"))
    lines.append("")

    if flagged:
        lines.append(f"Flagged images ({len(flagged)}):")
        for record in flagged:
            lines.append(f"  {record.filename} [{record.quality}] {record.rtk_solution}")
            if record.issues:
                lines.append(f"    - {record.issues}")
        lines.append("")
    else:
        lines.append("All images passed RTK quality checks.")
        lines.append("")

    fixed_pct = 100.0 * sum(1 for r in records if r.rtk_flag == 50) / total
    lines.append("Summary:")
    lines.append(f"  RTK fixed coverage: {fixed_pct:.1f}%")
    if horiz_values:
        lines.append(
            f"  Typical horizontal accuracy: {statistics.median(horiz_values) * 100:.2f} cm (median)"
        )
    if diff_age_values:
        lines.append(f"  Typical correction age: {statistics.median(diff_age_values):.2f} s (median)")
    if fixed_pct < 100:
        lines.append("  Note: Images without RTK fixed (flag 50) may reduce mapping accuracy.")
    lines.append("=" * 72)
    return "\n".join(lines)


def print_report(records: list[ImageRtkRecord], folder: Path) -> None:
    print(build_report_text(records, folder))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract DJI image metadata and analyze RTK positioning quality."
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=".",
        type=Path,
        help="Folder containing drone images (default: current directory)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="CSV output path (default: <folder>/rtk_analysis.csv or <output-dir>/rtk_analysis.csv)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for all RTK outputs (csv, geojson, kml, txt, summary json)",
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="Launch the graphical interface",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.gui:
        from rtk_gui import launch_gui

        launch_gui(default_folder=args.folder.resolve())
        return 0

    folder = args.folder.resolve()
    output_path = None
    if args.output and not args.output_dir:
        output_path = args.output.resolve()

    try:
        outputs = run_analysis(folder, output_path=output_path, output_dir=args.output_dir)
        print_report(outputs.records, outputs.folder)
        print(f"Detailed results written to: {outputs.csv_path}")
        print(f"Report written to: {outputs.report_path}")
        print(f"Summary JSON written to: {outputs.summary_path}")
        print(f"GeoJSON map written to: {outputs.geojson_path} ({outputs.geojson_count} points)")
        print(f"KML map written to: {outputs.kml_path} ({outputs.kml_count} points)")
        return 0
    except (RuntimeError, FileNotFoundError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if len(sys.argv) == 1:
        from rtk_gui import launch_gui

        launch_gui()
    else:
        raise SystemExit(main())
