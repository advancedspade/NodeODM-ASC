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
const archiver = require("archiver");
const config = require("../config");
const GCS = require("./GCS");
const ziputils = require("./ziputils");
const logger = require("./logger");
const { sanitizeProjectName, gcsDestPathForProject, isDownloadableProjectRelativePath } = require("./gcsProjectName");

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZIP_EXT = /\.zip$/i;
const MAX_SIGN_BATCH = 50;
/** Restart step 2 if still on preparing/starting after this long (stale lock or missed start). */
const COMMIT_STALL_MS = 90000;

const sessions = new Map();
/** Upload IDs with an active commit job on this process (not persisted). */
const activeCommits = new Set();

function gcsUploadSessionsRoot() {
    const dataRoot = path.resolve("/var/www/data");
    if (fs.existsSync(dataRoot)) {
        return path.join(dataRoot, "gcs-upload-sessions");
    }
    return path.resolve("tmp", "gcs-upload-sessions");
}

function gcsSessionStagingPath(uploadId) {
    const prefix = (config.gcsUploadPrefix || "").replace(/\/$/, "");
    const base = `.uploads/${uploadId}`;
    return prefix ? `${prefix}/${base}` : base;
}

function sessionTmpDir(uploadId) {
    if (!UPLOAD_ID_RE.test(String(uploadId || ""))) return null;
    return path.join(gcsUploadSessionsRoot(), uploadId);
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

function sessionMetaPath(uploadId) {
    const dir = sessionTmpDir(uploadId);
    return dir ? path.join(dir, "session.json") : null;
}

function progressStatusPath(uploadId) {
    const dir = sessionTmpDir(uploadId);
    return dir ? path.join(dir, "commit-progress.json") : null;
}

function serializeSession(session) {
    return {
        uploadId: session.uploadId,
        projectName: session.projectName,
        sanitizedName: session.sanitizedName,
        gcsDestPath: session.gcsDestPath,
        gcsStagingPath: session.gcsStagingPath,
        createdAt: session.createdAt,
        stagedFileCount: session.stagedFileCount || 0,
        stagedRelativePaths: session.stagedRelativePaths
            ? Array.from(session.stagedRelativePaths) : [],
        directUpload: !!session.directUpload,
        localExtracted: !!session.localExtracted,
        zipOnlyUpload: !!session.zipOnlyUpload,
        progress: session.progress || null,
        commitResult: session.commitResult || null
    };
}

function persistSession(uploadId, session) {
    const p = sessionMetaPath(uploadId);
    if (!p || !session) return;
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(Object.assign({ savedAt: Date.now() }, serializeSession(session))));
    } catch (e) {
        logger.warn(`GCS session persist failed: ${e.message}`);
    }
}

function sessionFromSnapshotData(data, uploadId) {
    if (!data || typeof data !== "object") return null;
    return {
        uploadId: data.uploadId || uploadId,
        projectName: data.projectName,
        sanitizedName: data.sanitizedName,
        gcsDestPath: data.gcsDestPath,
        gcsStagingPath: data.gcsStagingPath,
        createdAt: data.createdAt || Date.now(),
        stagedFileCount: data.stagedFileCount || 0,
        stagedRelativePaths: new Set(data.stagedRelativePaths || []),
        directUpload: data.directUpload !== false,
        localExtracted: !!data.localExtracted,
        zipOnlyUpload: !!data.zipOnlyUpload,
        progress: data.progress || null,
        commitResult: data.commitResult || null
    };
}

function loadSessionFromDisk(uploadId) {
    const p = sessionMetaPath(uploadId);
    if (p && fs.existsSync(p)) {
        try {
            const data = JSON.parse(fs.readFileSync(p, "utf8"));
            const session = sessionFromSnapshotData(data, uploadId);
            if (session) {
                sessions.set(uploadId, session);
                return session;
            }
        } catch (e) {
            logger.warn(`GCS session load failed for ${uploadId}: ${e.message}`);
        }
    }
    return recoverSessionFromProgress(uploadId);
}

function recoverSessionFromProgress(uploadId) {
    const progress = readCommitProgress(uploadId);
    if (!progress || !progress.sessionSnapshot) return null;
    try {
        const session = sessionFromSnapshotData(progress.sessionSnapshot, uploadId);
        if (!session) return null;
        const progressCopy = Object.assign({}, progress);
        delete progressCopy.sessionSnapshot;
        delete progressCopy.savedAt;
        if (progressCopy.phase) session.progress = progressCopy;
        sessions.set(uploadId, session);
        persistSession(uploadId, session);
        logger.info(`GCS session recovered from progress snapshot: ${uploadId}`);
        return session;
    } catch (e) {
        logger.warn(`GCS session recover failed for ${uploadId}: ${e.message}`);
        return null;
    }
}

function getOrLoadSession(uploadId) {
    return getSession(uploadId) || loadSessionFromDisk(uploadId);
}

function persistCommitProgress(uploadId, progress) {
    const p = progressStatusPath(uploadId);
    if (!p || !progress) return;
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(Object.assign({ savedAt: Date.now() }, progress)));
    } catch (e) {
        logger.warn(`GCS commit progress write failed: ${e.message}`);
    }
}

function readCommitProgress(uploadId) {
    const p = progressStatusPath(uploadId);
    if (!p || !fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
        return null;
    }
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
    let session = getOrLoadSession(uploadId);
    if (!session) {
        session = recoverSessionFromProgress(uploadId);
    }
    if (session) {
        req.gcsUploadSession = session;
        return next();
    }
    const progressDisk = readCommitProgress(uploadId);
    if (progressDisk) {
        req.gcsCommitProgressDisk = progressDisk;
        return next();
    }
    const disk = readCommitStatus(uploadId);
    if (disk) {
        req.gcsUploadCommitDisk = disk;
        return next();
    }
    if (fs.existsSync(dir)) {
        req.gcsUploadWaiting = true;
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
    if (!dir) {
        return res.json({ error: "Invalid upload session id." });
    }
    let session = getOrLoadSession(uploadId);
    if (!session) {
        session = recoverSessionFromProgress(uploadId);
    }
    if (!session) {
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
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    if (forceRefresh) {
        GCS.invalidateProjectsListCache();
    }

    GCS.listProjectsCached((err, projects) => {
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

function incompleteStatusLabel(entry) {
    if (entry.hasRawImages) {
        return "Raw images only — no orthophoto yet";
    }
    return "No orthophoto output";
}

function handleListIncompleteProjects(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    if (forceRefresh) {
        GCS.invalidateProjectsListCache();
    }

    GCS.listIncompleteProjectsCached((err, projects) => {
        if (err) return res.json({ error: err.message });

        const bucket = config.gcsBucket || "";
        const list = (projects || []).map(p => ({
            name: p.name,
            displayName: projectDisplayName(p.name),
            hasRawImages: !!p.hasRawImages,
            status: incompleteStatusLabel(p),
            gcsUri: bucket && p.gcsPath ? `gs://${bucket}/${p.gcsPath}` : ""
        }));

        res.json({ projects: list });
    });
}

function resolveProjectRelativePath(objectRel) {
    const rel = String(objectRel || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
    if (!rel || rel.includes("..")) return null;
    const parts = rel.split("/").filter(p => p && p !== "." && p !== "..");
    if (!parts.length) return null;
    return parts.join("/");
}

function resolveProjectObjectPath(projectName, objectRel) {
    const sanitized = sanitizeProjectName(projectName, "");
    if (!sanitized || sanitized !== String(projectName || "").trim()) {
        return null;
    }
    const rel = resolveProjectRelativePath(objectRel);
    if (!rel || !isDownloadableProjectRelativePath(rel)) return null;
    const base = gcsDestPathForProject(sanitized, config.gcsUploadPrefix);
    return base ? `${base}/${rel}` : null;
}

function parseArchivePathsQuery(raw) {
    if (raw == null || raw === "") return null;
    const parts = String(raw).split(",").map(p => resolveProjectRelativePath(p)).filter(Boolean);
    return parts.length ? parts : null;
}

function handleListProjectInputs(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }

    const projectName = String(req.params.projectName || "").trim();
    GCS.listProjectInputFiles(projectName, (err, files) => {
        if (err) return res.json({ error: err.message });
        if (!files || !files.length) {
            return res.json({
                error: "No input images found for this project in cloud storage.",
                projectName,
                files: []
            });
        }
        res.json({
            projectName,
            displayName: projectDisplayName(projectName),
            fileCount: files.length,
            files
        });
    });
}

function handleListProjectFiles(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }

    const projectName = String(req.params.projectName || "").trim();
    GCS.listProjectFiles(projectName, (err, files) => {
        if (err) return res.json({ error: err.message });
        res.json({
            projectName,
            displayName: projectDisplayName(projectName),
            fileCount: (files || []).length,
            files: files || []
        });
    });
}

function handleDownloadProjectFile(req, res) {
    if (!GCS.enabled()) {
        return res.status(503).json({ error: "GCS uploads are not available on this server." });
    }

    const objectPath = resolveProjectObjectPath(req.params.projectName, req.query.path);
    if (!objectPath) {
        return res.status(400).json({ error: "Invalid project file path." });
    }

    GCS.getObjectMetadata(objectPath, (err, metadata) => {
        if (err) {
            return res.status(404).json({ error: "File not found in cloud storage." });
        }
        const contentType = (metadata && metadata.contentType) ||
            GCS.contentTypeForPath(objectPath) ||
            "application/octet-stream";
        const filename = path.basename(objectPath);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
        if (metadata && metadata.size) {
            res.setHeader("Content-Length", String(metadata.size));
        }
        const stream = GCS.createReadStream(objectPath);
        if (!stream) {
            return res.status(503).json({ error: "GCS is not initialized" });
        }
        stream.on("error", () => {
            if (!res.headersSent) {
                res.status(500).json({ error: "Failed to read file from cloud storage." });
            }
        });
        stream.pipe(res);
    });
}

function handleArchiveProject(req, res) {
    if (!GCS.enabled()) {
        return res.status(503).json({ error: "GCS uploads are not available on this server." });
    }

    const projectName = String(req.params.projectName || "").trim();
    const sanitized = sanitizeProjectName(projectName, "");
    if (!sanitized || sanitized !== projectName) {
        return res.status(400).json({ error: "Invalid project name." });
    }

    const pathFilter = parseArchivePathsQuery(req.query.paths);
    if (pathFilter && pathFilter.length === 1) {
        // Single-file selection streams directly — no zip wrapper.
        req.query.path = pathFilter[0];
        return handleDownloadProjectFile(req, res);
    }

    GCS.listProjectFiles(projectName, (err, files) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        let selected = files || [];
        if (pathFilter) {
            const wanted = new Set(pathFilter);
            selected = selected.filter(f => wanted.has(f.path));
        }

        if (!selected.length) {
            return res.status(404).json({ error: "No downloadable files found for this project." });
        }

        const base = gcsDestPathForProject(sanitized, config.gcsUploadPrefix);
        const zipName = `${sanitized}.zip`;
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

        const archive = archiver("zip", { store: true });
        archive.on("error", archiveErr => {
            logger.error(`Project archive failed for ${projectName}: ${archiveErr.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: "Failed to build project archive." });
            } else {
                res.destroy(archiveErr);
            }
        });
        archive.pipe(res);

        async.eachSeries(selected, (file, next) => {
            const objectPath = `${base}/${file.path}`;
            const stream = GCS.createReadStream(objectPath);
            if (!stream) return next(new Error("GCS is not initialized"));
            stream.on("error", next);
            archive.append(stream, { name: file.path });
            // archiver consumes the stream; move on once it's queued.
            next();
        }, appendErr => {
            if (appendErr) {
                logger.error(`Project archive append failed for ${projectName}: ${appendErr.message}`);
                archive.abort();
                if (!res.headersSent) {
                    return res.status(500).json({ error: "Failed to build project archive." });
                }
                return res.destroy(appendErr);
            }
            archive.finalize();
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

        const session = {
            uploadId,
            projectName: String(rawName).trim(),
            sanitizedName,
            gcsDestPath: gcsDest,
            gcsStagingPath: gcsSessionStagingPath(uploadId),
            createdAt: Date.now(),
            stagedFileCount: 0,
            stagedRelativePaths: new Set(),
            directUpload: true
        };
        sessions.set(uploadId, session);
        persistSession(uploadId, session);
        logger.info(`GCS upload session ${uploadId} → ${sessionTmpDir(uploadId)}`);

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
    if (session.uploadId) persistSession(session.uploadId, session);
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

function verifyUploadedObject(session, relativePath, expectedBytes, cb) {
    const rel = sanitizeRelativePath(relativePath);
    const objectPath = gcsObjectPathForRelative(session, rel);
    GCS.objectMetadata(objectPath, (err, metadata) => {
        if (err) {
            const code = err.code || (err.response && err.response.statusCode);
            if (code === 404 || code === "404") {
                return cb(new Error(`File not found in cloud storage after upload: ${rel}`));
            }
            return cb(err);
        }
        const size = metadata && metadata.size != null ? parseInt(metadata.size, 10) : 0;
        const expected = parseInt(expectedBytes, 10) || 0;
        if (expected > 0 && size !== expected) {
            return cb(new Error(
                `Upload incomplete for ${rel}: ${size} bytes in storage, expected ${expected}. ` +
                "Retry the upload (do not refresh until step 1 finishes)."
            ));
        }
        cb(null, { relativePath: rel, size });
    });
}

function handleComplete(req, res) {
    const session = req.gcsUploadSession;
    const body = req.body || {};
    let paths = [];
    let expectedByPath = {};

    if (Array.isArray(body.relativePaths) && body.relativePaths.length) {
        paths = body.relativePaths;
        if (Array.isArray(body.expectedBytes) && body.expectedBytes.length === paths.length) {
            paths.forEach((p, i) => { expectedByPath[p] = body.expectedBytes[i]; });
        }
    } else if (body.relativePath) {
        paths = [body.relativePath];
        if (body.expectedBytes != null) {
            expectedByPath[body.relativePath] = body.expectedBytes;
        }
    } else {
        return res.json({ error: "relativePath or relativePaths[] is required." });
    }

    async.eachSeries(paths, (relPath, next) => {
        verifyUploadedObject(session, relPath, expectedByPath[relPath], (verifyErr, info) => {
            if (verifyErr) return next(verifyErr);
            markStaged(session, info.relativePath || relPath);
            next();
        });
    }, err => {
        if (err) {
            logger.warn(`GCS upload complete verification failed: ${err.message}`);
            return res.json({ error: err.message });
        }
        if (paths.length === 1 && ZIP_EXT.test(sanitizeRelativePath(paths[0]))) {
            session.zipOnlyUpload = true;
        }
        if (session.uploadId) persistSession(session.uploadId, session);
        res.json({
            success: true,
            stagedFiles: session.stagedFileCount,
            relativePaths: paths.map(p => sanitizeRelativePath(p))
        });
    });
}

function stagedRelativePathsArray(session) {
    return session.stagedRelativePaths ? Array.from(session.stagedRelativePaths) : [];
}

function isZipOnlyUpload(session) {
    if (!session || session.localExtracted) return false;
    if (session.zipOnlyUpload || (session.progress && session.progress.zipCommit)) return true;
    const paths = stagedRelativePathsArray(session);
    return paths.length === 1 && ZIP_EXT.test(sanitizeRelativePath(paths[0]));
}

/** If the archive has one top-level folder, upload its contents (not the wrapper name). */
function resolveExtractUploadRoot(extractDir) {
    if (!fs.existsSync(extractDir)) return extractDir;
    let entries;
    try {
        entries = fs.readdirSync(extractDir, { withFileTypes: true });
    } catch (e) {
        return extractDir;
    }
    const visible = entries.filter(e => {
        const name = e.name || "";
        return name && name !== "__MACOSX" && !name.startsWith(".");
    });
    if (visible.length === 1 && visible[0].isDirectory()) {
        const nested = path.join(extractDir, visible[0].name);
        logger.info(`GCS zip extract: single top-level folder "${visible[0].name}" — uploading its contents`);
        return nested;
    }
    return extractDir;
}

function verifyObjectsAtDest(session, relativePaths, cb, onFileDone) {
    const destBase = String(session.gcsDestPath || "").replace(/\/+$/, "") + "/";
    const paths = relativePaths.map(p => sanitizeRelativePath(p));
    const zipOnly = paths.length > 0 && paths.every(p => ZIP_EXT.test(p));
    if (zipOnly) {
        return cb(new Error(
            ".zip archive was not extracted on the server (only the archive object was found). " +
            "Re-upload the .zip or redeploy the latest server build."
        ));
    }
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

function patchCommitProgress(session, patch) {
    if (!session || !session.progress) return;
    Object.assign(session.progress, patch);
    const uploadId = session.uploadId;
    if (uploadId) {
        persistCommitProgress(uploadId, Object.assign({}, session.progress, {
            sessionSnapshot: serializeSession(session)
        }));
        persistSession(uploadId, session);
    }
}

function commitDirectGcsUpload(session, uploadId, cb, onFileDone) {
    const destPath = session.gcsDestPath;
    const tmpDir = sessionTmpDir(uploadId);
    const localStaging = sessionStagingDir(uploadId);
    const paths = stagedRelativePathsArray(session).map(p => sanitizeRelativePath(p));

    if (!paths.length) {
        return cb(new Error("No files staged for this session."));
    }

    const zipPaths = paths.filter(p => ZIP_EXT.test(p));
    const nonZipPaths = paths.filter(p => !ZIP_EXT.test(p));
    const mustExtractZip = isZipOnlyUpload(session);

    if (zipPaths.length > 1 || (zipPaths.length === 1 && nonZipPaths.length > 0)) {
        return cb(new Error("Upload either one .zip or individual files, not both."));
    }

    if (mustExtractZip && !zipPaths.length) {
        return cb(new Error(
            `Session is a .zip upload but staged path is not a .zip: ${paths.join(", ")}`
        ));
    }

    if (zipPaths.length === 1) {
        const zipRel = zipPaths[0];
        const zipObjectPath = gcsObjectPathForRelative(session, zipRel);
        const zipLocal = path.join(tmpDir, "upload.zip");
        const extractDir = localStaging;

        patchCommitProgress(session, {
            subPhase: "downloading_zip",
            statusMessage: "Preparing to download archive from cloud storage…",
            currentFile: zipRel,
            bytesCompleted: 0,
            bytesTotal: 0
        });
        logger.info(`GCS zip commit: downloading ${zipObjectPath}`);

        GCS.objectExists(zipObjectPath, (existsErr, exists) => {
            if (existsErr) return cb(existsErr);
            if (!exists) {
                return cb(new Error(`Archive not found in cloud storage (${zipRel}). Step 1 may not have finished uploading.`));
            }

            GCS.objectMetadata(zipObjectPath, (metaErr, metadata) => {
                if (metaErr) return cb(metaErr);
                const zipSize = metadata && metadata.size != null ? parseInt(metadata.size, 10) : 0;
                const sizeLabel = zipSize > 0
                    ? `${(zipSize / (1024 * 1024)).toFixed(0)} MB`
                    : "archive";
                patchCommitProgress(session, {
                    subPhase: "downloading_zip",
                    statusMessage: `Downloading ${sizeLabel} from cloud storage to server…`,
                    currentFile: zipRel,
                    bytesCompleted: 0,
                    bytesTotal: zipSize
                });

                rimraf(extractDir, () => {
                    fs.mkdir(extractDir, { recursive: true }, mkdirErr => {
                        if (mkdirErr) return cb(mkdirErr);

                        GCS.downloadFile(zipObjectPath, zipLocal, dlErr => {
                            if (dlErr) return cb(dlErr);

                            patchCommitProgress(session, {
                                subPhase: "extracting",
                                statusMessage: "Extracting archive on server…",
                                currentFile: zipRel,
                                bytesCompleted: 0,
                                bytesTotal: 0
                            });
                            logger.info(`GCS zip commit: extracting ${zipLocal} → ${extractDir}`);

                            ziputils.unzip(zipLocal, extractDir, unzipErr => {
                                rimraf(zipLocal, () => {});
                                if (unzipErr) return cb(unzipErr);

                                const uploadRoot = resolveExtractUploadRoot(extractDir);
                                const extractedCount = countFilesUnder(uploadRoot);
                                if (extractedCount === 0) {
                                    return cb(new Error(
                                        "Archive extracted but contained no files. " +
                                        "Ensure the .zip holds a project folder (ODM output, tileset, etc.)."
                                    ));
                                }

                                patchCommitProgress(session, {
                                    subPhase: "uploading",
                                    statusMessage: `Uploading ${extractedCount} extracted file(s) to project folder…`,
                                    filesTotal: extractedCount,
                                    filesCompleted: 0,
                                    currentFile: ""
                                });
                                logger.info(`GCS zip commit: uploading ${extractedCount} files from ${uploadRoot} to ${destPath}`);

                                uploadFolderToGcs(uploadRoot, destPath, (upErr, stats) => {
                                    if (upErr) return cb(upErr);
                                    GCS.deleteObjects([zipObjectPath], delErr => {
                                        if (delErr) {
                                            logger.warn(`GCS zip cleanup failed for ${zipObjectPath}: ${delErr.message}`);
                                        }
                                        cb(null, stats);
                                    });
                                }, null, onFileDone);
                            });
                        }, (received, total) => {
                            patchCommitProgress(session, {
                                subPhase: "downloading_zip",
                                statusMessage: total > 0
                                    ? `Downloading archive… ${Math.round((received / total) * 100)}%`
                                    : "Downloading archive from cloud storage…",
                                bytesCompleted: received,
                                bytesTotal: total,
                                currentFile: zipRel
                            });
                        });
                    });
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

            patchCommitProgress(session, {
                subPhase: "downloading_zip",
                statusMessage: "Downloading archive from staging…",
                currentFile: path.basename(zipObject.name)
            });

            rimraf(extractDir, () => {
                fs.mkdir(extractDir, { recursive: true }, mkdirErr => {
                    if (mkdirErr) return cb(mkdirErr);

                    GCS.downloadFile(zipObject.name, zipLocal, dlErr => {
                        if (dlErr) return cb(dlErr);

                        patchCommitProgress(session, {
                            subPhase: "extracting",
                            statusMessage: "Extracting archive on server…"
                        });

                        ziputils.unzip(zipLocal, extractDir, unzipErr => {
                            rimraf(zipLocal, () => {});
                            if (unzipErr) return cb(unzipErr);

                            const uploadRoot = resolveExtractUploadRoot(extractDir);
                            const extractedCount = countFilesUnder(uploadRoot);
                            patchCommitProgress(session, {
                                subPhase: "uploading",
                                statusMessage: `Uploading ${extractedCount} extracted file(s)…`,
                                filesTotal: extractedCount,
                                filesCompleted: 0
                            });

                            uploadFolderToGcs(uploadRoot, destPath, (upErr, stats) => {
                                if (upErr) return cb(upErr);
                                cleanupStagingPrefix(stagingPath, delErr => {
                                    if (delErr) {
                                        return cb(new Error(`Upload copied but staging cleanup failed: ${delErr.message}`));
                                    }
                                    cb(null, stats);
                                });
                            }, null, onFileDone);
                        });
                    }, (received, total) => {
                        patchCommitProgress(session, {
                            subPhase: "downloading_zip",
                            statusMessage: total > 0
                                ? `Downloading archive… ${Math.round((received / total) * 100)}%`
                                : "Downloading archive from staging…",
                            bytesCompleted: received,
                            bytesTotal: total
                        });
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
            ziputils.unzip(incomingPath, stagingDir, unzipErr => {
                if (unzipErr) return finish(unzipErr);
                session.stagedFileCount = countFilesUnder(stagingDir);
                session.localExtracted = true;
                finish(null, {
                    relativePath: "",
                    extracted: true,
                    stagedFiles: session.stagedFileCount
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

function startCommitWork(session, uploadId) {
    if (activeCommits.has(uploadId)) return false;
    activeCommits.add(uploadId);

    const stagingDir = sessionStagingDir(uploadId);

    patchCommitProgress(session, {
        subPhase: "starting",
        statusMessage: "Starting archive processing on server…"
    });

    setImmediate(() => {
        const onFileDone = (completed, total, name) => {
            if (!session.progress) return;
            session.progress.filesCompleted = completed;
            session.progress.filesTotal = total;
            session.progress.currentFile = name || "";
        };

        const done = (err, stats) => {
            activeCommits.delete(uploadId);
            if (session.progress) {
                session.progress.filesCompleted = session.progress.filesTotal || (stats && stats.fileCount) || 0;
                session.progress.done = true;
                session.progress.phase = err ? "error" : "complete";
                session.progress.currentFile = "";
            }
            if (err) {
                if (session.progress) {
                    session.progress.statusMessage = err.message;
                    session.progress.subPhase = "error";
                }
                session.commitResult = { error: err.message };
                persistCommitStatus(uploadId, session.commitResult);
                persistSession(uploadId, session);
            } else {
                session.commitResult = {
                    success: true,
                    filesUploaded: stats.fileCount,
                    gcsDestPath: session.gcsDestPath,
                    gcsUri: `gs://${config.gcsBucket}/${session.gcsDestPath}/`
                };
                persistCommitStatus(uploadId, session.commitResult);
                persistSession(uploadId, session);
                logger.info(`GCS manual upload commit complete: ${stats.fileCount} files → ${session.gcsDestPath}`);
            }
        };

        try {
            if (session.directUpload) {
                if (isZipOnlyUpload(session)) {
                    logger.info(`GCS zip commit: starting for upload ${uploadId}`);
                    commitDirectGcsUpload(session, uploadId, done, onFileDone);
                    return;
                }

                const localStaging = sessionStagingDir(uploadId);
                const localCount = localStaging ? countFilesUnder(localStaging) : 0;
                if (localCount > 0) {
                    patchCommitProgress(session, {
                        subPhase: "uploading",
                        statusMessage: `Uploading ${localCount} extracted file(s) to project folder…`,
                        filesTotal: localCount,
                        filesCompleted: 0
                    });
                    logger.info(`GCS commit: uploading ${localCount} local staged files to ${session.gcsDestPath}`);
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
            } else if (stagingDir) {
                uploadFolderToGcs(stagingDir, session.gcsDestPath, done, onFileDone);
            } else {
                done(new Error("Invalid upload session staging path."));
            }
        } catch (e) {
            activeCommits.delete(uploadId);
            done(e);
        }
    });
    return true;
}

function commitProgressAgeMs(session) {
    if (!session || !session.progress) return 0;
    const started = session.progress.startedAt || 0;
    return started ? Math.max(0, Date.now() - started) : 0;
}

function isCommitStalled(session) {
    if (!session || !session.progress || session.progress.done) return false;
    if (session.progress.phase !== "committing") return false;
    const sub = session.progress.subPhase || "";
    if (sub !== "preparing" && sub !== "starting") return false;
    return commitProgressAgeMs(session) >= COMMIT_STALL_MS;
}

function resumeCommitIfNeeded(session, uploadId) {
    if (!session || !session.progress) return;
    if (session.progress.done || session.progress.phase !== "committing") return;

    const stalled = isCommitStalled(session);
    if (activeCommits.has(uploadId)) {
        if (!stalled) return;
        logger.warn(`GCS commit stale lock cleared: ${uploadId} (subPhase=${session.progress.subPhase || "?"})`);
        activeCommits.delete(uploadId);
    }

    logger.info(`GCS commit resume: ${uploadId} (subPhase=${session.progress.subPhase || "?"}, age=${Math.round(commitProgressAgeMs(session) / 1000)}s)`);
    startCommitWork(session, uploadId);
}

function handleCommit(req, res) {
    const session = req.gcsUploadSession;
    const uploadId = req.gcsUploadId;
    const stagingDir = sessionStagingDir(uploadId);

    if (!stagingDir) {
        return res.json({ error: "Invalid upload session." });
    }

    if (session.progress && session.progress.phase === "committing" && !session.progress.done) {
        if (activeCommits.has(uploadId) && !isCommitStalled(session)) {
            return res.json({
                success: true,
                committing: true,
                filesTotal: session.progress.filesTotal || 0,
                alreadyInProgress: true
            });
        }
        resumeCommitIfNeeded(session, uploadId);
        return res.json({
            success: true,
            committing: true,
            resumed: true,
            filesTotal: session.progress.filesTotal || 0
        });
    }

    const finishStart = (fileCount, opts) => {
        const zipCommit = !!(opts && opts.zipCommit);
        session.progress = {
            phase: "committing",
            subPhase: zipCommit ? "preparing" : "uploading",
            statusMessage: (opts && opts.statusMessage) ||
                (zipCommit ? "Preparing archive…" : "Processing upload…"),
            filesTotal: fileCount || 0,
            filesCompleted: 0,
            bytesCompleted: 0,
            bytesTotal: 0,
            currentFile: "",
            zipCommit,
            done: false,
            startedAt: Date.now()
        };
        session.commitResult = null;

        persistSession(uploadId, session);

        res.json({
            success: true,
            committing: true,
            filesTotal: fileCount
        });

        startCommitWork(session, uploadId);
    };

    if (session.directUpload) {
        const relPaths = session.stagedRelativePaths ? Array.from(session.stagedRelativePaths) : [];
        const zipOnly = relPaths.length === 1 && ZIP_EXT.test(relPaths[0]) && !session.localExtracted;
        const staged = session.stagedFileCount ||
            (session.stagedRelativePaths && session.stagedRelativePaths.size) || 0;
        if (!staged && !zipOnly) {
            return res.json({ error: "No files staged for upload." });
        }
        if (zipOnly) {
            return finishStart(0, {
                zipCommit: true,
                statusMessage: "Archive uploaded — preparing extraction…"
            });
        }
        return finishStart(staged);
    }

    const fileCount = countFilesUnder(stagingDir);
    if (fileCount === 0) {
        return res.json({ error: "No files staged for upload." });
    }
    finishStart(fileCount);
}

function handleRecover(req, res) {
    if (!GCS.enabled()) {
        return res.json({ error: "GCS uploads are not available on this server." });
    }

    const uploadId = req.params.uploadId;
    if (!UPLOAD_ID_RE.test(String(uploadId || ""))) {
        return res.json({ error: "Invalid upload session id." });
    }

    const existing = getOrLoadSession(uploadId);
    if (existing) {
        return res.json({ success: true, recovered: false, uploadId });
    }

    const body = req.body || {};
    const rawName = body.projectName || body.sanitizedName || "";
    const sanitizedName = sanitizeProjectName(rawName);
    let relativePaths = [];
    if (Array.isArray(body.relativePaths) && body.relativePaths.length) {
        relativePaths = body.relativePaths.map(p => sanitizeRelativePath(p));
    } else if (body.relativePath) {
        relativePaths = [sanitizeRelativePath(body.relativePath)];
    }
    if (!sanitizedName || !relativePaths.length) {
        return res.json({
            error: "Recovery requires projectName and relativePath(s) from step 1."
        });
    }

    const tmpDir = sessionTmpDir(uploadId);
    fs.mkdir(tmpDir, { recursive: true }, mkdirErr => {
        if (mkdirErr) return res.json({ error: mkdirErr.message });

        const session = {
            uploadId,
            projectName: String(rawName).trim() || sanitizedName,
            sanitizedName,
            gcsDestPath: gcsDestPathForProject(sanitizedName, config.gcsUploadPrefix),
            gcsStagingPath: gcsSessionStagingPath(uploadId),
            createdAt: Date.now(),
            stagedFileCount: relativePaths.length,
            stagedRelativePaths: new Set(relativePaths),
            directUpload: true,
            zipOnlyUpload: relativePaths.length === 1 && ZIP_EXT.test(relativePaths[0])
        };

        async.eachSeries(relativePaths, (relPath, next) => {
            verifyUploadedObject(session, relPath, 0, verifyErr => {
                if (verifyErr) return next(verifyErr);
                next();
            });
        }, err => {
            if (err) {
                logger.warn(`GCS upload recover failed for ${uploadId}: ${err.message}`);
                return res.json({ error: err.message });
            }
            sessions.set(uploadId, session);
            persistSession(uploadId, session);
            logger.info(`GCS upload session recovered from client snapshot: ${uploadId}`);
            res.json({ success: true, recovered: true, uploadId });
        });
    });
}

function handleProgress(req, res) {
    if (req.gcsUploadCommitDisk) {
        const disk = req.gcsUploadCommitDisk;
        if (disk.error) {
            return res.json({ done: true, error: disk.error, phase: "error" });
        }
        return res.json(Object.assign({ done: true, phase: "complete", success: true }, publicUploadPayload(disk)));
    }

    if (req.gcsCommitProgressDisk) {
        let recovered = recoverSessionFromProgress(req.gcsUploadId);
        if (recovered && recovered.progress) {
            resumeCommitIfNeeded(recovered, req.gcsUploadId);
            const out = Object.assign({ done: !!recovered.progress.done }, recovered.progress);
            if (recovered.progress.phase === "complete" || recovered.progress.done) {
                out.done = true;
            }
            return res.json(out);
        }
        const disk = req.gcsCommitProgressDisk;
        const out = Object.assign({ done: !!disk.done }, disk);
        delete out.sessionSnapshot;
        if (disk.phase === "complete" || disk.done) {
            out.done = true;
        }
        return res.json(out);
    }

    if (req.gcsUploadWaiting) {
        return res.json({
            done: false,
            phase: "waiting",
            statusMessage: "Reconnecting to upload session on server…",
            filesTotal: 0,
            filesCompleted: 0
        });
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
        resumeCommitIfNeeded(session, req.gcsUploadId);
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

    res.json({
        done: false,
        phase: "waiting",
        filesTotal: 0,
        filesCompleted: 0
    });
}

function handleDelete(req, res) {
    const uploadId = req.params.uploadId;
    const dir = sessionTmpDir(uploadId);
    const session = getOrLoadSession(uploadId);
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
    handleListIncompleteProjects,
    handleListProjectInputs,
    handleListProjectFiles,
    handleDownloadProjectFile,
    handleArchiveProject,
    handleInit,
    handleSign,
    handleComplete,
    handleFile,
    handleBatch,
    handleCommit,
    handleRecover,
    handleProgress,
    handleDelete
};
