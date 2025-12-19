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

module.exports = {
    enabled: function() {
        return storage !== null && bucket !== null;
    },

    initialize: function(cb) {
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
                        cb(new Error(`Cannot connect to GCS: ${err.message}`));
                    } else if (!exists) {
                        cb(new Error(`GCS bucket '${config.gcsBucket}' does not exist or is not accessible`));
                    } else {
                        logger.info(`Connected to GCS bucket: ${config.gcsBucket}`);
                        cb();
                    }
                });
            } catch (err) {
                cb(new Error(`Failed to initialize GCS: ${err.message}`));
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
     */
    uploadPaths: function(srcFolder, bucketName, dstFolder, paths, cb, onOutput) {
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
            const fullPath = path.join(srcFolder, p);

            // Skip non-existing items
            if (!fs.existsSync(fullPath)) {
                logger.debug(`Skipping non-existent path: ${fullPath}`);
                return;
            }

            if (fs.lstatSync(fullPath).isDirectory()) {
                // Glob all files in directory
                const globPaths = glob.sync(`${p}/**`, { cwd: srcFolder, nodir: true, nosort: true });
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
                    dest: path.join(dstFolder, p),
                    relativePath: p,
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
    cleanupLocalPaths: function(srcFolder, paths, cb, onOutput) {
        if (onOutput) onOutput("Cleaning up local files after GCS upload...");

        async.eachSeries(paths, (p, done) => {
            const fullPath = path.join(srcFolder, p);

            if (!fs.existsSync(fullPath)) {
                return done();
            }

            if (fs.lstatSync(fullPath).isDirectory()) {
                rmdir(fullPath, err => {
                    if (err) {
                        logger.warn(`Failed to delete directory ${fullPath}: ${err.message}`);
                    } else {
                        logger.debug(`Deleted directory: ${fullPath}`);
                    }
                    done(); // Continue even on error
                });
            } else {
                fs.unlink(fullPath, err => {
                    if (err) {
                        logger.warn(`Failed to delete file ${fullPath}: ${err.message}`);
                    } else {
                        logger.debug(`Deleted file: ${fullPath}`);
                    }
                    done(); // Continue even on error
                });
            }
        }, err => {
            if (onOutput) onOutput("Local cleanup completed");
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

