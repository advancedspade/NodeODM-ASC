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

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdir(req.rtkPreviewDir, { recursive: true }, err => {
                cb(err, req.rtkPreviewDir);
            });
        },
        filename: (req, file, cb) => {
            const base = path.basename(file.originalname || "image.jpg");
            cb(null, base.replace(/[^\w.\-()+ ]/g, "_"));
        }
    }),
    limits: {
        files: 50000
    },
    fileFilter: (req, file, cb) => {
        if (IMAGE_EXTENSIONS.test(file.originalname || "")) cb(null, true);
        else cb(null, false);
    }
});

function assignPreviewDir(req, res, next) {
    // Must be absolute: uploads land under process cwd (/var/www/tmp), but rtkRunner
    // spawns Python with cwd libs/ — relative paths would resolve to libs/tmp/...
    req.rtkPreviewDir = path.resolve("tmp", `rtk-preview-${uuidv4()}`);
    next();
}

function cleanupPreviewDir(dir) {
    rimraf(dir, err => {
        if (err) logger.warn(`RTK preview cleanup failed: ${err.message}`);
    });
}

function handleStatus(req, res) {
    const status = rtkRunner.getStatus();
    res.json({
        enabled: config.rtkAnalysis !== false,
        available: status.available,
        reason: status.reason
    });
}

function handleAnalyze(req, res) {
    const previewDir = req.rtkPreviewDir;

    if (!config.rtkAnalysis){
        cleanupPreviewDir(previewDir);
        return res.json({ error: "RTK analysis is disabled on this node." });
    }

    if (!rtkRunner.isAvailable()){
        cleanupPreviewDir(previewDir);
        return res.json({
            error: rtkRunner.getStatus().reason || "RTK analysis is not available on this server."
        });
    }

    if (!req.files || !req.files.length){
        cleanupPreviewDir(previewDir);
        return res.json({ error: "Need at least one image file for RTK analysis." });
    }

    const outputDir = path.join(previewDir, "rtk_out");

    rtkRunner.runAnalysis(previewDir, outputDir, (err, result) => {
        cleanupPreviewDir(previewDir);

        if (err){
            return res.json({ error: err.message });
        }

        const summary = result.summary || {};
        const flaggedCount = summary.flagged_count || 0;
        const hasDiscrepancies = flaggedCount > 0;
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
            hasDiscrepancies,
            severity,
            message: hasDiscrepancies
                ? `${flaggedCount} image(s) have RTK quality issues (FAIL: ${failCount}, WARN: ${warnCount}).`
                : "All images passed RTK quality checks."
        });
    });
}

module.exports = {
    assignPreviewDir,
    uploadImages: upload.array("images"),
    handleStatus,
    handleAnalyze
};
