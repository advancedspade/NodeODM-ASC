/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const rimraf = require("rimraf");
const uuidv4 = require("uuid/v4");
const config = require("../config");
const rtkRunner = require("./rtkRunner");
const logger = require("./logger");

const IMAGE_EXTENSIONS = /\.(jpe?g|tiff?|dng|png)$/i;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isImageFilename(name) {
    return IMAGE_EXTENSIONS.test(name || "");
}

function sessionDir(sessionId) {
    if (!SESSION_ID_RE.test(String(sessionId || ""))) return null;
    return path.resolve("tmp", `rtk-preview-${sessionId}`);
}

function createMulterStorage() {
    return multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdir(req.rtkPreviewDir, { recursive: true }, err => {
                cb(err, req.rtkPreviewDir);
            });
        },
        filename: (req, file, cb) => {
            const base = path.basename(file.originalname || "image.jpg");
            cb(null, base.replace(/[^\w.\-()+ ]/g, "_"));
        }
    });
}

const uploadMany = multer({
    storage: createMulterStorage(),
    limits: { files: 50000 },
    fileFilter: (req, file, cb) => {
        if (isImageFilename(file.originalname)) cb(null, true);
        else cb(null, false);
    }
});

const uploadOne = multer({
    storage: createMulterStorage(),
    limits: { fileSize: 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (isImageFilename(file.originalname)) cb(null, true);
        else cb(null, false);
    }
});

function assignPreviewDir(req, res, next) {
    req.rtkPreviewDir = path.resolve("tmp", `rtk-preview-${uuidv4()}`);
    next();
}

function assignSessionDir(req, res, next) {
    const dir = sessionDir(req.params.sessionId);
    if (!dir) {
        return res.json({ error: "Invalid RTK session id." });
    }
    fs.access(dir, fs.constants.R_OK, err => {
        if (err) {
            return res.json({ error: "RTK session not found or expired." });
        }
        req.rtkPreviewDir = dir;
        next();
    });
}

function cleanupPreviewDir(dir) {
    if (!dir) return;
    rimraf(dir, err => {
        if (err) logger.warn(`RTK preview cleanup failed: ${err.message}`);
    });
}

function sendAnalysisResult(res, result) {
    const summary = result.summary || {};
    const flaggedCount = summary.flagged_count || 0;
    const failCount = (summary.quality && summary.quality.FAIL) || 0;
    const warnCount = (summary.quality && summary.quality.WARN) || 0;

    let severity = "ok";
    if (failCount > 0) severity = "error";
    else if (warnCount > 0) severity = "warn";

    res.json({
        success: true,
        summary,
        records: summary.records || result.records || [],
        reportText: result.reportText || "",
        hasDiscrepancies: flaggedCount > 0,
        severity,
        message: flaggedCount > 0
            ? `${flaggedCount} image(s) have RTK quality issues (FAIL: ${failCount}, WARN: ${warnCount}).`
            : "All images passed RTK quality checks."
    });
}

function runAnalysisOnDir(previewDir, res, cleanupAfter) {
    if (!config.rtkAnalysis) {
        if (cleanupAfter) cleanupPreviewDir(previewDir);
        return res.json({ error: "RTK analysis is disabled on this node." });
    }

    if (!rtkRunner.isAvailable()) {
        if (cleanupAfter) cleanupPreviewDir(previewDir);
        return res.json({
            error: rtkRunner.getStatus().reason || "RTK analysis is not available on this server."
        });
    }

    const outputDir = path.join(previewDir, "rtk_out");

    rtkRunner.runAnalysis(previewDir, outputDir, (err, result) => {
        if (cleanupAfter) cleanupPreviewDir(previewDir);

        if (err) {
            return res.json({ error: err.message });
        }

        sendAnalysisResult(res, result);
    });
}

function handleStatus(req, res) {
    const status = rtkRunner.getStatus();
    res.json({
        enabled: config.rtkAnalysis !== false,
        available: status.available,
        reason: status.reason,
        sessionUpload: true
    });
}

function handleSessionCreate(req, res) {
    const id = uuidv4();
    const dir = sessionDir(id);
    fs.mkdir(dir, { recursive: true }, err => {
        if (err) return res.json({ error: err.message });
        res.json({ sessionId: id });
    });
}

function handleSessionUpload(req, res) {
    const file = req.file || (req.files && req.files[0]);
    if (!file) {
        return res.json({ error: "Need an image file." });
    }
    res.json({ success: true, filename: file.originalname });
}

function handleSessionAnalyze(req, res) {
    const previewDir = req.rtkPreviewDir;

    fs.readdir(previewDir, (err, names) => {
        if (err) {
            return res.json({ error: err.message });
        }

        const images = names.filter(n => isImageFilename(n));
        if (!images.length) {
            return res.json({ error: "No supported image files in session." });
        }

        runAnalysisOnDir(previewDir, res, true);
    });
}

function handleSessionDelete(req, res) {
    const dir = sessionDir(req.params.sessionId);
    if (!dir) {
        return res.json({ error: "Invalid RTK session id." });
    }
    cleanupPreviewDir(dir);
    res.json({ success: true });
}

/** Legacy single-request upload (may fail behind HTTPS LB body limits). */
function handleAnalyze(req, res) {
    const previewDir = req.rtkPreviewDir;

    if (!req.files || !req.files.length) {
        cleanupPreviewDir(previewDir);
        return res.json({ error: "Need at least one image file for RTK analysis." });
    }

    runAnalysisOnDir(previewDir, res, true);
}

module.exports = {
    assignPreviewDir,
    assignSessionDir,
    uploadImages: uploadMany.array("images"),
    uploadSessionImage: uploadOne.single("images"),
    handleStatus,
    handleSessionCreate,
    handleSessionUpload,
    handleSessionAnalyze,
    handleSessionDelete,
    handleAnalyze
};
