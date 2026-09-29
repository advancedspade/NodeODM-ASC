/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const crypto = require("crypto");

// Keep in sync with cad-ortho-export/gcs_export.py.
const UNITS_METRES = {
    "cm": 0.01,
    "m": 1,
    "ft (US survey)": 1200 / 3937
};

const MIN_GSD_METRES = 0.01;
const MAX_GSD_METRES = 10;

// A queued row that never becomes running is a start that did not land.
// Running past the Cloud Run timeout plus a grace period is a dead execution.
const QUEUED_STALE_MS = 20 * 60 * 1000;
const RUNNING_STALE_MS = (2 * 60 + 15) * 60 * 1000;

const ORTHO_REL = "odm_orthophoto/odm_orthophoto.tif";
const STATUS_REL = "odm_orthophoto/cad_export.json";
const OUTPUT_REL = "odm_orthophoto/odm_orthophoto_small.tif";

// Under .uploads, which listProjectFiles and /download already omit, and
// outside every project prefix (project names cannot start with a dot).
// The bucket lifecycle rule for this prefix removes staged files an
// interrupted execution leaves behind.
const STAGE_ROOT = ".uploads/cad-export";

function cadStagePrefix(uploadPrefix, sanitizedName, claim) {
    if (!sanitizedName || !claim) return "";
    const prefix = String(uploadPrefix || "").replace(/\/$/, "");
    const rel = `${STAGE_ROOT}/${sanitizedName}/${claim}`;
    return prefix ? `${prefix}/${rel}` : rel;
}

function parseExportRequest(body) {
    const src = body && typeof body === "object" ? body : {};
    const gsd = Number(src.gsd);
    const unit = src.unit == null || src.unit === "" ? "cm" : String(src.unit);
    const factor = UNITS_METRES[unit];
    if (!Number.isFinite(gsd) || factor == null) {
        return { error: "Ground resolution must be a positive number in cm, m, or US survey feet." };
    }
    const metres = gsd * factor;
    if (metres < MIN_GSD_METRES || metres > MAX_GSD_METRES) {
        return { error: "Ground resolution must be between 1 cm and 10 m." };
    }
    const keepCrs = src.keepCrs === true || src.keepCrs === "true";
    let epsg = null;
    if (!keepCrs) {
        const epsgText = String(src.epsg == null ? "" : src.epsg).trim();
        epsg = /^\d+$/.test(epsgText) ? Number(epsgText) : NaN;
        if (!Number.isInteger(epsg) || epsg < 1024 || epsg > 32767) {
            return { error: "Choose a coordinate system, or keep the source CRS." };
        }
    }
    return {
        value: {
            gsd,
            unit,
            keepCrs,
            epsg
        }
    };
}

function exportIsActive(doc, nowMs) {
    if (!doc || (doc.status !== "running" && doc.status !== "queued")) return false;
    const started = Date.parse(doc.startedAt || "");
    if (!Number.isFinite(started)) return true;
    const limit = doc.status === "queued" ? QUEUED_STALE_MS : RUNNING_STALE_MS;
    return (nowMs - started) < limit;
}

function jobResourceName(configured) {
    const name = String(configured || "").trim().replace(/^\/+/, "");
    if (!name) return "";
    if (/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(name)) return name;
    return "";
}

function isNotFound(err) {
    return !!(err && (err.code === 404 || err.code === "404"));
}

function isPreconditionFailed(err) {
    return !!(err && (err.code === 412 || err.code === "412"));
}

function newExportClaim() {
    return crypto.randomBytes(16).toString("hex");
}

// claim is the lease. The worker may update this object only while the live
// generation still carries the same claim.
function buildQueuedExport(params, sourceBytes, claim, startedAt) {
    if (!claim) throw new Error("CAD export claim is required.");
    return {
        status: "queued",
        claim: String(claim),
        params,
        startedAt,
        finishedAt: null,
        execution: null,
        error: null,
        verify: null,
        outputs: [],
        sourceBytes: Number(sourceBytes) || 0,
        outputBytes: 0,
        seconds: 0
    };
}

module.exports = {
    UNITS_METRES,
    MIN_GSD_METRES,
    MAX_GSD_METRES,
    QUEUED_STALE_MS,
    RUNNING_STALE_MS,
    ORTHO_REL,
    STATUS_REL,
    OUTPUT_REL,
    STAGE_ROOT,
    cadStagePrefix,
    parseExportRequest,
    exportIsActive,
    jobResourceName,
    isNotFound,
    isPreconditionFailed,
    newExportClaim,
    buildQueuedExport
};
