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
const async = require("async");
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
const SIGN_URL_TTL_MS = 60 * 60 * 1000;
const MAX_SIGN_BATCH = 50;

const sessions = new Map();

function gcsSessionStagingPath(uploadId) {
    const prefix = (config.gcsUploadPrefix || "").replace(/\/$/, "");
    const base = `.uploads/${uploadId}`;
    return prefix ? `${prefix}/${base}` : base;
}

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

const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const incoming = path.join(req.gcsUploadDir, "incoming");
        fs.mkdir(incoming, { recursive: true }, err => cb(err, incoming));
    },
    filename: (req, file, cb) => {
        cb(null, `upload-${uuidv4()}${path.extname(file.originalname || "")}`);
    }
});

const uploadMiddleware = multer({
    storage: multerStorage,
    limits: { fileSize: 1024 * 1024 * 1024 * 15 }
}).single("file");

const uploadBatchMiddleware = multer({
    storage: multerStorage,
    limits: {
        fileSize: 1024 * 1024 * 1024 * 15,
        files: 50
    }
}).array("files", 50);

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
        directUpload: true,
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
            gcsStagingPath: gcsSessionStagingPath(uploadId),
            createdAt: Date.now(),
            stagedFileCount: 0,
            stagedRelativePaths: new Set(),
            directUpload: true
        });

        res.json({
            uploadId,
            projectName: String(rawName).trim(),
            sanitizedName,
            gcsDestPath: gcsDest,
            gcsStagingPath: gcsSessionStagingPath(uploadId),
            bucket: config.gcsBucket,
            directUpload: true,
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

function gcsObjectPathForRelative(session, relativePath) {
    const rel = sanitizeRelativePath(relativePath);
    return `${session.gcsStagingPath}/${rel}`;
}

function signOneFile(session, relativePath, contentType, cb) {
    const rel = sanitizeRelativePath(relativePath);
    const objectPath = gcsObjectPathForRelative(session, rel);
    const ct = contentType || GCS.contentTypeForPath(rel);
    GCS.getSignedUploadUrl(objectPath, ct, (err, signedUrl) => {
        if (err) return cb(err);
        cb(null, {
            relativePath: rel,
            objectPath,
            signedUrl,
            contentType: ct,
            expiresIn: Math.floor(SIGN_URL_TTL_MS / 1000)
        });
    });
}

function markStaged(session, relativePath) {
    const rel = sanitizeRelativePath(relativePath);
    if (!session.stagedRelativePaths) session.stagedRelativePaths = new Set();
    if (!session.stagedRelativePaths.has(rel)) {
        session.stagedRelativePaths.add(rel);
        session.stagedFileCount = session.stagedRelativePaths.size;
    }
    return rel;
}

function handleSign(req, res) {
    const session = req.gcsUploadSession;
    const body = req.body || {};

    let entries = [];
    if (Array.isArray(body.files) && body.files.length) {
        entries = body.files.slice(0, MAX_SIGN_BATCH).map(f => ({
            relativePath: f.relativePath,
            contentType: f.contentType
        }));
    } else if (body.relativePath) {
        entries = [{ relativePath: body.relativePath, contentType: body.contentType }];
    } else {
        return res.json({ error: "relativePath or files[] is required." });
    }

    for (let i = 0; i < entries.length; i++) {
        const name = entries[i].relativePath || "";
        if (ZIP_EXT.test(name) && entries.length > 1) {
            return res.json({ error: "Request signed URLs for .zip files one at a time." });
        }
    }

    async.mapLimit(entries, 16, (entry, cb) => {
        signOneFile(session, entry.relativePath, entry.contentType, cb);
    }, (err, signatures) => {
        if (err) {
            logger.warn(`GCS signed URL failed: ${err.message}`);
            return res.json({ error: err.message });
        }
        if (signatures.length === 1) {
            return res.json(Object.assign({ success: true }, signatures[0]));
        }
        res.json({ success: true, signatures });
    });
}

function handleComplete(req, res) {
    const session = req.gcsUploadSession;
    const body = req.body || {};
    let paths = [];

    if (Array.isArray(body.relativePaths) && body.relativePaths.length) {
        paths = body.relativePaths;
    } else if (body.relativePath) {
        paths = [body.relativePath];
    } else {
        return res.json({ error: "relativePath or relativePaths[] is required." });
    }

    const staged = paths.map(p => markStaged(session, p));
    res.json({
        success: true,
        stagedFiles: session.stagedFileCount,
        relativePaths: staged,
        gcsDestPath: session.gcsDestPath
    });
}

function commitFromGcsStaging(session, uploadId, cb, onFileDone) {
    const stagingPath = session.gcsStagingPath;
    const destPath = session.gcsDestPath;
    const tmpDir = sessionTmpDir(uploadId);
    const localStaging = sessionStagingDir(uploadId);

    GCS.listFilesUnderPrefix(stagingPath, (err, objects) => {
        if (err) return cb(err);
        if (!objects.length) {
            return cb(new Error("No files staged in GCS for this session."));
        }

        const zipObjects = objects.filter(o => ZIP_EXT.test(o.name));
        const nonZipCount = objects.length - zipObjects.length;

        if (zipObjects.length > 1 || (zipObjects.length === 1 && nonZipCount > 0)) {
            return cb(new Error("Upload either one .zip or individual files, not both."));
        }

        if (zipObjects.length === 1) {
            const zipObject = zipObjects[0];
            const zipLocal = path.join(tmpDir, "upload.zip");
            const extractDir = localStaging;

            fs.mkdir(extractDir, { recursive: true }, mkdirErr => {
                if (mkdirErr) return cb(mkdirErr);

                GCS.downloadFile(zipObject.name, zipLocal, dlErr => {
                    if (dlErr) return cb(dlErr);

                    ziputils.unzip(zipLocal, extractDir, unzipErr => {
                        rimraf(zipLocal, () => {});
                        if (unzipErr) return cb(unzipErr);

                        uploadFolderToGcs(extractDir, destPath, (upErr, stats) => {
                            if (upErr) return cb(upErr);
                            GCS.deletePrefix(stagingPath, delErr => {
                                if (delErr) logger.warn(`GCS staging cleanup: ${delErr.message}`);
                                cb(null, stats);
                            });
                        }, null, onFileDone);
                    });
                });
            });
            return;
        }

        GCS.copyPrefix(stagingPath, destPath, (copyErr, stats) => {
            if (copyErr) return cb(copyErr);
            GCS.deletePrefix(stagingPath, delErr => {
                if (delErr) logger.warn(`GCS staging cleanup: ${delErr.message}`);
                cb(null, stats);
            });
        }, onFileDone);
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

function cleanupIncomingFiles(files, cb) {
    async.each(files || [], (f, next) => {
        rimraf(f.path, () => next());
    }, cb || (() => {}));
}

function handleBatch(req, res) {
    const session = req.gcsUploadSession;
    const uploadId = req.gcsUploadId;
    const stagingDir = sessionStagingDir(uploadId);
    const files = req.files || [];

    if (!stagingDir) {
        return res.json({ error: "Invalid upload session." });
    }
    if (!files.length) {
        return res.json({ error: "No files received." });
    }

    let relativePaths;
    try {
        relativePaths = JSON.parse(req.body.relativePaths || "[]");
    } catch (e) {
        cleanupIncomingFiles(files);
        return res.json({ error: "Invalid relativePaths JSON." });
    }
    if (!Array.isArray(relativePaths) || relativePaths.length !== files.length) {
        cleanupIncomingFiles(files);
        return res.json({
            error: `relativePaths must be a JSON array with one entry per file (got ${relativePaths.length}, expected ${files.length}).`
        });
    }

    for (let i = 0; i < files.length; i++) {
        const name = files[i].originalname || path.basename(files[i].path);
        if (ZIP_EXT.test(name)) {
            cleanupIncomingFiles(files);
            return res.json({ error: "Upload .zip files one at a time (not in a batch)." });
        }
    }

    fs.mkdir(stagingDir, { recursive: true }, mkdirErr => {
        if (mkdirErr) {
            cleanupIncomingFiles(files);
            return res.json({ error: mkdirErr.message });
        }

        const entries = files.map((f, i) => ({
            file: f,
            relativePath: relativePaths[i] || f.originalname || path.basename(f.path)
        }));

        async.eachSeries(entries, (entry, cb) => {
            stageFileAtPath(stagingDir, entry.relativePath, entry.file.path, err => {
                rimraf(entry.file.path, () => cb(err));
            });
        }, err => {
            if (err) {
                logger.warn(`GCS manual upload batch staging failed: ${err.message}`);
                return res.json({ error: err.message });
            }
            session.stagedFileCount = countFilesUnder(stagingDir);
            res.json({
                success: true,
                staged: true,
                batchSize: files.length,
                stagedFiles: session.stagedFileCount,
                gcsDestPath: session.gcsDestPath
            });
        });
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

    const finishStart = (fileCount) => {
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
            const onFileDone = (completed, total, name) => {
                if (!session.progress) return;
                session.progress.filesCompleted = completed;
                session.progress.filesTotal = total;
                session.progress.currentFile = name || "";
            };

            const done = (err, stats) => {
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
            };

            if (session.directUpload) {
                commitFromGcsStaging(session, uploadId, done, onFileDone);
            } else {
                uploadFolderToGcs(stagingDir, session.gcsDestPath, done, onFileDone);
            }
        });
    };

    if (session.directUpload) {
        const staged = session.stagedFileCount || 0;
        if (!staged) {
            return res.json({ error: "No files staged for upload." });
        }
        return finishStart(staged);
    }

    const fileCount = countFilesUnder(stagingDir);
    if (fileCount === 0) {
        return res.json({ error: "No files staged for upload." });
    }
    finishStart(fileCount);
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
    const session = getSession(uploadId);
    sessions.delete(uploadId);

    const finish = () => {
        if (!dir) {
            return res.json({ error: "Invalid upload session id." });
        }
        rimraf(dir, err => {
            if (err) logger.warn(`GCS upload session cleanup: ${err.message}`);
            res.json({ success: true });
        });
    };

    if (session && session.directUpload && session.gcsStagingPath) {
        GCS.deletePrefix(session.gcsStagingPath, delErr => {
            if (delErr) logger.warn(`GCS staging prefix cleanup: ${delErr.message}`);
            finish();
        });
    } else {
        finish();
    }
}

module.exports = {
    assignUpload,
    uploadMiddleware,
    uploadBatchMiddleware,
    handleStatus,
    handleListProjects,
    handleInit,
    handleSign,
    handleComplete,
    handleFile,
    handleBatch,
    handleCommit,
    handleProgress,
    handleDelete
};
