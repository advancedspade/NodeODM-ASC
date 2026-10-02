/*
Size warning for the CAD orthophoto form. GDAL on the reference node reads
the orthophoto header; the JPEG byte model lives in orthoExport.js.
*/
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { estimateJpegBytes, WARN_OUTPUT_BYTES } = require("./orthoExport");

const SCRIPT = path.join(__dirname, "..", "cad-ortho-export", "estimate_grid.py");
const TIMEOUT_MS = 20000;
const CACHE_MAX = 32;

const cache = new Map();
const inflight = new Map();

function cacheGet(key) {
    if (!cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function cacheSet(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function resultFor(grid) {
    const estimateBytes = estimateJpegBytes(grid.width, grid.height, grid.transparentFraction);
    return {
        estimateBytes,
        estimateMb: Math.round(estimateBytes / 1e6),
        warn: estimateBytes > WARN_OUTPUT_BYTES,
        width: grid.width,
        height: grid.height
    };
}

function runGrid(vsiPath, gsdMetres, epsg) {
    return new Promise((resolve, reject) => {
        const child = spawn("python3", [
            SCRIPT,
            vsiPath,
            String(gsdMetres),
            epsg == null ? "" : String(epsg)
        ], {
            env: Object.assign({}, process.env, {
                CPL_MACHINE_IS_GCE: process.env.CPL_MACHINE_IS_GCE || "YES",
                GDAL_DISABLE_READDIR_ON_OPEN: "EMPTY_DIR",
                GDAL_HTTP_MERGE_CONSECUTIVE_RANGES: "YES",
                VSI_CACHE: "TRUE"
            })
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("CAD export size estimate timed out."));
        }, TIMEOUT_MS);
        child.stdout.on("data", chunk => {
            stdout += chunk;
        });
        child.stderr.on("data", chunk => {
            stderr += chunk;
        });
        child.on("error", err => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", code => {
            clearTimeout(timer);
            if (code !== 0) {
                const detail = stderr.trim().split("\n").pop() || `exit ${code}`;
                reject(new Error(detail));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                reject(err);
            }
        });
    });
}

function estimateOrthoSize({ vsiPath, gsdMetres, epsg, cacheKey }) {
    const cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const pending = runGrid(vsiPath, gsdMetres, epsg).then(grid => {
        const result = resultFor(grid);
        cacheSet(cacheKey, result);
        return result;
    }).finally(() => {
        inflight.delete(cacheKey);
    });
    inflight.set(cacheKey, pending);
    return pending;
}

module.exports = {
    estimateOrthoSize,
    resultFor
};
