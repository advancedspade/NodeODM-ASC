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
const glob = require("glob");
const config = require("../config");
const GCS = require("./GCS");
const ziputils = require("./ziputils");
const logger = require("./logger");
const { sanitizeProjectName, gcsDestPathForProject } = require("./gcsProjectName");

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZIP_EXT = /\.zip$/i;

const sessions = new Map();

function sessionTmpDir(uploadId) {
    if (!UPLOAD_ID_RE.test(String(uploadId || ""))) return null;
    return path.resolve("tmp", `gcs-upload-${uploadId}`);
}

function sessionStagingDir(uploadId) {
    const base = sessionTmpDir(uploadId);
    return base ? path.join(base, "staging") : null;
}

function getSession(uploadId) {
    return sessions.get(uploadId) || null;
}

function countFilesUnder(dir) {
    if (!fs.existsSync(dir)) return 0;
    return glob.sync("**/*", { cwd: dir, nodir: true, nosort: true }).length;
}

/** Safe relative path for GCS keys (no .., no absolute paths). */
function sanitizeRelativePath(raw, fallbackName) {
    const normalized = String(raw || fallbackName || "file")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
    const parts = normalized.split("/").filter(p => p && p !== "." && p !== "..");
    const safe = parts.map(p => p.replace(/[^\w.\-()+ ]/g, "_")).join("/");
    return safe || "file";
}

function assignUpload(req, res, next) {
    const uploadId = req.params.uploadId;
    const dir = sessionTmpDir(uploadId);
    const session = getSession(uploadId);
    if (!dir || !session) {
        return res.json({ error: "Upload session not found or expired." });
    }
    req.gcsUploadId = uploadId;
    req.gcsUploadDir = dir;
    req.gcsUploadSession = session;
    next();
}

const uploadMiddleware = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const incoming = path.join(req.gcsUploadDir, "incoming");
            fs.mkdir(incoming, { recursive: true }, err => cb(err, incoming));
        },
        filename: (req, file, cb) => {
            cb(null, `upload-${uuidv4()}${path.extname(file.originalname || "")}`);
        }
    }),
    limits: { fileSize: 1024 * 1024 * 1024 * 15 }
}).single("file");

function handleStatus(req, res) {
    if (!GCS.enabled()) {
        let reason = "GCS bucket is not configured on this node (set GCS_BUCKET or --gcs_bucket).";
        if (config.gcsBucket) {
            reason = GCS.lastInitError() ||
                "GCS bucket is set but the server could not connect (check VM/service account or Application Default Credentials).";
        }
        return res.json({
            enabled: false,
            reason,
            configured: !!config.gcsBucket
        });
    }
    res.json({
        enabled: true,
        bucket: config.gcsBucket,
        prefix: config.gcsUploadPrefix || "",
        uriExample: `gs://${config.gcsBucket}/${gcsDestPathForProject("My_Project", config.gcsUploadPrefix)}/`
    });
}

function projectDisplayName(sanitized) {
    return String(sanitized || "").replace(/_/g, " ");
}

function handleListProjects(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }
    const query = String((req.query && req.query.q) || "").trim().toLowerCase();

    GCS.listProjects((err, projects) => {
        if (err) return res.json({ error: err.message });

        let list = (projects || []).map(name => ({
            name,
            displayName: projectDisplayName(name)
        }));

        if (query) {
            list = list.filter(p => {
                return p.name.toLowerCase().indexOf(query) !== -1 ||
                    p.displayName.toLowerCase().indexOf(query) !== -1;
            });
        }

        res.json({
            projects: list,
            prefix: config.gcsUploadPrefix || "",
            bucket: config.gcsBucket
        });
    });
}

function handleInit(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }

    const rawName = (req.body && req.body.projectName) || (req.query && req.query.projectName) || "";
    const sanitizedName = sanitizeProjectName(rawName);
    if (!sanitizedName) {
        return res.json({ error: "Project title is required." });
    }

    const uploadId = uuidv4();
    const tmpDir = sessionTmpDir(uploadId);
    const gcsDest = gcsDestPathForProject(sanitizedName, config.gcsUploadPrefix);

    fs.mkdir(tmpDir, { recursive: true }, err => {
        if (err) return res.json({ error: err.message });

        sessions.set(uploadId, {
            projectName: String(rawName).trim(),
            sanitizedName,
            gcsDestPath: gcsDest,
            createdAt: Date.now(),
            stagedFileCount: 0
        });

        res.json({
            uploadId,
            projectName: String(rawName).trim(),
            sanitizedName,
            gcsDestPath: gcsDest,
            bucket: config.gcsBucket,
            gcsUri: `gs://${config.gcsBucket}/${gcsDest}/`
        });
    });
}

function uploadFolderToGcs(localDir, gcsDestPath, cb, onFileDone) {
    if (!fs.existsSync(localDir)) {
        return cb(null, { fileCount: 0 });
    }
    const fileCount = countFilesUnder(localDir);
    if (fileCount === 0) {
        return cb(new Error("No files to upload."));
    }
    GCS.uploadPaths(localDir, config.gcsBucket, gcsDestPath, ["."], err => {
        if (err) return cb(err);
        cb(null, { fileCount });
    }, null, onFileDone);
}

function stageFileAtPath(stagingDir, relativePath, srcPath, cb) {
    const rel = sanitizeRelativePath(relativePath);
    const destPath = path.join(stagingDir, rel);
    fs.mkdir(path.dirname(destPath), { recursive: true }, err => {
        if (err) return cb(err);
        fs.rename(srcPath, destPath, renameErr => {
            if (renameErr) {
                fs.copyFile(srcPath, destPath, copyErr => {
                    rimraf(srcPath, () => cb(copyErr));
                });
            } else {
                cb(null, rel);
            }
        });
    });
}

function handleFile(req, res) {
    const session = req.gcsUploadSession;
    const uploadId = req.gcsUploadId;
    const incomingPath = req.file && req.file.path;
    const stagingDir = sessionStagingDir(uploadId);

    if (!incomingPath || !stagingDir) {
        return res.json({ error: "No file received." });
    }

    const originalName = req.file.originalname || path.basename(incomingPath);
    const relativePathRaw = (req.body && req.body.relativePath) || originalName;
    const isZip = ZIP_EXT.test(originalName);

    const finish = (err, result) => {
        rimraf(incomingPath, () => {});
        if (err) {
            logger.warn(`GCS manual upload staging failed: ${err.message}`);
            return res.json({ error: err.message });
        }
        res.json({
            success: true,
            staged: true,
            filename: originalName,
            relativePath: result.relativePath,
            extracted: !!result.extracted,
            stagedFiles: result.stagedFiles,
            gcsDestPath: session.gcsDestPath
        });
    };

    fs.mkdir(stagingDir, { recursive: true }, mkdirErr => {
        if (mkdirErr) return finish(mkdirErr);

        if (isZip) {
            const extractDir = path.join(stagingDir, sanitizeRelativePath(
                path.basename(originalName, path.extname(originalName)),
                "extracted"
            ));
            fs.mkdir(extractDir, { recursive: true }, err => {
                if (err) return finish(err);

                ziputils.unzip(incomingPath, extractDir, unzipErr => {
                    if (unzipErr) return finish(unzipErr);
                    session.stagedFileCount = countFilesUnder(stagingDir);
                    finish(null, {
                        relativePath: path.relative(stagingDir, extractDir).replace(/\\/g, "/"),
                        extracted: true,
                        stagedFiles: session.stagedFileCount
                    });
                });
            });
        } else {
            stageFileAtPath(stagingDir, relativePathRaw, incomingPath, (err, rel) => {
                if (err) return finish(err);
                session.stagedFileCount = (session.stagedFileCount || 0) + 1;
                finish(null, {
                    relativePath: rel,
                    extracted: false,
                    stagedFiles: session.stagedFileCount
                });
            });
        }
    });
}

function handleCommit(req, res) {
    const session = req.gcsUploadSession;
    const uploadId = req.gcsUploadId;
    const stagingDir = sessionStagingDir(uploadId);

    if (!stagingDir) {
        return res.json({ error: "Invalid upload session." });
    }

    if (session.progress && session.progress.phase === "committing" && !session.progress.done) {
        return res.json({
            success: true,
            committing: true,
            filesTotal: session.progress.filesTotal || 0,
            alreadyInProgress: true
        });
    }

    const fileCount = countFilesUnder(stagingDir);
    if (fileCount === 0) {
        return res.json({ error: "No files staged for upload." });
    }

    session.progress = {
        phase: "committing",
        filesTotal: fileCount,
        filesCompleted: 0,
        currentFile: "",
        done: false,
        startedAt: Date.now()
    };
    session.commitResult = null;

    res.json({
        success: true,
        committing: true,
        filesTotal: fileCount
    });

    setImmediate(() => {
        uploadFolderToGcs(stagingDir, session.gcsDestPath, (err, stats) => {
            if (err) {
                session.commitResult = { error: err.message };
            } else {
                session.commitResult = {
                    success: true,
                    filesUploaded: stats.fileCount,
                    gcsDestPath: session.gcsDestPath,
                    gcsUri: `gs://${config.gcsBucket}/${session.gcsDestPath}/`
                };
            }
            if (session.progress) {
                session.progress.done = true;
                session.progress.phase = err ? "error" : "complete";
            }
        }, (completed, total, name) => {
            if (!session.progress) return;
            session.progress.filesCompleted = completed;
            session.progress.filesTotal = total;
            session.progress.currentFile = name || "";
        });
    });
}

function handleProgress(req, res) {
    const session = req.gcsUploadSession;

    if (session.commitResult) {
        if (session.commitResult.error) {
            return res.json({
                done: true,
                error: session.commitResult.error,
                phase: "error"
            });
        }
        return res.json(Object.assign({ done: true, phase: "complete" }, session.commitResult));
    }

    if (session.progress) {
        return res.json(Object.assign({ done: !!session.progress.done }, session.progress));
    }

    const stagingDir = sessionStagingDir(req.gcsUploadId);
    const staged = session.stagedFileCount || (stagingDir ? countFilesUnder(stagingDir) : 0);
    res.json({
        done: false,
        phase: staged > 0 ? "staging" : "empty",
        filesTotal: staged,
        filesCompleted: staged
    });
}

function handleDelete(req, res) {
    const uploadId = req.params.uploadId;
    const dir = sessionTmpDir(uploadId);
    sessions.delete(uploadId);
    if (!dir) {
        return res.json({ error: "Invalid upload session id." });
    }
    rimraf(dir, err => {
        if (err) logger.warn(`GCS upload session cleanup: ${err.message}`);
        res.json({ success: true });
    });
}

module.exports = {
    assignUpload,
    uploadMiddleware,
    handleStatus,
    handleListProjects,
    handleInit,
    handleFile,
    handleCommit,
    handleProgress,
    handleDelete
};
