/*
NodeODM App and REST API to access ODM.
Copyright (C) 2016 NodeODM Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

const { Storage } = require('@google-cloud/storage');
const async = require('async');
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const logger = require('./logger');
const config = require('../config');
const rmdir = require('rimraf');

let storage = null;
let bucket = null;
let lastInitError = null;

module.exports = {
    enabled: function() {
        return storage !== null && bucket !== null;
    },

    lastInitError: function() {
        return lastInitError;
    },

    initialize: function(cb) {
        lastInitError = null;
        if (config.gcsBucket) {
            const storageConfig = {};

            // If a key file is provided, use it; otherwise rely on default credentials
            // (e.g., VM service account, workload identity, GOOGLE_APPLICATION_CREDENTIALS env var)
            if (config.gcsKeyPath) {
                storageConfig.keyFilename = config.gcsKeyPath;
            }

            // Optional: specify project ID explicitly
            if (config.gcsProjectId) {
                storageConfig.projectId = config.gcsProjectId;
            }

            try {
                storage = new Storage(storageConfig);
                bucket = storage.bucket(config.gcsBucket);

                // Test connection by checking if bucket exists
                bucket.exists((err, exists) => {
                    if (err) {
                        storage = null;
                        bucket = null;
                        lastInitError = `Cannot connect to GCS: ${err.message}`;
                        cb(new Error(lastInitError));
                    } else if (!exists) {
                        storage = null;
                        bucket = null;
                        lastInitError = `GCS bucket '${config.gcsBucket}' does not exist or is not accessible`;
                        cb(new Error(lastInitError));
                    } else {
                        logger.info(`Connected to GCS bucket: ${config.gcsBucket}`);
                        cb();
                    }
                });
            } catch (err) {
                storage = null;
                bucket = null;
                lastInitError = `Failed to initialize GCS: ${err.message}`;
                cb(new Error(lastInitError));
            }
        } else {
            cb();
        }
    },

    /**
     * Upload paths to GCS bucket
     * @param {String} srcFolder - Local folder where files are located
     * @param {String} bucketName - GCS bucket name (unused, uses config)
     * @param {String} dstFolder - Destination prefix/folder in GCS
     * @param {String[]} paths - List of paths relative to srcFolder to upload
     * @param {Function} cb - Callback function
     * @param {Function} onOutput - Optional callback for progress output
     * @param {Function} onFileDone - Optional callback(completed, total, filename) after each file
     */
    uploadPaths: function(srcFolder, bucketName, dstFolder, paths, cb, onOutput, onFileDone) {
        if (!storage || !bucket) {
            return cb(new Error("GCS is not initialized"));
        }

        const PARALLEL_UPLOADS = config.gcsParallelUploads || 16;
        const MAX_RETRIES = 5;

        let uploadList = [];
        let completedUploads = 0;
        let totalFiles = 0;

        // Build upload list from paths
        paths.forEach(p => {
            const normalized = (p === '*' ? '.' : p);
            const fullPath = path.join(srcFolder, normalized);

            // Skip non-existing items
            if (!fs.existsSync(fullPath)) {
                logger.debug(`Skipping non-existent path: ${fullPath}`);
                return;
            }

            if (fs.lstatSync(fullPath).isDirectory()) {
                // Glob all files in directory.
                // Special-case '.' to mean "everything under srcFolder" without leading './' in keys.
                const globPattern = normalized === '.' ? `**/*` : `${normalized}/**/*`;
                const globPaths = glob.sync(globPattern, { cwd: srcFolder, nodir: true, nosort: true });
                globPaths.forEach(gp => {
                    uploadList.push({
                        src: path.join(srcFolder, gp),
                        dest: path.join(dstFolder, gp),
                        relativePath: gp,
                        retries: 0
                    });
                });
            } else {
                uploadList.push({
                    src: fullPath,
                    dest: path.join(dstFolder, normalized),
                    relativePath: normalized,
                    retries: 0
                });
            }
        });

        totalFiles = uploadList.length;

        if (totalFiles === 0) {
            if (onOutput) onOutput("No files to upload to GCS");
            return cb();
        }

        if (onOutput) onOutput(`Uploading ${totalFiles} files to GCS bucket '${config.gcsBucket}'...`);

        let cbCalled = false;

        const q = async.queue((file, done) => {
            const filename = path.basename(file.dest);
            const fileSize = fs.statSync(file.src).size;
            const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

            logger.debug(`Uploading ${file.src} --> gs://${config.gcsBucket}/${file.dest} (${fileSizeMB} MB)`);

            const gcsFile = bucket.file(file.dest);

            // Configure upload options
            const uploadOptions = {
                resumable: fileSize > 5 * 1024 * 1024, // Use resumable for files > 5MB
                validation: 'crc32c',
                metadata: {
                    contentType: getContentType(file.src)
                }
            };

            // For large files, set chunk size
            if (fileSize > 10 * 1024 * 1024) {
                uploadOptions.chunkSize = 10 * 1024 * 1024; // 10MB chunks
            }

            const startTime = Date.now();

            fs.createReadStream(file.src)
                .pipe(gcsFile.createWriteStream(uploadOptions))
                .on('error', err => {
                    logger.debug(`Upload error for ${filename}: ${err.message}`);

                    if (file.retries < MAX_RETRIES) {
                        file.retries++;
                        const delay = Math.pow(2, file.retries) * 1000;
                        if (onOutput) onOutput(`Retrying ${filename} (attempt ${file.retries}/${MAX_RETRIES}) in ${delay/1000}s...`);

                        setTimeout(() => {
                            q.push(file, errHandler);
                            done();
                        }, delay);
                    } else {
                        done(new Error(`Failed to upload ${filename} after ${MAX_RETRIES} retries: ${err.message}`));
                    }
                })
                .on('finish', () => {
                    completedUploads++;
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    const progress = Math.round((completedUploads / totalFiles) * 100);

                    if (onOutput) {
                        onOutput(`[${progress}%] Uploaded ${filename} (${fileSizeMB} MB in ${elapsed}s)`);
                    }
                    if (onFileDone) {
                        onFileDone(completedUploads, totalFiles, file.relativePath || filename);
                    }

                    done();
                });
        }, PARALLEL_UPLOADS);

        const errHandler = err => {
            if (err) {
                q.kill();
                if (!cbCalled) {
                    cbCalled = true;
                    cb(err);
                }
            }
        };

        q.drain = () => {
            if (!cbCalled) {
                cbCalled = true;
                if (onOutput) onOutput(`Successfully uploaded ${totalFiles} files to GCS!`);
                cb();
            }
        };

        q.push(uploadList, errHandler);
    },

    /**
     * Delete local files/folders after successful upload
     * @param {String} srcFolder - Base folder
     * @param {String[]} paths - Paths to delete (relative to srcFolder)
     * @param {Function} cb - Callback
     * @param {Function} onOutput - Optional output callback
     */
    /**
     * List project folder names under gcsUploadPrefix (top-level "directories" in the bucket).
     */
    listProjects: function(cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }

        const prefix = config.gcsUploadPrefix
            ? String(config.gcsUploadPrefix).replace(/\/$/, "") + "/"
            : "";

        bucket.getFiles({ prefix, delimiter: "/", autoPaginate: false, maxResults: 5000 }, (err, files, nextQuery, apiResponse) => {
            if (err) return cb(err);

            const names = new Set();
            (apiResponse && apiResponse.prefixes || []).forEach(p => {
                let name = p.slice(prefix.length).replace(/\/$/, "");
                if (name && !name.includes("/") && !name.startsWith(".")) names.add(name);
            });

            // Fallback: infer folder names from object keys when delimiter prefixes are empty.
            (files || []).forEach(file => {
                const key = file.name || "";
                if (!key.startsWith(prefix)) return;
                const rest = key.slice(prefix.length);
                const seg = rest.split("/")[0];
                if (seg && !seg.startsWith(".")) names.add(seg);
            });

            cb(null, Array.from(names).sort((a, b) => a.localeCompare(b)));
        });
    },

    /**
     * Resumable upload session URL (uses VM/service-account OAuth — no signBlob IAM needed).
     * Browser PUTs the file body to the returned URL.
     */
    getResumableUploadUrl: function(objectPath, contentType, origin, cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        const file = bucket.file(objectPath);
        const opts = {
            metadata: {
                contentType: contentType || "application/octet-stream"
            }
        };
        if (origin) opts.origin = origin;

        file.createResumableUpload(opts, (err, uri) => {
            if (err) return cb(err);
            cb(null, uri);
        });
    },

    listFilesUnderPrefix: function(prefix, cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        const normalized = String(prefix || "").replace(/\/+$/, "") + "/";
        bucket.getFiles({ prefix: normalized, autoPaginate: true }, (err, files) => {
            if (err) return cb(err);
            const objects = (files || []).filter(f => {
                const name = f.name || "";
                return name.length > normalized.length && !name.endsWith("/");
            });
            cb(null, objects);
        });
    },

    copyObject: function(srcPath, destPath, cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        bucket.file(srcPath).copy(bucket.file(destPath), err => cb(err));
    },

    copyPrefix: function(srcPrefix, destPrefix, cb, onFileDone) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        const srcBase = String(srcPrefix || "").replace(/\/+$/, "") + "/";
        const destBase = String(destPrefix || "").replace(/\/+$/, "") + "/";
        const PARALLEL = config.gcsParallelUploads || 16;

        module.exports.listFilesUnderPrefix(srcBase, (err, files) => {
            if (err) return cb(err);
            if (!files.length) {
                return cb(new Error("No staged objects found in GCS."));
            }

            let completed = 0;
            const total = files.length;
            const q = async.queue((file, done) => {
                const rel = file.name.slice(srcBase.length);
                const dest = destBase + rel;
                module.exports.copyObject(file.name, dest, copyErr => {
                    if (copyErr) return done(copyErr);
                    completed++;
                    if (onFileDone) onFileDone(completed, total, rel);
                    done();
                });
            }, PARALLEL);

            q.push(files, qErr => {
                if (qErr) return cb(qErr);
                cb(null, { fileCount: total });
            });
        });
    },

    deletePrefix: function(prefix, cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        const normalized = String(prefix || "").replace(/\/+$/, "") + "/";
        bucket.getFiles({ prefix: normalized, autoPaginate: true }, (err, files) => {
            if (err) return cb(err);
            if (!files || !files.length) return cb();
            async.eachLimit(files, 16, (file, done) => file.delete(done), cb);
        });
    },

    downloadFile: function(objectPath, destPath, cb) {
        if (!bucket) {
            return cb(new Error("GCS is not initialized"));
        }
        fs.mkdir(path.dirname(destPath), { recursive: true }, mkdirErr => {
            if (mkdirErr) return cb(mkdirErr);
            bucket.file(objectPath).download({ destination: destPath }, cb);
        });
    },

    contentTypeForPath: function(filePath) {
        return getContentType(filePath);
    },

    cleanupLocalPaths: function(srcFolder, paths, cb, onOutput) {
        if (onOutput) onOutput("Cleaning up local files after GCS upload...");
        logger.info(`Starting cleanup of ${paths.length} paths in ${srcFolder}`);

        async.eachSeries(paths, (p, done) => {
            const fullPath = path.join(srcFolder, p);

            if (!fs.existsSync(fullPath)) {
                if (onOutput) onOutput(`Skipping non-existent: ${p}`);
                return done();
            }

            if (fs.lstatSync(fullPath).isDirectory()) {
                if (onOutput) onOutput(`Deleting directory: ${p}`);
                rmdir(fullPath, err => {
                    if (err) {
                        logger.warn(`Failed to delete directory ${fullPath}: ${err.message}`);
                        if (onOutput) onOutput(`Warning: Failed to delete ${p}: ${err.message}`);
                    } else {
                        logger.info(`Deleted directory: ${fullPath}`);
                        if (onOutput) onOutput(`Deleted directory: ${p}`);
                    }
                    done(); // Continue even on error
                });
            } else {
                if (onOutput) onOutput(`Deleting file: ${p}`);
                fs.unlink(fullPath, err => {
                    if (err) {
                        logger.warn(`Failed to delete file ${fullPath}: ${err.message}`);
                        if (onOutput) onOutput(`Warning: Failed to delete ${p}: ${err.message}`);
                    } else {
                        logger.info(`Deleted file: ${fullPath}`);
                        if (onOutput) onOutput(`Deleted file: ${p}`);
                    }
                    done(); // Continue even on error
                });
            }
        }, err => {
            if (onOutput) onOutput("Local cleanup completed");
            logger.info("Local cleanup completed");
            cb(err);
        });
    }
};

/**
 * Get content type for a file based on extension
 */
function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.zip': 'application/zip',
        '.las': 'application/octet-stream',
        '.laz': 'application/octet-stream',
        '.ply': 'application/octet-stream',
        '.obj': 'model/obj',
        '.mtl': 'model/mtl',
        '.glb': 'model/gltf-binary',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.geojson': 'application/geo+json',
        '.gpkg': 'application/geopackage+sqlite3',
        '.mbtiles': 'application/x-sqlite3',
        '.kmz': 'application/vnd.google-earth.kmz'
    };

    return contentTypes[ext] || 'application/octet-stream';
}

