/*
 * Defaults for GET /options and for filterOptions when the client omits an option.
 * Keep mesh-size (and the full map) in sync with public/js/ndm-ui-defaults.json — the UI loads that file for reliable display.
 *
 * Omitted on purpose:
 * - fast-orthophoto — UI "3D / Ortho only"
 * - rerun-from — leave unset (ODM default)
 * - boundary, cameras, sm-cluster — blank / ODM default
 * - gps-z-offset, matcher-order, sfm-no-partial — not in ODM 3.0.x option list
 *
 * feature-type: requested "dpsift" is not an ODM 3.0.4 choice; using "sift".
 * optimize-disk-space: default "false" keeps originals under images/ for all.zip; when "Save raw inputs" is unchecked the UI sends "true".
 * max-concurrency "8" is for /options display; filterOptions derives a RAM-safe value unless the client explicitly sends this option.
 */
"use strict";

const OPTION_UI_DEFAULTS = {
    "3d-tiles": "true",
    "auto-boundary": "true",
    "auto-boundary-distance": "10",
    "bg-removal": "false",
    "build-overviews": "true",
    "camera-lens": "auto",
    "cog": "true",
    "crop": "3",
    "dem-decimation": "1",
    "dem-euclidean-map": "false",
    "dem-gapfill-steps": "3",
    "dem-resolution": "5",
    "dsm": "false",
    "dtm": "false",
    "end-with": "odm_postprocess",
    "feature-quality": "high",
    "feature-type": "sift",
    "force-gps": "false",
    "gltf": "true",
    "gps-accuracy": "3",
    "ignore-gsd": "false",
    "matcher-neighbors": "8",
    "matcher-type": "flann",
    "max-concurrency": "8",
    "merge": "all",
    "mesh-octree-depth": "12",
    "mesh-size": "4000000",
    "min-num-features": "13000",
    "no-gpu": "false",
    "optimize-disk-space": "false",
    "orthophoto-compression": "DEFLATE",
    "orthophoto-cutline": "false",
    "orthophoto-kmz": "false",
    "orthophoto-no-tiled": "false",
    "orthophoto-png": "false",
    "orthophoto-resolution": "0.1",
    "pc-classify": "false",
    "pc-copc": "false",
    "pc-csv": "false",
    "pc-ept": "false",
    "pc-filter": "5",
    "pc-las": "false",
    "pc-quality": "medium",
    "pc-rectify": "false",
    "pc-sample": "0",
    "pc-skip-geometric": "false",
    "primary-band": "auto",
    "radiometric-calibration": "none",
    "rolling-shutter": "false",
    "rolling-shutter-readout": "0",
    "sfm-algorithm": "incremental",
    "skip-3dmodel": "true",
    "skip-band-alignment": "false",
    "skip-orthophoto": "false",
    "skip-report": "false",
    "sky-removal": "false",
    "sm-no-align": "false",
    "smrf-scalar": "1.25",
    "smrf-slope": "0.15",
    "smrf-threshold": "0.5",
    "smrf-window": "18.0",
    "split": "99999",
    "split-overlap": "150",
    "texturing-keep-unseen-faces": "false",
    "texturing-single-material": "false",
    "texturing-skip-global-seam-leveling": "false",
    "tiles": "true",
    "use-3dmesh": "false",
    "use-exif": "false",
    "use-fixed-camera-params": "false",
    "use-hybrid-bundle-adjustment": "false",
    "video-limit": "500",
    "video-resolution": "4000"
};

function applyUiDefaultsToOptions(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
        const opt = list[i];
        if (!opt || typeof opt.name !== "string") continue;
        if (!Object.prototype.hasOwnProperty.call(OPTION_UI_DEFAULTS, opt.name)) continue;
        opt.value = String(OPTION_UI_DEFAULTS[opt.name]);
        if (opt.type === "enum" && Array.isArray(opt.domain)) {
            const v = opt.value;
            if (opt.domain.indexOf(v) === -1) opt.domain.unshift(v);
        }
    }
}

module.exports.OPTION_UI_DEFAULTS = OPTION_UI_DEFAULTS;
module.exports.applyUiDefaultsToOptions = applyUiDefaultsToOptions;
