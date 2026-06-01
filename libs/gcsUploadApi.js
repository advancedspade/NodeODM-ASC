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

function commitStatusPath(uploadId) {
    const dir = sessionTmpDir(uploadId);
    return dir ? path.join(dir, "commit-status.json") : null;
}

function readCommitStatus(uploadId) {
    const p = commitStatusPath(uploadId);
    if (!p || !fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
        return null;
    }
}

function persistCommitStatus(uploadId, data) {
    const p = commitStatusPath(uploadId);
    if (!p) return;
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(Object.assign({ savedAt: Date.now() }, data)));
    } catch (e) {
        logger.warn(`GCS commit status write failed: ${e.message}`);
    }
}

function assignUploadProgress(req, res, next) {
    const uploadId = req.params.uploadId;
    const dir = sessionTmpDir(uploadId);
    if (!dir) {
        return res.json({ error: "Invalid upload session id." });
    }
    req.gcsUploadId = uploadId;
    req.gcsUploadDir = dir;
    const session = getSession(uploadId);
    if (session) {
        req.gcsUploadSession = session;
        return next();
    }
    const disk = readCommitStatus(uploadId);
    if (disk) {
        req.gcsUploadCommitDisk = disk;
        return next();
    }
    return res.json({ error: "Upload session not found or expired." });
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

function publicUploadPayload(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = Object.assign({}, obj);
    delete out.gcsUri;
    delete out.gcsDestPath;
    delete out.gcsStagingPath;
    delete out.bucket;
    return out;
}

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
        directUpload: true
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
            projects: list
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
            directUpload: true
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
    const destBase = String(session.gcsDestPath || "").replace(/\/+$/, "");
    return `${destBase}/${rel}`;
}

function signOneFile(session, relativePath, contentType, origin, cb) {
    const rel = sanitizeRelativePath(relativePath);
    const objectPath = gcsObjectPathForRelative(session, rel);
    const ct = contentType || GCS.contentTypeForPath(rel);
    GCS.getResumableUploadUrl(objectPath, ct, origin, (err, uploadUrl) => {
        if (err) return cb(err);
        cb(null, {
            relativePath: rel,
            signedUrl: uploadUrl,
            uploadUrl,
            contentType: ct,
            uploadMethod: "resumable"
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

    const origin = req.headers.origin || "";

    async.mapLimit(entries, 16, (entry, cb) => {
        signOneFile(session, entry.relativePath, entry.contentType, origin, cb);
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
        relativePaths: staged
    });
}

function verifyObjectsAtDest(session, relativePaths, cb, onFileDone) {
    const destBase = String(session.gcsDestPath || "").replace(/\/+$/, "") + "/";
    const paths = relativePaths.map(p => sanitizeRelativePath(p));
    let completed = 0;
    const total = paths.length;
    if (onFileDone) onFileDone(0, total, "verifying…");

    async.eachLimit(paths, 32, (rel, done) => {
        GCS.objectExists(destBase + rel, (err, exists) => {
            if (err) return done(err);
            if (!exists) return done(new Error(`Missing uploaded file: ${rel}`));
            completed++;
            if (onFileDone) onFileDone(completed, total, rel);
            done();
        });
    }, err => {
        if (err) return cb(err);
        if (onFileDone) onFileDone(total, total, "");
        cb(null, { fileCount: total });
    });
}

function cleanupStagingPrefix(stagingPath, cb) {
    GCS.deletePrefixWithRetry(stagingPath, delErr => {
        if (delErr) {
            logger.warn(`GCS staging cleanup failed for ${stagingPath}: ${delErr.message}`);
            return cb(delErr);
        }
        logger.info(`GCS staging cleaned up: ${stagingPath}`);
        cb();
    });
}

function cleanupAbandonedDirectUpload(session, cb) {
    const destBase = String(session.gcsDestPath || "").replace(/\/+$/, "") + "/";
    const relPaths = session.stagedRelativePaths ? Array.from(session.stagedRelativePaths) : [];
    const objectPaths = relPaths.map(rel => destBase + sanitizeRelativePath(rel));

    async.series([
        next => {
            if (!objectPaths.length) return next();
            GCS.deleteObjects(objectPaths, next);
        },
        next => {
            if (!session.gcsStagingPath) return next();
            GCS.deletePrefixWithRetry(session.gcsStagingPath, next);
        }
    ], cb);
}

function commitDirectGcsUpload(session, uploadId, cb, onFileDone) {
    const destPath = session.gcsDestPath;
    const tmpDir = sessionTmpDir(uploadId);
    const localStaging = sessionStagingDir(uploadId);
    const paths = session.stagedRelativePaths ? Array.from(session.stagedRelativePaths) : [];

    if (!paths.length) {
        return cb(new Error("No files staged for this session."));
    }

    const zipPaths = paths.filter(p => ZIP_EXT.test(p));
    const nonZipPaths = paths.filter(p => !ZIP_EXT.test(p));

    if (zipPaths.length > 1 || (zipPaths.length === 1 && nonZipPaths.length > 0)) {
        return cb(new Error("Upload either one .zip or individual files, not both."));
    }

    if (zipPaths.length === 1) {
        const zipRel = zipPaths[0];
        const zipObjectPath = gcsObjectPathForRelative(session, zipRel);
        const zipLocal = path.join(tmpDir, "upload.zip");
        const extractDir = localStaging;

        fs.mkdir(extractDir, { recursive: true }, mkdirErr => {
            if (mkdirErr) return cb(mkdirErr);

            GCS.downloadFile(zipObjectPath, zipLocal, dlErr => {
                if (dlErr) return cb(dlErr);

                ziputils.unzip(zipLocal, extractDir, unzipErr => {
                    rimraf(zipLocal, () => {});
                    if (unzipErr) return cb(unzipErr);

                    uploadFolderToGcs(extractDir, destPath, (upErr, stats) => {
                        if (upErr) return cb(upErr);
                        GCS.deleteObjects([zipObjectPath], delErr => {
                            if (delErr) {
                                logger.warn(`GCS zip cleanup failed for ${zipObjectPath}: ${delErr.message}`);
                                return cb(new Error(`Archive extracted but could not remove .zip from project folder: ${delErr.message}`));
                            }
                            cb(null, stats);
                        });
                    }, null, onFileDone);
                });
            });
        });
        return;
    }

    verifyObjectsAtDest(session, paths, cb, onFileDone);
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
                            cleanupStagingPrefix(stagingPath, delErr => {
                                if (delErr) {
                                    return cb(new Error(`Upload copied but staging cleanup failed: ${delErr.message}`));
                                }
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
            cleanupStagingPrefix(stagingPath, delErr => {
                if (delErr) {
                    return cb(new Error(`Upload copied but staging cleanup failed: ${delErr.message}`));
                }
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
            stagedFiles: result.stagedFiles
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
                    session.localExtracted = true;
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
                stagedFiles: session.stagedFileCount
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
                if (session.progress) {
                    session.progress.filesCompleted = session.progress.filesTotal || (stats && stats.fileCount) || 0;
                    session.progress.done = true;
                    session.progress.phase = err ? "error" : "complete";
                    session.progress.currentFile = "";
                }
                if (err) {
                    session.commitResult = { error: err.message };
                    persistCommitStatus(uploadId, session.commitResult);
                } else {
                    session.commitResult = {
                        success: true,
                        filesUploaded: stats.fileCount,
                        gcsDestPath: session.gcsDestPath,
                        gcsUri: `gs://${config.gcsBucket}/${session.gcsDestPath}/`
                    };
                    persistCommitStatus(uploadId, session.commitResult);
                    logger.info(`GCS manual upload commit complete: ${stats.fileCount} files → ${session.gcsDestPath}`);
                }
            };

            if (session.directUpload) {
                const localStaging = sessionStagingDir(uploadId);
                const localCount = localStaging ? countFilesUnder(localStaging) : 0;
                if (localCount > 0) {
                    uploadFolderToGcs(localStaging, session.gcsDestPath, done, onFileDone);
                    return;
                }
                GCS.listFilesUnderPrefix(session.gcsStagingPath, (listErr, stagingObjects) => {
                    if (listErr) return done(listErr);
                    if (stagingObjects && stagingObjects.length) {
                        commitFromGcsStaging(session, uploadId, done, onFileDone);
                    } else {
                        commitDirectGcsUpload(session, uploadId, done, onFileDone);
                    }
                });
            } else {
                uploadFolderToGcs(stagingDir, session.gcsDestPath, done, onFileDone);
            }
        });
    };

    if (session.directUpload) {
        const staged = session.stagedFileCount ||
            (session.stagedRelativePaths && session.stagedRelativePaths.size) || 0;
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
    if (req.gcsUploadCommitDisk) {
        const disk = req.gcsUploadCommitDisk;
        if (disk.error) {
            return res.json({ done: true, error: disk.error, phase: "error" });
        }
        return res.json(Object.assign({ done: true, phase: "complete", success: true }, publicUploadPayload(disk)));
    }

    const session = req.gcsUploadSession;
    if (!session) {
        const disk = readCommitStatus(req.gcsUploadId);
        if (disk) {
            if (disk.error) {
                return res.json({ done: true, error: disk.error, phase: "error" });
            }
            return res.json(Object.assign({ done: true, phase: "complete", success: true }, publicUploadPayload(disk)));
        }
        return res.json({ error: "Upload session not found or expired." });
    }

    if (session.commitResult) {
        if (session.commitResult.error) {
            return res.json({
                done: true,
                error: session.commitResult.error,
                phase: "error"
            });
        }
        return res.json(Object.assign({ done: true, phase: "complete" }, publicUploadPayload(session.commitResult)));
    }

    if (session.progress) {
        const out = Object.assign({ done: !!session.progress.done }, session.progress);
        if (session.progress.phase === "complete") {
            out.done = true;
        }
        if (!out.done && session.progress.filesTotal > 0 &&
            session.progress.filesCompleted >= session.progress.filesTotal) {
            const disk = readCommitStatus(req.gcsUploadId);
            if (disk && disk.success) {
                return res.json(Object.assign({ done: true, phase: "complete", success: true }, publicUploadPayload(disk)));
            }
        }
        return res.json(out);
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
    const disk = readCommitStatus(uploadId);
    const committed = (session && session.commitResult && session.commitResult.success) ||
        (disk && disk.success);
    const abandon = String(req.query.abandon || "") === "1" ||
        String(req.query.abandon || "").toLowerCase() === "true";
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

    const cleanupGcs = () => {
        if (!session || !session.directUpload) {
            return finish();
        }
        if (committed || !abandon) {
            if (session.gcsStagingPath) {
                return GCS.deletePrefixWithRetry(session.gcsStagingPath, delErr => {
                    if (delErr) logger.warn(`GCS legacy staging cleanup: ${delErr.message}`);
                    finish();
                });
            }
            return finish();
        }
        cleanupAbandonedDirectUpload(session, err => {
            if (err) logger.warn(`GCS abandoned upload cleanup: ${err.message}`);
            finish();
        });
    };

    cleanupGcs();
}

module.exports = {
    assignUpload,
    assignUploadProgress,
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
