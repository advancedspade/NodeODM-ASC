/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/
"use strict";

const { GoogleAuth } = require("google-auth-library");
const config = require("../config");
const GCS = require("./GCS");
const logger = require("./logger");
const { sanitizeProjectName, gcsDestPathForProject } = require("./gcsProjectName");
const {
    ORTHO_REL,
    STATUS_REL,
    UNITS_METRES,
    succeededOutputRel,
    cadStagePrefix,
    parseExportRequest,
    exportIsActive,
    jobResourceName,
    isNotFound,
    isPreconditionFailed,
    newExportClaim,
    buildQueuedExport
} = require("./orthoExport");
const { estimateOrthoSize } = require("./orthoExportEstimate");

let cloudAuth = null;

function sanitizedProject(projectName) {
    const sanitized = sanitizeProjectName(projectName, "");
    if (!sanitized || sanitized !== String(projectName || "").trim()) return "";
    return sanitized;
}

function projectBase(projectName) {
    const sanitized = sanitizedProject(projectName);
    return sanitized ? gcsDestPathForProject(sanitized, config.gcsUploadPrefix) : "";
}

function objectPath(base, rel) {
    return `${base}/${rel}`;
}

function readStatus(statusPath) {
    return new Promise((resolve, reject) => {
        GCS.readObjectText(statusPath, (err, result) => {
            if (isNotFound(err)) return resolve({ generation: 0, doc: null });
            if (err) return reject(err);
            let doc = null;
            try {
                doc = JSON.parse(result.text);
            } catch (e) {
                doc = null;
            }
            resolve({ generation: result.generation, doc });
        });
    });
}

function writeStatus(statusPath, doc, generation) {
    return new Promise((resolve, reject) => {
        GCS.saveObjectText(statusPath, JSON.stringify(doc, null, 2) + "\n", {
            contentType: "application/json",
            ifGenerationMatch: generation
        }, err => {
            if (err) return reject(err);
            resolve();
        });
    });
}

function orthoMetadata(orthoPath) {
    return new Promise((resolve, reject) => {
        GCS.objectMetadata(orthoPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata);
        });
    });
}

function outputExists(outputPath) {
    return new Promise((resolve, reject) => {
        GCS.objectExists(outputPath, (err, exists) => {
            if (err) return reject(err);
            resolve(!!exists);
        });
    });
}

function authClient() {
    if (!cloudAuth) {
        cloudAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    }
    return cloudAuth;
}

async function startJob(jobName, envMap) {
    const client = await authClient().getClient();
    const res = await client.request({
        url: `https://run.googleapis.com/v2/${jobName}:run`,
        method: "POST",
        data: {
            overrides: {
                containerOverrides: [{
                    env: Object.keys(envMap).map(name => ({ name, value: String(envMap[name]) }))
                }]
            }
        }
    });
    const data = res.data || {};
    const meta = data.metadata || {};
    return {
        operation: data.name || null,
        execution: meta.name || null
    };
}

function publicStatus(doc, outputRel) {
    return {
        configured: true,
        status: doc || null,
        active: exportIsActive(doc, Date.now()),
        output: outputRel || null
    };
}

async function handleOrthoExportStatus(req, res) {
    if (!GCS.enabled()) {
        return res.status(503).json({ error: "GCS uploads are not available on this server." });
    }
    const base = projectBase(req.params.projectName);
    if (!base) return res.status(400).json({ error: "Invalid project name." });

    const job = jobResourceName(config.cadOrthoExportJob);
    if (!job) {
        return res.json({ configured: false, status: null, active: false, output: null });
    }

    try {
        const state = await readStatus(objectPath(base, STATUS_REL));
        const rel = succeededOutputRel(state.doc);
        const exists = rel ? await outputExists(objectPath(base, rel)) : false;
        res.json(publicStatus(state.doc, exists ? rel : null));
    } catch (err) {
        logger.error(`CAD export status: ${err.message}`);
        res.status(500).json({ error: "Could not read CAD export status." });
    }
}

async function handleOrthoExport(req, res) {
    if (!GCS.enabled()) {
        return res.status(503).json({ error: "GCS uploads are not available on this server." });
    }
    const projectName = String(req.params.projectName || "").trim();
    const base = projectBase(projectName);
    if (!base) return res.status(400).json({ error: "Invalid project name." });

    const job = jobResourceName(config.cadOrthoExportJob);
    if (!job) {
        return res.status(503).json({ error: "CAD export is not configured on this server." });
    }
    if (!config.gcsBucket) {
        return res.status(503).json({ error: "GCS bucket is not configured." });
    }

    const parsed = parseExportRequest(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const params = parsed.value;

    const orthoPath = objectPath(base, ORTHO_REL);
    const statusPath = objectPath(base, STATUS_REL);

    let metadata;
    try {
        metadata = await orthoMetadata(orthoPath);
    } catch (err) {
        if (isNotFound(err)) {
            return res.status(404).json({ error: "This project has no orthophoto to export." });
        }
        logger.error(`CAD export ortho lookup: ${err.message}`);
        return res.status(500).json({ error: "Could not read the orthophoto." });
    }

    let state;
    try {
        state = await readStatus(statusPath);
    } catch (err) {
        logger.error(`CAD export status read: ${err.message}`);
        return res.status(500).json({ error: "Could not read CAD export status." });
    }
    if (exportIsActive(state.doc, Date.now())) {
        return res.status(409).json({
            error: "A CAD export is already running for this project.",
            status: state.doc
        });
    }

    const claim = newExportClaim();
    const queued = buildQueuedExport(
        params,
        Number(metadata.size) || 0,
        claim,
        new Date().toISOString()
    );

    let claimed;
    try {
        await writeStatus(statusPath, queued, state.generation);
        claimed = await readStatus(statusPath);
    } catch (err) {
        if (isPreconditionFailed(err)) {
            return res.status(409).json({ error: "A CAD export is already running for this project." });
        }
        logger.error(`CAD export status write: ${err.message}`);
        return res.status(500).json({ error: "Could not record the CAD export." });
    }
    if (!claimed.doc || claimed.doc.claim !== claim) {
        return res.status(409).json({ error: "A CAD export is already running for this project." });
    }

    const stagePrefix = cadStagePrefix(config.gcsUploadPrefix, sanitizedProject(projectName), claim);
    const env = {
        CAD_EXPORT_SOURCE: `gs://${config.gcsBucket}/${orthoPath}`,
        CAD_EXPORT_DEST_PREFIX: `gs://${config.gcsBucket}/${base}/odm_orthophoto`,
        CAD_EXPORT_STAGE_PREFIX: `gs://${config.gcsBucket}/${stagePrefix}`,
        CAD_EXPORT_GSD: String(params.gsd),
        CAD_EXPORT_UNIT: params.unit,
        CAD_EXPORT_KEEP_CRS: params.keepCrs ? "true" : "false",
        CAD_EXPORT_SOURCE_BYTES: String(queued.sourceBytes || 0),
        CAD_EXPORT_CLAIM: claim
    };
    if (!params.keepCrs) env.CAD_EXPORT_EPSG = String(params.epsg);

    try {
        const started = await startJob(job, env);
        queued.execution = started.execution || started.operation;
        res.json({
            configured: true,
            active: true,
            output: null,
            status: queued,
            operation: started.operation
        });
    } catch (err) {
        const message = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
            err.message ||
            "Could not start CAD export.";
        logger.error(`CAD export start: ${message}`);
        const failed = Object.assign({}, queued, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: message
        });
        try {
            await writeStatus(statusPath, failed, claimed.generation);
        } catch (writeErr) {
            if (isPreconditionFailed(writeErr)) {
                logger.error("CAD export start failed after the queued record was replaced.");
            } else {
                logger.error(`CAD export failure status: ${writeErr.message}`);
            }
        }
        if (!res.headersSent) {
            res.status(502).json({ error: message, status: failed });
        }
    }
}

async function handleOrthoExportEstimate(req, res) {
    if (!GCS.enabled()) {
        return res.status(503).json({ error: "GCS uploads are not available on this server." });
    }
    const base = projectBase(req.params.projectName);
    if (!base) return res.status(400).json({ error: "Invalid project name." });
    if (!jobResourceName(config.cadOrthoExportJob)) {
        return res.json({ configured: false, warn: false, estimateBytes: null });
    }
    if (!config.gcsBucket) {
        return res.status(503).json({ error: "GCS bucket is not configured." });
    }

    const parsed = parseExportRequest(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const params = parsed.value;
    const orthoPath = objectPath(base, ORTHO_REL);

    let metadata;
    try {
        metadata = await orthoMetadata(orthoPath);
    } catch (err) {
        if (isNotFound(err)) {
            return res.status(404).json({ error: "This project has no orthophoto to export." });
        }
        logger.error(`CAD export estimate lookup: ${err.message}`);
        return res.status(500).json({ error: "Could not read the orthophoto." });
    }

    const metres = params.gsd * UNITS_METRES[params.unit];
    try {
        const estimate = await estimateOrthoSize({
            vsiPath: `/vsigs/${config.gcsBucket}/${orthoPath}`,
            gsdMetres: metres,
            epsg: params.keepCrs ? null : params.epsg,
            cacheKey: [orthoPath, metadata.generation, metres, params.keepCrs ? "keep" : params.epsg].join(":")
        });
        res.json(Object.assign({ configured: true }, estimate));
    } catch (err) {
        logger.warn(`CAD export estimate: ${err.message}`);
        res.json({ configured: true, warn: false, estimateBytes: null, unavailable: true });
    }
}

function handleOrthoExportGet(req, res) {
    handleOrthoExportStatus(req, res).catch(err => {
        logger.error(`CAD export status: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: "Could not read CAD export status." });
    });
}

function handleOrthoExportPost(req, res) {
    handleOrthoExport(req, res).catch(err => {
        logger.error(`CAD export: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: "Could not start CAD export." });
    });
}

function handleOrthoExportEstimatePost(req, res) {
    handleOrthoExportEstimate(req, res).catch(err => {
        logger.error(`CAD export estimate: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: "Could not estimate the CAD orthophoto." });
    });
}

module.exports = {
    handleOrthoExportGet,
    handleOrthoExportPost,
    handleOrthoExportEstimatePost
};
